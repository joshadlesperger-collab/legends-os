import assert from "node:assert/strict";
import test from "node:test";
import { classifyObservation, dedupeEbayItems, getIncrementalWindowStart, getSyncLockDisposition, getSyncRunTerminalStatus, normalizeEbayItem, normalizeItemSpecifics } from "../lib/ebay-sync-domain.ts";
import type { EbayListingItem } from "../lib/ebay.ts";

function item(overrides: Partial<EbayListingItem> = {}): EbayListingItem {
  return {
    ItemID: "item-1",
    Title: "Test card",
    Quantity: 1,
    QuantityAvailable: 1,
    SellingStatus: { CurrentPrice: { "#text": 25 }, QuantitySold: 0 },
    ...overrides,
  };
}

const existing = { currentPrice: "25", quantity: 1, quantitySold: 0, watchers: 0, views: 0, listingStatus: "active" };

test("normalizes new active and ended observations explicitly", () => {
  assert.equal(classifyObservation(null, normalizeEbayItem(item(), "active")).kind, "new");
  assert.equal(classifyObservation(existing, normalizeEbayItem(item(), "ended")).kind, "ended");
});

test("normalization preserves the authoritative seller category identity", () => {
  const observation = normalizeEbayItem({
    ItemID: "123456789012",
    Title: "2025 Topps Chrome Card",
    Quantity: 1,
    QuantityAvailable: 1,
    SellingStatus: { CurrentPrice: 10, QuantitySold: 0 },
    PrimaryCategory: { CategoryID: "261328" },
  }, "active");
  assert.equal(observation.categoryId, "261328");
});

test("classifies unchanged and meaningful active changes", () => {
  const unchanged = normalizeEbayItem(item(), "active");
  assert.deepEqual(classifyObservation(existing, unchanged), { kind: "unchanged", snapshotWorthy: false, priceChanged: false });

  const changed = normalizeEbayItem(item({ SellingStatus: { CurrentPrice: { "#text": 30 }, QuantitySold: 0 } }), "active");
  assert.deepEqual(classifyObservation(existing, changed), { kind: "changed", snapshotWorthy: true, priceChanged: true });
});

test("updates metadata without creating a performance snapshot", () => {
  const observation = normalizeEbayItem(item({ Title: "Updated title" }), "active");
  const state = { ...existing, title: "Old title", description: null, categoryId: null, condition: null,
    listingFormat: null, startTime: null, endTime: null, imageUrls: [] };
  assert.deepEqual(classifyObservation(state, observation), { kind: "changed", snapshotWorthy: false, priceChanged: false });
});

test("recognizes an ended item reappearing with the same provider item id", () => {
  const ended = { ...existing, listingStatus: "ended" };
  assert.equal(classifyObservation(ended, normalizeEbayItem(item(), "active")).kind, "reappeared");
});

test("deduplicates repeated and overlapping provider items by item id", () => {
  const duplicate = item({ Title: "newest representation" });
  const rows = dedupeEbayItems([item(), duplicate, item({ ItemID: "item-2" })]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].Title, "newest representation");
});

test("incremental windows overlap the last successful checkpoint", () => {
  const now = new Date("2026-08-13T12:00:00.000Z");
  const lastSync = new Date("2026-08-13T11:30:00.000Z");
  assert.equal(getIncrementalWindowStart(lastSync, now).toISOString(), "2026-08-13T11:25:00.000Z");
});

test("rejects malformed prices rather than persisting fabricated zero values", () => {
  assert.throws(() => normalizeEbayItem(item({ SellingStatus: {} }), "active"), /invalid current price/);
});

test("normalizes authoritative item specifics without inventing values", () => {
  const specifics = normalizeItemSpecifics(item({ ItemSpecifics: { NameValueList: [
    { Name: "Player/Athlete", Value: [" Shohei Ohtani ", "Shohei Ohtani"] },
    { Name: "Year", Value: "2024" },
    { Name: "", Value: "ignored" },
  ] } }));
  assert.deepEqual(specifics, { "Player/Athlete": ["Shohei Ohtani"], Year: ["2024"] });
});

test("a second sync is blocked while a recent run is active, but a stale lock is recoverable", () => {
  const now = new Date("2026-08-13T12:00:00.000Z");
  assert.equal(getSyncLockDisposition(new Date("2026-08-13T11:59:00.000Z"), now), "blocked");
  assert.equal(getSyncLockDisposition(new Date("2026-08-13T09:00:00.000Z"), now), "stale");
});

test("success and failure both release the running lock through terminal status", () => {
  assert.equal(getSyncRunTerminalStatus("success"), "completed");
  assert.equal(getSyncRunTerminalStatus("failure"), "failed");
});
