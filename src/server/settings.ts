// Host settings: environment variables with defaults, read in one place.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BROKER, DEFAULTS, ENV } from "../shared/constants.ts";

/** Repository root (src/server/ -> ../..). */
export const ROOT = resolve(import.meta.dirname, "../..");

export interface Settings {
  jobsDir: string;
  model: string;
  timeoutMin: number;
  runtime: string;
  adminUrl: string;
  adminToken: string;
}

/** Reads one key from the repo .env without loading the rest: the rest are broker secrets. */
function dotenvValue(key: string, file = join(ROOT, ".env")): string | undefined {
  if (!existsSync(file)) return undefined;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m?.[1] === key) return m[2]!.replace(/^(['"])(.*)\1$/, "$2");
  }
  return undefined;
}

export function settings(env: NodeJS.ProcessEnv = process.env): Settings {
  return {
    jobsDir: resolve(env[ENV.jobsDir] || join(ROOT, "jobs")),
    model: env[ENV.model] || DEFAULTS.model,
    timeoutMin: Number(env[ENV.timeoutMin] || DEFAULTS.timeoutMin),
    runtime: env[ENV.runtime] || DEFAULTS.runtime,
    adminUrl: `http://${BROKER.hostAddress}:${BROKER.adminPort}`,
    adminToken: env[ENV.adminToken] || dotenvValue(ENV.adminToken) || "",
  };
}
