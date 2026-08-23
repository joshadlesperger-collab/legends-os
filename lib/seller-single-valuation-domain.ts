import type { ValuationResult } from "./comp-validation/types.ts";

export const SINGLE_VALUATION_VERSION = "canonical-seller-single-v2.2-free-ladder";
export const SALES_TAX_RATE = 0.08;
export const SHIPPING_PER_CARD = 1.05;

export type CompConfidence = "High" | "Medium" | "Low";
export type AcquisitionRecommendation = "BUY" | "WATCH" | "PASS";

const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

export function acquisitionEconomics(currentBid: number, estimatedMarketValue: number | null) {
  const currentLandedCost = round2(currentBid * (1 + SALES_TAX_RATE) + SHIPPING_PER_CARD);
  if (estimatedMarketValue == null || !Number.isFinite(estimatedMarketValue) || estimatedMarketValue <= 0) {
    return { currentLandedCost, projectedGrossProfit: null, projectedRoi: null, maxBid: null, bidCushion: null };
  }
  const projectedGrossProfit = round2(estimatedMarketValue - currentLandedCost);
  const projectedRoi = currentLandedCost > 0 ? round2(projectedGrossProfit / currentLandedCost * 100) : null;
  const maxBid = round2(Math.max(0, (estimatedMarketValue / 2 - SHIPPING_PER_CARD) / (1 + SALES_TAX_RATE)));
  return { currentLandedCost, projectedGrossProfit, projectedRoi, maxBid, bidCushion: round2(maxBid - currentBid) };
}

export function acquisitionConfidence(result: ValuationResult): CompConfidence {
  if (result.confidenceBand === "very-high" || result.confidenceBand === "high") return "High";
  if (result.confidenceBand === "moderate") return "Medium";
  return "Low";
}

export function acquisitionRecommendation(input: {
  estimatedMarketValue: number | null;
  currentLandedCost: number;
  confidence: CompConfidence;
  acceptedSoldComps: number;
  exactOrNearComps: number;
}): AcquisitionRecommendation {
  if (input.estimatedMarketValue == null) return "WATCH";
  const clearsTarget = input.estimatedMarketValue >= 2 * input.currentLandedCost;
  if (!clearsTarget) return "PASS";
  if (input.confidence === "Low" || input.acceptedSoldComps < 2 || input.exactOrNearComps < 2) return "WATCH";
  return "BUY";
}

export function valuationRationale(result: ValuationResult, confidence: CompConfidence) {
  if (result.recommendedPrice == null) return "No defensible sold-comp estimate; held for review without a manufactured value.";
  const match = result.exactMatchCount > 0
    ? `${result.exactMatchCount} exact and ${result.nearExactMatchCount} near-exact sold comps`
    : `${result.nearExactMatchCount} near-exact sold comps and weaker proxy evidence`;
  const freshness = result.newestCompDate ? `newest ${new Date(result.newestCompDate).toISOString().slice(0, 10)}` : "sale dates unavailable";
  return `${confidence} confidence from ${match}; ${freshness}; weighted sold-market estimate with stale, duplicate, and outlier evidence excluded.`;
}

export function buildSingleValuationSnapshot(result: ValuationResult, currentBid: number, valuedAt = new Date(), options: { persistProviderRecords?: boolean } = {}) {
  const estimatedMarketValue = result.recommendedPrice;
  const confidence = acquisitionConfidence(result);
  const economics = acquisitionEconomics(currentBid, estimatedMarketValue);
  const recommendation = acquisitionRecommendation({
    estimatedMarketValue,
    currentLandedCost: economics.currentLandedCost,
    confidence,
    acceptedSoldComps: result.acceptedCompCount,
    exactOrNearComps: result.exactMatchCount + result.nearExactMatchCount,
  });
  return {
    version: SINGLE_VALUATION_VERSION,
    valuedAt: valuedAt.toISOString(),
    evidenceStateHash: result.stateHash,
    estimatedMarketValue,
    compConfidence: confidence,
    confidenceScore: result.confidenceScore,
    rationale: valuationRationale(result, confidence),
    currentBid: round2(currentBid),
    ...economics,
    recommendation,
    assumptions: { salesTaxRate: SALES_TAX_RATE, shippingPerCard: SHIPPING_PER_CARD, targetLandedCostMultiple: 2 },
    evidence: {
      provider: result.provider,
      sources: result.evidenceSources,
      observedAt: result.evidenceObservedAt,
      windowDays: result.evidenceWindowDays,
      acceptedCompCount: result.acceptedCompCount,
      excludedCompCount: result.excludedCompCount,
      exactMatchCount: result.exactMatchCount,
      nearExactMatchCount: result.nearExactMatchCount,
      newestCompDate: result.newestCompDate,
      oldestCompDate: result.oldestCompDate,
      marketRange: { low: result.lowMarketRange, high: result.highMarketRange },
      medianSoldPrice: result.medianSoldPrice,
      dispersionPct: result.priceDispersionPct,
      confidenceComponents: result.confidenceComponents,
      queryStrategyVersion: result.queryStrategyVersion ?? null,
      queryAudit: result.queryAudit ?? [],
      evidenceRetention: options.persistProviderRecords ? "provider-plan-allows-persistent-records" : "derived-summary-only-provider-records-transient",
      comps: options.persistProviderRecords ? result.comps : [],
      exclusionSummary: Object.fromEntries(result.comps.filter((comp) => comp.inclusionStatus === "excluded").reduce((map, comp) => map.set(comp.exclusionReason ?? "unspecified", (map.get(comp.exclusionReason ?? "unspecified") ?? 0) + 1), new Map<string, number>())),
      notes: result.notes,
    },
    parsedIdentity: result.parsedIdentity,
  };
}
