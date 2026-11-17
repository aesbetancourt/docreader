// Docker, driven through its CLI: hardened container runs and per-job internal networks.
import { userInfo } from "node:os";
import { BROKER, CONTAINER_LIMITS } from "../shared/constants.ts";
import { run, type RunResult } from "../shared/process.ts";

/** UID used when the host user is root, so containers never run as root. */
const FALLBACK_UID = "10001:10001";

interface Mount {
  host: string;
  container: string;
  readOnly: boolean;
}

export interface ContainerOptions {
  name: string;
  image: string;
  /** "none" or a network name. */
  network: string;
  mounts: Mount[];
  /** Passed by name (`-e NAME`), so the values never show in the process list. */
  env?: Record<string, string>;
  args?: string[];
  runtime: string;
  timeoutMs: number;
  stdoutFile?: string;
  stderrFile?: string;
  onStdoutLine?: (line: string) => void;
}

function containerUser(): string {
  const { uid, gid } = userInfo();
  return uid > 0 ? `${uid}:${gid}` : FALLBACK_UID;
}

/** Hardening for every agent container. */
function hardeningFlags(runtime: string): string[] {
  return [
    "--user",
    containerUser(),
    "--read-only",
    "--tmpfs",
    `/tmp:rw,exec,nosuid,nodev,size=${CONTAINER_LIMITS.tmpfsSize},mode=1777`,
    "--memory",
    CONTAINER_LIMITS.memory,
    "--cpus",
    CONTAINER_LIMITS.cpus,
    "--pids-limit",
    CONTAINER_LIMITS.pids,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--runtime",
    runtime,
  ];
}

export function runArgs(opts: ContainerOptions): string[] {
  const args = ["run", "--rm", "--name", opts.name, "--network", opts.network, ...hardeningFlags(opts.runtime)];
  for (const m of opts.mounts)
    args.push("--mount", `type=bind,source=${m.host},target=${m.container}${m.readOnly ? ",readonly" : ""}`);
  for (const k of Object.keys(opts.env ?? {})) args.push("-e", k);
  return [...args, opts.image, ...(opts.args ?? [])];
}

/** Runs a container. At the timeout, `docker kill` stops it. */
export function runContainer(opts: ContainerOptions): Promise<RunResult> {
  return run("docker", runArgs(opts), {
    env: { ...process.env, ...opts.env },
    timeoutMs: opts.timeoutMs,
    onTimeout: async () => void (await docker(["kill", opts.name])),
    stdoutFile: opts.stdoutFile,
    stderrFile: opts.stderrFile,
    onStdoutLine: opts.onStdoutLine,
  });
}

/** Runs a docker CLI command. Does not throw. */
export async function docker(args: string[]): Promise<RunResult> {
  const r = await run("docker", args);
  return { ...r, stdout: r.stdout.trim(), stderr: r.stderr.trim() };
}

async function dockerOrThrow(args: string[]): Promise<string> {
  const r = await docker(args);
  if (r.code !== 0) throw new Error(`docker ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

export const jobNetwork = (jobId: string) => `job-${jobId}`;

/** Creates the per-job internal network (no internet) and attaches the broker to it. */
export async function createJobNetwork(jobId: string): Promise<void> {
  await dockerOrThrow(["network", "create", "--internal", "--label", `org.docreader.job=${jobId}`, jobNetwork(jobId)]);
  await dockerOrThrow(["network", "connect", jobNetwork(jobId), BROKER.containerName]);
}

export async function removeJobNetwork(jobId: string): Promise<void> {
  await docker(["network", "disconnect", "--force", jobNetwork(jobId), BROKER.containerName]);
  await docker(["network", "rm", jobNetwork(jobId)]);
}

export async function removeContainer(name: string): Promise<void> {
  await docker(["rm", "--force", name]);
}

export async function imageLabel(image: string, label: string): Promise<string | undefined> {
  const r = await docker(["image", "inspect", "--format", `{{ index .Config.Labels "${label}" }}`, image]);
  return r.code === 0 && r.stdout && r.stdout !== "<no value>" ? r.stdout : undefined;
}
