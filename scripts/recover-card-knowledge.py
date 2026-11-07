"""Read archived evidence and official PDFs; never execute recovered code or modify a database.

Usage: python scripts/recover-card-knowledge.py
Requires pypdf and pdfplumber. Inputs live in artifacts/knowledge-graph/.
"""
import hashlib
import json
import pathlib
import re
import sqlite3
import unicodedata
from datetime import datetime, timezone
from pypdf import PdfReader
import pdfplumber

ROOT = pathlib.Path(__file__).resolve().parents[1]
WORK = ROOT / "artifacts/knowledge-graph"
OUT = ROOT / "data/card-catalog"
PRODUCT = "topps-chrome-basketball-2025-26"
URL = "https://cdn.shopify.com/s/files/1/0662/9749/5709/files/"

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def stable(*parts):
    return hashlib.sha256(json.dumps(parts, ensure_ascii=False).encode()).hexdigest()[:24]

def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

def main():
    sources = [dict(id="topps-chrome-2025-26-" + kind, kind=kind,
        url=URL + filename, sha256=digest(WORK / "sources" / (kind + ".pdf")),
        retrievedAt=datetime.fromtimestamp((WORK / "sources" / (kind + ".pdf")).stat().st_mtime, timezone.utc).isoformat().replace("+00:00", "Z"), publisher="Topps")
        for kind, filename in [("checklist", "2025-26_Topps_Chrome_Basketball_Checklist.pdf?v=1787956981"),
                               ("odds", "2025-26_Topps_Chrome_Basketball_Odds.pdf?v=1787958983")]]
    # Preserve printed team names and player names. No alias merging across releases.
    teams = "Atlanta Hawks|Boston Celtics|Brooklyn Nets|Charlotte Hornets|Chicago Bulls|Cleveland Cavaliers|Dallas Mavericks|Denver Nuggets|Detroit Pistons|Golden State Warriors|Houston Rockets|Indiana Pacers|Los Angeles Clippers|Los Angeles Lakers|Memphis Grizzlies|Miami Heat|Milwaukee Bucks|Minnesota Timberwolves|New Orleans Pelicans|New York Knicks|Oklahoma City Thunder|Orlando Magic|Philadelphia 76ers|Phoenix Suns|Portland Trail Blazers|Portland Trailblazers|Sacramento Kings|San Antonio Spurs|Toronto Raptors|Utah Jazz|Washington Wizards|New Jersey Nets|Seattle SuperSonics|Seattle Supersonics".split("|")
    team_pattern = re.compile(r"^(.*?) (" + "|".join(re.escape(t) for t in teams) + r")(?: (Rookie))?$", re.I)
    cards, unresolved = [], []
    category, section = "BASE", "BASE CARDS"
    for page, pdf_page in enumerate(PdfReader(WORK / "sources/checklist.pdf").pages, 1):
        for line in pdf_page.extract_text().splitlines():
            line = unicodedata.normalize("NFC", line.strip())
            if not line:
                continue
            if line in {"BASE", "INSERT", "AUTOGRAPH", "RELIC", "AUTOGRAPH RELIC"}:
                category = line
                continue
            match = re.match(r"^(\d+|[A-Z0-9]+-[A-Z0-9-]+) (.+)$", line)
            if not match:
                if line == line.upper():
                    section = line
                else:
                    unresolved.append(dict(page=page, raw=line, reason="Unparsed line"))
                continue
            number, body = match.groups()
            subject = team_pattern.match(body)
            if not subject and section == "ROCK STARS":
                rookie = body.endswith(" Rookie")
                player, team = body.removesuffix(" Rookie"), None
                unresolved.append(dict(page=page, raw=line, reason="Team is not supplied in the official checklist"))
            elif not subject:
                unresolved.append(dict(page=page, raw=line, reason="Subject/team requires review"))
                continue
            else:
                player, team, rookie = subject.groups()
            cards.append(dict(id=stable(PRODUCT, section, number), productId=PRODUCT,
                section=section, category=category, cardNumber=number, player=player,
                subjectId=stable(PRODUCT, player.casefold()), team=team, rookie=bool(rookie),
                sourceId=sources[0]["id"], sourcePage=page, raw=line))
    assert len({c["id"] for c in cards}) == len(cards), "Duplicate checklist identities"
    base = [c for c in cards if c["section"] == "BASE CARDS"]
    assert len(base) == 299 and {int(c["cardNumber"]) for c in base} == set(range(1, 301)) - {226}
    # The odds PDF mixes formats, including Sapphire. Preserve full rows as evidence;
    # do not infer serial runs, per-card applicability or cross-format price ratios.
    odds = []
    with pdfplumber.open(WORK / "sources/odds.pdf") as pdf:
        for page, pdf_page in enumerate(pdf.pages, 1):
            for table in pdf_page.extract_tables():
                for row in table:
                    raw = " ".join(" ".join(cell.split()) for cell in row if cell)
                    match = re.match(r"^(.*?)\s+(\d+:\d+.*)$", raw)
                    if not match:
                        continue
                    # Wrapped labels can continue after numeric columns in extracted text.
                    label = " ".join(re.sub(r"\d+:\d+", "", raw).split())
                    odds.append(dict(id=stable(PRODUCT, page, len(odds), raw), label=label, raw=raw,
                        sourceId=sources[1]["id"], sourcePage=page,
                        ratios=re.findall(r"\d+:\d+", raw), formatMapping="requires-review"))
    assert odds, "No odds rows extracted"
    catalog = dict(version=1, product=dict(id=PRODUCT, name="2025-26 Topps Chrome Basketball",
        season="2025-26", printedYear=2025, manufacturer="Topps", sport="Basketball",
        expectedBaseCards=299, status="source-backed", productUrl="https://www.topps.com/products/2025-26-topps-chrome%C2%AE-basketball-hobby-box"),
        sources=sources, cards=cards, odds=odds, unresolved=unresolved,
        limitations=["Card 226 is absent from the official checklist; do not fabricate it.",
            "Subject IDs are product-scoped; cross-product player aliases need review.",
            "Odds rows include multiple formats; column mapping and serial print runs need review.",
            "Checklist entries do not prove ownership, condition or a physical card's parallel.",
            "No market sales or prices are inferred from checklist or odds data."])
    save(OUT / (PRODUCT + ".json"), catalog)
    db_path = WORK / "recovered/legends-pricing.sqlite"
    db = sqlite3.connect(db_path.as_uri() + "?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    assert db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    assert not db.execute("PRAGMA foreign_key_check").fetchall()
    tables = ["source_records", "card_variants", "inventory", "evidence_summaries", "market_observations", "price_recommendations", "listing_records", "pilot"]
    recovered = {name: [dict(row) for row in db.execute("SELECT * FROM " + name)] for name in tables}
    db.close()
    save(WORK / "recovered-records.json", dict(version=1, sourceSha256=digest(db_path), tables=recovered))
    summary = dict(version=1, recoveredAt="2026-10-23", sourceSha256=digest(db_path),
        counts={name: len(rows) for name, rows in recovered.items()},
        productGroups=[dict(season=k[0], product=k[1], candidateVariants=v) for k, v in sorted(
            __import__("collections").Counter((r["season"], r["product"]) for r in recovered["card_variants"]).items())],
        databaseApplied=False, liveStatusVerified=False,
        limitations=["Recovered historical records only; no new inventory created.", "Candidate variant groups and legacy prices remain unvalidated.", "No individual observations may be fabricated from aggregate summaries."])
    save(WORK / "recovery-summary.json", summary)
    print(json.dumps(dict(recovered=summary["counts"], checklist=len(cards), base=len(base), odds=len(odds), unresolved=len(unresolved))))

if __name__ == "__main__":
    main()
