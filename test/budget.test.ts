import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  BudgetError,
  cacheKey,
  JobRegistry,
  llmCost,
  pageCost,
  safeEqual,
  tokenCost,
  type Prices,
} from "../src/broker/budget.ts";

const prices: Prices = {
  asOf: "2026-11-15",
  llm: { m1: { inputPerMTok: 1, outputPerMTok: 4, cachedInputPerMTok: 0.1, source: "test" } },
  llmDefault: { inputPerMTok: 2, outputPerMTok: 8, source: "test" },
  tools: {
    ocr_pages: { perPage: 0.0015, source: "test" },
    describe_figure: { inputPerMTok: 0.3, outputPerMTok: 2.5, estimatePerCall: 0.01, source: "test" },
  },
};
const doc = { name: "contract.pdf", sha256: "AB".repeat(32) };
const registry = (dir?: string) => new JobRegistry(prices, dir, () => new Date("2026-11-15T10:00:00Z"));
const codeOf = (fn: () => unknown) => {
  try {
    fn();
    return "ok";
  } catch (e) {
    return (e as BudgetError).code;
  }
};

describe("prices", () => {
  test("llm cost splits cached and fresh input tokens", () => {
    assert.equal(
      llmCost(prices, "m1", { promptTokens: 1_000_000, completionTokens: 500_000, cachedTokens: 400_000 }),
      2.64,
    );
  });
  test("an unknown model uses the default price", () => {
    assert.equal(llmCost(prices, "other", { promptTokens: 1_000_000, completionTokens: 0 }), 2);
  });
  test("page and token costs", () => {
    assert.equal(pageCost(prices, "ocr_pages", 10), 0.015);
    assert.throws(() => pageCost(prices, "parse_layout", 1));
    assert.equal(tokenCost(prices, "describe_figure", 1_000_000, 1_000_000), 2.8);
  });
});

describe("cache key", () => {
  const base = { docSha256: doc.sha256, tool: "ocr_pages", version: "v2", pages: [3, 1, 2] };
  test("page order and duplicates do not change the key", () => {
    assert.equal(cacheKey(base), cacheKey({ ...base, pages: [1, 2, 3, 3] }));
  });
  test("tool, version, pages and question change the key", () => {
    const k = cacheKey(base);
    for (const v of [{ tool: "parse_layout" }, { version: "v3" }, { pages: [1, 2] }, { question: "what?" }])
      assert.notEqual(cacheKey({ ...base, ...v }), k);
  });
});

describe("tokens", () => {
  test("a created token authenticates its job; wrong, missing and revoked tokens do not", () => {
    const r = registry();
    const { token } = r.create({ jobId: "j1", docs: [doc], budgetUsd: 1, allowCloudTools: true });
    assert.equal(r.authenticate(`Bearer ${token}`).jobId, "j1");
    assert.equal(
      codeOf(() => r.authenticate(null)),
      "unauthorized",
    );
    assert.equal(
      codeOf(() => r.authenticate("Bearer nope")),
      "unauthorized",
    );
    r.revoke("j1");
    assert.equal(
      codeOf(() => r.authenticate(`Bearer ${token}`)),
      "unauthorized",
    );
  });
  test("an active job id cannot be registered twice; bad ids are refused", () => {
    const r = registry();
    r.create({ jobId: "j1", docs: [], budgetUsd: 1, allowCloudTools: true });
    assert.equal(
      codeOf(() => r.create({ jobId: "j1", docs: [], budgetUsd: 1, allowCloudTools: true })),
      "bad_request",
    );
    assert.equal(
      codeOf(() => r.create({ jobId: "../x", docs: [], budgetUsd: 1, allowCloudTools: true })),
      "bad_request",
    );
  });
  test("safeEqual", () => {
    assert.equal(safeEqual("a", "a"), true);
    assert.equal(safeEqual("a", "b"), false);
  });
});

describe("budget", () => {
  test("llm calls are refused once spend reaches the budget", async () => {
    const r = registry();
    r.create({ jobId: "j1", docs: [doc], budgetUsd: 0.01, allowCloudTools: true });
    const job = r.get("j1")!;
    r.assertCanCallLlm(job);
    await r.record(job, { kind: "llm", model: "m1", usd: 0.01, durationMs: 5 });
    assert.equal(
      codeOf(() => r.assertCanCallLlm(job)),
      "budget_exceeded",
    );
  });
  test("a tool reservation that passes the budget is refused", async () => {
    const r = registry();
    r.create({ jobId: "j1", docs: [doc], budgetUsd: 0.01, allowCloudTools: true });
    const job = r.get("j1")!;
    r.reserve(job, 0.006);
    assert.equal(
      codeOf(() => r.reserve(job, 0.006)),
      "budget_exceeded",
    );
    await r.settle(job, 0.006, { kind: "tool", tool: "ocr_pages", usd: 0.003, durationMs: 1 });
    assert.equal(r.left(job), 0.007);
  });
  test("documents and cloud permission are checked", () => {
    const r = registry();
    r.create({ jobId: "j1", docs: [doc], budgetUsd: 1, allowCloudTools: false });
    const job = r.get("j1")!;
    assert.equal(r.doc(job, "contract.pdf").sha256, doc.sha256.toLowerCase());
    assert.equal(
      codeOf(() => r.doc(job, "other.pdf")),
      "forbidden",
    );
    assert.equal(
      codeOf(() => r.assertCloudAllowed(job)),
      "forbidden",
    );
  });
  test("every call is appended to jobs/<id>/broker.jsonl", async () => {
    const dir = await mkdtemp(join(tmpdir(), "budget-"));
    const r = registry(dir);
    r.create({ jobId: "j1", docs: [doc], budgetUsd: 1, allowCloudTools: true });
    const job = r.get("j1")!;
    await r.record(job, { kind: "llm", model: "m1", usd: 0.1, durationMs: 3 });
    await r.record(job, { kind: "tool", tool: "ocr_pages", usd: 0, durationMs: 2, cacheHit: true });
    const lines = (await readFile(join(dir, "j1", "broker.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.equal(lines[1].cacheHit, true);
    assert.equal(r.summary(job).spentUsd, 0.1);
  });
});
