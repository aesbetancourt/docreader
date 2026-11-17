// One task in a fresh sandbox: answer questions about documents, or convert them to Markdown/JSON.
import { createHash, randomBytes } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  AGENT_PATHS,
  BROKER_URL_FOR_AGENT,
  DEFAULTS,
  ENV,
  IMAGES,
  JOB_FILES,
  MAX_EVENT_TEXT,
  MAX_INLINE_OUTPUT_BYTES,
  OPENCODE,
  OUTPUT_FILES,
  ROUTES,
  WEB,
} from "../shared/constants.ts";
import type {
  AgentEvent,
  ConvertFormat,
  JobSummary,
  OutputFile,
  Source,
  Task,
  TaskMode,
  TaskResult,
  Usage,
} from "../shared/types.ts";
import { createJobNetwork, imageLabel, jobNetwork, removeContainer, removeJobNetwork, runContainer } from "./docker.ts";
import { settings as loadSettings, type Settings } from "./settings.ts";

export type TaskStage = "starting" | "working" | "finishing";

/** What the user asked for. */
export interface TaskRequest {
  mode: TaskMode;
  questions?: string[];
  format?: ConvertFormat;
  instructions?: string;
}

export interface TaskOptions {
  /** OpenCode Go model id. Default: the server setting. */
  model?: string;
  budgetUsd?: number;
  allowCloudTools?: boolean;
  settings?: Settings;
  onStage?: (stage: TaskStage) => void;
  /** Each step of the agent's work, live. */
  onAgentEvent?: (event: AgentEvent) => void;
  /** Spend so far (model and paid tools), every few seconds while the agent runs. */
  onUsage?: (usage: Usage) => void;
}

/** Model and tool spend from the broker's call log. */
function usageFrom(model: string, budgetUsd: number, summary: JobSummary | undefined): Usage {
  const llm = { calls: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0 };
  const toolCalls: Usage["toolCalls"] = [];
  for (const c of summary?.calls ?? []) {
    if (c.kind === "llm") {
      llm.calls++;
      llm.promptTokens += c.usage?.promptTokens ?? 0;
      llm.cachedTokens += c.usage?.cachedTokens ?? 0;
      llm.completionTokens += c.usage?.completionTokens ?? 0;
    } else {
      const { tool, doc, pages, usd, cacheHit, durationMs, error } = c;
      toolCalls.push({ tool, doc, pages, usd, cacheHit, durationMs, error });
    }
  }
  return { model, budgetUsd, llmUsd: summary?.llmUsd ?? 0, toolsUsd: summary?.toolsUsd ?? 0, llm, toolCalls };
}

/** Jobs whose sandbox is running now. The server removes them on shutdown. */
export const activeJobs = new Set<string>();
export const agentContainerName = (jobId: string) => `docreader-${jobId}-agent`;

const clip = (v: unknown): string => {
  const s = typeof v === "string" ? v : JSON.stringify(v ?? "", null, 1);
  return s.length > MAX_EVENT_TEXT
    ? `${s.slice(0, MAX_EVENT_TEXT)}\n... (${s.length - MAX_EVENT_TEXT} more characters)`
    : s;
};

/** One line of `opencode run --format json` -> a simple event, or undefined for lines the page does not need. */
export function parseAgentEvent(line: string): AgentEvent | undefined {
  if (!line.startsWith("{")) return undefined;
  let e: any;
  try {
    e = JSON.parse(line);
  } catch {
    return undefined;
  }
  const at: number = e.timestamp ?? Date.now();
  const part = e.part ?? {};
  switch (e.type) {
    case "reasoning":
      return part.text ? { kind: "thinking", at, text: part.text } : undefined;
    case "text":
      return part.text ? { kind: "text", at, text: part.text } : undefined;
    case "tool_use": {
      const st = part.state ?? {};
      const time = st.time ?? {};
      return {
        kind: "tool",
        at,
        tool: String(part.tool ?? "tool"),
        title: st.title,
        status: String(st.status ?? "completed"),
        input: clip(st.input),
        output: clip(st.output ?? st.error ?? ""),
        durationMs: typeof time.end === "number" && typeof time.start === "number" ? time.end - time.start : undefined,
      };
    }
    case "step_finish": {
      const t = part.tokens ?? {};
      return {
        kind: "step",
        at,
        tokens: {
          input: t.input ?? 0,
          output: t.output ?? 0,
          reasoning: t.reasoning ?? 0,
          cacheRead: t.cache?.read ?? 0,
        },
      };
    }
    case "error":
      return {
        kind: "error",
        at,
        message: String(e.error?.message ?? e.error?.data?.message ?? JSON.stringify(e.error ?? e)),
      };
    default:
      return undefined;
  }
}

/** OpenCode config for the agent: the broker is the only provider and the only MCP server. */
export function opencodeConfig(model: string, brokerUrl = BROKER_URL_FOR_AGENT): string {
  const tokenRef = `{env:${ENV.jobToken}}`;
  return JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    model: `${OPENCODE.providerId}/${model}`,
    small_model: `${OPENCODE.providerId}/${model}`,
    autoupdate: false,
    share: "disabled",
    permission: "allow",
    provider: {
      [OPENCODE.providerId]: {
        npm: "@ai-sdk/openai-compatible",
        name: "docreader broker",
        options: { baseURL: `${brokerUrl}${ROUTES.llmBase}`, apiKey: tokenRef },
        // Text-only: OpenCode must never attach images. Pictures go through the describe_figure tool.
        models: {
          [model]: {
            name: model,
            attachment: false,
            modalities: { input: ["text"], output: ["text"] },
            limit: { context: DEFAULTS.modelContextTokens, output: DEFAULTS.modelOutputTokens },
          },
        },
      },
    },
    mcp: {
      [OPENCODE.mcpServerName]: {
        type: "remote",
        url: `${brokerUrl}${ROUTES.mcp}`,
        oauth: false,
        headers: { Authorization: `Bearer ${tokenRef}` },
      },
    },
  });
}

/** A file name that is safe in a path and in a prompt: ASCII letters, digits and a few marks. */
function safeFileName(name: string): string {
  const ascii = name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  const cleaned = ascii.replace(/[^\w.()+,=@-]+/g, "_").replace(/^[._]+/, "");
  return cleaned || "document";
}

/** Safe, unique names for the input files, in order: report.pdf, report-2.pdf, ... */
export function inputNames(files: string[]): string[] {
  const used = new Set<string>();
  return files.map((f) => {
    const base = safeFileName(basename(f));
    const dot = base.lastIndexOf(".");
    const [stem, ext] = dot > 0 ? [base.slice(0, dot), base.slice(dot)] : [base, ""];
    let name = base;
    for (let i = 2; used.has(name.toLowerCase()); i++) name = `${stem}-${i}${ext}`;
    used.add(name.toLowerCase());
    return name;
  });
}

const newJobId = (now = new Date()) =>
  `${now.toISOString().slice(0, 19).replace(/:/g, "-")}-${randomBytes(2).toString("hex")}`;

async function brokerAdmin<T>(s: Settings, method: string, path: string, body?: unknown): Promise<T> {
  if (!s.adminToken) throw new Error(`${ENV.adminToken} is not set (env or .env)`);
  let res: Response;
  try {
    res = await fetch(`${s.adminUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${s.adminToken}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error("the broker is not running; start it with: docreader broker up");
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`broker ${method} ${path}: HTTP ${res.status} ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/** The checked sources if the checker ran, else the raw list the agent wrote. */
async function readSources(outDir: string): Promise<Source[]> {
  const checked = await readJson<{ sources?: Source[] }>(join(outDir, OUTPUT_FILES.check));
  if (checked?.sources) return checked.sources;
  const raw = await readJson<Source[] | { sources?: Source[] }>(join(outDir, OUTPUT_FILES.sources));
  return Array.isArray(raw) ? raw : (raw?.sources ?? []);
}

/** Converted files, with their content when small enough to send to the page. */
async function readOutputs(outDir: string): Promise<OutputFile[]> {
  const dir = join(outDir, OUTPUT_FILES.convertedDir);
  const names = await readdir(dir).catch(() => [] as string[]);
  const out: OutputFile[] = [];
  for (const name of names.toSorted()) {
    const info = await stat(join(dir, name));
    if (!info.isFile()) continue;
    const content = info.size <= MAX_INLINE_OUTPUT_BYTES ? await readFile(join(dir, name), "utf8") : undefined;
    out.push({ name, bytes: info.size, ...(content !== undefined ? { content } : {}) });
  }
  return out;
}

export async function runTask(files: string[], request: TaskRequest, opts: TaskOptions = {}): Promise<TaskResult> {
  const base = opts.settings ?? loadSettings();
  const s = { ...base, model: opts.model ?? base.model };
  const stage = opts.onStage ?? (() => {});
  const started = Date.now();
  const task: Task = {
    mode: request.mode,
    questions: request.questions ?? [],
    ...(request.mode === "convert" ? { format: request.format ?? "markdown" } : {}),
    ...(request.instructions?.trim() ? { instructions: request.instructions.trim() } : {}),
    budgetUsd: opts.budgetUsd ?? DEFAULTS.budgetUsd,
    allowCloudTools: opts.allowCloudTools ?? true,
  };

  const jobId = newJobId();
  const root = join(s.jobsDir, jobId);
  const dir = {
    in: join(root, JOB_FILES.input),
    enriched: join(root, JOB_FILES.enriched),
    out: join(root, JOB_FILES.output),
    task: join(root, JOB_FILES.taskDir),
    session: join(root, JOB_FILES.session),
  };
  for (const d of Object.values(dir)) await mkdir(d, { recursive: true });
  const docs: { name: string; sha256: string }[] = [];
  const names = inputNames(files);
  for (const [i, f] of files.entries()) {
    const name = names[i]!;
    await copyFile(f, join(dir.in, name));
    docs.push({
      name,
      sha256: createHash("sha256")
        .update(await readFile(join(dir.in, name)))
        .digest("hex"),
    });
  }
  await writeFile(join(dir.task, JOB_FILES.task), JSON.stringify(task));

  const container = agentContainerName(jobId);
  let token = "";
  let networkUp = false;
  let error: string | undefined;
  try {
    stage("starting");
    token = (
      await brokerAdmin<{ token: string }>(s, "POST", ROUTES.adminJobs, {
        jobId,
        docs,
        budgetUsd: task.budgetUsd,
        allowCloudTools: task.allowCloudTools,
      })
    ).token;
    activeJobs.add(jobId);
    await createJobNetwork(jobId);
    networkUp = true;
    stage("working");
    const poll = opts.onUsage
      ? setInterval(() => {
          brokerAdmin<JobSummary>(s, "GET", `${ROUTES.adminJobs}/${jobId}`)
            .then((summary) => opts.onUsage!(usageFrom(s.model, task.budgetUsd, summary)))
            .catch(() => {});
        }, WEB.usagePollMs)
      : undefined;
    const result = await runContainer({
      name: container,
      image: IMAGES.agent,
      network: jobNetwork(jobId),
      runtime: s.runtime,
      mounts: [
        { host: dir.in, container: AGENT_PATHS.input, readOnly: true },
        { host: dir.enriched, container: AGENT_PATHS.enriched, readOnly: true },
        { host: dir.task, container: AGENT_PATHS.taskDir, readOnly: true },
        { host: dir.out, container: AGENT_PATHS.output, readOnly: false },
        { host: dir.session, container: AGENT_PATHS.opencodeData, readOnly: false },
      ],
      env: { [ENV.jobToken]: token, [ENV.model]: s.model, [ENV.opencodeConfig]: opencodeConfig(s.model) },
      timeoutMs: s.timeoutMin * 60_000,
      stdoutFile: join(root, JOB_FILES.trajectory),
      stderrFile: join(root, JOB_FILES.agentLog),
      onStdoutLine: (line) => {
        const event = opts.onAgentEvent && parseAgentEvent(line);
        if (event) opts.onAgentEvent!(event);
      },
    }).finally(() => clearInterval(poll));
    if (result.timedOut) error = `the agent timed out after ${s.timeoutMin} min`;
    else if (result.code !== 0)
      error = `the agent exited with code ${result.code} (see ${join(root, JOB_FILES.agentLog)})`;
  } catch (e) {
    error = (e as Error).message;
  }

  stage("finishing");
  const spend = token
    ? await brokerAdmin<JobSummary>(s, "GET", `${ROUTES.adminJobs}/${jobId}`).catch(() => undefined)
    : undefined;
  if (token) await brokerAdmin(s, "DELETE", `${ROUTES.adminJobs}/${jobId}`).catch(() => undefined);
  await removeContainer(container);
  if (networkUp) await removeJobNetwork(jobId);
  activeJobs.delete(jobId);

  const answer = ((await readFile(join(dir.out, OUTPUT_FILES.answer), "utf8").catch(() => "")) ?? "").trim();
  const outputs = await readOutputs(dir.out);
  const produced = task.mode === "convert" ? outputs.length > 0 : answer.length > 0;
  const budgetHit = !!spend && spend.spentUsd >= spend.budgetUsd;
  const result: TaskResult = {
    jobId,
    mode: task.mode,
    status: produced ? "done" : budgetHit ? "budget_exceeded" : error ? "failed" : "no_output",
    questions: task.questions,
    ...(task.format ? { format: task.format } : {}),
    ...(task.instructions ? { instructions: task.instructions } : {}),
    answer,
    outputs,
    sources: await readSources(dir.out),
    usage: usageFrom(s.model, task.budgetUsd, spend),
    run: {
      model: s.model,
      opencodeVersion: (await imageLabel(IMAGES.agent, OPENCODE.imageVersionLabel)) ?? "unknown",
      durationSec: Math.round((Date.now() - started) / 1000),
    },
    ...(error ? { error } : {}),
  };
  await writeFile(join(root, JOB_FILES.result), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}
