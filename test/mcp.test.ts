import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, test } from "node:test";
import { PDFDocument } from "pdf-lib";
import { JobRegistry, type Prices } from "../src/broker/budget.ts";
import { expandTable } from "../src/broker/google.ts";
import { createMcpHandler } from "../src/broker/mcp.ts";
import type { GoogleClients } from "../src/broker/tools.ts";
import { TOOLS } from "../src/shared/constants.ts";

const prices: Prices = {
  asOf: "2026-11-15",
  llm: {},
  llmDefault: { inputPerMTok: 1, outputPerMTok: 1, source: "t" },
  tools: {
    [TOOLS.ocr]: { perPage: 0.0015, processorVersion: "ocr-v", source: "t" },
    [TOOLS.layout]: { perPage: 0.01, processorVersion: "lay-v", source: "t" },
    [TOOLS.figure]: { inputPerMTok: 0.3, outputPerMTok: 2.5, estimatePerCall: 0.005, source: "t" },
  },
};
const google = {
  project: "p",
  docaiLocation: "eu",
  ocrProcessorId: "o",
  layoutProcessorId: "l",
  vertexLocation: "global",
  geminiModel: "gemini-x",
};

let root = "";
let calls: { tool: string; pages: number; mimeType: string }[] = [];
const clients: GoogleClients = {
  async ocr(content, mimeType) {
    const n = mimeType === "application/pdf" ? (await PDFDocument.load(content)).getPageCount() : 1;
    calls.push({ tool: "ocr", pages: n, mimeType });
    return Array.from({ length: n }, (_, i) => ({ text: `ocr text ${i}`, confidence: 0.9, blocks: [] }));
  },
  async layout(_content, mimeType, _cfg, _v, pages) {
    calls.push({ tool: "layout", pages, mimeType });
    return Array.from({ length: pages }, () => ({
      markdown: "# T\n",
      tables: [
        [
          ["Item", "Rate"],
          ["A", "4.5"],
        ],
      ],
      figures: [{ text: "chart" }],
    }));
  },
  async vision(_image, mimeType) {
    calls.push({ tool: "vision", pages: 1, mimeType });
    return { answer: "42 units", inputTokens: 1000, outputTokens: 100 };
  },
};

async function setup(opts: { budgetUsd?: number; allowCloudTools?: boolean } = {}) {
  root = await mkdtemp(join(tmpdir(), "mcp-"));
  const pdf = await PDFDocument.create();
  for (let i = 0; i < 12; i++) pdf.addPage();
  const files: Record<string, Uint8Array> = {
    "scan.pdf": await pdf.save(),
    "photo.jpg": new TextEncoder().encode("jpeg bytes"),
    "notes.txt": new TextEncoder().encode("text"),
  };
  await mkdir(join(root, "jobs/j1/in"), { recursive: true });
  const docs = [];
  for (const [name, bytes] of Object.entries(files)) {
    await writeFile(join(root, "jobs/j1/in", name), bytes);
    docs.push({ name, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  const registry = new JobRegistry(prices, join(root, "jobs"));
  const { token } = registry.create({
    jobId: "j1",
    docs,
    budgetUsd: opts.budgetUsd ?? 1,
    allowCloudTools: opts.allowCloudTools ?? true,
  });
  const handler = createMcpHandler({
    registry,
    prices,
    jobsDir: join(root, "jobs"),
    cacheDir: join(root, "cache"),
    google,
    clients,
  });
  const job = registry.authenticate(`Bearer ${token}`);
  let id = 0;
  const rpc = async (method: string, params: unknown) => {
    const res = await handler(
      job,
      new Request("http://b/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      }),
    );
    return (await res.json()) as any;
  };
  const call = async (name: string, args: unknown) => {
    const r = await rpc("tools/call", { name, arguments: args });
    const text: string = r.result?.content?.[0]?.text ?? JSON.stringify(r.error);
    return { isError: !!r.result?.isError || !!r.error, text, json: () => JSON.parse(text) };
  };
  return { registry, job, rpc, call };
}

beforeEach(() => {
  calls = [];
});

describe("mcp tools", () => {
  test("tools/list shows the four tools with prices", async () => {
    const { rpc } = await setup();
    const tools = (await rpc("tools/list", {})).result.tools as { name: string; description: string }[];
    assert.deepEqual(
      tools.map((t) => t.name).toSorted(),
      [TOOLS.budget, TOOLS.figure, TOOLS.ocr, TOOLS.layout].toSorted(),
    );
    assert.match(tools.find((t) => t.name === TOOLS.ocr)!.description, /\$1\.50 per 1,000 pages/);
  });

  test("ocr_pages writes enriched files, charges, logs and caches per page", async () => {
    const { call, registry, job } = await setup();
    const r = await call(TOOLS.ocr, { doc: "scan.pdf", pages: [3, 2] });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.json().usd, 0.003);
    assert.equal(await readFile(join(root, "jobs/j1/enriched/scan.pdf/ocr/0003.txt"), "utf8"), "ocr text 1");
    const again = (await call(TOOLS.ocr, { doc: "scan.pdf", pages: [2, 3, 4] })).json();
    assert.deepEqual([again.usd, again.cachedPages], [0.0015, [2, 3]]);
    assert.deepEqual(
      calls.map((c) => c.pages),
      [2, 1],
    );
    assert.equal(registry.summary(job).toolsUsd, 0.0045);
    const log = (await readFile(join(root, "jobs/j1/broker.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.ok(log[0].wrote.includes("scan.pdf/ocr/0002.json"));
  });

  test("an image file is one page and is sent as it is", async () => {
    const { call } = await setup();
    const r = await call(TOOLS.ocr, { doc: "photo.jpg", pages: [1] });
    assert.equal(r.isError, false, r.text);
    assert.deepEqual(calls, [{ tool: "ocr", pages: 1, mimeType: "image/jpeg" }]);
    assert.match((await call(TOOLS.ocr, { doc: "photo.jpg", pages: [2] })).text, /out of range/);
  });

  test("other file types are refused with a hint", async () => {
    const { call } = await setup();
    assert.match((await call(TOOLS.ocr, { doc: "notes.txt", pages: [1] })).text, /PDF and image files/);
  });

  test("refusals: cloud off, unknown doc, changed doc, budget, page caps", async () => {
    const off = await setup({ allowCloudTools: false });
    assert.match((await off.call(TOOLS.ocr, { doc: "scan.pdf", pages: [1] })).text, /allowCloudTools=false/);
    const { call } = await setup({ budgetUsd: 0.004 });
    assert.match((await call(TOOLS.ocr, { doc: "other.pdf", pages: [1] })).text, /not part of this job/);
    assert.match((await call(TOOLS.ocr, { doc: "scan.pdf", pages: [1, 2, 3] })).text, /budget_exceeded/);
    assert.equal(
      (await call(TOOLS.ocr, { doc: "scan.pdf", pages: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] })).isError,
      true,
    );
    assert.match((await call(TOOLS.ocr, { doc: "scan.pdf", pages: [13] })).text, /out of range/);
    await writeFile(join(root, "jobs/j1/in/scan.pdf"), "changed");
    assert.match((await call(TOOLS.ocr, { doc: "scan.pdf", pages: [1] })).text, /does not match the registered sha256/);
    assert.deepEqual(calls, []);
  });

  test("parse_layout writes tables", async () => {
    const { call } = await setup();
    const r = (await call(TOOLS.layout, { doc: "scan.pdf", pages: [5] })).json();
    assert.deepEqual([r.tablesFound, r.figuresFound, r.usd], [1, 1, 0.01]);
    assert.equal(
      await readFile(join(root, "jobs/j1/enriched/scan.pdf/layout/0005.tables/t1.csv"), "utf8"),
      "Item,Rate\nA,4.5\n",
    );
  });

  test("describe_figure renders the PDF page, answers, and caches", async () => {
    const { call, registry, job } = await setup();
    const r = (await call(TOOLS.figure, { doc: "scan.pdf", page: 3, question: "Peak value?" })).json();
    assert.equal(r.answer, "42 units");
    assert.match(r.figureRef, /^0003-[0-9a-f]{12}\.json$/);
    assert.ok(existsSync(join(root, "jobs/j1/enriched/scan.pdf/figures", r.figureRef)));
    assert.deepEqual(calls, [{ tool: "vision", pages: 1, mimeType: "image/png" }]);
    assert.equal(registry.summary(job).toolsUsd, 0.00055);
    assert.equal((await call(TOOLS.figure, { doc: "scan.pdf", page: 3, question: "Peak value?" })).json().usd, 0);
  });

  test("describe_figure reads an image the agent cropped into /out, and nothing outside it", async () => {
    const { call } = await setup();
    await mkdir(join(root, "jobs/j1/out"), { recursive: true });
    await writeFile(join(root, "jobs/j1/out/chart.png"), "png bytes");
    const r = await call(TOOLS.figure, { image: "/out/chart.png", question: "Q3 value?" });
    assert.equal(r.isError, false, r.text);
    assert.match(r.json().figureRef, /^image-[0-9a-f]{12}\.json$/);
    assert.deepEqual(calls, [{ tool: "vision", pages: 1, mimeType: "image/png" }]);
    for (const image of ["/out/../in/scan.pdf", "/etc/passwd", "/out/missing.png", "/out/notes.txt"]) {
      assert.equal((await call(TOOLS.figure, { image, question: "x" })).isError, true, image);
    }
    assert.match((await call(TOOLS.figure, { question: "x" })).text, /give doc and page, or image/);
  });

  test("budget_status", async () => {
    const { call } = await setup();
    await call(TOOLS.ocr, { doc: "scan.pdf", pages: [1] });
    const s = (await call(TOOLS.budget, {})).json();
    assert.deepEqual([s.budgetUsd, s.spentUsd, s.toolCalls[0].tool], [1, 0.0015, TOOLS.ocr]);
  });
});

const cell = (text: string, rowSpan = 1, colSpan = 1) => ({ blocks: [{ textBlock: { text } }], rowSpan, colSpan });

describe("layout tables", () => {
  test("merged cells are repeated in every cell they cover", () => {
    assert.deepEqual(
      expandTable([
        { cells: [cell("Region", 2), cell("2025", 1, 2)] },
        { cells: [cell("H1"), cell("H2")] },
        { cells: [cell("North"), cell("10"), cell("12")] },
      ]),
      [
        ["Region", "2025", "2025"],
        ["Region", "H1", "H2"],
        ["North", "10", "12"],
      ],
    );
  });
});
