import test from "node:test";
import assert from "node:assert/strict";
import { scarcityGuard } from "../lib/card-scarcity-guard.ts";
const anchor={saleId:"sale-1",sourceUrl:"https://www.ebay.com/itm/123",soldDate:"2026-10-01",buyerTotal:5,sourcePrintRun:99};
const anchors=()=>[0,1,2].map(n=>({...anchor,saleId:`sale-${n}`,sourceUrl:`https://www.ebay.com/itm/${n}`}));
test("Dick Vitale /25 at $3 is blocked against /99 sold for $5",()=>{
 const r=scarcityGuard({targetPrintRun:25,proposedBuyerTotal:3,exactSoldCount:0,anchors:anchors()});
 assert.equal(r.passed,false);assert.equal(r.estimatedBuyerTotal,19.8);assert.equal(r.calculations[0].soldDate,anchor.soldDate);
});
test("math-supported asking total passes and records provenance",()=>{
 const r=scarcityGuard({targetPrintRun:25,proposedBuyerTotal:19.95,exactSoldCount:0,anchors:anchors()});assert.ok(r.passed);assert.equal(r.method,"related-print-run");
});
test("one cheap exact auction cannot outweigh math; five verified exact sales can",()=>{
 for(const count of [1,2,3,4]) assert.equal(scarcityGuard({targetPrintRun:25,proposedBuyerTotal:3,exactSoldCount:count,anchors:anchors()}).passed,false);
 assert.ok(scarcityGuard({targetPrintRun:25,proposedBuyerTotal:3,exactSoldCount:5,anchors:anchors()}).passed);
});
test("unknown evidence blocks numbered proposals instead of assuming no contradiction",()=>{
 assert.equal(scarcityGuard({targetPrintRun:25,proposedBuyerTotal:3,exactSoldCount:1,anchors:[]}).passed,false);
 assert.ok(scarcityGuard({targetPrintRun:25,proposedBuyerTotal:3,exactSoldCount:1,anchors:[],searchEvidence:"Related sold search inspected; no usable anchors found"}).passed);
});
test("source buyer total includes postage before scaling",()=>{
 const r=scarcityGuard({targetPrintRun:25,proposedBuyerTotal:19.95,exactSoldCount:0,anchors:[{...anchor,buyerTotal:6.5}]});assert.equal(r.estimatedBuyerTotal,25.74);assert.equal(r.passed,false);
});

test("large reductions preserve the old price without strong exact evidence",()=>{
 const r=scarcityGuard({targetPrintRun:null,proposedBuyerTotal:3,existingBuyerTotal:19.95,exactSoldCount:1,anchors:[]});assert.equal(r.passed,false);
});
test("five exact sales cannot justify an override below their own supported total",()=>{
 const r=scarcityGuard({targetPrintRun:25,proposedBuyerTotal:3,exactSupportedBuyerTotal:15,exactSoldCount:5,anchors:[]});assert.equal(r.passed,false);
});

test("prefer /50 then /99; exclude /299 once lower-run sample is sufficient",()=>{
 const low=anchors().map(a=>({...a,sourcePrintRun:50}));
 const high={...anchor,saleId:"high",sourceUrl:"https://www.ebay.com/itm/high",sourcePrintRun:299,buyerTotal:1};
 const r=scarcityGuard({targetPrintRun:25,proposedBuyerTotal:10,exactSoldCount:0,anchors:[high,...low]});
 assert.ok(r.passed);assert.equal(r.estimatedBuyerTotal,10);assert.equal(r.excludedAnchors.length,1);
 const mixed=scarcityGuard({targetPrintRun:25,proposedBuyerTotal:30,exactSoldCount:0,anchors:[high,...low.slice(0,1),...anchors().slice(0,2).map(a=>({...a,saleId:a.saleId+"-99",sourceUrl:a.sourceUrl+"99"}))]});
 assert.deepEqual(mixed.calculations.map(a=>a.sourcePrintRun),[50,99,99]);
});
test("one related sale remains an estimate requiring review",()=>{
 assert.equal(scarcityGuard({targetPrintRun:25,proposedBuyerTotal:20,exactSoldCount:0,anchors:[anchor]}).passed,false);
});
