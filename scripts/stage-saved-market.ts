import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { validateCatalog } from "../lib/card-knowledge.ts";
import { reviewMarketBatch } from "../lib/card-market-review.ts";
const savedSchema = z.object({ sourceSha256: z.string().regex(/^[a-f0-9]{64}$/), analyzedAt: z.string(), captureTimeVerified: z.literal(false),
  rows: z.array(z.object({ itemId: z.string().regex(/^\d+$/), sourceUrl: z.string().url(), title: z.string(), soldDateText: z.string(),
    displayedPrices: z.array(z.string()), priceStatus: z.enum(["displayed_auction_result", "accepted_price_unknown", "fixed_transaction_unverified"]),
    displayedShippingCents: z.number().int().nonnegative().nullable(), bids: z.number().int().nullable(), flags: z.array(z.string()) })).max(240) });
async function main() {
  const saved = savedSchema.parse(JSON.parse(await readFile("artifacts/knowledge-graph/saved-html-test.json", "utf8")));
  // These manual browser observations belong only to the reviewed source snapshot.
  if (saved.sourceSha256 !== "e42040d44dd4e881648d1d2df3727c37b5babab8dfdd7bcfa028ad1fda0c5411") throw Error("Different source requires a fresh review");
  const checks: Record<string, string> = {
    "198713414761": "Checked original URL: redirects to eBay product /p/3089162685. Product asking prices excluded; original sale not verified.",
    "128142139873": "Checked original URL: redirects to an eBay product page. Original sale not verified.",
    "840028932778": "Checked original URL: redirects to eBay product /p/5089389494. Original sale not verified.",
    "960076616507": "Checked original URL: redirects to eBay product /p/6089209155. Original sale not verified.",
    "860045768954": "Checked original URL: redirects to eBay product /p/5089387894. Original sale not verified.",
    "377579315409": "Original listing opened via See original listing. Same item ID and title; SOLD US $1.04, 2 bids; ended Oct 23, 2026 18:19:54 PDT; advertised shipping $4.99 with combined shipping available; seller condition Ungraded - Excellent. Front photo reviewed: basketball-pattern border. Actual paid shipping, cancellation/refund status and own-purchase exclusion remain unknown. Do not pool with plain Refractor or Near Mint. This confirms displayed listing facts, not an independently settled transaction."
  };
  const rows = saved.rows.map((r, i) => {
    if (r.sourceUrl !== `https://www.ebay.com/itm/${r.itemId}`) throw Error("Listing URL/ID mismatch");
    const shipping = r.displayedShippingCents === null ? "Shipping unknown" : r.displayedShippingCents === 0 ? "Free delivery" : `+$${(r.displayedShippingCents / 100).toFixed(2)} delivery`;
    const text = [`Sold ${r.soldDateText}`, r.displayedPrices.join(" "), r.priceStatus === "accepted_price_unknown" ? "or Best Offer" : r.priceStatus === "displayed_auction_result" ? `${r.bids ?? "Unknown"} bids` : "Buy It Now", shipping].join(" | ");
    return { n: i + 1, title: r.title, text, price: r.displayedPrices.join(" "), sourceUrl: r.sourceUrl,
      rowId: `item${BigInt(r.itemId).toString(16)}`, auction: r.priceStatus === "displayed_auction_result",
      flags: [...r.flags, checks[r.itemId] ? r.itemId === "377579315409" ? "listing_facts_checked_transaction_unverified" : "original_listing_redirects_to_product" : "listing_check_pending"],
      listingCheck: checks[r.itemId] ?? "Not individually visited. Saved search observation only." };
  });
  const packet = { version: 1, sourceUrl: "https://www.ebay.com/sch/i.html?_nkw=2025+topps+chrome+basketball&LH_Sold=1&_ipg=240", observedAt: new Date(saved.analyzedAt).toISOString(), reviewStartedAt: new Date().toISOString(), databaseImported: false, rows };
  const catalog = validateCatalog(JSON.parse(await readFile("data/card-catalog/topps-chrome-basketball-2025-26.json", "utf8")));
  const report = reviewMarketBatch(packet, catalog);
  const provenance = { sourceSha256: saved.sourceSha256, captureTimeVerified: false, listingChecks: 6, displayedSoldListingConfirmed: 1, redirectedListings: 5, pendingListings: rows.length - 6, databaseImported: false };
  await writeFile("artifacts/knowledge-graph/saved-market-packet.json", JSON.stringify({ ...packet, ...provenance }, null, 2));
  await writeFile("artifacts/knowledge-graph/saved-market-review.json", JSON.stringify({ ...report, ...provenance }, null, 2));
  console.log(JSON.stringify({ ...provenance, observations: rows.length, uncertainPrices: report.summary.uncertainPrices, products: report.summary.products }, null, 2));
}
main().catch(() => { console.error("Saved market staging failed validation; no database writes were attempted."); process.exitCode = 1; });
