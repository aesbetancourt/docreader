// Client for the docreader server: POST the form, read the server-sent events.
import { WEB } from "../shared/constants.ts";
import type { AgentEvent, ConvertFormat, TaskMode, TaskResult, Usage } from "../shared/types.ts";
import type { TaskStage } from "../server/task.ts";

export interface ServerInfo {
  model: string;
  models: string[];
  budgetUsd: number;
}

export async function serverInfo(): Promise<ServerInfo> {
  return (await fetch(WEB.routes.info)).json();
}

export interface RunInput {
  mode: TaskMode;
  model: string;
  files: File[];
  questions: string;
  format: ConvertFormat;
  instructions: string;
  budgetUsd: number;
  local: boolean;
}

export interface RunHandlers {
  onStage: (stage: TaskStage) => void;
  onAgentEvent: (event: AgentEvent) => void;
  onUsage: (usage: Usage) => void;
  onResult: (result: TaskResult) => void;
  onError: (message: string) => void;
}

export const fileUrl = (jobId: string, name: string) =>
  `${WEB.routes.files}/${encodeURIComponent(jobId)}/${encodeURIComponent(name)}`;

export async function runTask(input: RunInput, handlers: RunHandlers): Promise<void> {
  const form = new FormData();
  for (const f of input.files) form.append("files", f, f.name);
  form.append("mode", input.mode);
  form.append("model", input.model);
  form.append("questions", input.questions);
  form.append("format", input.format);
  form.append("instructions", input.instructions);
  form.append("budgetUsd", String(input.budgetUsd));
  form.append("local", String(input.local));

  const res = await fetch(WEB.routes.run, { method: "POST", body: form });
  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    handlers.onError(body.error ?? `HTTP ${res.status}`);
    return;
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let end: number;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const event = /^event: (.*)$/m.exec(block)?.[1];
      const data = JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? "null");
      if (event === WEB.events.stage) handlers.onStage(data.stage);
      else if (event === WEB.events.agent) handlers.onAgentEvent(data);
      else if (event === WEB.events.usage) handlers.onUsage(data);
      else if (event === WEB.events.result) handlers.onResult(data);
      else if (event === WEB.events.error) handlers.onError(data.message);
    }
  }
}
