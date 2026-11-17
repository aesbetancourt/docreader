// Data shapes shared by the CLI, the broker and the agent container.

export const TASK_MODES = ["ask", "convert"] as const;
/** ask: answer questions. convert: turn each document into a structured file (Markdown or JSON). */
export type TaskMode = (typeof TASK_MODES)[number];

export const CONVERT_FORMATS = ["markdown", "json"] as const;
export type ConvertFormat = (typeof CONVERT_FORMATS)[number];

/** What the server hands to the agent container (jobs/<id>/job/task.json). */
export interface Task {
  mode: TaskMode;
  /** ask mode. */
  questions: string[];
  /** convert mode. */
  format?: ConvertFormat;
  /** Optional extra guidance, for example "only the tables". */
  instructions?: string;
  budgetUsd: number;
  allowCloudTools: boolean;
}

/** A file the agent produced in convert mode. `content` is included when it is small enough. */
export interface OutputFile {
  name: string;
  bytes: number;
  content?: string;
}

const CHECK_STATUSES = ["checked", "moved", "located", "not found", "not checkable", "error"] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];

/** One source the agent listed. `check` is added afterwards by the advisory checker. */
export interface Source {
  doc: string;
  page?: number;
  quote?: string;
  sheet?: string;
  range?: string;
  values?: unknown[];
  figure?: boolean;
  check?: { status: CheckStatus; detail: string };
}

type TaskStatus = "done" | "no_output" | "budget_exceeded" | "failed";

/** One paid tool call (OCR, layout, vision), as the broker logged it. */
interface ToolCallSummary {
  tool?: string;
  doc?: string;
  pages?: number[];
  usd: number;
  cacheHit?: boolean;
  durationMs?: number;
  error?: string;
}

/** Money and work so far for one request. Sent live during the run, and in the result. */
export interface Usage {
  model: string;
  llmUsd: number;
  toolsUsd: number;
  budgetUsd: number;
  llm: { calls: number; promptTokens: number; cachedTokens: number; completionTokens: number };
  toolCalls: ToolCallSummary[];
}

/** Written to jobs/<id>/result.json and sent to the page. */
export interface TaskResult {
  jobId: string;
  mode: TaskMode;
  status: TaskStatus;
  questions: string[];
  format?: ConvertFormat;
  instructions?: string;
  /** ask: the answer. convert: the agent's short summary of what it produced. */
  answer: string;
  /** convert: the converted files. */
  outputs: OutputFile[];
  sources: Source[];
  usage: Usage;
  run: { model: string; opencodeVersion: string; durationSec: number };
  error?: string;
}

/** One step of the agent's work, simplified from OpenCode's JSON events for the web page. */
export type AgentEvent =
  | { kind: "thinking"; at: number; text: string }
  | { kind: "text"; at: number; text: string }
  | {
      kind: "tool";
      at: number;
      tool: string;
      title?: string;
      status: string;
      input: string;
      output: string;
      durationMs?: number;
    }
  | { kind: "step"; at: number; tokens: { input: number; output: number; reasoning: number; cacheRead: number } }
  | { kind: "error"; at: number; message: string };

/** Broker admin API: GET /admin/jobs/:id. */
export interface JobSummary {
  jobId: string;
  budgetUsd: number;
  spentUsd: number;
  leftUsd: number;
  llmUsd: number;
  toolsUsd: number;
  allowCloudTools: boolean;
  revoked: boolean;
  calls: {
    kind: "llm" | "tool";
    tool?: string;
    doc?: string;
    pages?: number[];
    usd: number;
    cacheHit?: boolean;
    durationMs?: number;
    error?: string;
    usage?: { promptTokens: number; completionTokens: number; cachedTokens?: number };
  }[];
}
