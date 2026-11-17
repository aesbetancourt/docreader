// Broker settings, read once from the environment (set by compose.yaml and .env).
import { readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { BROKER, DEFAULTS, ENV } from "../shared/constants.ts";
import type { Prices } from "./budget.ts";
import type { GoogleConfig } from "./tools.ts";

/** OpenCode Go endpoints (https://opencode.ai/docs/go/). */
const OPENCODE_GO = {
  chatBaseUrl: "https://opencode.ai/inference/go/openai/v1",
  modelsUrl: "https://opencode.ai/inference/go/v1/models",
} as const;

const GOOGLE_DEFAULTS = {
  docaiLocation: "eu",
  vertexLocation: "global",
  geminiModel: "gemini-3.8-flash",
} as const;

export interface BrokerConfig {
  publicPort: number;
  adminPort: number;
  adminHost: string;
  adminToken: string;
  jobsDir: string;
  cacheDir: string;
  prices: Prices;
  llm: { baseUrl: string; modelsUrl: string; apiKey: string; fallbackModels: string[] };
  google?: GoogleConfig;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

/** The first non-loopback IPv4 address: the compose network, before any job network is attached. */
function defaultAdminHost(): string {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) if (a.family === "IPv4" && !a.internal) return a.address;
  }
  return BROKER.hostAddress;
}

function googleConfig(env: NodeJS.ProcessEnv = process.env): GoogleConfig | undefined {
  const project = env[ENV.gcpProject];
  const ocr = env[ENV.docaiOcrProcessor];
  const layout = env[ENV.docaiLayoutProcessor];
  if (!project || !ocr || !layout) return undefined;
  return {
    project,
    docaiLocation: env[ENV.docaiLocation] || GOOGLE_DEFAULTS.docaiLocation,
    ocrProcessorId: ocr,
    layoutProcessorId: layout,
    vertexLocation: env[ENV.vertexLocation] || GOOGLE_DEFAULTS.vertexLocation,
    geminiModel: env[ENV.geminiModel] || GOOGLE_DEFAULTS.geminiModel,
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BrokerConfig {
  return {
    publicPort: BROKER.publicPort,
    adminPort: BROKER.adminPort,
    // Admin listens only on the compose network address, so job networks cannot reach it.
    adminHost: env[ENV.adminHost] || defaultAdminHost(),
    adminToken: required(env, ENV.adminToken),
    jobsDir: required(env, ENV.brokerJobsDir),
    cacheDir: required(env, ENV.cacheDir),
    prices: JSON.parse(readFileSync(required(env, ENV.pricesFile), "utf8")) as Prices,
    llm: {
      baseUrl: (env[ENV.opencodeBaseUrl] || OPENCODE_GO.chatBaseUrl).replace(/\/+$/, ""),
      modelsUrl: env[ENV.opencodeModelsUrl] || OPENCODE_GO.modelsUrl,
      apiKey: required(env, ENV.opencodeApiKey),
      fallbackModels: [DEFAULTS.model],
    },
    google: googleConfig(env),
  };
}
