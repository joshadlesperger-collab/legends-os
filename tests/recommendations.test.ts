import assert from "node:assert/strict";
import test from "node:test";
import { buildRecommendation, getReliableMarketEvidence, type ListingRecord, type MarketEvidence } from "../lib/recommendations.ts";
import { formatRecommendationMoney } from "../lib/recommendation-display.ts";
import { isActionablePricingRecommendation } from "../lib/recommendation-queue.ts";
import { buildSearchQuery, mapSaleToComp } from "../lib/comp-validation/theCardApiProvider.ts";
import { capConfidenceForQuantity, confidenceBandForScore, selectEvidenceWindow } from "../lib/comp-validation/engine.ts";
import { parseCardIdentity } from "../lib/comp-validation/identity.ts";

const listing = (currentPrice: unknown): ListingRecord => ({
  id: "listing-1",
  storeId: "store-1",
  title: "2025 Example Player Gold /50 PSA 10",
  currentPrice,
  views: 20,
  watchers: 2,
  quantitySold: 0,
  quantity: 1,
  startTime: new Date("2026-08-01T00:00:00.000Z"),
  createdAt: new Date("2026-08-01T00:00:00.000Z"),
  store: { accountId: "account-1" },
});

const evidence = (marketValue: unknown, overrides: Partial<MarketEvidence> = {}): MarketEvidence => ({
  marketValue,
  acceptedCompCount: 4,
  confidenceScore: 78,
  confidenceBand: "moderate",
  source: "validated sold comps",
  observedAt: new Date("2026-08-14T00:00:00.000Z"),
  ...overrides,
});

test("production regression: Prisma Decimal-like prices never collapse to the one-dollar clamp", () => {
  const decimalLike = { toString: () => "64.95" };
  const result = buildRecommendation(listing(decimalLike), evidence(50));
  assert.equal(result.type, "lower-price");
  assert.equal(result.suggestedPrice, 50);
  assert.notEqual(result.suggestedPrice, 1);
});

test("missing or failed comp provider evidence produces no fabricated price", () => {
  for (const missing of [null, undefined]) {
    const result = buildRecommendation(listing(25), missing ?? null);
    assert.equal(result.type, "insufficient-data");
    assert.equal(result.suggestedPrice, null);
  }
});

test("invalid, zero, and null market values produce no fabricated price", () => {
  for (const value of ["not-a-number", 0, null]) {
    const result = buildRecommendation(listing(25), evidence(value));
    assert.equal(result.type, "insufficient-data");
    assert.equal(result.suggestedPrice, null);
  }
});

test("validated 25 dollar market evidence produces a supported recommendation", () => {
  const result = buildRecommendation(listing(35), evidence(25));
  assert.equal(result.type, "lower-price");
  assert.equal(result.suggestedPrice, 25);
  assert.match(result.reason, /4 validated sold comps/);
});

test("validated 100 dollar market evidence produces a supported recommendation", () => {
  const result = buildRecommendation(listing(80), evidence(100));
  assert.equal(result.type, "raise-price");
  assert.equal(result.suggestedPrice, 100);
});

test("cents and dollars retain exact decimal units", () => {
  assert.equal(buildRecommendation(listing("25.99"), evidence("24.50")).suggestedPrice, 24.5);
  assert.equal(formatRecommendationMoney("24.50"), "$24.50");
});

test("persisted unavailable recommendations render an explicit fail-closed message", () => {
  assert.equal(formatRecommendationMoney(null), "No reliable price recommendation");
  assert.equal(formatRecommendationMoney("NaN"), "No reliable price recommendation");
});

test("a legitimate one-dollar market recommendation requires reliable one-dollar evidence", () => {
  const result = buildRecommendation(listing(1.5), evidence(1));
  assert.equal(result.type, "lower-price");
  assert.equal(result.suggestedPrice, 1);
});

test("cached evidence fails closed unless fresh, sufficiently populated, and confident", () => {
  const now = new Date("2026-08-14T00:00:00.000Z");
  const quality = (result: Record<string, unknown>, updatedAt = "2026-08-13T00:00:00.000Z") => ({
    compValidation: { cache: { identity: { updatedAt, result } } },
  });
  const valid = { weightedRecentMarketValue: 25, acceptedCompCount: 3, confidenceScore: 70, confidenceBand: "moderate", providerId: "the-card-api" };
  assert.equal(getReliableMarketEvidence(quality(valid), "identity", now)?.marketValue, 25);
  assert.equal(getReliableMarketEvidence(quality({ ...valid, acceptedCompCount: 2 }), "identity", now), null);
  assert.equal(getReliableMarketEvidence(quality({ ...valid, confidenceScore: 49 }), "identity", now), null);
  assert.equal(getReliableMarketEvidence(quality(valid, "2026-06-01T00:00:00.000Z"), "identity", now), null);
});

test("only supported, confident, positive price changes belong in the action queue", () => {
  assert.equal(isActionablePricingRecommendation({ type: "lower-price", suggestedPrice: "25.00", confidence: 70 }), true);
  assert.equal(isActionablePricingRecommendation({ type: "raise-price", suggestedPrice: 100, confidence: 50 }), false);
  assert.equal(isActionablePricingRecommendation({ type: "raise-price", suggestedPrice: 100, confidence: 60 }), true);
  assert.equal(isActionablePricingRecommendation({ type: "insufficient-data", suggestedPrice: null, confidence: 0 }), false);
  assert.equal(isActionablePricingRecommendation({ type: "hold", suggestedPrice: null, confidence: 80 }), false);
  assert.equal(isActionablePricingRecommendation({ type: "end-relist", suggestedPrice: null, confidence: 90 }), false);
  assert.equal(isActionablePricingRecommendation({ type: "lower-price", suggestedPrice: 1, confidence: 49 }), false);
});

test("provider queries retain identity terms while removing listing noise", () => {
  const title = "2026 Bowman Chrome #CPA-CSC Caden Scarborough 1st Green Grass Auto /99";
  const query = buildSearchQuery(parseCardIdentity(title), title);
  assert.match(query, /2026 bowman caden scarborough/);
  assert.doesNotMatch(query, /\/99|auto|green/);
});

test("confirmed sold price remains usable when shipping is unknown without copying target identity", () => {
  const identity = parseCardIdentity("2025 Topps Mike Trout #10 PSA 10 Gold");
  const comp = mapSaleToComp({ sale: { id: "sale-1", title: "2025 Topps Mike Trout #10 PSA 10", price: 25, price_confirmed: true, currency: "USD", sale_date: "2026-08-14", shipping_price: null, grader: "PSA", grade: "10", card_number: "10", year: 2025 }, identity, providerName: "The Card API" });
  assert.ok(comp);
  assert.equal(comp!.soldPrice, 25);
  assert.equal(comp!.totalBuyerCost, null);
  assert.equal(comp!.attributes.parallel, null);
  assert.equal(comp!.priceConfirmed, true);
});

test("unconfirmed, non-USD, or dateless provider rows fail closed", () => {
  const identity = parseCardIdentity("2025 Topps Mike Trout #10");
  const base = { id: "sale", title: "2025 Topps Mike Trout #10", price: 25, sale_date: "2026-08-14" };
  assert.equal(mapSaleToComp({ sale: { ...base, price_confirmed: false }, identity, providerName: "The Card API" }), null);
  assert.equal(mapSaleToComp({ sale: { ...base, currency: "CAD" }, identity, providerName: "The Card API" }), null);
  assert.equal(mapSaleToComp({ sale: { ...base, sale_date: null }, identity, providerName: "The Card API" }), null);
});

test("confidence bands and adaptive evidence windows follow the V1 contract", () => {
  assert.equal(confidenceBandForScore(95, 5), "very-high");
  assert.equal(confidenceBandForScore(80, 5), "high");
  assert.equal(confidenceBandForScore(65, 3), "moderate");
  assert.equal(confidenceBandForScore(55, 3), "low");
  assert.equal(confidenceBandForScore(95, 2), "insufficient");
  assert.equal(selectEvidenceWindow([5, 30, 89, 160]), 90);
  assert.equal(selectEvidenceWindow([95, 120, 179, 250]), 180);
  assert.equal(selectEvidenceWindow([190, 220]), 365);
  assert.equal(capConfidenceForQuantity(98, 2), 39);
  assert.equal(capConfidenceForQuantity(98, 3), 74);
  assert.equal(capConfidenceForQuantity(98, 4), 89);
  assert.equal(capConfidenceForQuantity(98, 5), 98);
});

test("card identity does not mistake a leading year or product for the player",()=>{
  const identity=parseCardIdentity("2025 Topps Archives Nick Kurtz Blue Foil #145 /25 RC");
  assert.equal(identity.player,"nick kurtz");assert.equal(identity.year,2025);assert.equal(identity.setName,"topps archives");assert.equal(identity.cardNumber,"145");assert.equal(identity.serialNumber,null);assert.equal(identity.printRun,25);
});

test("serial identity preserves both card position and print run without fabrication",()=>{
  const identity=parseCardIdentity("Shohei Ohtani 2024 Topps Chrome Gold Refractor #1 12/50");
  assert.equal(identity.player,"shohei ohtani");assert.equal(identity.serialNumber,12);assert.equal(identity.printRun,50);assert.equal(identity.serialNumbered,true);assert.ok(identity.identityCompleteness>=80);
  const unknown=parseCardIdentity("Mystery Baseball Card");assert.equal(unknown.year,null);assert.ok(unknown.missingAttributes.includes("year"));
});
