// OpenAI-compatible pass-through to OpenCode Go (spec section 7.2).
import { BROKER } from "../shared/constants.ts";
import { BudgetError, llmCost, type JobRegistry, type JobState, type Prices, type Usage } from "./budget.ts";

export interface LlmConfig {
  upstreamBaseUrl: string;
  apiKey: string;
  /** Upstream model list. Default: `${upstreamBaseUrl}/models`. */
  modelsUrl?: string;
  /** Models announced by GET /models when the upstream list fails. */
  models: string[];
}

/** OpenCode Go asks for a stable session ID per conversation (https://opencode.ai/docs/go/). */
export const SESSION_HEADER = "x-opencode-session";

/** The client's x-opencode-session if it is safe to forward; otherwise one ID per job. */
function sessionHeader(req: Request, jobId: string): string {
  const v = req.headers.get(SESSION_HEADER)?.trim();
  return v && /^[\w.:-]{1,128}$/.test(v) ? v : `docreader-${jobId}`;
}

export function openAiError(status: number, message: string, type: string): Response {
  return Response.json({ error: { message, type, code: type } }, { status });
}

interface OpenAiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  opencode?: { list_cost?: number; allowance?: number };
}

function toUsage(u: OpenAiUsage | undefined | null): Usage | undefined {
  if (!u || typeof u.prompt_tokens !== "number") return undefined;
  return {
    promptTokens: u.prompt_tokens,
    completionTokens: u.completion_tokens ?? 0,
    cachedTokens: u.prompt_tokens_details?.cached_tokens ?? 0,
    ...(typeof u.opencode?.list_cost === "number" ? { upstreamUsd: u.opencode.list_cost } : {}),
    ...(typeof u.opencode?.allowance === "number" ? { allowance: u.opencode.allowance } : {}),
  };
}

/** Passes SSE bytes through unchanged and reports the last `usage` object seen. */
function usageTap(onDone: (usage: Usage | undefined, error?: string) => void): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  let buffer = "";
  let usage: Usage | undefined;
  const scan = (line: string) => {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;
    try {
      const parsed = JSON.parse(data) as { usage?: OpenAiUsage };
      usage = toUsage(parsed.usage) ?? usage;
    } catch {
      // Not JSON: pass through, nothing to record.
    }
  };
  return new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      buffer += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        scan(buffer.slice(0, nl).replace(/\r$/, ""));
        buffer = buffer.slice(nl + 1);
      }
    },
    flush() {
      if (buffer) scan(buffer);
      onDone(usage);
    },
  });
}

export class LlmProxy {
  private readonly cfg: LlmConfig;
  private readonly registry: JobRegistry;
  private readonly prices: Prices;
  private readonly fetchImpl: typeof fetch;

  constructor(cfg: LlmConfig, registry: JobRegistry, prices: Prices, fetchImpl: typeof fetch = fetch) {
    this.cfg = cfg;
    this.registry = registry;
    this.prices = prices;
    this.fetchImpl = fetchImpl;
  }

  async models(): Promise<Response> {
    try {
      const res = await this.fetchImpl(this.cfg.modelsUrl ?? `${this.cfg.upstreamBaseUrl}/models`, {
        headers: { authorization: `Bearer ${this.cfg.apiKey}` },
      });
      if (res.ok) return Response.json(await res.json());
    } catch {
      // Fall back to the configured list.
    }
    return Response.json({
      object: "list",
      data: this.cfg.models.map((id) => ({ id, object: "model", owned_by: "opencode-go" })),
    });
  }

  async chat(job: JobState, req: Request): Promise<Response> {
    try {
      this.registry.assertCanCallLlm(job);
    } catch (e) {
      if (e instanceof BudgetError) return openAiError(402, e.message, e.code);
      throw e;
    }
    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return openAiError(400, "request body must be JSON", "bad_request");
    }
    const model = typeof body.model === "string" ? body.model : "";
    const stream = body.stream === true;
    if (stream) body.stream_options = { ...(body.stream_options as object | undefined), include_usage: true };

    const started = performance.now();
    const record = (usage: Usage | undefined, error?: string) =>
      void this.registry
        .record(job, {
          kind: "llm",
          model,
          usage,
          // Upstream knows the real price (cache discounts included). prices.json is the fallback.
          usd: usage ? (usage.upstreamUsd ?? llmCost(this.prices, model, usage)) : 0,
          durationMs: Math.round(performance.now() - started),
          error: error ?? (usage ? undefined : "no usage reported by upstream"),
        })
        .catch((err) => console.error("call log failed", err));

    let upstream: Response;
    try {
      upstream = await this.fetchImpl(`${this.cfg.upstreamBaseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: req.headers.get("accept") ?? "application/json",
          authorization: `Bearer ${this.cfg.apiKey}`,
          // OpenCode Go asks for a stable session ID per conversation and a specific user agent.
          // One job is one OpenCode conversation, so the job id is the fallback session ID.
          [SESSION_HEADER]: sessionHeader(req, job.jobId),
          "user-agent": BROKER.userAgent,
        },
        body: JSON.stringify(body),
        signal: req.signal,
      });
    } catch (e) {
      record(undefined, `upstream fetch failed: ${(e as Error).message}`);
      return openAiError(502, "upstream LLM is not reachable", "upstream_error");
    }

    const headers = new Headers();
    for (const h of ["content-type", "cache-control", "x-request-id"]) {
      const v = upstream.headers.get(h);
      if (v) headers.set(h, v);
    }

    if (!upstream.ok) {
      const text = await upstream.text();
      record(undefined, `upstream HTTP ${upstream.status}: ${text.slice(0, 500)}`);
      return new Response(text, { status: upstream.status, headers });
    }

    if (stream && upstream.body) {
      return new Response(upstream.body.pipeThrough(usageTap(record)), { status: upstream.status, headers });
    }

    const text = await upstream.text();
    let usage: Usage | undefined;
    try {
      usage = toUsage((JSON.parse(text) as { usage?: OpenAiUsage }).usage);
    } catch {
      usage = undefined;
    }
    record(usage);
    return new Response(text, { status: upstream.status, headers });
  }
}
