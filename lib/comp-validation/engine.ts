import crypto from "crypto";
import { parseCardIdentity } from "./identity.ts";
import { fixtureCompProvider } from "./fixtureProvider.ts";
import { getProviderStatus, getProviderWeights } from "./provider.ts";
import type { CompProviderAdapter } from "./provider.ts";
import { theCardApiProvider } from "./theCardApiProvider.ts";
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
  ProviderStatus,
} from "./types.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

export type CompValidationState = {
  feedback?: Record<string, CompFeedbackEntry>;
  cache?: Record<string, { stateHash: string; updatedAt: string; result: Omit<Pick<ValuationResult, "recommendedPrice" | "weightedRecentMarketValue" | "lowMarketRange" | "highMarketRange" | "confidenceScore" | "confidenceBand" | "trendDirection" | "trendPct" | "recommendationType" | "acceptedCompCount" | "excludedCompCount" | "newestCompDate" | "oldestCompDate" | "evidenceSources" | "evidenceWindowDays" | "medianSoldPrice" | "meanSoldPrice" | "priceDispersionPct" | "exactMatchCount" | "nearExactMatchCount" | "confidenceComponents" | "evidenceObservedAt">, never> & { providerId?: string } }>;
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

function normalized(value: string | null | undefined) {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function titleSimilarity(soldTitle: string, target: ReturnType<typeof parseCardIdentity>) {
  const ignored = new Set(["the", "and", "card", "sports", "baseball", "football", "basketball", "hockey", "rookie", "rc"]);
  const targetTokens = new Set(normalized(target.setName).split(" ").filter((token) => token.length > 1 && !ignored.has(token)));
  const soldTokens = new Set(normalized(soldTitle).split(" ").filter((token) => token.length > 1 && !ignored.has(token)));
  if (!targetTokens.size) return 0;
  return Array.from(targetTokens).filter((token) => soldTokens.has(token)).length / targetTokens.size;
}

function getMatchScore(sale: CompSale, target: ReturnType<typeof parseCardIdentity>) {
  let score = 0;
  const saleIdentity = sale.attributes;

  if (!sale.priceConfirmed || sale.currency !== "USD") return 0;
  if (target.year == null || saleIdentity.year == null || target.year !== saleIdentity.year) return 0;
  if (!target.player || !saleIdentity.player || normalized(target.player) !== normalized(saleIdentity.player)) return 0;
  if (!target.setName || !saleIdentity.setName || normalized(target.setName) !== normalized(saleIdentity.setName)) return 0;
  if (target.cardNumber && saleIdentity.cardNumber && normalized(target.cardNumber) !== normalized(saleIdentity.cardNumber)) return 0;
  if (target.rawOrGraded !== saleIdentity.rawOrGraded) return 0;
  if (target.gradeCompany && normalized(target.gradeCompany) !== normalized(saleIdentity.gradeCompany)) return 0;
  if (target.gradeValue != null && saleIdentity.gradeValue != null && Math.abs(target.gradeValue - saleIdentity.gradeValue) > 0.01) return 0;
  if (normalized(target.parallel) !== normalized(saleIdentity.parallel)) return 0;
  if(target.rookie!==saleIdentity.rookie)return 0;
  if(target.serialNumbered!==saleIdentity.serialNumbered)return 0;
  if(target.printRun!=null&&saleIdentity.printRun!==target.printRun)return 0;
  if(target.autograph!==saleIdentity.autograph||target.patch!==saleIdentity.patch)return 0;
  if((target.variation??null)!==(saleIdentity.variation??null))return 0;

  const similarity = titleSimilarity(sale.soldTitle, target);
  if (similarity < 0.45 && !(target.cardNumber && saleIdentity.cardNumber)) return 0;

  score += 15;
  score += Math.round(similarity * 30);
  if (target.year != null && saleIdentity.year === target.year) score += 10;
  if (target.cardNumber && normalized(target.cardNumber) === normalized(saleIdentity.cardNumber)) score += 20;
  if (target.manufacturer && normalized(target.manufacturer) === normalized(saleIdentity.manufacturer)) score += 5;
  if (saleIdentity.rookie === target.rookie) score += 10;
  if (saleIdentity.autograph === target.autograph) score += 10;
  if (saleIdentity.patch === target.patch) score += 8;
  if ((saleIdentity.parallel ?? "") === (target.parallel ?? "")) score += 12;
  if ((saleIdentity.variation ?? "") === (target.variation ?? "")) score += 8;
  if (saleIdentity.serialNumbered === target.serialNumbered) score += 8;

  const sameGradeCompany = normalized(saleIdentity.gradeCompany) === normalized(target.gradeCompany);
  if (sameGradeCompany && target.gradeCompany) score += 10;
  if (saleIdentity.gradeValue != null && target.gradeValue != null) {
    const delta = Math.abs(saleIdentity.gradeValue - target.gradeValue);
    score += Math.max(0, 10 - 2 * delta);
  }

  return clamp(Math.round(score), 0, 100);
}

function getMatchFailureReason(sale: CompSale, target: ReturnType<typeof parseCardIdentity>): string | null {
  const attrs = sale.attributes;
  if (!sale.priceConfirmed) return "missing-sale-confirmation";
  if (sale.currency !== "USD") return "non-usd";
  if (target.year == null || attrs.year == null) return "missing-year";
  if (target.year !== attrs.year) return "wrong-year";
  if (!target.player || !attrs.player) return "missing-player";
  if(normalized(target.player)!==normalized(attrs.player))return "different-player";
  if(!target.setName||!attrs.setName)return "missing-product";
  if(normalized(target.setName)!==normalized(attrs.setName))return "different-product";
  if (target.cardNumber && attrs.cardNumber && normalized(target.cardNumber) !== normalized(attrs.cardNumber)) return "different-card-number";
  if (target.rawOrGraded !== attrs.rawOrGraded) return "wrong-grade-format";
  if (target.gradeCompany && normalized(target.gradeCompany) !== normalized(attrs.gradeCompany)) return "wrong-grading-company";
  if (target.gradeValue != null && attrs.gradeValue != null && Math.abs(target.gradeValue - attrs.gradeValue) > 0.01) return "wrong-grade";
  if (normalized(target.parallel) !== normalized(attrs.parallel)) return "different-parallel";
  if(target.rookie!==attrs.rookie)return "different-rookie-status";
  if(target.serialNumbered!==attrs.serialNumbered)return "different-serial-format";
  if(target.printRun!=null&&attrs.printRun!==target.printRun)return "different-print-run";
  if(target.autograph!==attrs.autograph)return "different-autograph-format";
  if(target.patch!==attrs.patch)return "different-memorabilia-format";
  if((target.variation??null)!==(attrs.variation??null))return "different-variation";
  return null;
}

function classifyTier(score: number, sale: CompSale, target: ReturnType<typeof parseCardIdentity>): MatchTier | null {
  if (sale.attributes.rawOrGraded !== target.rawOrGraded) return null;
  const exactCardNumber = Boolean(target.cardNumber && sale.attributes.cardNumber && normalized(target.cardNumber) === normalized(sale.attributes.cardNumber));
  if (score >= 85 && exactCardNumber) return "exact";
  if (score >= 65) return "near-exact";
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

export function confidenceBandForScore(score: number, acceptedCompCount: number) {
  if (score < 40 || acceptedCompCount < 3) return "insufficient" as const;
  if (score >= 90) return "very-high" as const;
  if (score >= 75) return "high" as const;
  if (score >= 60) return "moderate" as const;
  return "low" as const;
}

export function evaluateCompAgainstIdentity(sale: CompSale, target: ReturnType<typeof parseCardIdentity>) {
  const score = getMatchScore(sale, target);
  return { score, tier: classifyTier(score, sale, target), failureReason: getMatchFailureReason(sale, target) };
}

export function selectEvidenceWindow(daysSinceSales: number[]) {
  if (daysSinceSales.filter((days) => days <= 90).length >= 3) return 90;
  if (daysSinceSales.filter((days) => days <= 180).length >= 3) return 180;
  return 365;
}

export function capConfidenceForQuantity(score: number, compCount: number) {
  if (compCount < 3) return Math.min(score, 39);
  if (compCount === 3) return Math.min(score, 74);
  if (compCount === 4) return Math.min(score, 89);
  return score;
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
  if (confidence < 60 || acceptedCompCount < 3) return "insufficient-data";

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
  allowLiveProvider?: boolean;
  evidenceAdapter?: CompProviderAdapter;
  providerStatusOverride?: ProviderStatus;
  countsAgainstExternalBudget?: boolean;
}) {
  const { listing, telemetry, identityResultCache, allowLiveProvider = false, evidenceAdapter, providerStatusOverride, countsAgainstExternalBudget = true } = input;

  const providerStatus = providerStatusOverride??getProviderStatus();
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
      recommendationType: recommendationType({confidence:cached.confidenceScore,acceptedCompCount:cached.acceptedCompCount,currentPrice:listing.currentPrice,recommendedPrice:cached.recommendedPrice,tierOnlyFallback:cached.exactMatchCount+cached.nearExactMatchCount===0}),
    };
    return { result: copied, compState: state };
  }

  telemetry.cacheMisses += 1;
  const liveAllowedForThisRun = allowLiveProvider && providerStatus.mode === "live" && providerStatus.liveReady;
  const fixtureExplicitlyAllowed = process.env.COMP_PROVIDER_MODE === "fixture" && process.env.NODE_ENV !== "production";

  let activeProvider = evidenceAdapter??(liveAllowedForThisRun ? theCardApiProvider : fixtureCompProvider);
  const notesFromProviderSelection: string[] = [];

  if (!liveAllowedForThisRun && providerStatus.mode === "live") {
    notesFromProviderSelection.push("Live provider is configured but disabled for this non-cohort valuation run.");
  }

  let comps = [] as CompSale[];
  if (evidenceAdapter||liveAllowedForThisRun || fixtureExplicitlyAllowed) try {
    if(countsAgainstExternalBudget)telemetry.externalProviderCalls += 1;
    comps = await activeProvider.searchSoldComps({
      identity: parsedIdentity,
      listingTitle: listing.title,
      maxResults: 40,
    });
  } catch {
    comps = [];
    notesFromProviderSelection.push("Sold-comp provider request failed; valuation failed closed without simulated fallback data.");
  }

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
    const retrievalFloor = comp.retrievalTier === "proxy" ? 4 : comp.retrievalTier === "near" ? 3 : 1;
    const matchResearchTier:1|2|3|4|5=tier==="exact"?(days<=90?1:2):tier==="near-exact"?3:score>=45?4:5;
    const researchTier = Math.max(retrievalFloor, matchResearchTier) as 1|2|3|4|5;
    const researchTierLabel={1:"Exact recent sale",2:"Exact expanded-window sale",3:"Near-exact comparable",4:"Related card / parallel context",5:"Market context only"}[researchTier];
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
      exclusionReason = getMatchFailureReason(comp, parsedIdentity) ?? "insufficient-identity";
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
      researchTier,
      researchTierLabel,
      matchScore: score,
      inclusionStatus,
      inclusionReason,
      exclusionReason,
      recencyWeight: recency,
      providerWeight,
      finalWeight,
      duplicateGroupId,
      daysSinceSale: days,
      retrievalTier: comp.retrievalTier ?? "exact",
      retrievalQuery: comp.retrievalQuery ?? null,
      queryStrategyVersion: comp.queryStrategyVersion ?? null,
    });
  }

  const initiallyAccepted = evaluated.filter((comp) => comp.inclusionStatus === "accepted");
  const evidenceWindowDays = selectEvidenceWindow(initiallyAccepted.map((comp) => comp.daysSinceSale));
  for (const comp of evaluated) {
    if (comp.inclusionStatus === "accepted" && comp.daysSinceSale > evidenceWindowDays) {
      comp.inclusionStatus = "excluded";
      comp.inclusionReason = "outside adaptive evidence window";
      comp.exclusionReason = "stale";
    }
  }

  const marketPrice = (comp: CompEvaluation) => comp.totalBuyerCost ?? comp.soldPrice;
  const acceptedBeforeOutlier = evaluated.filter((comp) => comp.inclusionStatus === "accepted");
  const totalValues = acceptedBeforeOutlier.map(marketPrice);

  if (totalValues.length >= 3) {
    const bounds = evaluateOutliers(totalValues, totalValues.length);

    for (const comp of evaluated) {
      if (comp.inclusionStatus !== "accepted") continue;
      const value = marketPrice(comp);

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
  const acceptedCosts = accepted.map((comp) => ({ value: marketPrice(comp), weight: comp.finalWeight }));

  const acceptedKnownCosts = acceptedCosts.map((row) => row.value);
  const unknownShippingAccepted = accepted.some((comp) => comp.shipping == null);

  const medianPrice = acceptedKnownCosts.length ? median(acceptedKnownCosts) : null;
  const meanPrice = acceptedKnownCosts.length ? mean(acceptedKnownCosts) : null;
  const weightedEstimate = acceptedCosts.length ? weightedMedian(acceptedCosts) : null;
  const weightedMarket = medianPrice == null || weightedEstimate == null ? null : medianPrice * 0.7 + weightedEstimate * 0.3;

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
    .filter((comp) => now - new Date(comp.soldDate).getTime() <= 30 * DAY_MS)
    .map((comp) => ({ value: marketPrice(comp), weight: comp.finalWeight }));
  const priorCosts = accepted
    .filter((comp) => {
      const days = (now - new Date(comp.soldDate).getTime()) / DAY_MS;
      return days > 30 && days <= 90;
    })
    .map((comp) => ({ value: marketPrice(comp), weight: comp.finalWeight }));

  const recentMedian = recentCosts.length ? weightedMedian(recentCosts) : null;
  const priorMedian = priorCosts.length ? weightedMedian(priorCosts) : null;
  const trendPct = recentMedian != null && priorMedian != null && priorMedian > 0 ? ((recentMedian / priorMedian) - 1) * 100 : 0;
  const trendDirection = trendPct >= 8 ? "up" : trendPct <= -8 ? "down" : "flat";

  const exactCount = accepted.filter((comp) => comp.matchTier === "exact" && comp.retrievalTier === "exact").length;
  const nearCount = accepted.filter((comp) => comp.retrievalTier !== "proxy" && (comp.matchTier === "near-exact" || comp.retrievalTier === "near")).length;
  const proxyCount = accepted.filter((comp) => comp.retrievalTier === "proxy").length;
  const fallbackCount = accepted.filter((comp) => comp.matchTier === "fallback").length;

  const spreadPct = weightedMarket && low != null && high != null ? ((high - low) / weightedMarket) * 100 : 999;
  const fallbackOnly = accepted.length > 0 && accepted.every((comp) => comp.matchTier === "fallback");
  const medianAbsoluteDeviation = medianPrice == null ? 0 : median(acceptedKnownCosts.map((value) => Math.abs(value - medianPrice)));
  const robustDispersion = medianPrice && medianPrice > 0 ? (medianAbsoluteDeviation / medianPrice) * 100 : null;
  const quantityPoints = accepted.length <= 0 ? 0 : accepted.length === 1 ? 5 : accepted.length === 2 ? 9 : accepted.length === 3 ? 12 : accepted.length === 4 ? 16 : 20;
  const confidenceComponents = {
    identityMatch: round2(30 * mean(accepted.map((comp) => comp.matchScore / 100))),
    compQuantity: quantityPoints,
    recency: round2(20 * mean(accepted.map((comp) => comp.recencyWeight))),
    priceConsistency: robustDispersion == null ? 0 : round2(15 * (1 - clamp(robustDispersion / 50, 0, 1))),
    sourceQuality: round2(15 * mean(accepted.map((comp) => comp.providerWeight * (["the-card-api","legends-internal-sales"].includes(comp.providerId) ? 1 : 0.7)))),
  };
  let confidence = Object.values(confidenceComponents).reduce((sum, value) => sum + value, 0);
  if (fallbackOnly) confidence -= 15;
  if (unknownShippingAccepted) confidence -= 5;
  if (evidenceWindowDays === 180) confidence -= 4;
  if (evidenceWindowDays > 180) confidence -= 10;
  confidence = clamp(confidence, 0, 100);
  confidence = capConfidenceForQuantity(confidence, accepted.length);
  if (!parsedIdentity.cardNumber && exactCount === 0) confidence = Math.min(confidence, 59);
  if (accepted.some((comp) => comp.retrievalTier === "proxy")) confidence = Math.min(confidence, 39);

  const targetShipping: number | null = null;
  const targetShippingKnown = false;
  const targetShippingAdjustment = targetShippingKnown && targetShipping != null ? targetShipping : 0;

  const recommendedPrice = weightedMarket == null
    ? null
    : Math.max(0.01, round2(weightedMarket - targetShippingAdjustment));

  const confidenceBandValue = confidenceBandForScore(confidence, accepted.length);
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
  if (activeProvider.providerId === fixtureCompProvider.providerId) {
    notes.push("Fixture provider mode is active for this valuation run.");
  }
  notes.push(...notesFromProviderSelection);

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
    provider: {
      ...providerStatus,
      mode: activeProvider.providerId === fixtureCompProvider.providerId ? "fixture" : providerStatus.mode,
      providerId: activeProvider.providerId,
      providerName: activeProvider.providerName,
      liveReady: activeProvider.providerId === fixtureCompProvider.providerId ? false : providerStatus.liveReady,
    },
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
    newestCompDate: accepted.length ? accepted.map((comp) => comp.soldDate).sort().at(-1) ?? null : null,
    oldestCompDate: accepted.length ? accepted.map((comp) => comp.soldDate).sort()[0] ?? null : null,
    evidenceSources: Array.from(new Set(accepted.map((comp) => comp.providerName))).sort(),
    evidenceWindowDays: accepted.length ? evidenceWindowDays : null,
    medianSoldPrice: medianPrice == null ? null : round2(medianPrice),
    meanSoldPrice: meanPrice == null ? null : round2(meanPrice),
    priceDispersionPct: robustDispersion == null ? null : round2(robustDispersion),
    exactMatchCount: exactCount,
    nearExactMatchCount: nearCount,
    proxyMatchCount: proxyCount,
    confidenceComponents,
    evidenceObservedAt: new Date(now).toISOString(),
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
