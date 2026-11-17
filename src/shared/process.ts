// Child process helper for Node: run a command, capture or stream its output, stop it at a timeout.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Text written to stdin, then stdin is closed. */
  input?: string | Uint8Array;
  timeoutMs?: number;
  /** Called when the timeout fires, before the process is killed (for example `docker kill`). */
  onTimeout?: () => void | Promise<void>;
  /** Also append stdout / stderr to these files. */
  stdoutFile?: string;
  stderrFile?: string;
  /** Pass output straight to this terminal instead of capturing it. */
  inherit?: boolean;
  /** Called with each complete line of stdout, as it arrives. */
  onStdoutLine?: (line: string) => void;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Keeps at most this much captured output in memory per stream. */
const MAX_CAPTURE = 2_000_000;

export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: [
        opts.input === undefined ? "ignore" : "pipe",
        opts.inherit ? "inherit" : "pipe",
        opts.inherit ? "inherit" : "pipe",
      ],
    });
    let stdout = "";
    let stderr = "";
    let partial = "";
    let timedOut = false;
    const files = [opts.stdoutFile, opts.stderrFile].map((f) => (f ? createWriteStream(f, { flags: "a" }) : undefined));
    child.stdout?.on("data", (b: Buffer) => {
      files[0]?.write(b);
      const text = b.toString();
      if (stdout.length < MAX_CAPTURE) stdout += text;
      if (opts.onStdoutLine) {
        const lines = (partial + text).split("\n");
        partial = lines.pop() ?? "";
        for (const line of lines) opts.onStdoutLine(line);
      }
    });
    child.stderr?.on("data", (b: Buffer) => {
      files[1]?.write(b);
      if (stderr.length < MAX_CAPTURE) stderr += b.toString();
    });
    if (opts.input !== undefined) child.stdin?.end(opts.input);
    const timer = opts.timeoutMs
      ? setTimeout(async () => {
          timedOut = true;
          await opts.onTimeout?.();
          child.kill("SIGKILL");
        }, opts.timeoutMs)
      : undefined;
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (partial && opts.onStdoutLine) opts.onStdoutLine(partial);
      for (const f of files) f?.end();
      resolve({ code: code ?? 1, stdout, stderr, timedOut });
    });
  });
}
