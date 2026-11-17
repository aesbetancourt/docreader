// Agent container: build the prompt, run OpenCode, then label the sources the agent listed (advisory).
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AGENT_PATHS, ENV, FORMAT_EXTENSION, OPENCODE, OUTPUT_FILES } from "../shared/constants.ts";
import { run } from "../shared/process.ts";
import type { ConvertFormat, Task, TaskMode } from "../shared/types.ts";

const PROMPT_DIR = import.meta.dirname;
const SOURCE_CHECKER = join(import.meta.dirname, "check_sources.py");
const TASK_TEMPLATE: Record<TaskMode, string> = { ask: "task-ask.md", convert: "task-convert.md" };

const FORMAT_NAME: Record<ConvertFormat, string> = { markdown: "Markdown", json: "JSON" };
const FORMAT_RULES: Record<ConvertFormat, string> = {
  markdown:
    "   - Use headings for sections, Markdown tables for tables, and lists for lists.\n" +
    "   - Mark where content comes from, so a reader can find it: `<!-- page 3 -->` for a PDF page, `## Sheet: <name>` for a spreadsheet sheet.",
  json:
    "   - Write valid JSON with a structure that fits the document. For a report: " +
    '`{ "title", "sections": [{ "heading", "page", "text", "tables": [{ "columns": [...], "rows": [[...]] }] }] }`. ' +
    "For a spreadsheet: one array of row objects per sheet, with the column headers as keys.\n" +
    "   - Keep numbers as numbers and dates in ISO format (2026-01-31).",
};

function pdfPageCount(path: string): string {
  const out = spawnSync("pdfinfo", [path], { encoding: "utf8" }).stdout ?? "";
  const m = /^Pages:\s+(\d+)/m.exec(out);
  return m ? `, ${m[1]} pages` : "";
}

/** One line per input file: path, size and, for a PDF, page count. */
export function documentList(dir: string = AGENT_PATHS.input): string {
  return readdirSync(dir)
    .filter((f) => statSync(join(dir, f)).isFile())
    .map((f) => {
      const kb = Math.max(1, Math.round(statSync(join(dir, f)).size / 1024));
      const pages = f.toLowerCase().endsWith(".pdf") ? pdfPageCount(join(dir, f)) : "";
      return `- \`${join(dir, f)}\` (${kb} KB${pages})`;
    })
    .join("\n");
}

/** Fills the task template (ask or convert) and the shared prompt. */
export function buildPrompt(shared: string, taskTemplate: string, task: Task, documents: string): string {
  const format = task.format ?? "markdown";
  const taskText = taskTemplate
    .replaceAll("{{QUESTIONS}}", task.questions.map((q, i) => `${i + 1}. ${q}`).join("\n"))
    .replaceAll("{{FORMAT_NAME}}", FORMAT_NAME[format])
    .replaceAll("{{EXTENSION}}", FORMAT_EXTENSION[format])
    .replaceAll("{{FORMAT_RULES}}", FORMAT_RULES[format])
    .replaceAll(
      "{{INSTRUCTIONS}}",
      task.instructions?.trim() ? `Instructions from the user:\n\n${task.instructions.trim()}` : "",
    );
  const budget =
    `$${task.budgetUsd.toFixed(2)} for this task (model calls and paid tools together).` +
    (task.allowCloudTools
      ? ""
      : " Paid tools are turned off for this task: the documents must not leave this machine. Use local tools only.");
  return shared.replace("{{TASK}}", taskText.trim()).replace("{{DOCUMENTS}}", documents).replace("{{BUDGET}}", budget);
}

async function main(): Promise<number> {
  const model = process.env[ENV.model];
  if (!model) throw new Error(`${ENV.model} is not set`);
  const task = JSON.parse(await readFile(AGENT_PATHS.task, "utf8")) as Task;
  const prompt = buildPrompt(
    await readFile(join(PROMPT_DIR, "prompt.md"), "utf8"),
    await readFile(join(PROMPT_DIR, TASK_TEMPLATE[task.mode]), "utf8"),
    task,
    documentList(),
  );
  if (task.mode === "convert") await mkdir(join(AGENT_PATHS.output, OUTPUT_FILES.convertedDir), { recursive: true });

  const agent = await run(
    "opencode",
    [
      "run",
      "--format",
      "json",
      "--thinking",
      "--standalone",
      "--auto",
      "-m",
      `${OPENCODE.providerId}/${model}`,
      prompt,
    ],
    {
      cwd: AGENT_PATHS.output,
      env: { ...process.env, OPENCODE_DISABLE_PROJECT_CONFIG: "true" },
      inherit: true,
    },
  );

  const sources = join(AGENT_PATHS.output, OUTPUT_FILES.sources);
  if (existsSync(sources)) {
    const check = await run("python3", ["-I", SOURCE_CHECKER, sources, AGENT_PATHS.input, AGENT_PATHS.enriched]);
    const report = check.code === 0 ? check.stdout : JSON.stringify({ error: check.stderr.slice(0, 500), sources: [] });
    await writeFile(join(AGENT_PATHS.output, OUTPUT_FILES.check), report);
  }
  return agent.code;
}

if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (e) {
    console.error(`docreader agent: ${(e as Error).message}`);
    process.exitCode = 2;
  }
}
