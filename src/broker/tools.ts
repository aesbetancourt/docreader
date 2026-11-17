// Paid tools: ocr_pages, parse_layout, describe_figure. The broker checks the doc, the budget and the cache.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join, normalize } from "node:path";
import { PDFDocument } from "pdf-lib";
import { AGENT_PATHS, JOB_FILES, MAX_PAGES_PER_TOOL_CALL, TOOLS } from "../shared/constants.ts";
import { run } from "../shared/process.ts";
import { BudgetError, cacheKey, round, tokenCost, type JobRegistry, type JobState, type Prices } from "./budget.ts";

/** Resolution for page images sent to the vision model. */
const RENDER_DPI = 150;

const PDF_MIME = "application/pdf";
/** Images that Document AI reads; the vision model takes the first three. */
const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
};
const VISION_MIME = new Set(["image/png", "image/jpeg", "image/webp"]);
/** Largest image the agent can send to the vision model. */
const MAX_FIGURE_IMAGE_BYTES = 15 * 1024 * 1024;
/** enriched/ folder for figure answers about an image that is not tied to one document. */
const FIGURES_WITHOUT_DOC = "_images";

export interface GoogleConfig {
  project: string;
  docaiLocation: string;
  ocrProcessorId: string;
  layoutProcessorId: string;
  vertexLocation: string;
  geminiModel: string;
}

export interface OcrPageOut {
  text: string;
  confidence: number | null;
  blocks: { text: string; confidence: number | null }[];
}

export interface LayoutPageOut {
  markdown: string;
  tables: string[][][];
  figures: { caption?: string; text?: string }[];
}

/** `content` is a PDF or one image, with its MIME type. Results come back one per page. */
export interface GoogleClients {
  ocr(content: Uint8Array, mimeType: string, cfg: GoogleConfig, version: string): Promise<OcrPageOut[]>;
  layout(
    content: Uint8Array,
    mimeType: string,
    cfg: GoogleConfig,
    version: string,
    pages: number,
  ): Promise<LayoutPageOut[]>;
  vision(
    image: Uint8Array,
    mimeType: string,
    question: string,
    cfg: GoogleConfig,
  ): Promise<{ answer: string; inputTokens: number; outputTokens: number }>;
}

export interface ToolContext {
  job: JobState;
  registry: JobRegistry;
  prices: Prices;
  jobsDir: string;
  cacheDir: string;
  google?: GoogleConfig;
  /** Test seam: replaces the Google calls. */
  clients?: Partial<GoogleClients>;
}

const pageName = (page: number) => String(page).padStart(4, "0");

// ------------------------------------------------------------------ shared checks

interface CheckedDoc {
  name: string;
  sha256: string;
  path: string;
  bytes: Uint8Array;
  mimeType: string;
}

/** The doc belongs to this job: name and sha256 match the registered input. */
async function checkDoc(ctx: ToolContext, name: string): Promise<CheckedDoc> {
  const doc = ctx.registry.doc(ctx.job, name);
  const path = join(ctx.jobsDir, ctx.job.jobId, "in", name);
  if (!existsSync(path)) throw new BudgetError(`document "${name}" is missing from the job input`, "forbidden");
  const bytes = new Uint8Array(await readFile(path));
  const sha = createHash("sha256").update(bytes).digest("hex");
  if (sha !== doc.sha256) throw new BudgetError(`document "${name}" does not match the registered sha256`, "forbidden");
  const ext = extname(name).toLowerCase();
  const mimeType = ext === ".pdf" ? PDF_MIME : IMAGE_MIME[ext];
  if (!mimeType)
    throw new BudgetError(
      `this tool reads PDF and image files, not ${ext || "this file"}; read it with local tools or convert it to PDF first`,
      "bad_request",
    );
  return { name, sha256: sha, path, bytes, mimeType };
}

/** Pages in a PDF; an image is one page. */
async function pageCount(doc: CheckedDoc): Promise<number> {
  if (doc.mimeType !== PDF_MIME) return 1;
  try {
    return (await PDFDocument.load(doc.bytes, { ignoreEncryption: true, updateMetadata: false })).getPageCount();
  } catch {
    throw new BudgetError(`cannot read ${doc.name} as a PDF`, "bad_request");
  }
}

/** Sorted, unique, in range, at most MAX_PAGES_PER_TOOL_CALL. */
function checkPages(pages: number[], count: number): number[] {
  const out = [...new Set(pages)].toSorted((a, b) => a - b);
  if (out.length === 0) throw new BudgetError("give at least one page", "bad_request");
  if (out.length > MAX_PAGES_PER_TOOL_CALL)
    throw new BudgetError(`at most ${MAX_PAGES_PER_TOOL_CALL} pages per call; you gave ${out.length}`, "bad_request");
  const bad = out.filter((p) => !Number.isInteger(p) || p < 1 || p > count);
  if (bad.length) throw new BudgetError(`pages out of range 1..${count}: ${bad.join(", ")}`, "bad_request");
  return out;
}

/** Cuts the requested pages into a small PDF before sending it to Google. */
async function cutPdf(bytes: Uint8Array, pages: number[]): Promise<Uint8Array> {
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const out = await PDFDocument.create();
  for (const page of await out.copyPages(
    src,
    pages.map((p) => p - 1),
  ))
    out.addPage(page);
  return out.save();
}

/** The image the vision model sees: a rendered PDF page, or the image file itself. */
async function pageImage(doc: CheckedDoc, page: number): Promise<{ image: Uint8Array; mimeType: string }> {
  if (doc.mimeType !== PDF_MIME) {
    if (!VISION_MIME.has(doc.mimeType))
      throw new BudgetError(`the vision model reads PNG, JPEG or WebP images, not ${doc.mimeType}`, "bad_request");
    return { image: doc.bytes, mimeType: doc.mimeType };
  }
  const dir = await mkdtemp(join(tmpdir(), "page-"));
  try {
    const r = await run("pdftoppm", [
      "-r",
      String(RENDER_DPI),
      "-png",
      "-singlefile",
      "-f",
      String(page),
      "-l",
      String(page),
      doc.path,
      join(dir, "p"),
    ]);
    if (r.code !== 0) throw new Error(`pdftoppm failed: ${r.stderr.slice(0, 200)}`);
    return { image: new Uint8Array(await readFile(join(dir, "p.png"))), mimeType: "image/png" };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function requireGoogle(ctx: ToolContext): GoogleConfig {
  if (!ctx.google)
    throw new BudgetError("cloud tools are not configured in the broker (GCP settings are missing)", "forbidden");
  return ctx.google;
}

function priceOf(ctx: ToolContext, tool: string) {
  const p = ctx.prices.tools[tool];
  if (!p) throw new Error(`no price for ${tool} in config/prices.json`);
  return p;
}

// ------------------------------------------------------------------ cache

function cacheEntry(ctx: ToolContext, parts: Parameters<typeof cacheKey>[0]): string {
  return join(ctx.cacheDir, parts.tool, cacheKey(parts));
}

async function writeCache(entry: string, files: Record<string, string>): Promise<void> {
  const tmp = `${entry}.tmp-${process.pid}-${Date.now()}`;
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(dirname(join(tmp, rel)), { recursive: true });
    await writeFile(join(tmp, rel), content);
  }
  await rm(entry, { recursive: true, force: true });
  await mkdir(dirname(entry), { recursive: true });
  await rename(tmp, entry);
}

async function listFiles(dir: string, base = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(join(dir, base), { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    out.push(...(e.isDirectory() ? await listFiles(dir, rel) : [rel]));
  }
  return out;
}

/** Host path of a file under jobs/<id>/enriched/. */
const enrichedPath = (ctx: ToolContext, rel: string) => join(ctx.jobsDir, ctx.job.jobId, JOB_FILES.enriched, rel);

/** Copies a cache entry into jobs/<id>/enriched/<doc>/. Returns paths relative to enriched/. */
async function publish(ctx: ToolContext, doc: string, entry: string): Promise<string[]> {
  const target = enrichedPath(ctx, doc);
  const files = await listFiles(entry);
  for (const rel of files) {
    await mkdir(dirname(join(target, rel)), { recursive: true });
    await cp(join(entry, rel), join(target, rel));
  }
  return files.map((rel) => `${doc}/${rel}`);
}

const csvCell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

function toCsv(rows: string[][]): string {
  return rows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
}

// ------------------------------------------------------------------ per-page flow

/** Doc check, page caps, per-page cache, budget reservation, one Google call for the missing pages, call log. */
async function pageTool(
  ctx: ToolContext,
  tool: string,
  docName: string,
  requested: number[],
  call: (
    content: Uint8Array,
    mimeType: string,
    pages: number[],
    version: string,
  ) => Promise<Map<number, Record<string, string>>>,
) {
  const started = performance.now();
  const doc = await checkDoc(ctx, docName);
  ctx.registry.assertCloudAllowed(ctx.job);
  const pages = checkPages(requested, await pageCount(doc));
  const price = priceOf(ctx, tool);
  const version = price.processorVersion ?? "default";
  const entries = new Map(pages.map((p) => [p, cacheEntry(ctx, { docSha256: doc.sha256, tool, version, pages: [p] })]));
  const missing = pages.filter((p) => !existsSync(entries.get(p)!));
  const estimate = round((price.perPage ?? 0) * missing.length);
  if (missing.length) ctx.registry.reserve(ctx.job, estimate);
  const log = { kind: "tool" as const, tool, doc: doc.name, pages, input: { doc: doc.name, pages: requested } };
  try {
    if (missing.length) {
      // A PDF is cut to the missing pages before it leaves the machine; an image is sent as it is.
      const content = doc.mimeType === PDF_MIME ? await cutPdf(doc.bytes, missing) : doc.bytes;
      const files = await call(content, doc.mimeType, missing, version);
      for (const p of missing) {
        const f = files.get(p);
        if (!f) throw new Error(`${tool} returned no output for page ${p}`);
        await writeCache(entries.get(p)!, f);
      }
    }
    const wrote: string[] = [];
    for (const p of pages) wrote.push(...(await publish(ctx, doc.name, entries.get(p)!)));
    await ctx.registry.settle(ctx.job, missing.length ? estimate : 0, {
      ...log,
      usd: estimate,
      durationMs: Math.round(performance.now() - started),
      cacheHit: missing.length === 0,
      wrote,
    });
    return {
      pages,
      cachedPages: pages.filter((p) => !missing.includes(p)),
      wrote,
      usd: estimate,
      budgetLeftUsd: ctx.registry.left(ctx.job),
    };
  } catch (e) {
    await ctx.registry.settle(ctx.job, missing.length ? estimate : 0, {
      ...log,
      usd: 0,
      durationMs: Math.round(performance.now() - started),
      error: (e as Error).message,
    });
    throw e;
  }
}

// ------------------------------------------------------------------ tools

export async function ocrPages(ctx: ToolContext, input: { doc: string; pages: number[] }) {
  const cfg = requireGoogle(ctx);
  const ocr = ctx.clients?.ocr ?? (await import("./google.ts")).googleClients.ocr;
  const confidences: number[] = [];
  const res = await pageTool(ctx, TOOLS.ocr, input.doc, input.pages, async (content, mimeType, pages, version) => {
    const out = await ocr(content, mimeType, cfg, version);
    if (out.length !== pages.length) throw new Error(`OCR returned ${out.length} pages for ${pages.length} requested`);
    return new Map(
      pages.map((p, i) => {
        const r = out[i]!;
        return [
          p,
          {
            [`ocr/${pageName(p)}.txt`]: r.text,
            [`ocr/${pageName(p)}.json`]: JSON.stringify(
              { page: p, confidence: r.confidence, processorVersion: version, blocks: r.blocks },
              null,
              2,
            ),
          },
        ];
      }),
    );
  });
  for (const file of res.wrote.filter((w) => w.endsWith(".json"))) {
    const meta = JSON.parse(await readFile(enrichedPath(ctx, file), "utf8")) as { confidence: number | null };
    if (typeof meta.confidence === "number") confidences.push(meta.confidence);
  }
  return {
    pages: res.pages,
    cachedPages: res.cachedPages,
    meanConfidence: confidences.length
      ? Math.round((confidences.reduce((a, b) => a + b, 0) / confidences.length) * 1000) / 1000
      : null,
    paths: res.pages.map((p) => `${AGENT_PATHS.enriched}/${input.doc}/ocr/${pageName(p)}.txt`),
    usd: res.usd,
    budgetLeftUsd: res.budgetLeftUsd,
  };
}

export async function parseLayout(ctx: ToolContext, input: { doc: string; pages: number[] }) {
  const cfg = requireGoogle(ctx);
  const layout = ctx.clients?.layout ?? (await import("./google.ts")).googleClients.layout;
  const res = await pageTool(ctx, TOOLS.layout, input.doc, input.pages, async (content, mimeType, pages, version) => {
    const out = await layout(content, mimeType, cfg, version, pages.length);
    return new Map(
      pages.map((p, i) => {
        const r = out[i] ?? { markdown: "", tables: [], figures: [] };
        const n = pageName(p);
        const files: Record<string, string> = {
          [`layout/${n}.md`]: r.markdown,
          [`layout/${n}.figures.json`]: JSON.stringify(r.figures, null, 2),
        };
        r.tables.forEach((t, k) => (files[`layout/${n}.tables/t${k + 1}.csv`] = toCsv(t)));
        return [p, files];
      }),
    );
  });
  const tables = res.wrote.filter((w) => w.includes(".tables/")).map((w) => `${AGENT_PATHS.enriched}/${w}`);
  let figuresFound = 0;
  for (const file of res.wrote.filter((w) => w.endsWith(".figures.json"))) {
    figuresFound += (JSON.parse(await readFile(enrichedPath(ctx, file), "utf8")) as unknown[]).length;
  }
  return {
    pages: res.pages,
    cachedPages: res.cachedPages,
    tablesFound: tables.length,
    figuresFound,
    paths: { markdown: res.pages.map((p) => `${AGENT_PATHS.enriched}/${input.doc}/layout/${pageName(p)}.md`), tables },
    usd: res.usd,
    budgetLeftUsd: res.budgetLeftUsd,
  };
}

export interface FigureInput {
  question: string;
  /** A document page, rendered by the broker... */
  doc?: string;
  page?: number;
  /** ...or an image the agent made under /out, for example a crop of one chart. */
  image?: string;
}

/** Reads an image the agent saved in its own output folder. Nothing outside that folder. */
async function agentImage(
  ctx: ToolContext,
  agentPath: string,
): Promise<{ bytes: Uint8Array; mimeType: string; sha256: string }> {
  const prefix = `${AGENT_PATHS.output}/`;
  const rel = agentPath.startsWith(prefix) ? normalize(agentPath.slice(prefix.length)) : "";
  if (!rel || rel.startsWith("..") || isAbsolute(rel))
    throw new BudgetError(`image must be a file under ${prefix}, for example ${prefix}chart.png`, "bad_request");
  const mimeType = IMAGE_MIME[extname(rel).toLowerCase()];
  if (!mimeType || !VISION_MIME.has(mimeType))
    throw new BudgetError("image must be a PNG, JPEG or WebP file", "bad_request");
  const full = join(ctx.jobsDir, ctx.job.jobId, JOB_FILES.output, rel);
  if (!existsSync(full)) throw new BudgetError(`${agentPath} does not exist`, "bad_request");
  const bytes = new Uint8Array(await readFile(full));
  if (bytes.byteLength > MAX_FIGURE_IMAGE_BYTES)
    throw new BudgetError(
      `image is larger than ${MAX_FIGURE_IMAGE_BYTES / 1024 / 1024} MB; crop or scale it down`,
      "bad_request",
    );
  return { bytes, mimeType, sha256: createHash("sha256").update(bytes).digest("hex") };
}

export async function describeFigure(ctx: ToolContext, input: FigureInput) {
  const started = performance.now();
  const cfg = requireGoogle(ctx);
  ctx.registry.assertCloudAllowed(ctx.job);
  const question = input.question.trim();
  if (!question) throw new BudgetError("give a precise question", "bad_request");

  // What the model will look at, and a stable identity for the cache.
  let source: {
    label: string;
    folder: string;
    sha256: string;
    page: number;
    load: () => Promise<{ image: Uint8Array; mimeType: string }>;
  };
  if (input.image) {
    const img = await agentImage(ctx, input.image);
    const folder = input.doc ? (await checkDoc(ctx, input.doc)).name : FIGURES_WITHOUT_DOC;
    source = {
      label: input.image,
      folder,
      sha256: img.sha256,
      page: 0,
      load: async () => ({ image: img.bytes, mimeType: img.mimeType }),
    };
  } else {
    if (!input.doc || input.page === undefined) throw new BudgetError("give doc and page, or image", "bad_request");
    const doc = await checkDoc(ctx, input.doc);
    const count = await pageCount(doc);
    const page = input.page;
    if (!Number.isInteger(page) || page < 1 || page > count)
      throw new BudgetError(`page must be in 1..${count}`, "bad_request");
    source = { label: doc.name, folder: doc.name, sha256: doc.sha256, page, load: () => pageImage(doc, page) };
  }

  const entry = cacheEntry(ctx, {
    docSha256: source.sha256,
    tool: TOOLS.figure,
    version: cfg.geminiModel,
    pages: [source.page],
    question,
  });
  const hash = entry.split("/").pop()!.slice(0, 12);
  const figureRef = source.page ? `${pageName(source.page)}-${hash}.json` : `image-${hash}.json`;
  const hit = existsSync(entry);
  const estimate = round(priceOf(ctx, TOOLS.figure).estimatePerCall ?? 0.01);
  if (!hit) ctx.registry.reserve(ctx.job, estimate);
  const log = {
    kind: "tool" as const,
    tool: TOOLS.figure,
    doc: source.label,
    pages: source.page ? [source.page] : [],
    input: { ...input, question },
  };
  let usd = 0;
  try {
    if (!hit) {
      const vision = ctx.clients?.vision ?? (await import("./google.ts")).googleClients.vision;
      const { image, mimeType } = await source.load();
      const r = await vision(image, mimeType, question, cfg);
      usd = tokenCost(ctx.prices, TOOLS.figure, r.inputTokens, r.outputTokens);
      await writeCache(entry, {
        [`figures/${figureRef}`]: JSON.stringify(
          { source: source.label, page: source.page || undefined, question, answer: r.answer, model: cfg.geminiModel },
          null,
          2,
        ),
      });
    }
    const wrote = await publish(ctx, source.folder, entry);
    await ctx.registry.settle(ctx.job, hit ? 0 : estimate, {
      ...log,
      usd,
      durationMs: Math.round(performance.now() - started),
      cacheHit: hit,
      wrote,
    });
    const saved = JSON.parse(await readFile(join(entry, "figures", figureRef), "utf8")) as { answer: string };
    return {
      answer: saved.answer,
      figureRef,
      path: `${AGENT_PATHS.enriched}/${source.folder}/figures/${figureRef}`,
      usd,
      budgetLeftUsd: ctx.registry.left(ctx.job),
    };
  } catch (e) {
    await ctx.registry.settle(ctx.job, hit ? 0 : estimate, {
      ...log,
      usd: 0,
      durationMs: Math.round(performance.now() - started),
      error: (e as Error).message,
    });
    throw e;
  }
}
