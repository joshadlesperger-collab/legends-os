import test from "node:test";
import assert from "node:assert/strict";
import { projectPricing, roundUpListingPrice, type PricingReview, type SoldComp } from "../lib/card-pricing-review.ts";
import { canonicalCardKey, type DraftCard } from "../lib/card-listing-factory.ts";
const identity = { sport: "Baseball" as const, player: "Hunter Goodman", year: 2026, manufacturer: "Topps", set: "Finest", cardNumber: "155", parallel: "Gold Geometric Refractor", serialNumber: "30/50", numberedTo: 50 };
const today = "2026-10-16";
const comp = (price=10, id="one"): SoldComp => ({ id, sourceUrl:`https://example.com/sold/${id}`, soldDate: "2026-10-01", itemPrice: price, shipping: 1.49, notes:"Exact parallel; test fixture", verified: true, identityKey:canonicalCardKey(identity) });
const draft = (patch: Partial<PricingReview> = {}): DraftCard => ({ identity, quantity:1, verified:true, frontImageId:"front", backImageId:"back", pricing:{ comps:[comp()], premiumPercent:9, needsTracked:false, envelopeEligible:true, ...patch } });
const project = (value:DraftCard) => projectPricing(value,today);
test("average comp, 8-10% premium, separate shipping and buyer total", () => {
 const result=project(draft({comps:[comp(5,"a"),comp(15,"b"),comp(10,"c")]}));
 assert.equal(result.compValue,10); assert.equal(result.listingPrice,10.95); assert.equal(result.lowPrice,10.8); assert.equal(result.highPrice,11);
 assert.equal(result.shippingCharge,1.95); assert.equal(result.buyerTotal,12.9); assert.deepEqual(result.reviewReasons,[]);
 assert.equal(project(draft({comps:[comp(5,"a"),comp(10,"b")]})).compValue,7.5);
});
test("Goodman displayed-sale example uses mean and rounds after the premium",()=>{
 const result=project(draft({comps:[comp(4.99,"a"),comp(8,"b"),comp(5.5,"c")]}));
 assert.ok(Math.abs(result.compValue!-18.49/3)<0.000001);
 assert.equal(result.listingPrice,6.95);assert.equal(result.lowPrice,6.66);assert.equal(result.highPrice,6.78);
 assert.equal(result.shippingCharge,1.49);assert.equal(result.buyerTotal,8.44);
});

test("General promotion defaults to 3%, remains separate from price and binds approval",()=>{
 const original=draft({comps:[comp(4.99,"a"),comp(8,"b"),comp(5.5,"c")]});
 const result=project(original);
 assert.equal(result.generalPromotionPercent,3);
 assert.equal(result.estimatedPromotionFeeBeforeTax,0.25);
 const approved={...original,pricing:{...original.pricing!,approvedSnapshot:result.snapshot}};
 assert.equal(project(approved).approved,true);
 const increased=project({...approved,pricing:{...approved.pricing,generalPromotionPercent:5}});
 assert.equal(increased.estimatedPromotionFeeBeforeTax,0.42);
 assert.equal(increased.listingPrice,6.95);
 assert.equal(increased.shippingCharge,1.49);
 assert.equal(increased.approved,false);
 const off=project({...original,pricing:{...original.pricing!,generalPromotionPercent:0}});
 assert.equal(off.estimatedPromotionFeeBeforeTax,0);
 assert.deepEqual(off.reviewReasons,[]);
 for(const rate of [-1,2,5.1,Infinity,NaN]) {
  const invalid=project({...approved,pricing:{...approved.pricing,generalPromotionPercent:rate}});
  assert.equal(invalid.approved,false);
  assert.equal(invalid.estimatedPromotionFeeBeforeTax,null);
  assert.ok(invalid.reviewReasons.some(reason=>reason.includes("General promotion")));
 }
});

test("price endings always round up, retaining exact endings and crossing dollars",()=>{
 for(const [input,expected] of [[0.01,0.49],[6.49,6.49],[6.4901,6.95],[6.72,6.95],[6.95,6.95],[6.9501,7.49],[6.99,7.49],[100.1,100.49]]) assert.equal(roundUpListingPrice(input),expected);
 // Do not round the premium to cents before selecting the ending.
 assert.equal(project(draft({comps:[comp(5.05)],premiumPercent:8.75})).listingPrice,5.95);
});
test("missing, unverified, duplicate, invalid and stale evidence blocks approval",()=>{
 for(const comps of [[],[{...comp(),verified:false}],[comp(),comp()], [{...comp(),sourceUrl:"javascript:alert(1)"}], [{...comp(),soldDate:"2026-02-30"}], [{...comp(),soldDate:"2026-06-01"}], [{...comp(),soldDate:"2026-10-17"}], [{...comp(),itemPrice:NaN}], [{...comp(),shipping:NaN}], [{...comp(),itemPrice:-1}], [{...comp(),itemPrice:2.345}]]) {
  const result=project(draft({comps})); assert.equal(result.approved,false); assert.ok(result.reviewReasons.length); assert.equal(result.listingPrice,null);
 }
 assert.equal(project(draft({premiumPercent:11})).listingPrice,null);
});
test("envelope verification, tracked overrides, graded cards and threshold crossing",()=>{
 assert.ok(project(draft({envelopeEligible:false})).reviewReasons.some(x=>x.includes("envelope")));
 assert.equal(project(draft({needsTracked:true,envelopeEligible:false})).shippingCharge,6.29);
 assert.equal(project({...draft({envelopeEligible:false}),identity:{...identity,graded:true,grade:"PSA 9"},pricing:{...draft().pricing!,comps:[{...comp(),identityKey:canonicalCardKey({...identity,graded:true,grade:"PSA 9"})}],envelopeEligible:false}}).shippingCharge,6.29);
 assert.equal(project(draft({comps:[comp(19)],envelopeEligible:false})).shippingCharge,6.29);
 assert.equal(project(draft({comps:[comp(5)]})).shippingCharge,1.49);
});
test("economic approval binds to evidence, price, shipping, identity and photo pair",()=>{
 const original=draft(); const ready=project(original);
 const approved={...original,pricing:{...original.pricing!,approvedSnapshot:ready.snapshot}};
 assert.equal(project(approved).approved,true);
 for(const changed of [ {...approved,frontImageId:"replacement"}, {...approved,verified:false}, {...approved,identity:{...identity,parallel:"Refractor"}}, {...approved,pricing:{...approved.pricing,premiumPercent:10}}, {...approved,pricing:{...approved.pricing,needsTracked:true}}, {...approved,pricing:{...approved.pricing,comps:[comp(11)]}} ]) assert.equal(project(changed).approved,false);
 const changedIdentity={...approved,identity:{...identity,parallel:"Refractor"}};
 assert.ok(project(changedIdentity).reviewReasons.some(x=>x.includes("matching card")));
});

test("review UI shares the orchestrator's under-three conversion and raw patch shipping",()=>{
 const result=project(draft({comps:[comp(1.75)]}));
 assert.equal(result.roundedBase,1.95);assert.equal(result.listingPrice,3.44);assert.equal(result.shippingCharge,0);assert.equal(result.freeEnvelopeConversion,true);
 assert.ok(Math.abs(result.roundingAdjustment!-(1.95-1.75*1.09))<1e-8);
 assert.equal(project(draft({comps:[comp(1.75)],needsTracked:true})).listingPrice,1.95);
 assert.equal(project(draft({comps:[comp(5)],patchCard:true})).shippingCharge,1.95);
 const original=draft({comps:[comp(5)]}),ready=project(original);
 assert.equal(project({...original,pricing:{...original.pricing!,approvedSnapshot:ready.snapshot,patchCard:true}}).approved,false);
});
