import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { buildPrompt } from "../src/agent/entrypoint.ts";
import { run } from "../src/shared/process.ts";
import type { Source } from "../src/shared/types.ts";

const ROOT = join(import.meta.dirname, "..");
const SAMPLES = join(ROOT, "samples");
/** The checker needs openpyxl and python-docx: use the repo venv when it exists. */
const PYTHON = existsSync(join(ROOT, ".venv/bin/python")) ? join(ROOT, ".venv/bin/python") : "python3";

async function check(sources: object[]): Promise<Source[]> {
  const dir = await mkdtemp(join(tmpdir(), "check-"));
  await mkdir(join(dir, "in"));
  await mkdir(join(dir, "enriched/invoice.pdf/ocr"), { recursive: true });
  for (const f of ["contract.pdf", "sales.xlsx", "memo.docx", "invoice.pdf"])
    await copyFile(join(SAMPLES, f), join(dir, "in", f));
  await writeFile(join(dir, "enriched/invoice.pdf/ocr/0002.txt"), "Total due: EUR 14,520.00\n");
  await writeFile(join(dir, "sources.json"), JSON.stringify(sources));
  const r = await run(PYTHON, [
    "-I",
    join(ROOT, "src/agent/check_sources.py"),
    join(dir, "sources.json"),
    join(dir, "in"),
    join(dir, "enriched"),
  ]);
  assert.equal(r.code, 0, r.stderr);
  return (JSON.parse(r.stdout) as { sources: Source[] }).sources;
}

const statuses = (s: Source[]) => s.map((x) => x.check?.status);

describe("source checker (advisory)", () => {
  test("labels PDF quotes: checked, moved, not found, OCR text", async () => {
    const r = await check([
      { doc: "contract.pdf", page: 3, quote: "ninety (90) days\u2019 written notice" },
      { doc: "contract.pdf", page: 1, quote: "ninety (90) days' written notice" },
      { doc: "contract.pdf", page: 1, quote: "a sentence that is not there" },
      { doc: "invoice.pdf", page: 2, quote: "Total due: EUR 14,520.00" },
    ]);
    assert.deepEqual(statuses(r), ["checked", "moved", "not found", "checked"]);
    assert.match(r[1]!.check!.detail, /page 3/);
  });

  test("labels spreadsheet cells, DOCX quotes, figures and unknown documents", async () => {
    const r = await check([
      { doc: "sales.xlsx", sheet: "Sales", range: "A3:D4", values: ["Month", "Region"] },
      { doc: "sales.xlsx", sheet: "Sales", range: "A3:D4", values: [123456] },
      { doc: "sales.xlsx", sheet: "Nope", range: "A1" },
      { doc: "memo.docx", quote: "The project owner is Dana Ruiz" },
      { doc: "contract.pdf", page: 2, figure: true },
      { doc: "missing.pdf", quote: "x" },
    ]);
    assert.deepEqual(statuses(r), ["checked", "not found", "not found", "checked", "not checkable", "error"]);
  });
});

describe("prompt", () => {
  const shared = "{{TASK}}|{{DOCUMENTS}}|{{BUDGET}}";
  test("ask: questions, documents, budget; local mode turns paid tools off", () => {
    const p = buildPrompt(
      shared,
      "Q:\n{{QUESTIONS}}",
      { mode: "ask", questions: ["A?", "B?"], budgetUsd: 1, allowCloudTools: false },
      "- `/in/a.pdf`",
    );
    assert.match(p, /^Q:\n1\. A\?\n2\. B\?\|- `\/in\/a\.pdf`\|\$1\.00/);
    assert.match(p, /Paid tools are turned off/);
  });
  test("convert: format name, extension, rules and user instructions", () => {
    const tpl = "{{FORMAT_NAME}} {{EXTENSION}}\n{{FORMAT_RULES}}\n{{INSTRUCTIONS}}";
    const md = buildPrompt(
      shared,
      tpl,
      {
        mode: "convert",
        questions: [],
        format: "markdown",
        instructions: "only tables",
        budgetUsd: 1,
        allowCloudTools: true,
      },
      "",
    );
    assert.match(md, /^Markdown \.md\n/);
    assert.match(md, /Markdown tables/);
    assert.match(md, /Instructions from the user:\n\nonly tables/);
    assert.match(
      buildPrompt(
        shared,
        tpl,
        { mode: "convert", questions: [], format: "json", budgetUsd: 1, allowCloudTools: true },
        "",
      ),
      /^JSON \.json\n/,
    );
  });
});
