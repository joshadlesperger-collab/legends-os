import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateCatalog } from "../lib/card-knowledge.ts";
import { reviewCompsApiPilot } from "../lib/compsapi-pilot.ts";
const catalog = validateCatalog(JSON.parse(readFileSync("data/card-catalog/topps-chrome-basketball-2025-26.json", "utf8")));
test("provider averages and offers stay unverified; overlaps and products stay distinct", () => {
  const base = { item_id:"123", title:"2025 Topps Chrome Cooper Flagg #251", url:"https://www.ebay.com/itm/123",
    price:10, units_sold:3, best_offer:true, last_sold:"2026-10-23T18:00:00Z", shipping_cost:0 };
  const report = reviewCompsApiPilot({ok:true,items:[base,base,{...base,item_id:"456",url:"https://www.ebay.com/itm/456",title:"2025 Topps Chrome Black Cooper Flagg #251",units_sold:1}, {bad:true}]},catalog,new Set(["123"]));
  assert.equal(report.summary.uniqueListings,2);
  assert.equal(report.summary.duplicates,1);
  assert.equal(report.summary.malformedRows,1);
  assert.equal(report.summary.overlapsSavedHtml,1);
  assert.equal(report.summary.titleMatches,1);
  assert.ok(report.rows[0].flags.includes("multi_unit_average"));
  assert.equal(report.rows[1].proposedChecklistEntryId,null);
  assert.ok(report.rows.every(r=>r.verifiedTransactionPrice === null && !r.pricingEligible));
  assert.throws(()=>reviewCompsApiPilot({ok:false,items:[]},catalog,new Set()));
});
test("deduplicates against the union of HTML and prior API batches", () => {
  const items = ["123", "456", "789", "999"].map(item_id => ({item_id,title:"2025 Topps Chrome Black",price:1,units_sold:1}));
  const r = reviewCompsApiPilot({ok:true,items}, catalog, new Set(["123","456"]),new Set(["456","789"]));
  assert.equal(r.summary.overlapsSavedHtml,2);
  assert.equal(r.summary.overlapsPriorApi,2);
  assert.equal(r.summary.overlapsExisting,3);
  assert.equal(r.summary.newListings,1);
  assert.equal(r.rows.filter(row=>!row.overlapsExisting)[0].item_id,"999");
});
