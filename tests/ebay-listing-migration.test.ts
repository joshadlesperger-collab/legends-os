import assert from "node:assert/strict";
import test from "node:test";
import { parseAddFixedPriceItemResponse, type EbayListingItem } from "../lib/ebay.ts";
import { createListingOnceWithMandatorySkuRecovery, type MigrationCreateProvider } from "../lib/ebay-listing-migration.ts";

const item = (itemId: string, sku: string): EbayListingItem => ({ ItemID: itemId, SKU: sku, Title: "Card", Quantity: 1, QuantityAvailable: 1, SellingStatus: { ListingStatus: "Active", CurrentPrice: 3.95 } });

test("parses the successful canary AddFixedPriceItem response shape with XML declaration metadata", () => {
  const parsed = {
    "?xml": { "@_version": "1.0", "@_encoding": "utf-8" },
    AddFixedPriceItemResponse: { "@_xmlns": "urn:ebay:apis:eBLBaseComponents", Timestamp: "2026-08-23T14:47:13.000Z", Ack: "Success", Version: 1427, Build: "E1427_CORE_API5_19110891_R1", ItemID: 128040442291, StartTime: "2026-08-23T14:47:13.000Z", EndTime: "2026-09-22T14:47:13.000Z", Fees: { Fee: [] } },
  };
  assert.deepEqual(parseAddFixedPriceItemResponse(parsed), { itemId: "128040442291", ack: "Success", warnings: [] });
});

test("captured provider ItemID is reconciled exactly without SKU search", async () => {
  let skuSearches = 0;
  const provider: MigrationCreateProvider = { createOnce: async () => ({ itemId: "128040442291", ack: "Success", warnings: [] }), getByItemId: async id => item(id, "MIG-358541944109"), findActiveBySku: async () => { skuSearches += 1; return []; } };
  const result = await createListingOnceWithMandatorySkuRecovery(provider, "MIG-358541944109");
  assert.equal(result.resolution, "provider-item-id");
  assert.equal(result.itemId, "128040442291");
  assert.equal(skuSearches, 0);
});

test("missing parsed ItemID recovers exactly one active destination by SKU without retrying create", async () => {
  let creates = 0;
  const provider: MigrationCreateProvider = { createOnce: async () => { creates += 1; return { itemId: null, ack: "Success", warnings: [] }; }, getByItemId: async () => { throw new Error("not called"); }, findActiveBySku: async () => [item("128040442335", "MIG-358847656958")] };
  const result = await createListingOnceWithMandatorySkuRecovery(provider, "MIG-358847656958");
  assert.equal(result.resolution, "destination-sku");
  assert.equal(result.itemId, "128040442335");
  assert.equal(creates, 1);
});

test("ambiguous provider failure reconciles by SKU and never retries create", async () => {
  let creates = 0;
  const provider: MigrationCreateProvider = { createOnce: async () => { creates += 1; throw new Error("socket closed after request body"); }, getByItemId: async () => { throw new Error("not called"); }, findActiveBySku: async () => [item("128040442368", "MIG-358847631794")] };
  const result = await createListingOnceWithMandatorySkuRecovery(provider, "MIG-358847631794");
  assert.equal(result.resolution, "destination-sku");
  assert.equal(creates, 1);
});

test("zero SKU matches is recoverable and requires operator review before retry", async () => {
  const provider: MigrationCreateProvider = { createOnce: async () => ({ itemId: null, ack: "Unknown", warnings: [] }), getByItemId: async () => { throw new Error("not called"); }, findActiveBySku: async () => [] };
  await assert.rejects(createListingOnceWithMandatorySkuRecovery(provider, "MIG-358541944109"), (error: unknown) => error instanceof Error && error.message.includes("operator review is required before any retry"));
});

test("multiple active SKU matches stop as duplicate risk", async () => {
  const provider: MigrationCreateProvider = { createOnce: async () => ({ itemId: null, ack: "Unknown", warnings: [] }), getByItemId: async () => { throw new Error("not called"); }, findActiveBySku: async () => [item("1", "MIG-358541944109"), item("2", "MIG-358541944109")] };
  await assert.rejects(createListingOnceWithMandatorySkuRecovery(provider, "MIG-358541944109"), /Duplicate-risk condition/);
});
