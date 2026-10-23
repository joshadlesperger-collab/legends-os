import test from "node:test";
import assert from "node:assert/strict";
import { prepareEbayDraftReview } from "../lib/card-ebay-draft.ts";
import { canonicalCardKey, type DraftCard } from "../lib/card-listing-factory.ts";
import { projectPricing } from "../lib/card-pricing-review.ts";

const today = "2026-10-16";
function approved(): DraftCard {
  const identity = { sport: "Baseball" as const, player: "Hunter Goodman", year: 2026, manufacturer: "Topps", set: "Finest", cardNumber: "155", parallel: "Gold Geometric Refractor", serialNumber: "30/50", numberedTo: 50 };
  const draft: DraftCard = { identity, quantity: 1, verified: true, frontImageId: "front", backImageId: "back", pricing: { premiumPercent: 9, needsTracked: false, envelopeEligible: true, comps: [4.99,8,5.5,4.99,8,5.5].map((itemPrice,i) => ({ id: String(i), sourceUrl: `https://example.com/sold/${i}`, soldDate: "2026-10-01", itemPrice, shipping: 1.49, notes: "Test fixture", verified: true, identityKey: canonicalCardKey(identity) })) } };
  draft.pricing!.approvedSnapshot = projectPricing(draft,today).snapshot;
  return draft;
}
test("approved Goodman handoff preserves seller, rounded economics and front-first ordering without authorizing writes", () => {
  const plan = prepareEbayDraftReview(approved(), today);
  assert.equal(plan.intendedSeller,"imaydit58"); assert.equal(plan.localReviewReady,true);
  assert.equal(plan.preparedReview!.price.value,"6.95"); assert.equal(plan.preparedReview!.buyerShippingCharge.value,"1.49");
  assert.deepEqual(plan.preparedReview!.sourceImageIds,["front","back"]);
  assert.deepEqual(plan.preparedReview!.promotion,{strategy:"GENERAL",ratePercent:3,enabled:true,estimatedFeeBeforeTax:0.25,requiresEbayVerification:true});
  assert.equal(plan.canCreateEbayOffer,false); assert.equal(plan.canPublish,false);
  assert.ok(plan.connectionRequirements.some(x=>x.includes("idempotency")));
});
test("price, photo, identity changes and expired comps withhold handoff despite prior approval", () => {
  for (const mutate of [(d:DraftCard)=>{d.pricing!.generalPromotionPercent=5;},(d:DraftCard)=>{d.pricing!.premiumPercent=10;},(d:DraftCard)=>{d.frontImageId="replacement";},(d:DraftCard)=>{d.identity.cardNumber="133";},(d:DraftCard)=>{d.verified=false;},(d:DraftCard)=>{d.pricing!.approvedSnapshot=undefined;}]) {
    const draft=approved(); mutate(draft); const result=prepareEbayDraftReview(draft,today);
    assert.equal(result.localReviewReady,false); assert.equal(result.preparedReview,null);
  }
  assert.equal(prepareEbayDraftReview(approved(),"2027-02-01").preparedReview,null);
});
