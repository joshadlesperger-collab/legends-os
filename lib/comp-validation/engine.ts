import crypto from "crypto";
import { parseCardIdentity } from "@/lib/comp-validation/identity";
import { fixtureCompProvider } from "@/lib/comp-validation/fixtureProvider";
import { getProviderStatus, getProviderWeights } from "@/lib/comp-validation/provider";
import type {
  CohortBand,
  CohortItem,
  CompEvaluation,
  CompFeedbackEntry,
  CompSale,
  ListingForComp,
  MatchTier,
  TelemetryCounters,
  ValuationResult,
} from "@/lib/comp-validation/types";

const DAY_MS = 24 * 60 * 60 * 1000;

type CompValidationState = {
  feedback?: Record<string, CompFeedbackEntry>;
  cache?: Record<string, { stateHash: string; updatedAt: string; result: Pick<ValuationResult, "recommendedPrice" | "weightedRecentMarketValue" | "lowMarketRange" | "highMarketRange" | "confidenceScore" | "confidenceBand" | "trendDirection" | "trendPct" | "recommendationType" | "acceptedCompCount" | "excludedCompCount"> }>;
};

export function createTelemetry(): TelemetryCounters {
  return {
    dbReads: 0,
    dbWrites: 0,
    identitiesProcessed: 0,
    cacheHits: 0,
    cacheMisses: 0,
    externalProviderCalls: 0,
    compsRetrieved: 0,
  };
}

function round2(value: number) {
  return Math.round(value * 100) / 100;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function mean(values: number[]) {
  if (!values.length) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(values: number[], p: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (p / 100) * (sorted.length - 1);
  const low = Math.floor(index);
  const high = Math.ceil(index);
  if (low === high) return sorted[low];
  const frac = index - low;
  return sorted[low] + (sorted[high] - sorted[low]) * frac;
}

function weightedMean(values: Array<{ value: number; weight: number }>) {
  const totalWeight = values.reduce((sum, row) => sum + row.weight, 0);
  if (totalWeight <= 0) return 0;
  return values.reduce((sum, row) => sum + row.value * row.weight, 0) / totalWeight;
}

function weightedMedian(values: Array<{ value: number; weight: number }>) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a.value - b.value);
  const total = sorted.reduce((sum, row) => sum + row.weight, 0);
  if (total <= 0) return median(sorted.map((row) => row.value));
  let cumulative = 0;
  for (const row of sorted) {
    cumulative += row.weight;
    if (cumulative >= total / 2) return row.value;
  }
  return sorted[sorted.length - 1].value;
}

function recencyWeight(daysSinceSale: number, exactRecentCount: number) {
  let weight: number;
  if (daysSinceSale <= 30) weight = 1;
  else if (daysSinceSale <= 90) weight = 0.7 - (0.4 * (daysSinceSale - 30)) / 60;
  else if (daysSinceSale <= 180) weight = 0.3 - (0.2 * (daysSinceSale - 90)) / 90;
  else if (daysSinceSale <= 365) weight = 0.1 - (0.09 * (daysSinceSale - 180)) / 185;
  else weight = 0.01;

  if (exactRecentCount >= 4 && daysSinceSale > 90) weight *= 0.2;
  if (exactRecentCount >= 6 && daysSinceSale > 180) weight *= 0.1;
  return clamp(weight, 0.001, 1);
}

function getMatchScore(sale: CompSale, target: ReturnType<typeof parseCardIdentity>) {
  let score = 0;
  const saleIdentity = sale.attributes;

  if (saleIdentity.rawOrGraded === target.rawOrGraded) score += 15;
  if (saleIdentity.rookie === target.rookie) score += 10;
  if (saleIdentity.autograph === target.autograph) score += 10;
  if (saleIdentity.patch === target.patch) score += 8;
  if ((saleIdentity.parallel ?? "") === (target.parallel ?? "")) score += 12;
  if ((saleIdentity.variation ?? "") === (target.variation ?? "")) score += 8;
  if (saleIdentity.serialNumbered === target.serialNumbered) score += 8;

  const sameGradeCompany = (saleIdentity.gradeCompany ?? "") === (target.gradeCompany ?? "");
  if (sameGradeCompany) score += 10;
  if (saleIdentity.gradeValue != null && target.gradeValue != null) {
    const delta = Math.abs(saleIdentity.gradeValue - target.gradeValue);
    score += Math.max(0, 10 - 2 * delta);
  }

  if (target.baseCardKey.length > 0) score += 19;

  return clamp(Math.round(score), 0, 100);
}

function classifyTier(score: number, sale: CompSale, target: ReturnType<typeof parseCardIdentity>): MatchTier | null {
  if (sale.attributes.rawOrGraded !== target.rawOrGraded) {
    return score >= 40 ? "fallback" : null;
  }
  if (score >= 90) return "exact";
  if (score >= 70) return "near-exact";
  if (score >= 40) return "fallback";
  return null;
}

function duplicateGroupKey(sale: CompSale) {
  const soldDate = new Date(sale.soldDate).toISOString().slice(0, 10);
  const total = sale.totalBuyerCost ?? sale.soldPrice;
  const grade = `${sale.attributes.gradeCompany ?? "none"}:${sale.attributes.gradeValue ?? "none"}`;
  return [soldDate, round2(total).toFixed(2), grade, sale.attributes.rawOrGraded].join("|");
}

function hashState(input: unknown) {
  return crypto.createHash("sha1").update(JSON.stringify(input)).digest("hex");
}

function getCompState(listingQuality: unknown): CompValidationState {
  const record = listingQuality && typeof listingQuality === "object" ? (listingQuality as Record<string, unknown>) : {};
  const state = record.compValidation;
  if (!state || typeof state !== "object") return {};
  return state as CompValidationState;
}

export function mergeCompState(listingQuality: unknown, state: CompValidationState): Record<string, unknown> {
  const record = listingQuality && typeof listingQuality === "object" ? { ...(listingQuality as Record<string, unknown>) } : {};
  record.compValidation = state;
  return record;
}

function confidenceBand(score: number, acceptedCompCount: number) {
  if (score < 30 || acceptedCompCount < 3) return "insufficient" as const;
  if (score >= 75) return "high" as const;
  if (score >= 50) return "moderate" as const;
  return "low" as const;
}

function recommendationType(input: {
  confidence: number;
  acceptedCompCount: number;
  currentPrice: number;
  recommendedPrice: number | null;
  tierOnlyFallback: boolean;
}): "raise-price" | "lower-price" | "hold" | "insufficient-data" {
  const { confidence, acceptedCompCount, currentPrice, recommendedPrice, tierOnlyFallback } = input;
  if (recommendedPrice == null) return "insufficient-data";
  if (confidence < 30 || acceptedCompCount < 3) return "insufficient-data";

  if (tierOnlyFallback && confidence < 50) return "hold";

  const ratio = currentPrice / Math.max(0.01, recommendedPrice);
  let raiseThreshold = 0.88;
  let lowerThreshold = 1.12;

  if (confidence >= 75) {
    raiseThreshold = 0.92;
    lowerThreshold = 1.08;
  } else if (confidence < 50) {
    raiseThreshold = 0.85;
    lowerThreshold = 1.15;
  }

  if (ratio <= raiseThreshold) return "raise-price";
  if (ratio >= lowerThreshold) return "lower-price";
  return "hold";
}

function evaluateOutliers(values: number[], sampleSize: number) {
  const med = median(values);
  const deviations = values.map((value) => Math.abs(value - med));
  const mad = median(deviations);
  const q1 = percentile(values, 25);
  const q3 = percentile(values, 75);
  const iqr = q3 - q1;

  let span = Math.max(3 * mad, 1.5 * iqr, med * 0.15);
  if (sampleSize >= 3 && sampleSize <= 4) {
    span = Math.max(4 * mad, med * 0.2);
  }

  return {
    lower: med - span,
    upper: med + span,
    median: med,
  };
}

export async function buildValuation(input: {
  listing: ListingForComp;
  telemetry: TelemetryCounters;
  identityResultCache: Map<string, ValuationResult>;
}) {
  const { listing, telemetry, identityResultCache } = input;

  const provider = getProviderStatus();
  const providerWeights = getProviderWeights();
  const parsedIdentity = parseCardIdentity(listing.title);

  telemetry.identitiesProcessed += 1;

  const state = getCompState(listing.listingQuality);
  const feedback = state.feedback ?? {};

  if (identityResultCache.has(parsedIdentity.identityHash)) {
    telemetry.cacheHits += 1;
    const cached = identityResultCache.get(parsedIdentity.identityHash)!;
    const copied: ValuationResult = {
      ...cached,
      listingId: listing.id,
      listingTitle: listing.title,
      currentPrice: listing.currentPrice,
    };
    return { result: copied, compState: state };
  }

  telemetry.cacheMisses += 1;
  telemetry.externalProviderCalls += 1;

  const comps = await fixtureCompProvider.searchSoldComps({
    identity: parsedIdentity,
    listingTitle: listing.title,
    maxResults: 40,
  });

  telemetry.compsRetrieved += comps.length;

  const now = Date.now();

  const exactRecentCount = comps.filter((comp) => {
    const days = Math.max(0, Math.floor((now - new Date(comp.soldDate).getTime()) / DAY_MS));
    const score = getMatchScore(comp, parsedIdentity);
    const tier = classifyTier(score, comp, parsedIdentity);
    return tier === "exact" && days <= 30;
  }).length;

  const duplicateGroups = new Map<string, CompSale[]>();
  for (const comp of comps) {
    const key = duplicateGroupKey(comp);
    const list = duplicateGroups.get(key) ?? [];
    list.push(comp);
    duplicateGroups.set(key, list);
  }

  const duplicateCanonical = new Set<string>();
  const duplicateIds = new Map<string, string>();
  duplicateGroups.forEach((list, group) => {
    if (list.length === 1) {
      duplicateCanonical.add(list[0].compKey);
      return;
    }
    list.sort((a, b) => (a.providerId < b.providerId ? -1 : 1));
    duplicateCanonical.add(list[0].compKey);
    for (const row of list) duplicateIds.set(row.compKey, group);
  });

  const evaluated: CompEvaluation[] = [];

  for (const comp of comps) {
    const score = getMatchScore(comp, parsedIdentity);
    const tier = classifyTier(score, comp, parsedIdentity);
    const duplicateGroupId = duplicateIds.get(comp.compKey) ?? null;

    const days = Math.max(0, Math.floor((now - new Date(comp.soldDate).getTime()) / DAY_MS));
    const recency = recencyWeight(days, exactRecentCount);
    const providerWeight = providerWeights[comp.providerId] ?? 0.8;

    let inclusionStatus: "accepted" | "excluded" = "accepted";
    let inclusionReason = "accepted for valuation";
    let exclusionReason: string | null = null;

    if (!duplicateCanonical.has(comp.compKey)) {
      inclusionStatus = "excluded";
      inclusionReason = "duplicate sale"
      exclusionReason = "duplicate-sale-detected";
    }

    if (!tier) {
      inclusionStatus = "excluded";
      inclusionReason = "match below fallback threshold";
      exclusionReason = "low-match-score";
    }

    if (comp.totalBuyerCost == null) {
      inclusionReason = "accepted with unknown shipping";
    }

    const feedbackEntry = feedback[comp.compKey];
    if (feedbackEntry?.excluded) {
      inclusionStatus = "excluded";
      inclusionReason = "seller excluded comp";
      exclusionReason = feedbackEntry.reason || "seller-manual-exclusion";
    }

    const tierWeight = tier === "exact" ? 1 : tier === "near-exact" ? 0.8 : 0.5;
    const finalWeight = recency * providerWeight * tierWeight;

    evaluated.push({
      compKey: comp.compKey,
      providerId: comp.providerId,
      providerName: comp.providerName,
      sourceItemId: comp.sourceItemId,
      sourceUrl: comp.sourceUrl,
      soldTitle: comp.soldTitle,
      soldDate: comp.soldDate,
      soldPrice: comp.soldPrice,
      shipping: comp.shipping,
      buyerPremium: comp.buyerPremium,
      totalBuyerCost: comp.totalBuyerCost,
      matchTier: tier ?? "fallback",
      matchScore: score,
      inclusionStatus,
      inclusionReason,
      exclusionReason,
      recencyWeight: recency,
      providerWeight,
      finalWeight,
      duplicateGroupId,
    });
  }

  const acceptedBeforeOutlier = evaluated.filter((comp) => comp.inclusionStatus === "accepted" && comp.totalBuyerCost != null);
  const totalValues = acceptedBeforeOutlier.map((comp) => comp.totalBuyerCost as number);

  if (totalValues.length >= 3) {
    const bounds = evaluateOutliers(totalValues, totalValues.length);

    for (const comp of evaluated) {
      if (comp.inclusionStatus !== "accepted" || comp.totalBuyerCost == null) continue;
      const value = comp.totalBuyerCost;

      const isExactAuction = comp.matchTier === "exact" && /sold example/i.test(comp.soldTitle);
      const outside = value < bounds.lower || value > bounds.upper;
      if (!outside) continue;

      if (isExactAuction && totalValues.length <= 5) {
        continue;
      }

      comp.inclusionStatus = "excluded";
      comp.inclusionReason = "auto-excluded outlier";
      comp.exclusionReason = value < bounds.lower ? "outlier-low" : "outlier-high";
    }
  }

  const accepted = evaluated.filter((comp) => comp.inclusionStatus === "accepted");
  const acceptedCosts = accepted
    .filter((comp) => comp.totalBuyerCost != null)
    .map((comp) => ({ value: comp.totalBuyerCost as number, weight: comp.finalWeight }));

  const acceptedKnownCosts = acceptedCosts.map((row) => row.value);
  const unknownShippingAccepted = accepted.some((comp) => comp.totalBuyerCost == null);

  const weightedMarket = acceptedCosts.length
    ? acceptedCosts.length >= 3
      ? weightedMedian(acceptedCosts)
      : weightedMean(acceptedCosts)
    : null;

  const low = acceptedKnownCosts.length
    ? acceptedKnownCosts.length >= 5
      ? percentile(acceptedKnownCosts, 15)
      : Math.min(...acceptedKnownCosts)
    : null;
  const high = acceptedKnownCosts.length
    ? acceptedKnownCosts.length >= 5
      ? percentile(acceptedKnownCosts, 85)
      : Math.max(...acceptedKnownCosts)
    : null;

  const recentCosts = accepted
    .filter((comp) => now - new Date(comp.soldDate).getTime() <= 30 * DAY_MS && comp.totalBuyerCost != null)
    .map((comp) => ({ value: comp.totalBuyerCost as number, weight: comp.finalWeight }));
  const priorCosts = accepted
    .filter((comp) => {
      const days = (now - new Date(comp.soldDate).getTime()) / DAY_MS;
      return days > 30 && days <= 90 && comp.totalBuyerCost != null;
    })
    .map((comp) => ({ value: comp.totalBuyerCost as number, weight: comp.finalWeight }));

  const recentMedian = recentCosts.length ? weightedMedian(recentCosts) : null;
  const priorMedian = priorCosts.length ? weightedMedian(priorCosts) : null;
  const trendPct = recentMedian != null && priorMedian != null && priorMedian > 0 ? ((recentMedian / priorMedian) - 1) * 100 : 0;
  const trendDirection = trendPct >= 8 ? "up" : trendPct <= -8 ? "down" : "flat";

  const exactCount = accepted.filter((comp) => comp.matchTier === "exact").length;
  const nearCount = accepted.filter((comp) => comp.matchTier === "near-exact").length;
  const fallbackCount = accepted.filter((comp) => comp.matchTier === "fallback").length;

  const baseEvidence = Math.min(60, exactCount * 15 + nearCount * 8 + fallbackCount * 4);
  const recencyBonus = Math.min(20, exactRecentCount * 8 + nearCount * 2);
  const sourceBonus = Math.round(20 * mean(accepted.map((comp) => comp.providerWeight)));

  const spreadPct = weightedMarket && low != null && high != null ? ((high - low) / weightedMarket) * 100 : 999;
  const dispersionPenalty = spreadPct > 30 ? 15 : spreadPct > 20 ? 8 : 0;
  const fallbackOnly = accepted.length > 0 && accepted.every((comp) => comp.matchTier === "fallback");
  const fallbackPenalty = fallbackOnly ? 25 : fallbackCount > exactCount + nearCount ? 10 : 0;
  const unknownShippingPenalty = unknownShippingAccepted ? 15 : 0;

  let confidence = clamp(baseEvidence + recencyBonus + sourceBonus - dispersionPenalty - fallbackPenalty - unknownShippingPenalty, 0, 100);
  if (accepted.length < 3) confidence = Math.min(confidence, 49);

  const targetShipping: number | null = null;
  const targetShippingKnown = false;
  const targetShippingAdjustment = targetShippingKnown && targetShipping != null ? targetShipping : 0;

  const recommendedPrice = weightedMarket == null
    ? null
    : Math.max(0.01, round2(weightedMarket - targetShippingAdjustment));

  const confidenceBandValue = confidenceBand(confidence, accepted.length);
  const recoType = recommendationType({
    confidence,
    acceptedCompCount: accepted.length,
    currentPrice: listing.currentPrice,
    recommendedPrice,
    tierOnlyFallback: fallbackOnly,
  });

  const notes: string[] = [];
  if (!targetShippingKnown) notes.push("Target listing shipping is unknown and confidence is reduced.");
  if (unknownShippingAccepted) notes.push("One or more accepted comps have unknown shipping; totals remain explicitly unknown.");
  if (provider.mode === "fixture") notes.push("Fixture provider mode is active until an authorized sold-data API is configured.");

  const payload = {
    listingId: listing.id,
    listingTitle: listing.title,
    identityHash: parsedIdentity.identityHash,
    recommendedPrice,
    weightedMarket,
    low,
    high,
    confidence,
    confidenceBand: confidenceBandValue,
    trendDirection,
    trendPct: round2(trendPct),
    recommendationType: recoType,
    accepted: accepted.length,
    excluded: evaluated.length - accepted.length,
    notes,
  };

  const result: ValuationResult = {
    listingId: listing.id,
    listingTitle: listing.title,
    parsedIdentity,
    provider,
    currentPrice: listing.currentPrice,
    targetShipping,
    targetShippingKnown,
    recommendedPrice,
    weightedRecentMarketValue: weightedMarket == null ? null : round2(weightedMarket),
    lowMarketRange: low == null ? null : round2(low),
    highMarketRange: high == null ? null : round2(high),
    trendDirection,
    trendPct: round2(trendPct),
    confidenceScore: Math.round(confidence),
    confidenceBand: confidenceBandValue,
    recommendationType: recoType,
    acceptedCompCount: accepted.length,
    excludedCompCount: evaluated.length - accepted.length,
    comps: evaluated.sort((a, b) => new Date(b.soldDate).getTime() - new Date(a.soldDate).getTime()),
    notes,
    stateHash: hashState(payload),
  };

  identityResultCache.set(parsedIdentity.identityHash, result);

  return { result, compState: state };
}

export function computeListingComplexity(listing: ListingForComp) {
  const title = listing.title.toLowerCase();
  let score = 0;
  if (/psa|bgs|sgc|cgc/.test(title)) score += 2;
  if (/auto|autograph|patch|jersey/.test(title)) score += 2;
  if (/refractor|prizm|xfractor|mojo|wave|gold|silver|red|blue|green|black/.test(title)) score += 2;
  if (/\d+\s*\/\s*\d+/.test(title)) score += 2;
  if (/rookie|\brc\b/.test(title)) score += 1;
  if ((listing.views ?? 0) > 30) score += 1;
  if ((listing.watchers ?? 0) > 5) score += 1;
  if (listing.currentPrice >= 100) score += 2;
  return score;
}

function pickBand(listing: ListingForComp): CohortBand | null {
  if (listing.currentPrice >= 100) return ">=100";
  if (listing.currentPrice >= 50) return "50-99.99";
  if (listing.currentPrice >= 20) return "20-49.99";
  return null;
}

function sortForCohort(items: ListingForComp[]) {
  return [...items].sort((a, b) => {
    const c = computeListingComplexity(b) - computeListingComplexity(a);
    if (c !== 0) return c;
    return b.currentPrice - a.currentPrice;
  });
}

export function buildValidationCohort(listings: ListingForComp[]): CohortItem[] {
  const band100 = sortForCohort(listings.filter((row) => pickBand(row) === ">=100")).slice(0, 20);
  const band50 = sortForCohort(listings.filter((row) => pickBand(row) === "50-99.99")).slice(0, 15);
  const band20 = sortForCohort(listings.filter((row) => pickBand(row) === "20-49.99")).slice(0, 10);

  const selected = new Set([...band100, ...band50, ...band20].map((row) => row.id));

  const edgeCases = sortForCohort(
    listings.filter((row) => !selected.has(row.id))
  )
    .slice(0, 5);

  const withBand = (row: ListingForComp, band: CohortBand): CohortItem => ({
    listingId: row.id,
    title: row.title,
    currentPrice: row.currentPrice,
    quantity: row.quantity,
    quantitySold: row.quantitySold,
    views: row.views,
    watchers: row.watchers,
    condition: row.condition,
    listingFormat: row.listingFormat,
    band,
    complexityScore: computeListingComplexity(row),
    expectedDollarImpact: null,
  });

  return [
    ...band100.map((row) => withBand(row, ">=100")),
    ...band50.map((row) => withBand(row, "50-99.99")),
    ...band20.map((row) => withBand(row, "20-49.99")),
    ...edgeCases.map((row) => withBand(row, "edge-case")),
  ];
}

export function updateExpectedDollarImpact(item: CohortItem, recommendedPrice: number | null): CohortItem {
  if (recommendedPrice == null) {
    return { ...item, expectedDollarImpact: null };
  }
  return {
    ...item,
    expectedDollarImpact: round2(Math.abs(recommendedPrice - item.currentPrice) * Math.max(1, item.quantity)),
  };
}
