import { useEffect, useRef, useState, type DragEvent } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { TaskStage } from "../server/task.ts";
import { DEFAULTS } from "../shared/constants.ts";
import type {
  AgentEvent,
  CheckStatus,
  ConvertFormat,
  OutputFile,
  Source,
  TaskMode,
  TaskResult,
  Usage,
} from "../shared/types.ts";
import { Activity } from "./Activity.tsx";
import { fileUrl, runTask, serverInfo } from "./api.ts";
import { UsagePanel } from "./UsagePanel.tsx";

const MODE_TEXT: Record<TaskMode, { tab: string; action: string }> = {
  ask: { tab: "Ask questions", action: "Ask" },
  convert: { tab: "Convert to structured", action: "Convert" },
};

const FORMAT_TEXT: Record<ConvertFormat, string> = { markdown: "Markdown", json: "JSON" };

const STAGE_TEXT: Record<TaskStage, string> = {
  starting: "Starting a sandbox",
  working: "The agent is reading the documents",
  finishing: "Checking the results",
};

const CHECK_TEXT: Record<CheckStatus, string> = {
  checked: "Checked",
  moved: "Checked (other place)",
  located: "Place found",
  "not found": "Not found",
  "not checkable": "Image reading",
  error: "Could not check",
};

const STATUS_TEXT: Record<TaskResult["status"], string> = {
  done: "",
  no_output: "The agent finished without a result.",
  budget_exceeded: "The budget ran out before the work was done. Raise the budget and try again.",
  failed: "The run failed.",
};

function formatSize(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function sourcePlace(s: Source): string {
  return [s.sheet && (s.range ? `${s.sheet}!${s.range}` : s.sheet), s.page && `page ${s.page}`]
    .filter(Boolean)
    .join(", ");
}

/** Seconds since `startedAt`, updated every second while it is set. */
function useElapsed(startedAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);
  return startedAt === null ? 0 : Math.max(0, Math.round((now - startedAt) / 1000));
}

function OutputPreview({ jobId, file }: { jobId: string; file: OutputFile }) {
  const isMarkdown = file.name.endsWith(".md");
  return (
    <details className="output" open>
      <summary>
        <span className="name">{file.name}</span>
        <span className="muted">{formatSize(file.bytes)}</span>
        <a href={fileUrl(jobId, file.name)} download onClick={(e) => e.stopPropagation()}>
          Download
        </a>
      </summary>
      {file.content === undefined ? (
        <p className="muted">Too large to preview. Download it.</p>
      ) : isMarkdown ? (
        <div className="answer">
          <Markdown remarkPlugins={[remarkGfm]}>{file.content}</Markdown>
        </div>
      ) : (
        <pre className="json">{file.content}</pre>
      )}
    </details>
  );
}

export function App() {
  const [mode, setMode] = useState<TaskMode>("ask");
  const [files, setFiles] = useState<File[]>([]);
  const [questions, setQuestions] = useState("");
  const [format, setFormat] = useState<ConvertFormat>("markdown");
  const [instructions, setInstructions] = useState("");
  const [budget, setBudget] = useState<number>(DEFAULTS.budgetUsd);
  const [models, setModels] = useState<string[]>([DEFAULTS.model]);
  const [model, setModel] = useState<string>(DEFAULTS.model);
  const [local, setLocal] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [running, setRunning] = useState(false);
  const [stage, setStage] = useState<TaskStage | null>(null);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [result, setResult] = useState<TaskResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const elapsed = useElapsed(running ? startedAt : null);

  useEffect(() => {
    serverInfo()
      .then((info) => {
        setModels(info.models);
        setModel(info.model);
      })
      .catch(() => {});
  }, []);

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    const incoming = [...list];
    setFiles((current) => [...current.filter((f) => !incoming.some((n) => n.name === f.name)), ...incoming]);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    addFiles(e.dataTransfer.files);
  };

  const canRun = files.length > 0 && !running && (mode === "convert" || questions.trim().length > 0);

  async function submit() {
    setStartedAt(Date.now());
    setRunning(true);
    setResult(null);
    setError(null);
    setStage(null);
    setEvents([]);
    setUsage(null);
    try {
      await runTask(
        { mode, model, files, questions, format, instructions, budgetUsd: budget, local },
        {
          onStage: setStage,
          onAgentEvent: (e) => setEvents((list) => [...list, e]),
          onUsage: setUsage,
          onResult: (r) => {
            setResult(r);
            setUsage(r.usage);
          },
          onError: setError,
        },
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  }

  return (
    <main>
      <header>
        <h1>docreader</h1>
        <p>
          Drop documents. Ask questions about them, or convert them to Markdown or JSON. An agent does the work in a
          sandbox; you can watch it.
        </p>
      </header>

      <section
        className={`drop ${dragging ? "dragging" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => picker.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && picker.current?.click()}
      >
        <input ref={picker} type="file" multiple hidden onChange={(e) => addFiles(e.target.files)} />
        <strong>Drop documents here</strong>
        <span>or click to choose. Any type: PDF, Excel, Word, CSV, PowerPoint, images, ...</span>
      </section>

      {files.length > 0 && (
        <ul className="files">
          {files.map((f) => (
            <li key={f.name}>
              <span className="name">{f.name}</span>
              <span className="size">{formatSize(f.size)}</span>
              <button
                type="button"
                aria-label={`Remove ${f.name}`}
                onClick={() => setFiles(files.filter((x) => x !== f))}
                disabled={running}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="tabs" role="tablist">
        {(Object.keys(MODE_TEXT) as TaskMode[]).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            className={mode === m ? "active" : ""}
            onClick={() => setMode(m)}
            disabled={running}
          >
            {MODE_TEXT[m].tab}
          </button>
        ))}
      </div>

      {mode === "ask" ? (
        <label className="field">
          <span>Questions (one per line)</span>
          <textarea
            rows={4}
            value={questions}
            placeholder={"What is the notice period?\nWho are the parties?"}
            onChange={(e) => setQuestions(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && canRun && submit()}
            disabled={running}
          />
        </label>
      ) : (
        <div className="convert">
          <label>
            Format
            <select value={format} onChange={(e) => setFormat(e.target.value as ConvertFormat)} disabled={running}>
              {(Object.keys(FORMAT_TEXT) as ConvertFormat[]).map((f) => (
                <option key={f} value={f}>
                  {FORMAT_TEXT[f]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Instructions (optional)</span>
            <textarea
              rows={2}
              value={instructions}
              placeholder="For example: only the tables; one section per month; skip the cover page"
              onChange={(e) => setInstructions(e.target.value)}
              disabled={running}
            />
          </label>
        </div>
      )}

      <div className="options">
        <label>
          Model
          <select value={model} onChange={(e) => setModel(e.target.value)} disabled={running}>
            {models.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        </label>
        <label>
          Budget (USD)
          <input
            type="number"
            min={0.05}
            step={0.05}
            value={budget}
            onChange={(e) => setBudget(Number(e.target.value))}
            disabled={running}
          />
        </label>
        <label className="check">
          <input type="checkbox" checked={local} onChange={(e) => setLocal(e.target.checked)} disabled={running} />
          Keep documents on this machine (no Google tools)
        </label>
        <button type="button" className="primary" onClick={submit} disabled={!canRun}>
          {running ? "Working..." : MODE_TEXT[mode].action}
        </button>
      </div>

      {running && (
        <div className="progress" aria-live="polite">
          <span className="spinner" />
          {stage ? STAGE_TEXT[stage] : "Uploading"} <span className="muted">({elapsed}s)</span>
        </div>
      )}

      {error && <div className="error">{error}</div>}

      <Activity events={events} running={running} />
      <UsagePanel usage={usage} running={running} />

      {result && (
        <article className="result">
          {result.status !== "done" && (
            <div className="error">
              {STATUS_TEXT[result.status]} {result.error}
            </div>
          )}
          {result.answer && (
            <div className="answer">
              <Markdown remarkPlugins={[remarkGfm]}>{result.answer}</Markdown>
            </div>
          )}
          {result.outputs.length > 0 && (
            <>
              <h2>Converted files</h2>
              {result.outputs.map((f) => (
                <OutputPreview key={f.name} jobId={result.jobId} file={f} />
              ))}
            </>
          )}
          {result.sources.length > 0 && (
            <>
              <h2>Sources</h2>
              <ul className="sources">
                {result.sources.map((s, i) => (
                  <li key={i}>
                    <span className={`badge ${(s.check?.status ?? "none").replace(" ", "-")}`}>
                      {s.check ? CHECK_TEXT[s.check.status] : "Not checked"}
                    </span>
                    <span className="doc">{s.doc}</span>
                    {sourcePlace(s) && <span className="place">{sourcePlace(s)}</span>}
                    {s.quote && <q>{s.quote}</q>}
                    {s.check && s.check.status !== "checked" && s.check.detail && (
                      <span className="detail">{s.check.detail}</span>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
          <footer>
            {result.run.durationSec}s &middot; {result.run.model} &middot; OpenCode {result.run.opencodeVersion}
            <span className="muted"> &middot; job {result.jobId}</span>
          </footer>
        </article>
      )}
    </main>
  );
}
