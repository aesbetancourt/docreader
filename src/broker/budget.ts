// Job tokens, budgets, prices, cache keys and the call log (spec section 7).
import { appendFile, mkdir } from "node:fs/promises";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";

interface LlmPrice {
  inputPerMTok: number;
  outputPerMTok: number;
  cachedInputPerMTok?: number;
  source: string;
}

interface ToolPrice {
  /** USD per page (Document AI processors). */
  perPage?: number;
  /** Token prices (Gemini). */
  inputPerMTok?: number;
  outputPerMTok?: number;
  /** Upper-bound estimate for one call, used before the call. */
  estimatePerCall?: number;
  processorVersion?: string;
  source: string;
}

export interface Prices {
  asOf: string;
  llm: Record<string, LlmPrice>;
  /** Price used for a model that is not in `llm`. */
  llmDefault: LlmPrice;
  tools: Record<string, ToolPrice>;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens?: number;
  /** USD cost reported by upstream (OpenCode Go `usage.opencode.list_cost`). Preferred over prices.json. */
  upstreamUsd?: number;
  /** OpenCode Go allowance used by this call, as reported by upstream. */
  allowance?: number;
}

export interface JobDoc {
  name: string;
  sha256: string;
}

export interface CallRecord {
  at: string;
  kind: "llm" | "tool";
  tool?: string;
  model?: string;
  doc?: string;
  pages?: number[];
  input?: unknown;
  usd: number;
  durationMs: number;
  cacheHit?: boolean;
  usage?: Usage;
  error?: string;
  /** Files the broker wrote, relative to jobs/<id>/enriched/. */
  wrote?: string[];
}

export interface JobState {
  jobId: string;
  docs: JobDoc[];
  budgetUsd: number;
  allowCloudTools: boolean;
  llmUsd: number;
  toolsUsd: number;
  /** USD held for tool calls that are running now. */
  reservedUsd: number;
  calls: CallRecord[];
  createdAt: string;
  revoked: boolean;
}

export class BudgetError extends Error {
  readonly code: "budget_exceeded" | "unauthorized" | "forbidden" | "bad_request";

  constructor(message: string, code: BudgetError["code"]) {
    super(message);
    this.code = code;
  }
}

export function round(usd: number): number {
  return Math.round(usd * 1e6) / 1e6;
}

export function llmCost(prices: Prices, model: string, usage: Usage): number {
  const p = prices.llm[model] ?? prices.llmDefault;
  const cached = Math.min(usage.cachedTokens ?? 0, usage.promptTokens);
  const fresh = usage.promptTokens - cached;
  const cachedRate = p.cachedInputPerMTok ?? p.inputPerMTok;
  return round((fresh * p.inputPerMTok + cached * cachedRate + usage.completionTokens * p.outputPerMTok) / 1e6);
}

export function pageCost(prices: Prices, tool: string, pages: number): number {
  const p = prices.tools[tool];
  if (!p || p.perPage === undefined) throw new Error(`no per-page price for ${tool}`);
  return round(p.perPage * pages);
}

export function tokenCost(prices: Prices, tool: string, input: number, output: number): number {
  const p = prices.tools[tool];
  if (!p || p.inputPerMTok === undefined || p.outputPerMTok === undefined)
    throw new Error(`no token price for ${tool}`);
  return round((input * p.inputPerMTok + output * p.outputPerMTok) / 1e6);
}

/** Cache key = sha256(doc) + tool + processor version + pages (+ question). */
export function cacheKey(parts: {
  docSha256: string;
  tool: string;
  version: string;
  pages: number[];
  question?: string;
}): string {
  const pages = [...new Set(parts.pages)].toSorted((a, b) => a - b).join(",");
  const raw = [parts.docSha256, parts.tool, parts.version, pages, parts.question?.trim() ?? ""].join("\n");
  return createHash("sha256").update(raw).digest("hex");
}

function hashToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

export class JobRegistry {
  private jobs = new Map<string, JobState>();
  private tokens = new Map<string, string>(); // hex(sha256(token)) → jobId

  private readonly prices: Prices;
  private readonly jobsDir: string | undefined;
  private readonly now: () => Date;

  constructor(prices: Prices, jobsDir?: string, now: () => Date = () => new Date()) {
    this.prices = prices;
    this.jobsDir = jobsDir;
    this.now = now;
  }

  create(input: { jobId: string; docs: JobDoc[]; budgetUsd: number; allowCloudTools: boolean }): {
    token: string;
    budgetUsd: number;
  } {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(input.jobId)) throw new BudgetError("invalid jobId", "bad_request");
    if (!(input.budgetUsd >= 0)) throw new BudgetError("invalid budgetUsd", "bad_request");
    const existing = this.jobs.get(input.jobId);
    if (existing && !existing.revoked) throw new BudgetError("job already registered", "bad_request");
    const token = `djt_${randomBytes(32).toString("hex")}`;
    this.jobs.set(input.jobId, {
      jobId: input.jobId,
      docs: input.docs.map((d) => ({ name: d.name, sha256: d.sha256.toLowerCase() })),
      budgetUsd: input.budgetUsd,
      allowCloudTools: input.allowCloudTools,
      llmUsd: 0,
      toolsUsd: 0,
      reservedUsd: 0,
      calls: [],
      createdAt: this.now().toISOString(),
      revoked: false,
    });
    this.tokens.set(hashToken(token).toString("hex"), input.jobId);
    return { token, budgetUsd: input.budgetUsd };
  }

  get(jobId: string): JobState | undefined {
    return this.jobs.get(jobId);
  }

  /** Returns the job for a bearer token, or throws `unauthorized`. */
  authenticate(header: string | null | undefined): JobState {
    const match = /^Bearer\s+(\S+)$/i.exec(header ?? "");
    if (!match?.[1]) throw new BudgetError("missing bearer token", "unauthorized");
    const hashed = hashToken(match[1]);
    const jobId = this.tokens.get(hashed.toString("hex"));
    const job = jobId ? this.jobs.get(jobId) : undefined;
    if (!job || job.revoked) throw new BudgetError("invalid or revoked job token", "unauthorized");
    return job;
  }

  revoke(jobId: string): JobState | undefined {
    const job = this.jobs.get(jobId);
    if (!job) return undefined;
    job.revoked = true;
    for (const [hash, id] of this.tokens) if (id === jobId) this.tokens.delete(hash);
    return job;
  }

  spent(job: JobState): number {
    return round(job.llmUsd + job.toolsUsd);
  }

  left(job: JobState): number {
    return round(Math.max(0, job.budgetUsd - job.llmUsd - job.toolsUsd - job.reservedUsd));
  }

  /** LLM rule: refuse when spend has reached the budget. */
  assertCanCallLlm(job: JobState): void {
    if (this.spent(job) >= job.budgetUsd) {
      throw new BudgetError(
        `Budget exhausted for job ${job.jobId}: spent $${this.spent(job).toFixed(4)} of $${job.budgetUsd.toFixed(4)}. Stop and write your result with what you have.`,
        "budget_exceeded",
      );
    }
  }

  /** Checks a document by name and returns it with its sha256. */
  doc(job: JobState, name: string): JobDoc {
    const doc = job.docs.find((d) => d.name === name);
    if (!doc) throw new BudgetError(`document "${name}" is not part of this job`, "forbidden");
    return doc;
  }

  assertCloudAllowed(job: JobState): void {
    if (!job.allowCloudTools) {
      throw new BudgetError(
        "cloud tools are disabled for this job (allowCloudTools=false); read the local files instead",
        "forbidden",
      );
    }
  }

  /** Holds `estimateUsd` until `settle`. Refuses if it would pass the budget. */
  reserve(job: JobState, estimateUsd: number): void {
    if (estimateUsd > this.left(job) + 1e-12) {
      throw new BudgetError(
        `This call is estimated at $${estimateUsd.toFixed(4)} but only $${this.left(job).toFixed(4)} is left. Use fewer pages or read the local files.`,
        "budget_exceeded",
      );
    }
    job.reservedUsd = round(job.reservedUsd + estimateUsd);
  }

  async settle(job: JobState, reservedUsd: number, record: Omit<CallRecord, "at">): Promise<CallRecord> {
    job.reservedUsd = round(Math.max(0, job.reservedUsd - reservedUsd));
    return this.record(job, record);
  }

  async record(job: JobState, record: Omit<CallRecord, "at">): Promise<CallRecord> {
    const full: CallRecord = { at: this.now().toISOString(), ...record, usd: round(record.usd) };
    if (full.kind === "llm") job.llmUsd = round(job.llmUsd + full.usd);
    else job.toolsUsd = round(job.toolsUsd + full.usd);
    job.calls.push(full);
    await this.appendLog(job.jobId, full);
    return full;
  }

  private async appendLog(jobId: string, record: CallRecord): Promise<void> {
    if (!this.jobsDir) return;
    const dir = join(this.jobsDir, jobId);
    await mkdir(dir, { recursive: true });
    await appendFile(join(dir, "broker.jsonl"), `${JSON.stringify(record)}\n`);
  }

  summary(job: JobState) {
    return {
      jobId: job.jobId,
      budgetUsd: job.budgetUsd,
      spentUsd: this.spent(job),
      leftUsd: this.left(job),
      llmUsd: job.llmUsd,
      toolsUsd: job.toolsUsd,
      allowCloudTools: job.allowCloudTools,
      revoked: job.revoked,
      calls: job.calls,
    };
  }
}

/** Constant-time compare for the admin token. */
export function safeEqual(a: string, b: string): boolean {
  const ha = hashToken(a);
  const hb = hashToken(b);
  return timingSafeEqual(ha, hb);
}
