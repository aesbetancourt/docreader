#!/usr/bin/env python3
"""Advisory source check. Reads the sources the agent listed and labels each one.

It never changes the answer. Labels:
  checked        the quote or values are in the document at that place
  moved          the quote is in the document, but on another page or place
  located        the place exists; nothing was given to compare
  not found      the quote or values are not there
  not checkable  a fact read from an image by a model
  error          the source could not be read

Usage: check_sources.py <sources.json> <in_dir> <enriched_dir>   (JSON report on stdout)
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
import unicodedata
from pathlib import Path

QUOTES = dict.fromkeys(map(ord, "\u2018\u2019\u201a\u201b\u2032`\u00b4"), "'")
QUOTES.update(dict.fromkeys(map(ord, "\u201c\u201d\u201e\u201f\u2033\u00ab\u00bb"), '"'))
QUOTES.update(dict.fromkeys(map(ord, "\u2010\u2011\u2012\u2013\u2014\u2015\u2212"), "-"))
QUOTES.update(dict.fromkeys(map(ord, "\u00ad\u200b\u200c\u200d\u2060\ufeff"), None))


def norm(s: object) -> str:
    t = unicodedata.normalize("NFKC", str(s)).translate(QUOTES).lower()
    return re.sub(r"\s+", " ", t).strip()


def as_number(v: object) -> float | None:
    if isinstance(v, bool) or v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    t = str(v).strip().replace("\u00a0", "").replace(" ", "")
    for cand in (t.replace(",", ""), t.replace(".", "").replace(",", ".")):
        try:
            return float(cand)
        except ValueError:
            pass
    return None


def same_date(a: object, b: object) -> bool:
    """A cell date-time 2026-01-13T00:00:00 matches the value 2026-01-13."""
    sa, sb = str(a), str(b)
    return bool(re.match(r"\d{4}-\d{2}-\d{2}", sa)) and sa[:10] == sb[:10] and len(sb) >= 10


def value_in(v: object, cells: list) -> bool:
    if v is None or v == "":
        return True  # an empty cell the agent copied: nothing to check
    n = as_number(v)
    for c in cells:
        if c is None:
            continue
        if hasattr(c, "isoformat"):
            c = c.isoformat()
        if norm(c) == norm(v) or same_date(c, v):
            return True
        m = as_number(c)
        if n is not None and m is not None and abs(n - m) <= 1e-9 * max(1.0, abs(n)):
            return True
    return False


# ------------------------------------------------------------------ readers (cached)

_pdf: dict[str, list[str]] = {}


def pdf_pages(path: Path) -> list[str]:
    if str(path) not in _pdf:
        out = subprocess.run(["pdftotext", "-layout", "-enc", "UTF-8", str(path), "-"], capture_output=True, text=True, errors="replace").stdout
        _pdf[str(path)] = out.split("\f")
    return _pdf[str(path)]


def enriched_page_text(enriched: Path, doc: str, page: int) -> str:
    n = f"{page:04d}"
    base = enriched / doc
    parts = [base / "ocr" / f"{n}.txt", base / "layout" / f"{n}.md"]
    parts += sorted((base / "layout" / f"{n}.tables").glob("*.csv")) if (base / "layout" / f"{n}.tables").is_dir() else []
    return "\n".join(p.read_text(errors="replace") for p in parts if p.is_file())


def enriched_pages(enriched: Path, doc: str) -> set[int]:
    pages = set()
    for p in (enriched / doc).glob("*/*"):
        m = re.match(r"(\d{4})", p.name)
        if m:
            pages.add(int(m.group(1)))
    return pages


_books: dict = {}


def workbook(path: Path):
    import openpyxl

    if str(path) not in _books:
        _books[str(path)] = openpyxl.load_workbook(path, data_only=True)
    return _books[str(path)]


def docx_text(path: Path) -> str:
    import docx

    d = docx.Document(str(path))
    parts = [p.text for p in d.paragraphs]
    for t in d.tables:
        for row in t.rows:
            parts.append(" | ".join(c.text for c in row.cells))
    return "\n".join(parts)


# ------------------------------------------------------------------ checks


def check_pdf(src: dict, path: Path, enriched: Path) -> tuple[str, str]:
    if src.get("figure"):
        return "not checkable", "read from an image by a model"
    quote = src.get("quote")
    if not quote:
        return "located", "no quote given"
    q = norm(quote)
    pages = pdf_pages(path)
    page = src.get("page")
    texts = {i + 1: t for i, t in enumerate(pages)}
    for p in enriched_pages(enriched, src["doc"]):
        texts[p] = texts.get(p, "") + "\n" + enriched_page_text(enriched, src["doc"], p)
    if isinstance(page, int) and q in norm(texts.get(page, "")):
        return "checked", f"page {page}"
    hits = [p for p, t in sorted(texts.items()) if q in norm(t)]
    if hits:
        return "moved", f"found on page {hits[0]}" + (f", not page {page}" if page else "")
    return "not found", "quote not in the text layer or in the OCR/layout output"


def check_xlsx(src: dict, path: Path) -> tuple[str, str]:
    from openpyxl.utils.cell import range_boundaries

    wb = workbook(path)
    sheet = src.get("sheet")
    if sheet and sheet not in wb.sheetnames:
        return "not found", f'no sheet "{sheet}"'
    sheets = [wb[sheet]] if sheet else wb.worksheets
    rng = src.get("range")
    cells: list = []
    for ws in sheets:
        if rng:
            c1, r1, c2, r2 = range_boundaries(str(rng).replace("$", ""))
            rows = ws.iter_rows(min_row=r1, max_row=r2, min_col=c1, max_col=c2, values_only=True)
        else:
            rows = ws.iter_rows(values_only=True)
        cells += [c for row in rows for c in row]
    where = f"{sheet or 'workbook'}{'!' + str(rng) if rng else ''}"
    values = src.get("values")
    quote = src.get("quote")
    if values:
        values = values if isinstance(values, list) else [values]
        missing = [v for v in values if not value_in(v, cells)]
        if missing:
            return "not found", f"{where}: not in the cells: {json.dumps(missing, ensure_ascii=False)[:200]}"
        return "checked", where
    if quote:
        joined = norm(" ".join(str(c) for c in cells if c is not None))
        return ("checked", where) if norm(quote) in joined else ("not found", f"{where}: quote not in the cells")
    if any(c not in (None, "") for c in cells):
        return "located", f"{where} (no values given to compare)"
    return "not found", f"{where} is empty"


def check_text(src: dict, text: str) -> tuple[str, str]:
    quote = src.get("quote")
    if not quote:
        return "located", "no quote given"
    return ("checked", "") if norm(quote) in norm(text) else ("not found", "quote not in the document")


def check(src: dict, in_dir: Path, enriched: Path) -> tuple[str, str]:
    doc = src.get("doc")
    if not isinstance(doc, str) or "/" in doc or not (in_dir / doc).is_file():
        return "error", f"unknown document {doc!r}"
    path = in_dir / doc
    ext = path.suffix.lower()
    if src.get("figure"):
        return "not checkable", "read from an image by a model"
    if ext == ".pdf":
        return check_pdf(src, path, enriched)
    if ext in (".xlsx", ".xlsm"):
        return check_xlsx(src, path)
    if ext == ".docx":
        return check_text(src, docx_text(path))
    return check_text(src, path.read_text(errors="replace"))


def main() -> None:
    sources_path, in_dir, enriched = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
    try:
        sources = json.loads(sources_path.read_text())
    except (OSError, ValueError) as e:
        json.dump({"error": f"cannot read sources: {e}", "sources": []}, sys.stdout)
        return
    if isinstance(sources, dict):
        sources = sources.get("sources", [])
    report = []
    for src in sources if isinstance(sources, list) else []:
        if not isinstance(src, dict):
            continue
        try:
            status, detail = check(src, in_dir, enriched)
        except Exception as e:  # noqa: BLE001 - advisory: report, never fail
            status, detail = "error", f"{type(e).__name__}: {e}"
        report.append({**src, "check": {"status": status, "detail": detail}})
    json.dump({"sources": report}, sys.stdout, ensure_ascii=False, default=str)


if __name__ == "__main__":
    main()
