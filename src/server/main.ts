#!/usr/bin/env node
// docreader server. `pnpm start`: build what is missing, start the broker, serve the web page.
// Ctrl+C stops the running sandboxes and the broker. `pnpm build`: rebuild the images and the page.
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import { ENV, IMAGES, OPENCODE, WEB } from "../shared/constants.ts";
import { run } from "../shared/process.ts";
import { activeJobs, agentContainerName } from "./task.ts";
import { docker, removeContainer, removeJobNetwork } from "./docker.ts";
import { startHttp, UI_DIST } from "./http.ts";
import { ROOT, settings } from "./settings.ts";

const OPENCODE_LATEST_URL = "https://registry.npmjs.org/@opencode/cli/latest";
const VITE_CONFIG = "src/ui/vite.config.ts";

const say = (msg: string) => console.log(`docreader: ${msg}`);

function composeEnv(): Record<string, string> {
  const { uid, gid } = userInfo();
  return { [ENV.uid]: String(uid), [ENV.gid]: String(gid), [ENV.jobsDir]: settings().jobsDir };
}

async function sh(cmd: string, args: string[], env: Record<string, string> = {}): Promise<void> {
  const r = await run(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, inherit: true });
  if (r.code !== 0) throw new Error(`${cmd} ${args.slice(0, 2).join(" ")} failed (exit ${r.code})`);
}

async function opencodeVersion(): Promise<string> {
  const pinned = process.env[ENV.opencodeVersion];
  if (pinned) return pinned;
  const res = await fetch(OPENCODE_LATEST_URL);
  if (!res.ok) throw new Error(`cannot resolve the latest OpenCode version: HTTP ${res.status}`);
  return ((await res.json()) as { version: string }).version;
}

async function buildImages(): Promise<void> {
  const version = await opencodeVersion();
  say(`building the agent image (OpenCode ${version})`);
  await sh("docker", [
    "build",
    "-f",
    "docker/agent.Dockerfile",
    "--build-arg",
    `OPENCODE_VERSION=${version}`,
    "--label",
    `${OPENCODE.imageVersionLabel}=${version}`,
    "-t",
    IMAGES.agent,
    ".",
  ]);
  say("building the broker image");
  await sh("docker", ["compose", "build", "broker"], composeEnv());
}

async function buildUi(): Promise<void> {
  say("building the web page");
  await sh(join(ROOT, "node_modules/.bin/vite"), ["build", "--config", VITE_CONFIG, "--logLevel", "warn"]);
}

const imageExists = async (image: string) => (await docker(["image", "inspect", image])).code === 0;

async function start(): Promise<void> {
  if ((await docker(["info"])).code !== 0) throw new Error("Docker is not running");
  if (!existsSync(join(ROOT, ".env"))) throw new Error("missing .env: copy .env.example to .env and fill it in");
  if (!(await imageExists(IMAGES.agent)) || !(await imageExists(IMAGES.broker))) await buildImages();
  if (!existsSync(UI_DIST)) await buildUi();

  const env = composeEnv();
  for (const d of [env[ENV.jobsDir]!, join(ROOT, "cache/broker"), join(ROOT, "secrets")])
    await mkdir(d, { recursive: true });
  say("starting the broker");
  await sh("docker", ["compose", "up", "-d", "--wait", "broker"], env);

  const server = startHttp();
  say(`ready: http://${WEB.host}:${WEB.port}  (model ${settings().model}; Ctrl+C to stop)`);

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    say("stopping");
    server.close();
    for (const jobId of activeJobs) {
      await removeContainer(agentContainerName(jobId));
      await removeJobNetwork(jobId);
    }
    await run("docker", ["compose", "down"], { cwd: ROOT, env: { ...process.env, ...env } });
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

const COMMANDS: Record<string, () => Promise<void>> = {
  start,
  build: async () => {
    await buildImages();
    await buildUi();
  },
};

if (import.meta.main) {
  const cmd = process.argv[2] ?? "start";
  const fn = COMMANDS[cmd];
  if (!fn) {
    console.error(`usage: node src/server/main.ts [${Object.keys(COMMANDS).join("|")}]`);
    process.exitCode = 2;
  } else {
    fn().catch((e: Error) => {
      console.error(`docreader: ${e.message}`);
      process.exit(1);
    });
  }
}
