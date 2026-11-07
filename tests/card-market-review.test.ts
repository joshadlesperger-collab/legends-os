import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { productHint, reviewMarketBatch, matchChecklistTitle } from "../lib/card-market-review.ts";
import { validateCatalog } from "../lib/card-knowledge.ts";
const catalog = validateCatalog(JSON.parse(readFileSync("data/card-catalog/topps-chrome-basketball-2025-26.json", "utf8")));
test("separate product variants and seasons before checklist matching", () => {
  assert.equal(productHint("2025 Topps Chrome Update Sapphire"), "Chrome Update Sapphire");
  assert.equal(productHint("2024-25 Chrome Cosmic"), "Other season");
  assert.equal(productHint("2025 Topps Chrome Black"), "Chrome Black");
  assert.equal(productHint("Topps 2025-26 Bowman Chrome Cooper Flagg #251"), "Bowman — release unverified");
  assert.equal(matchChecklistTitle("Topps 2025-26 Bowman Chrome Cooper Flagg #251", catalog).entryId, null);
});
test("title IDs respect year, release, player, card number and variation", () => {
  const base = matchChecklistTitle("2025-26 Topps Chrome Cooper Flagg #251 Blue X-Fractor PSA 9", catalog);
  assert.ok(base.entryId);
  assert.equal(base.candidates[0].section, "BASE CARDS");
  for (const title of ["2024-25 Topps Chrome Cooper Flagg #251", "2026 Topps Chrome Cooper Flagg #251", "2025 Topps Chrome Update Cooper Flagg #251", "2025 Topps Chrome Cosmic Cooper Flagg #251", "Topps Chrome Cooper Flagg #251", "2025 Topps Chrome Bam Adebayo #251", "2025 Topps Chrome Cooper Flagg #251 lot"]) assert.equal(matchChecklistTitle(title, catalog).entryId, null, title);
  assert.equal(matchChecklistTitle("2025-26 Topps Chrome Paolo Banchero #140 Image Variation", catalog).candidates.every(c => c.section === "BASE CARD VARIATIONS"), true);
});
test("a title match and visible price never become verified sale evidence", () => {
  const packet = { version: 1, sourceUrl: "https://www.ebay.com/sch/i.html", observedAt: "2026-10-24T01:31:27Z", reviewStartedAt: "2026-10-24T01:33:03Z", databaseImported: false,
    rows: [{ n: 1, rowId: "itemabc", title: "2025-26 Topps Chrome Cooper Flagg #251", text: "Sold Oct 23, 2026 | $20.00 | or Best Offer | Free delivery", auction: false, flags: [] }] };
  const result = reviewMarketBatch(packet, catalog);
  assert.equal(result.rows[0].priceStatus, "accepted_price_unknown");
  assert.equal(result.rows[0].verifiedItemCents, null);
  assert.equal(result.rows[0].eligibleForPricing, false);
  assert.ok(result.rows[0].proposedEntries.length > 0);
  assert.equal(result.verifiedComps, 0);
  const linked = reviewMarketBatch({ ...packet, rows: [{ ...packet.rows[0], sourceUrl: "https://www.ebay.com/itm/123" }] }, catalog);
  assert.equal(linked.rows[0].blockers.includes("individual_listing_url_not_retained"), false);
  assert.equal(linked.rows[0].verifiedItemCents, null);
  assert.equal(linked.rows[0].eligibleForPricing, false);
  assert.throws(() => reviewMarketBatch({ ...packet, rows: [{ ...packet.rows[0], sourceUrl: "https://example.com/itm/123" }] }, catalog));
  assert.equal(reviewMarketBatch({ ...packet, rows: [...packet.rows, ...packet.rows] }, catalog).rows[0].blockers.includes("duplicate_listing"), true);
});
