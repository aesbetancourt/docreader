// Live view of the agent's work: thinking, tool calls (with input and output), messages, token use.
import { useEffect, useRef } from "react";
import type { AgentEvent } from "../shared/types.ts";

type ToolEvent = Extract<AgentEvent, { kind: "tool" }>;

/** The most useful one-line summary of a tool call: the command, the file, or the tool's own title. */
function toolSummary(e: ToolEvent): string {
  try {
    const input = JSON.parse(e.input) as Record<string, unknown>;
    const first = input.command ?? input.filePath ?? input.path ?? input.pattern ?? input.doc;
    if (typeof first === "string") return first.split("\n")[0]!;
  } catch {
    // Input was cut or is not JSON: fall back to the title.
  }
  return e.title && e.title !== e.tool ? e.title : "";
}

function totals(events: AgentEvent[]) {
  let steps = 0;
  let input = 0;
  let output = 0;
  let tools = 0;
  for (const e of events) {
    if (e.kind === "step") {
      steps++;
      input += e.tokens.input + e.tokens.cacheRead;
      output += e.tokens.output + e.tokens.reasoning;
    } else if (e.kind === "tool") tools++;
  }
  return { steps, tools, input, output };
}

const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export function Activity({ events, running }: { events: AgentEvent[]; running: boolean }) {
  const end = useRef<HTMLDivElement>(null);
  const count = events.length;
  useEffect(() => {
    // Follow the newest event while the agent works.
    if (running && count > 0) end.current?.scrollIntoView({ block: "nearest" });
  }, [count, running]);

  if (events.length === 0) return null;
  const t = totals(events);
  return (
    <details className="activity" open={running || undefined}>
      <summary>
        Agent activity{" "}
        <span className="muted">
          &middot; {t.tools} tool calls &middot; {t.steps} steps &middot; {fmt(t.input)} tokens in &middot;{" "}
          {fmt(t.output)} out
        </span>
      </summary>
      <ol>
        {events.map((e, i) => {
          switch (e.kind) {
            case "thinking":
              return (
                <li key={i} className="ev thinking">
                  <span className="tag">thinking</span>
                  <p>{e.text}</p>
                </li>
              );
            case "text":
              return (
                <li key={i} className="ev text">
                  <span className="tag">message</span>
                  <p>{e.text}</p>
                </li>
              );
            case "tool":
              return (
                <li key={i} className={`ev tool ${e.status}`}>
                  <details>
                    <summary>
                      <span className="tag">{e.tool}</span>
                      <code>{toolSummary(e)}</code>
                      {e.durationMs !== undefined && <span className="muted">{(e.durationMs / 1000).toFixed(1)}s</span>}
                      {e.status !== "completed" && <span className="status">{e.status}</span>}
                    </summary>
                    <div className="io">
                      <h4>Input</h4>
                      <pre>{e.input}</pre>
                      <h4>Output</h4>
                      <pre>{e.output || "(empty)"}</pre>
                    </div>
                  </details>
                </li>
              );
            case "error":
              return (
                <li key={i} className="ev error-ev">
                  <span className="tag">error</span>
                  <p>{e.message}</p>
                </li>
              );
            case "step":
              return null;
          }
        })}
      </ol>
      <div ref={end} />
    </details>
  );
}
