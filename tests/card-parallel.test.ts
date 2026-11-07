import test from "node:test";
import assert from "node:assert/strict";
import { analyzeParallel, estimateParallel, type ParallelPacket, type ParallelSale } from "../lib/card-parallel.ts";

const now = new Date("2026-10-23T12:00:00Z");
const baseline = { parallel: "Base", finish: "Chrome", numbering: "unnumbered" as const, printRun: null };
const target = { parallel: "RayWave", finish: "Refractor", numbering: "unnumbered" as const, printRun: null };
function packet(): ParallelPacket {
  const sales: ParallelSale[] = [];
  for (let player=0;player<4;player++) for (const variant of [baseline,target]) for (let copy=0;copy<3;copy++) {
    const saleId = `${player}-${variant.parallel}-${copy}`;
    sales.push({ provider: "example", saleId, variantId: `${player}-${variant.parallel}`, sourceUrl: `https://example.com/sold/${saleId}`, soldAt: "2026-10-20T12:00:00Z", observedAt: "2026-10-21T12:00:00Z",
      itemCents: variant === target ? 1050 : 900, shippingCents: 100, currency: "USD", condition: "raw-nm", identityVerified: true, conditionVerified: true,
      kind: "sold", ownPurchase: false, hiddenPrice: false, productId: "test", section: "BASE CARDS", language: "English", entryId: `entry-${player}`, subjectId: `player-${player}`, variant, variantVerified: true, ordinaryCopy: true });
  }
  return { scope: { productId: "test", section: "BASE CARDS", language: "English", condition: "raw-nm", currency: "USD", baseline, target }, sales };
}
test("matched landed-price ratios produce 15%, with provenance and no approval", () => {
  const result = analyzeParallel(packet(),now);
  assert.equal(result.status,"research-estimate"); assert.equal(result.multiplier,1.15);
  assert.equal(result.playerCount,4); assert.equal(result.saleCount,24); assert.equal(result.listingApproved,false);
  assert.equal(result.pairs[0].saleKeys.length,6); assert.equal(result.pairs[0].sourceUrls.length,6);
});
test("direct comps win; absent direct comps use held-out player's verified base", () => {
  const p = packet();
  assert.equal(estimateParallel(p,"entry-0",now).basis,"direct-comps");
  p.sales = p.sales.filter(s => !(s.entryId === "entry-0" && s.variant.parallel === "RayWave"));
  const fallback = estimateParallel(p,"entry-0",now);
  assert.equal(fallback.basis,"parallel-fallback"); assert.equal(fallback.estimatedBuyerTotalCents,1150);
  assert.equal(fallback.model.playerCount,3); assert.equal(fallback.listingApproved,false);
  p.sales = p.sales.filter(s => s.entryId !== "entry-0");
  assert.equal(estimateParallel(p,"entry-0",now).estimatedBuyerTotalCents,null);
});
test("reject duplicate sales, unknown shipping, special copies, mismatched scope and stale evidence", () => {
  const changes: Partial<ParallelSale>[] = [{ shippingCents:null },{ ownPurchase:true },{ hiddenPrice:true },{ productId:"different" },{ language:"Japanese" },{ condition:"PSA10" },{ ordinaryCopy:false },{ variantVerified:false },{ kind:"asking" },{ soldAt:"2025-01-01T12:00:00Z" }];
  for (const change of changes) {
    const p = packet(); p.sales = p.sales.map(s => ({...s,...change}));
    assert.equal(analyzeParallel(p,now).multiplier,null,JSON.stringify(change));
  }
  const p = packet(); p.sales.push(...p.sales.map(s=>({...s})));
  assert.equal(analyzeParallel(p,now).saleCount,0);
});
test("different time windows, finishes, numbering and players cannot inflate coverage", () => {
  const p = packet();
  p.sales = p.sales.map(s => s.variant.parallel === "RayWave" ? {...s,soldAt:"2026-09-01T12:00:00Z"} : s);
  assert.equal(analyzeParallel(p,now).pairCount,0);
  const q = packet(); q.sales.forEach(s => {s.subjectId="same-player";});
  assert.equal(analyzeParallel(q,now).status,"insufficient-evidence");
  const r = packet(); r.sales = r.sales.map(s => ({...s,variant:{...s.variant,printRun:50,numbering:"numbered"}}));
  assert.equal(analyzeParallel(r,now).multiplier,null);
  assert.throws(()=>analyzeParallel({...packet(),scope:{...packet().scope,target:baseline}},now));
});
test("widely varying player ratios hold the fallback and empty data never assumes 15%", () => {
  const p = packet();
  p.sales.forEach(s => {if (s.variant.parallel === "RayWave") s.itemCents = s.subjectId === "player-0" || s.subjectId === "player-1" ? 100 : 10000;});
  assert.equal(analyzeParallel(p,now).status,"insufficient-evidence");
  assert.equal(analyzeParallel({...p,sales:[]},now).multiplier,null);
});
