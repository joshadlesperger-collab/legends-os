"""Audit retained manufacturer PDFs; preserve IDs and never infer print runs from odds."""
import collections
import hashlib
import json
import pathlib
import re
import unicodedata
import pdfplumber
from pypdf import PdfReader

ROOT = pathlib.Path(__file__).resolve().parents[1]
DATA = ROOT / "data/card-catalog"
catalog = json.loads((DATA / "topps-chrome-basketball-2025-26.json").read_text(encoding="utf-8"))
sources = ROOT / "artifacts/knowledge-graph/sources"
for source in catalog["sources"]:
    assert hashlib.sha256((sources / (source["kind"] + ".pdf")).read_bytes()).hexdigest() == source["sha256"], "Source revision requires new audit"

formats = [
    ("hobby", "HTA Hobby Distributor", 240.3, "chrome"),
    ("jumbo", "HTA Jumbo Distributor", 361.6, "chrome"),
    ("breaker", "HTA Breaker Distributor", 486.4, "chrome"),
    ("sapphire", "HTA Sapphire Distributor", 612.1, "sapphire"),
    ("value", "Value Box SE", 700.9, "chrome"),
    ("hanger", "Hanger Box", 788.0, "chrome"),
    ("mega", "Mega Box EA", 875.9, "chrome"),
    ("fanatics-pack", "Fanatics Bulk Pack", 978.3, "chrome"),
    ("fanatics-mega", "Fanatics Mega Box", 1080.0, "chrome"),
    ("refractor-box-set", "F12 Refractor Box Set", 1208.0, "chrome"),
]
mapped = []
with pdfplumber.open(sources / "odds.pdf") as pdf:
    for page_number, page in enumerate(pdf.pages, 1):
        assert page.width == 1224 and page.height == 792, "Unexpected PDF layout"
        words = page.extract_words()
        header = " ".join(w["text"] for w in words if 94 < w["top"] < 134)
        assert "SAPPHIRE" in header and "FANATICS" in header and "JUMBO" in header
        for table in page.find_tables():
            for row in table.rows:
                y0, y1 = row.bbox[1], row.bbox[3]
                ratios = [w for w in words if y0 <= (w["top"] + w["bottom"])/2 < y1 and re.fullmatch(r"\d+:\d+", w["text"])]
                if not ratios:
                    continue
                original = catalog["odds"][len(mapped)]
                assert original["sourcePage"] == page_number
                assert collections.Counter(w["text"] for w in ratios) == collections.Counter(original["ratios"])
                label = " ".join((page.crop((14, y0, 125, y1)).extract_text() or "").split())
                assert label == original["label"], (page_number, label, original["label"])
                cells = []
                for word in ratios:
                    fmt = min(formats, key=lambda f: abs(f[2]-word["x1"]))
                    assert abs(fmt[2]-word["x1"]) < 1, "Unknown numeric column"
                    numerator, denominator = map(int, word["text"].split(":"))
                    cells.append(dict(formatId=fmt[0], ratio=word["text"], numerator=numerator, denominator=denominator,
                        status="source-anomaly" if denominator == 0 else "transcribed", x1=round(word["x1"],2)))
                assert len({c["formatId"] for c in cells}) == len(cells)
                mapped.append(dict(oddsId=original["id"], label=label, sourcePage=page_number, bbox=list(row.bbox), cells=cells))
assert len(mapped) == len(catalog["odds"]) == 559

# Independent line-coverage check: every card-shaped manufacturer line must be accounted for.
printed = []
for page_number, page in enumerate(PdfReader(sources / "checklist.pdf").pages, 1):
    for line in page.extract_text().splitlines():
        line = unicodedata.normalize("NFC", line.strip())
        if re.match(r"^(\d+|[A-Z0-9]+-[A-Z0-9-]+) .+$", line):
            printed.append((page_number,line))
assert collections.Counter(printed) == collections.Counter((c["sourcePage"],c["raw"]) for c in catalog["cards"])

def norm(value):
    return re.sub(r"[^A-Z0-9]", "", value.upper())

sections = []
for section in dict.fromkeys(c["section"] for c in catalog["cards"]):
    # Only exact section labels are evidence of section-wide format presence.
    match_label = {"BASE CARDS":"Base", "BASE CARD VARIATIONS":"Base Variations"}.get(section, section)
    matches = [r for r in mapped if norm(r["label"]) == norm(match_label)]
    format_ids = sorted({cell["formatId"] for r in matches for cell in r["cells"] if cell["status"] == "transcribed"})
    sections.append(dict(section=section, entries=sum(c["section"] == section for c in catalog["cards"]),
        formatIds=format_ids, oddsIds=[r["oddsId"] for r in matches],
        editionStatus="sapphire-only-evidence" if format_ids == ["sapphire"] else "chrome-format-evidence" if format_ids and "sapphire" not in format_ids else "shared-format-evidence" if format_ids else "requires-review"))
audit = dict(version=1, productId=catalog["product"]["id"], auditedOn="2026-10-23", method="pdf-coordinate-audit-v1",
    sourceHashes={s["id"]:s["sha256"] for s in catalog["sources"]}, checklistRows=len(printed),
    baseCards=299, missingBaseNumbers=[226], sourceOmittedTeams=20,
    formats=[dict(id=f[0],label=f[1],edition=f[3]) for f in formats], oddsRows=mapped, sections=sections,
    findings=[dict(code="missing-base-226", status="source-omission", action="Do not invent a card."),
        dict(code="rock-stars-teams",status="source-omission",action="Retain null teams on 20 entries; player identity is complete."),
        dict(code="pulsar-1-to-0",status="requires-manufacturer-clarification",action="Preserve printed 1:0; never calculate probability from this cell."),
        dict(code="parallel-print-runs",status="requires-additional-source",action="Odds do not establish serial print runs or individual-card applicability.")],
    limitations=["Blank odds cells mean not stated in this document, not proof of absence.",
        "Combined checklist membership does not merge Chrome and Sapphire variants.",
        "Ratios are transcribed as printed; no universal pack-probability interpretation is inferred.",
        "Section joins use exact normalized labels only; unresolved joins remain held."])
(DATA / "topps-chrome-basketball-2025-26-audit.json").write_text(json.dumps(audit,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
print(json.dumps(dict(checklistRows=len(printed),oddsRows=len(mapped),mappedCells=sum(len(r["cells"]) for r in mapped),unmatchedSections=[s["section"] for s in sections if not s["formatIds"]])))
