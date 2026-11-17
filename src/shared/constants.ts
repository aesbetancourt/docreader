// Every name, port, path and default that more than one part of docreader uses. Change them here only.

export const APP_VERSION = "0.3.0";

/** Docker images and the broker container. */
export const IMAGES = {
  agent: "docreader-agent:dev",
  broker: "docreader-broker:dev",
} as const;

export const BROKER = {
  containerName: "docreader-broker",
  publicPort: 7700,
  adminPort: 7701,
  /** The host reaches the broker only through the loopback address. */
  hostAddress: "127.0.0.1",
  userAgent: `docreader-broker/${APP_VERSION}`,
} as const;

/** The docreader server: web page + API. Bound to the loopback address only. */
export const WEB = {
  host: "127.0.0.1",
  port: 7800,
  maxUploadBytes: 100 * 1024 * 1024,
  routes: { run: "/api/run", info: "/api/info", files: "/api/jobs" },
  /** Server-sent event names on the ask stream. */
  events: { stage: "stage", agent: "agent", usage: "usage", result: "result", error: "error" },
  /** How often the server reads the spend from the broker during a run. */
  usagePollMs: 3000,
} as const;

/** HTTP routes on the broker. */
export const ROUTES = {
  health: "/healthz",
  llmBase: "/llm/v1",
  chatCompletions: "/llm/v1/chat/completions",
  models: "/llm/v1/models",
  mcp: "/mcp",
  adminJobs: "/admin/jobs",
} as const;

/** URL of the broker as the agent container sees it (Docker DNS on the job network). */
export const BROKER_URL_FOR_AGENT = `http://${BROKER.containerName}:${BROKER.publicPort}`;

/** Longest tool input or output text sent to the web page per agent event. */
export const MAX_EVENT_TEXT = 4000;

/** Paths inside the agent container. */
export const AGENT_PATHS = {
  input: "/in",
  enriched: "/enriched",
  output: "/out",
  taskDir: "/job",
  task: "/job/task.json",
  /** OpenCode keeps its data under $XDG_DATA_HOME/opencode. */
  xdgData: "/var/lib/docreader",
  opencodeData: "/var/lib/docreader/opencode",
  app: "/app",
} as const;

/** Files the agent writes in its output folder. */
export const OUTPUT_FILES = {
  answer: "answer.md",
  sources: "sources.json",
  check: "check.json",
  /** convert mode: one file per document. */
  convertedDir: "converted",
} as const;

/** File extension per convert format. */
export const FORMAT_EXTENSION = { markdown: ".md", json: ".json" } as const;

/** Converted files up to this size are sent to the page inline; larger ones are download-only. */
export const MAX_INLINE_OUTPUT_BYTES = 1_000_000;

/** Files and folders in jobs/<jobId>/ on the host. */
export const JOB_FILES = {
  input: "in",
  enriched: "enriched",
  output: "out",
  taskDir: "job",
  session: "session",
  task: "task.json",
  result: "result.json",
  trajectory: "trajectory.jsonl",
  agentLog: "agent.log",
  brokerLog: "broker.jsonl",
} as const;

/** OpenCode wiring: the broker is the only provider and the only MCP server. */
export const OPENCODE = {
  providerId: "broker",
  mcpServerName: "docreader",
  imageVersionLabel: "org.docreader.opencode-version",
} as const;

export const DEFAULTS = {
  model: "deepseek-v4.1-flash",
  budgetUsd: 1,
  timeoutMin: 15,
  modelContextTokens: 128_000,
  modelOutputTokens: 16_384,
  runtime: "runc",
} as const;

/** OpenCode Go models offered on the page, best first (benchmark 2026-11-15). All use the OpenAI-compatible endpoint. */
export const MODEL_CHOICES = [
  "deepseek-v4.1-flash",
  "glm-5.3-flash",
  "minimax-m3.1-flash",
  "kimi-k3",
  "glm-5.3",
] as const;
export const MODEL_ID = /^[\w.-]{1,64}$/;

/** Resource limits for the agent container. */
export const CONTAINER_LIMITS = {
  memory: "4g",
  cpus: "2",
  pids: "256",
  tmpfsSize: "1g",
} as const;

/** Paid tool names, as the agent sees them. */
export const TOOLS = {
  ocr: "ocr_pages",
  layout: "parse_layout",
  figure: "describe_figure",
  budget: "budget_status",
} as const;

export const MAX_PAGES_PER_TOOL_CALL = 10;

/** Environment variable names. */
export const ENV = {
  // Host CLI.
  model: "DOCREADER_MODEL",
  timeoutMin: "DOCREADER_TIMEOUT_MIN",
  jobsDir: "DOCREADER_JOBS_DIR",
  runtime: "DOCREADER_RUNTIME",
  adminToken: "BROKER_ADMIN_TOKEN",
  opencodeVersion: "OPENCODE_VERSION",
  // Compose.
  uid: "DOCREADER_UID",
  gid: "DOCREADER_GID",
  // Agent container.
  jobToken: "JOB_TOKEN",
  opencodeConfig: "OPENCODE_CONFIG_CONTENT",
  // Broker.
  opencodeApiKey: "OPENCODE_API_KEY",
  opencodeBaseUrl: "OPENCODE_GO_BASE_URL",
  opencodeModelsUrl: "OPENCODE_GO_MODELS_URL",
  brokerJobsDir: "JOBS_DIR",
  cacheDir: "CACHE_DIR",
  pricesFile: "PRICES_FILE",
  adminHost: "BROKER_ADMIN_HOST",
  gcpProject: "GCP_PROJECT",
  docaiLocation: "DOCAI_LOCATION",
  docaiOcrProcessor: "DOCAI_OCR_PROCESSOR_ID",
  docaiLayoutProcessor: "DOCAI_LAYOUT_PROCESSOR_ID",
  vertexLocation: "VERTEX_LOCATION",
  geminiModel: "GEMINI_MODEL",
} as const;
