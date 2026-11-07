import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateCatalog } from "../lib/card-knowledge.ts";
import { prepareMarketObservationImport, importMarketObservations, mergeMarketPackets } from "../lib/market-observation-import.ts";
const catalog = validateCatalog(JSON.parse(readFileSync("data/card-catalog/topps-chrome-basketball-2025-26.json", "utf8")));
test("overlapping pages preserve provenance without duplicate listings and reject conflicts", () => {
  const row = { itemId:"123", sourceUrl:"https://www.ebay.com/itm/123", title:"2025 Topps Chrome Black Tyler Herro", soldDateText:"Oct 23, 2026", displayedPrices:["$1.25"], priceStatus:"accepted_price_unknown", displayedShippingCents:599,bids:null,flags:["accepted_price_unknown"] };
  const a = { sourceSha256:"a".repeat(64), analyzedAt:"2026-10-24T01:45:00Z",captureTimeVerified:false,rows:[row] };
  const b = {...a,sourceSha256:"b".repeat(64)};
  const merged = mergeMarketPackets([a,b]);
  assert.equal(merged.rows.length,1);
  assert.deepEqual(merged.rows[0].sourceSnapshots,[a.sourceSha256,b.sourceSha256]);
  assert.equal(prepareMarketObservationImport(merged,catalog).counts.uncertainPrices,1);
  assert.equal(prepareMarketObservationImport(merged,catalog).digest,prepareMarketObservationImport(mergeMarketPackets([b,a]),catalog).digest);
  assert.throws(()=>mergeMarketPackets([a,{...b,rows:[{...row,displayedPrices:["$2.00"]}]}]),/Conflicting/);
});
test("all products retained independently of checklist links; deterministic retry keys", () => {
  const row = { itemId:"123", sourceUrl:"https://www.ebay.com/itm/123", title:"2024-25 Topps Chrome Cosmic Collin Sexton", soldDateText:"Oct 23, 2026", displayedPrices:["$1.25"], priceStatus:"accepted_price_unknown", displayedShippingCents:599,bids:null,flags:[] };
  const packet = { sourceSha256:"a".repeat(64), analyzedAt:"2026-10-24T01:45:00Z",captureTimeVerified:false,rows:[row] };
  const plan = prepareMarketObservationImport(packet,catalog);
  assert.equal(plan.records.length,1);
  assert.equal(plan.records[0].raw.proposedChecklistEntryId,null);
  assert.equal(plan.records[0].raw.verifiedTransactionPrice,null);
  assert.equal(plan.importId,prepareMarketObservationImport({...packet,analyzedAt:"2026-10-24T02:45:00Z"},catalog).importId);
  assert.throws(()=>prepareMarketObservationImport({...packet,rows:[row,row]},catalog),/Duplicate/);
  assert.throws(()=>prepareMarketObservationImport({...packet,rows:[{...row,sourceUrl:"https://www.ebay.com/itm/456"}]},catalog),/URL/);
});
test("transactional archive retries do not insert the same batch twice", async () => {
  let imported = false, recordWrites = 0;
  const tx = { knowledgeImport: { findUnique: async () => imported ? { id:"existing" } : null, create: async () => { imported = true; } },
    knowledgeLegacyRecord: { createMany: async ({data}: {data: unknown[]}) => { recordWrites += data.length; } } };
  const client = { $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) } as unknown as Parameters<typeof importMarketObservations>[0];
  const packet = { sourceSha256:"b".repeat(64), analyzedAt:"2026-10-24T01:45:00Z", captureTimeVerified:false,
    rows:[{itemId:"456",sourceUrl:"https://www.ebay.com/itm/456",title:"2025 Topps Chrome Black Tyler Herro",soldDateText:"Oct 23, 2026",displayedPrices:["$1.00"],priceStatus:"displayed_auction_result",displayedShippingCents:136,bids:1,flags:[]}] };
  assert.equal((await importMarketObservations(client,packet,catalog)).status,"imported-observations");
  assert.equal((await importMarketObservations(client,packet,catalog)).status,"unchanged");
  assert.equal(recordWrites,1);
});
