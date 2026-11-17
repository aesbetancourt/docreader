// Broker: admin API (host only), LLM proxy and MCP tool server (agent, with a job token).
import { serve } from "@hono/node-server";
import { ROUTES } from "../shared/constants.ts";
import { BudgetError, JobRegistry, safeEqual, type JobState } from "./budget.ts";
import { loadConfig } from "./config.ts";
import { LlmProxy, openAiError } from "./llm.ts";
import { createMcpHandler } from "./mcp.ts";

export interface BrokerDeps {
  registry: JobRegistry;
  llm: LlmProxy;
  adminToken: string;
  /** Handles the MCP route for an authenticated job. */
  mcp?: (job: JobState, req: Request) => Promise<Response>;
}

const HTTP_STATUS: Record<BudgetError["code"], number> = {
  budget_exceeded: 402,
  unauthorized: 401,
  forbidden: 403,
  bad_request: 400,
};
const SHA256_HEX = /^[0-9a-fA-F]{64}$/;
const JOB_ROUTE = new RegExp(`^${ROUTES.adminJobs}/([^/]+)$`);

function asError(e: unknown): Response {
  if (e instanceof BudgetError)
    return Response.json({ error: e.message, code: e.code }, { status: HTTP_STATUS[e.code] });
  console.error(e);
  return Response.json({ error: "internal error" }, { status: 500 });
}

const bearer = (req: Request) => /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "")?.[1];

interface CreateJobBody {
  jobId?: unknown;
  docs?: unknown;
  budgetUsd?: unknown;
  allowCloudTools?: unknown;
}

function parseCreateJob(body: CreateJobBody) {
  const docs = Array.isArray(body.docs) ? body.docs : null;
  const docsOk = docs?.every(
    (d) => typeof d?.name === "string" && typeof d?.sha256 === "string" && SHA256_HEX.test(d.sha256),
  );
  if (
    typeof body.jobId !== "string" ||
    !docs ||
    !docsOk ||
    typeof body.budgetUsd !== "number" ||
    typeof body.allowCloudTools !== "boolean"
  )
    return undefined;
  return {
    jobId: body.jobId,
    docs: docs as { name: string; sha256: string }[],
    budgetUsd: body.budgetUsd,
    allowCloudTools: body.allowCloudTools,
  };
}

export function adminHandler(deps: BrokerDeps) {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (url.pathname === ROUTES.health) return new Response("ok");
    const token = bearer(req);
    if (!token || !safeEqual(token, deps.adminToken))
      return Response.json({ error: "admin token required" }, { status: 401 });
    try {
      if (url.pathname === ROUTES.adminJobs && req.method === "POST") {
        const input = parseCreateJob((await req.json()) as CreateJobBody);
        if (!input)
          return Response.json(
            { error: "body must be { jobId, docs: [{ name, sha256 }], budgetUsd, allowCloudTools }" },
            { status: 400 },
          );
        return Response.json(deps.registry.create(input), { status: 201 });
      }
      const jobId = JOB_ROUTE.exec(url.pathname)?.[1];
      if (jobId) {
        if (req.method !== "GET" && req.method !== "DELETE") return new Response("method not allowed", { status: 405 });
        const id = decodeURIComponent(jobId);
        const job = req.method === "DELETE" ? deps.registry.revoke(id) : deps.registry.get(id);
        return job
          ? Response.json(deps.registry.summary(job))
          : Response.json({ error: "unknown job" }, { status: 404 });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    } catch (e) {
      return asError(e);
    }
  };
}

export function publicHandler(deps: BrokerDeps) {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (url.pathname === ROUTES.health) return new Response("ok");
    let job: JobState;
    try {
      job = deps.registry.authenticate(req.headers.get("authorization"));
    } catch (e) {
      if (url.pathname.startsWith(ROUTES.llmBase) && e instanceof BudgetError)
        return openAiError(401, e.message, e.code);
      return asError(e);
    }
    try {
      if (url.pathname === ROUTES.models && req.method === "GET") return await deps.llm.models();
      if (url.pathname === ROUTES.chatCompletions && req.method === "POST") return await deps.llm.chat(job, req);
      if (url.pathname === ROUTES.mcp && deps.mcp) return await deps.mcp(job, req);
      return Response.json({ error: "not found" }, { status: 404 });
    } catch (e) {
      return asError(e);
    }
  };
}

if (import.meta.main) {
  const cfg = loadConfig();
  const registry = new JobRegistry(cfg.prices, cfg.jobsDir);
  const deps: BrokerDeps = {
    registry,
    llm: new LlmProxy(
      {
        upstreamBaseUrl: cfg.llm.baseUrl,
        modelsUrl: cfg.llm.modelsUrl,
        apiKey: cfg.llm.apiKey,
        models: cfg.llm.fallbackModels,
      },
      registry,
      cfg.prices,
    ),
    adminToken: cfg.adminToken,
    mcp: createMcpHandler({
      registry,
      prices: cfg.prices,
      jobsDir: cfg.jobsDir,
      cacheDir: cfg.cacheDir,
      google: cfg.google,
    }),
  };
  const pub = serve({ fetch: publicHandler(deps), port: cfg.publicPort, hostname: "0.0.0.0" });
  // LLM responses stream for minutes; Node's default request timeout would cut them.
  Object.assign(pub, { requestTimeout: 0 });
  serve({ fetch: adminHandler(deps), port: cfg.adminPort, hostname: cfg.adminHost });
  console.log(
    `broker: public on 0.0.0.0:${cfg.publicPort}, admin on ${cfg.adminHost}:${cfg.adminPort}, upstream ${cfg.llm.baseUrl}, google ${cfg.google ? "on" : "off"}`,
  );
}
