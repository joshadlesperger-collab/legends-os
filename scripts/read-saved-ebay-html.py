"""Offline inspection of user-provided HTML. No requests or script execution."""
import argparse
import hashlib
import html
import json
import re
import time
from collections import Counter
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path


class Node:
    def __init__(self, tag="", attrs=()):
        self.tag, self.attrs, self.children = tag, dict(attrs), []

    def text(self):
        if self.tag in {"script", "style", "svg", "template"}:
            return ""
        return " ".join(c.text() if isinstance(c, Node) else c for c in self.children)

    def all(self):
        yield self
        for child in self.children:
            if isinstance(child, Node):
                yield from child.all()

    def has_class(self, name):
        return name in (self.attrs.get("class") or "").split()


class Parser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = Node()
        self.stack = [self.root]

    def handle_starttag(self, tag, attrs):
        node = Node(tag, attrs)
        self.stack[-1].children.append(node)
        if tag not in {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        self.handle_endtag(tag)

    def handle_endtag(self, tag):
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i].tag == tag:
                del self.stack[i:]
                break

    def handle_data(self, data):
        self.stack[-1].children.append(data)


def clean(text):
    return re.sub(r"\s+", " ", text).strip()


def product(title):
    for pattern, group in [
        (r"2024[-/]?(2025|25)", "Other season"),
        (r"Nico Collins|Texans", "Other sport"),
        (r"McDonald", "McDonald's All-American"),
        (r"Cactus Jack", "Cactus Jack"),
        (r"Sapphire", "Chrome Update Sapphire" if re.search("Update", title, re.I) else "Sapphire — release unverified"),
        (r"Cosmic", "Chrome Cosmic"), (r"Chrome Black", "Chrome Black"), (r"Update", "Chrome Update")
    ]:
        if re.search(pattern, title, re.I):
            return group
    return "Chrome — release unverified"


def extract(source):
    parser = Parser()
    parser.feed(source)
    rows, ignored, duplicates = [], 0, 0
    seen = set()
    for card in parser.root.all():
        listing_id = card.attrs.get("data-listingid", "")
        if not listing_id or not re.fullmatch(r"\d+", listing_id):
            continue
        nodes = list(card.all())
        title_nodes = [n for n in nodes if n.has_class("s-card__title")]
        text = clean(card.text())
        sold = re.search(r"\bSold\s+([A-Za-z]{3}\s+\d{1,2},\s+\d{4})", text)
        if not title_nodes or not sold:
            ignored += 1
            continue
        if listing_id in seen:
            duplicates += 1
            continue
        seen.add(listing_id)
        title = clean(title_nodes[0].text()).replace("Opens in a new window or tab", "").removeprefix("NEW LISTING ").strip()
        links = [n.attrs.get("href", "") for n in nodes if n.tag == "a"]
        url = next((f"https://www.ebay.com/itm/{listing_id}" for link in links if re.match(rf"https://www\.ebay\.com/itm/{listing_id}(?:[/?#]|$)", link)), None)
        prices = [clean(n.text()) for n in nodes if n.has_class("s-card__price")]
        offers = bool(re.search(r"Best Offer", text, re.I))
        bids = re.search(r"\b(\d+) bids?\b", text)
        status = "accepted_price_unknown" if offers else "displayed_auction_result" if bids else "fixed_transaction_unverified"
        shipping = re.search(r"\+\$([\d,.]+) (?:delivery|shipping)", text)
        flags = ["condition_not_verified", "parallel_not_verified", "sale_status_not_verified", "own_purchase_not_checked"]
        if status != "displayed_auction_result": flags.append(status)
        if not url: flags.append("listing_url_missing")
        if re.search(r"\b(PSA|BGS|SGC|CGC)\s*\d", title, re.I): flags.append("graded")
        if re.search(r"\blot\b|\+ base|you pick|pick your", title, re.I): flags.append("multiple_cards_or_variations")
        if re.search("redemption", title, re.I): flags.append("redemption")
        if re.search(r"Located in (?!United States)", text): flags.append("international_shipping_imports")
        if len(re.findall(r"\$[\d,.]+", " ".join(prices))) != 1: flags.append("multiple_or_missing_display_prices")
        rows.append(dict(itemId=listing_id, sourceUrl=url, title=title, soldDateText=sold.group(1),
            productHint=product(title), displayedPrices=prices, priceStatus=status,
            displayedShippingCents=0 if "Free delivery" in text or "Free shipping" in text else round(float(shipping.group(1).replace(",", ""))*100) if shipping else None,
            bids=int(bids.group(1)) if bids else None, flags=flags,
            verifiedItemCents=None, eligibleForPricing=False))
    return rows, ignored, duplicates


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("source", type=Path)
    ap.add_argument("--output", type=Path, default=Path("artifacts/knowledge-graph/saved-html-test.json"))
    args = ap.parse_args()
    start = time.perf_counter()
    raw = args.source.read_bytes()
    rows, ignored, duplicates = extract(raw.decode("utf-8-sig"))
    summary = dict(listings=len(rows), completeListingUrls=sum(bool(r["sourceUrl"]) for r in rows),
        uniqueItemIds=len({r["itemId"] for r in rows}), soldDates=sum(bool(r["soldDateText"]) for r in rows),
        displayedPrices=sum(bool(r["displayedPrices"]) for r in rows), shippingAmounts=sum(r["displayedShippingCents"] is not None for r in rows),
        priceStatuses=dict(Counter(r["priceStatus"] for r in rows)), products=dict(Counter(r["productHint"] for r in rows)),
        ignoredNonSoldCards=ignored, duplicateCards=duplicates, verifiedComps=0, databaseImported=False)
    result = dict(version=1, sourceFilename=args.source.name, sourceSha256=hashlib.sha256(raw).hexdigest(),
        sourceBytes=len(raw), analyzedAt=datetime.now(timezone.utc).isoformat(), captureTimeVerified=False,
        extractionSeconds=round(time.perf_counter()-start, 3), summary=summary, rows=rows)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    body = "".join("<tr>" + "".join(f"<td>{html.escape(str(v))}</td>" for v in [r["itemId"], r["title"], r["productHint"], r["soldDateText"], "; ".join(r["displayedPrices"]), r["priceStatus"], "; ".join(r["flags"])]) + "</tr>" for r in rows)
    args.output.with_suffix(".html").write_text('<!doctype html><meta charset="utf-8"><title>Saved eBay page test</title><style>body{font:15px system-ui;margin:24px}td,th{padding:10px;border-bottom:1px solid #ddd;text-align:left}table{border-collapse:collapse}th{position:sticky;top:0;background:white}</style><h1>Saved eBay page test</h1><p>Offline staging only; no verified comps or database import. Prices are displayed amounts, not confirmed transaction amounts.</p><pre>' + html.escape(json.dumps(summary, indent=2)) + '</pre><table><thead><tr><th>Item ID</th><th>Title</th><th>Product proposal</th><th>Sold date</th><th>Displayed price</th><th>Price status</th><th>Holds</th></tr></thead><tbody>' + body + '</tbody></table>', encoding="utf-8")
    print(json.dumps(dict(**summary, extractionSeconds=result["extractionSeconds"], output=str(args.output)), indent=2))


if __name__ == "__main__":
    main()
