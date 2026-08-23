import assert from "node:assert/strict";
import test from "node:test";
import { buildWeekendTrafficSprint } from "../lib/weekend-traffic-sprint.ts";
import type { SalesVelocityEvidence } from "../lib/sales-velocity.ts";
import type { ListingCompletenessAssessment } from "../lib/listing-completeness-agent.ts";

function evidence(id: string, overrides: Partial<SalesVelocityEvidence> = {}): SalesVelocityEvidence {
  return { listingId: id, ebayItemId: id, title: `2025 Topps Baseball Player #${id}`, imageUrl: null, currentPrice: 20, quantity: 1, ageDays: 30, knownUnitCost: null, costComplete: false, estimatedGrossSpread: null, marginGuardrail: "Unknown", units30: 0, units90: 0, traffic: { impressions: 5, views: 1, clickThroughRate: 20, transactions: 0, conversionRate: 0, observedAt: new Date().toISOString(), windowStart: new Date().toISOString(), windowEnd: new Date().toISOString() }, watchers: { value: null, quality: "missing", observedAt: null }, offerEligibility: { eligible: false, observedAt: null }, advertising: { eligible: true, programStatus: "ELIGIBLE", campaignId: "c", campaignName: "pilot", campaignStatus: "RUNNING", adId: "a", adStatus: "ACTIVE", adRate: 5, observedAt: new Date().toISOString() }, valuation: { suggestedPrice: null, confidence: null, action: null }, freshness: { overall: "supported", generatedAt: new Date().toISOString() }, decision: { action: "MANUAL REVIEW", funnel: "Exposure", confidence: { score: 50, band: "low" }, why: "test", alternatives: [], missingEvidence: [], observationWindowDays: 7 }, ...overrides } as SalesVelocityEvidence;
}
function assessment(id: string, overrides: Partial<ListingCompletenessAssessment> = {}): ListingCompletenessAssessment {
  return { listingId: id, ebayItemId: id, title: `Card ${id}`, categoryId: "261328", score: 50, disposition: "COMPLETE", beforeState: {}, proposedPatch: [], missingFields: [], malformedFields: [], conflicts: [], categoryRequirements: { available: true, required: [], recommended: [] }, authoritative: true, ruleVersion: "test", parserVersion: "test", assessedAt: new Date().toISOString(), reason: "test", ...overrides };
}

test("safe metadata treatment excludes review-gated patches", () => {
  const safe = assessment("1", { disposition: "AUTO-FIX", proposedPatch: [{ field: "Season", targetAspect: "Season", semanticFamily: "year", before: null, proposed: "2025", confidence: 99, disposition: "AUTO-FIX", reason: "exact", evidence: [] }] });
  const sensitive = assessment("2", { disposition: "REVIEW", proposedPatch: [{ field: "Parallel/Variety", targetAspect: "Parallel/Variety", semanticFamily: null, before: null, proposed: "Gold", confidence: 99, disposition: "REVIEW", reason: "sensitive", evidence: [] }] });
  const result = buildWeekendTrafficSprint([evidence("1"), evidence("2")], [safe, sensitive]);
  assert.deepEqual(result.cohortA.map((row) => row.ebayItemId), ["1"]);
  assert.equal(result.cohortA[0]?.proposedAction, "Season → 2025");
});

test("low-exposure ad treatment gets a matched control and warns on unknown economics", () => {
  const highTraffic = evidence("3");
  highTraffic.traffic = { ...highTraffic.traffic!, impressions: 500 };
  const rows = [evidence("1"), evidence("2"), highTraffic];
  const result = buildWeekendTrafficSprint(rows, rows.map((row) => assessment(row.listingId)));
  assert.equal(result.cohortB.length, 1);
  assert.equal(result.cohortC.filter((row) => row.matchedFor === "B_AD_TEST").length, 1);
  assert.match(result.cohortB[0]!.proposedAction, /\+3 points/);
  assert.match(result.cohortB[0]!.economicsWarning, /Cost basis is incomplete/);
});

test("unknown category, missing traffic, and high-value ambiguity fail closed", () => {
  const rows = [evidence("1"), evidence("2", { traffic: null }), evidence("3", { currentPrice: 500 })];
  const result = buildWeekendTrafficSprint(rows, [assessment("1", { categoryId: null }), assessment("2"), assessment("3")]);
  assert.equal(result.cohortA.length + result.cohortB.length, 0);
  assert.equal(result.excluded.unsafeIdentity, 1);
  assert.equal(result.excluded.missingTraffic, 1);
  assert.equal(result.excluded.highValueAmbiguity, 1);
});
