// HTTP server: the web page and its API. Upload documents, ask or convert, watch the agent work.
// It runs on the host because it starts Docker containers; it listens on 127.0.0.1 only.
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, extname, join, normalize, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { DEFAULTS, JOB_FILES, MODEL_CHOICES, MODEL_ID, OUTPUT_FILES, WEB } from "../shared/constants.ts";
import { CONVERT_FORMATS, TASK_MODES, type ConvertFormat, type TaskMode } from "../shared/types.ts";
import { settings } from "./settings.ts";
import { inputNames, runTask, type TaskRequest } from "./task.ts";

export const UI_DIST = resolve(import.meta.dirname, "../ui/dist");
const JOB_ID = /^[\w-]{1,64}$/;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

const encoder = new TextEncoder();
const sse = (event: string, data: unknown) => encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

interface RunForm {
  request: TaskRequest;
  model?: string;
  files: File[];
  budgetUsd: number;
  allowCloudTools: boolean;
}

async function readForm(req: Request): Promise<RunForm | string> {
  const length = Number(req.headers.get("content-length") ?? 0);
  if (length > WEB.maxUploadBytes) return `the upload is larger than ${WEB.maxUploadBytes / 1024 / 1024} MB`;
  const form = await req.formData();
  const field = (name: string) => String(form.get(name) ?? "").trim();

  const files = form.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  const mode = (field("mode") || "ask") as TaskMode;
  const format = (field("format") || "markdown") as ConvertFormat;
  const questions = field("questions")
    .split("\n")
    .map((q) => q.trim())
    .filter(Boolean);
  const budgetUsd = Number(field("budgetUsd") || DEFAULTS.budgetUsd);
  const model = field("model") || undefined;

  if (files.length === 0) return "add at least one document";
  if (!TASK_MODES.includes(mode)) return `mode must be one of: ${TASK_MODES.join(", ")}`;
  if (mode === "ask" && questions.length === 0) return "write at least one question";
  if (mode === "convert" && !CONVERT_FORMATS.includes(format))
    return `format must be one of: ${CONVERT_FORMATS.join(", ")}`;
  if (!(budgetUsd > 0)) return "the budget must be a positive number";
  if (model && !MODEL_ID.test(model)) return "invalid model id";
  return {
    request: { mode, questions, format, instructions: field("instructions") },
    model,
    files,
    budgetUsd,
    allowCloudTools: field("local") !== "true",
  };
}

/** Runs one task and streams `stage`, `agent` and `usage` events, then one `result` (or `error`). */
function runStream(form: RunForm): Response {
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(sse(event, data));
        } catch {
          // The page was closed; the task still finishes and its result stays in jobs/.
        }
      };
      const uploadDir = join(settings().jobsDir, "_uploads", randomBytes(8).toString("hex"));
      try {
        await mkdir(uploadDir, { recursive: true });
        const names = inputNames(form.files.map((f) => f.name));
        const paths: string[] = [];
        for (const [i, f] of form.files.entries()) {
          const path = join(uploadDir, names[i]!);
          await writeFile(path, new Uint8Array(await f.arrayBuffer()));
          paths.push(path);
        }
        const result = await runTask(paths, form.request, {
          model: form.model,
          budgetUsd: form.budgetUsd,
          allowCloudTools: form.allowCloudTools,
          onStage: (stage) => send(WEB.events.stage, { stage }),
          onAgentEvent: (event) => send(WEB.events.agent, event),
          onUsage: (usage) => send(WEB.events.usage, usage),
        });
        send(WEB.events.result, result);
      } catch (e) {
        send(WEB.events.error, { message: (e as Error).message });
      } finally {
        await rm(uploadDir, { recursive: true, force: true });
        controller.close();
      }
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}

/** GET /api/jobs/<jobId>/<file>: download one converted file. */
async function convertedFile(jobId: string, name: string): Promise<Response> {
  if (!JOB_ID.test(jobId) || basename(name) !== name || name.startsWith("."))
    return new Response("not found", { status: 404 });
  const path = join(settings().jobsDir, jobId, JOB_FILES.output, OUTPUT_FILES.convertedDir, name);
  if (!existsSync(path)) return new Response("not found", { status: 404 });
  return new Response(await readFile(path), {
    headers: {
      "content-type": CONTENT_TYPES[extname(name)] ?? "application/octet-stream",
      "content-disposition": `attachment; filename="${name.replace(/"/g, "")}"`,
    },
  });
}

async function staticFile(pathname: string): Promise<Response> {
  if (!existsSync(UI_DIST)) return new Response("The web page is not built. Run: pnpm build", { status: 503 });
  const rel = pathname === "/" ? "index.html" : normalize(decodeURIComponent(pathname)).replace(/^[/\\]+/, "");
  const path = resolve(UI_DIST, rel);
  if (!path.startsWith(UI_DIST) || !existsSync(path)) return new Response("not found", { status: 404 });
  return new Response(await readFile(path), {
    headers: { "content-type": CONTENT_TYPES[extname(path)] ?? "application/octet-stream" },
  });
}

function webHandler() {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (url.pathname === WEB.routes.run && req.method === "POST") {
      const form = await readForm(req);
      return typeof form === "string" ? Response.json({ error: form }, { status: 400 }) : runStream(form);
    }
    if (url.pathname === WEB.routes.info && req.method === "GET") {
      const s = settings();
      const models = [s.model, ...MODEL_CHOICES.filter((m) => m !== s.model)];
      return Response.json({ model: s.model, models, budgetUsd: DEFAULTS.budgetUsd, timeoutMin: s.timeoutMin });
    }
    const file = new RegExp(`^${WEB.routes.files}/([^/]+)/([^/]+)$`).exec(url.pathname);
    if (file && req.method === "GET") return convertedFile(decodeURIComponent(file[1]!), decodeURIComponent(file[2]!));
    if (req.method === "GET") return staticFile(url.pathname);
    return new Response("not found", { status: 404 });
  };
}

/** Starts the HTTP server on the loopback address. */
export function startHttp() {
  const server = serve({ fetch: webHandler(), port: WEB.port, hostname: WEB.host });
  // A task can take minutes: do not let Node close the request early.
  Object.assign(server, { requestTimeout: 0 });
  return server;
}
