export type RecommendationType = "raise-price" | "lower-price" | "hold" | "insufficient-data";

export type ListingSnapshotRecord = {
  capturedAt: Date | string;
  currentPrice: unknown;
  quantitySold: number;
  views: number;
  watchers: number;
  listingStatus?: string;
};

export type ListingRecord = {
  id: string;
  storeId: string;
  title?: string | null;
  listingFormat?: string | null;
  categoryId?: string | null;
  currentPrice: unknown;
  views: number | null;
  watchers: number | null;
  quantitySold: number | null;
  quantity: number;
  startTime: Date | string | null;
  createdAt: Date | string;
  store: { accountId: string };
  snapshots?: ListingSnapshotRecord[];
};

export type CompStats = {
  compCount: number;
  compMedianPrice: number;
  compLowerPrice: number;
  compUpperPrice: number;
};

export type ScoreResult = {
  healthScore: number;
  opportunityScore: number;
  healthFactors: Record<string, number>;
  opportunityFactors: Record<string, number>;
};

export type RecommendationBreakdown = {
  score: number;
  rawScore: number;
  factors: {
    ageRisk: number;
    viewsShield: number;
    watchersShield: number;
    salesGapRisk: number;
    priceRisk: number;
    formatRisk: number;
    quantityRisk: number;
    titleRisk: number;
    engagementShield: number;
    baseRisk: number;
  };
  thresholds: {
    leaveAloneMax: number;
    lowerPriceMax: number;
  };
};

export type RecommendationResult = {
  type: RecommendationType;
  suggestedPrice: number | null;
  reason: string;
  expectedProfitImpact: number;
  confidence: number;
  breakdown?: RecommendationBreakdown;
};

export type MarketEvidence = {
  marketValue: unknown;
  acceptedCompCount: number;
  confidenceScore: number;
  confidenceBand: string;
  source: string;
  observedAt: Date | string;
};

const RECOMMENDATION_SCORE_LEAVE_ALONE_MAX = 39;
const RECOMMENDATION_SCORE_LOWER_PRICE_MAX = 69;

const AGE_WEIGHT = 20;
const SALES_WEIGHT = 22;
const PRICE_WEIGHT = 8;
const FORMAT_WEIGHT = 8;
const QUANTITY_WEIGHT = 4;
const TITLE_WEIGHT = 2;
const ENGAGEMENT_VIEWS_WEIGHT = 28;
const ENGAGEMENT_WATCHERS_WEIGHT = 40;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function numeric(value: unknown) {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (value && typeof value === "object" && typeof (value as { toString?: unknown }).toString === "function") {
    const parsed = Number((value as { toString: () => string }).toString());
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function positiveMoney(value: unknown): number | null {
  const parsed = numeric(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function getReliableMarketEvidence(
  listingQuality: unknown,
  identityHash: string,
  now = new Date()
): MarketEvidence | null {
  if (!listingQuality || typeof listingQuality !== "object") return null;
  const root = listingQuality as Record<string, unknown>;
  const compValidation = root.compValidation;
  if (!compValidation || typeof compValidation !== "object") return null;
  const cache = (compValidation as Record<string, unknown>).cache;
  if (!cache || typeof cache !== "object") return null;
  const entry = (cache as Record<string, unknown>)[identityHash];
  if (!entry || typeof entry !== "object") return null;

  const record = entry as Record<string, unknown>;
  const result = record.result;
  if (!result || typeof result !== "object") return null;
  const summary = result as Record<string, unknown>;
  const marketValue = positiveMoney(summary.weightedRecentMarketValue ?? summary.recommendedPrice);
  const acceptedCompCount = numeric(summary.acceptedCompCount);
  const confidenceScore = numeric(summary.confidenceScore);
  const confidenceBand = typeof summary.confidenceBand === "string" ? summary.confidenceBand : "insufficient";
  const providerId = typeof summary.providerId === "string" ? summary.providerId : null;
  const updatedAt = typeof record.updatedAt === "string" ? new Date(record.updatedAt) : null;
  const ageMs = updatedAt ? now.getTime() - updatedAt.getTime() : Number.POSITIVE_INFINITY;
  const fresh = updatedAt != null && Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= 30 * 24 * 60 * 60 * 1000;

  if (
    marketValue == null ||
    acceptedCompCount < 3 ||
    confidenceScore < 60 ||
    !["moderate", "high", "very-high"].includes(confidenceBand) ||
    providerId !== "the-card-api" ||
    !fresh
  ) {
    return null;
  }

  return {
    marketValue,
    acceptedCompCount,
    confidenceScore,
    confidenceBand,
    source: "validated sold comps",
    observedAt: updatedAt,
  };
}

function normalize(value: number, min: number, max: number) {
  if (max <= min) return 0;
  return clamp((value - min) / (max - min), 0, 1);
}

function titleHealthScore(title?: string | null) {
  if (!title) return 0.5;
  const normalized = title.toLowerCase();
  const positiveKeywords = [
    "graded",
    "factory sealed",
    "psa",
    "bgs",
    "gem mint",
    "mint",
    "uncut",
    "low pop",
    "rare",
    "short print",
    "promo",
    "first edition",
  ];
  const negativeKeywords = [
    "lot",
    "bundle",
    "bulk",
    "cards",
    "collection",
    "mixed",
    "random",
    "assortment",
    "ungraded",
  ];

  let score = 0.5;
  if (title.split(/\s+/).length < 5) score -= 0.15;
  if (positiveKeywords.some((keyword) => normalized.includes(keyword))) score += 0.2;
  if (negativeKeywords.some((keyword) => normalized.includes(keyword))) score -= 0.25;
  return clamp(score, 0, 1);
}

export function daysSince(value: Date | string | null | undefined) {
  if (!value) return 0;
  const timestamp = typeof value === "string" ? new Date(value).getTime() : value.getTime();
  if (!Number.isFinite(timestamp)) return 0;
  return Math.max(0, Math.floor((Date.now() - timestamp) / (1000 * 60 * 60 * 24)));
}

function buildComparableKey(listing: ListingRecord) {
  if (!listing.categoryId) return "";
  return `${listing.categoryId}:${listing.listingFormat ?? "unknown"}`;
}

function median(values: number[]) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor((sorted.length - 1) / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid] + sorted[mid + 1]) / 2;
}

function computeComparableStats(listing: ListingRecord, pool: ListingRecord[]): CompStats | null {
  const key = buildComparableKey(listing);
  if (!key) return null;

  const comparablePrices = pool
    .filter((other) => other.id !== listing.id && buildComparableKey(other) === key)
    .map((item) => numeric(item.currentPrice))
    .filter((price) => price > 0);

  if (comparablePrices.length < 3) {
    return null;
  }

  const compMedianPrice = median(comparablePrices);
  return {
    compCount: comparablePrices.length,
    compMedianPrice,
    compLowerPrice: Math.min(...comparablePrices),
    compUpperPrice: Math.max(...comparablePrices),
  };
}

function computeRecentSnapshotMetrics(listing: ListingRecord) {
  const snapshots = (listing.snapshots ?? [])
    .map((snapshot) => ({
      capturedAt: typeof snapshot.capturedAt === "string" ? new Date(snapshot.capturedAt).getTime() : snapshot.capturedAt.getTime(),
      quantitySold: Number(snapshot.quantitySold ?? 0),
      views: Number(snapshot.views ?? 0),
      watchers: Number(snapshot.watchers ?? 0),
    }))
    .filter((snapshot) => Number.isFinite(snapshot.capturedAt))
    .sort((a, b) => b.capturedAt - a.capturedAt);

  if (snapshots.length < 2) {
    return { days: 0, quantitySoldDelta: 0, viewsPerDay: 0, watcherDelta: 0 };
  }

  const latest = snapshots[0];
  const oldest = snapshots[snapshots.length - 1];
  const days = Math.max(1, Math.floor((latest.capturedAt - oldest.capturedAt) / (1000 * 60 * 60 * 24)));
  const quantitySoldDelta = Math.max(0, latest.quantitySold - oldest.quantitySold);
  const viewsDelta = Math.max(0, latest.views - oldest.views);
  const watcherDelta = Math.max(0, latest.watchers - oldest.watchers);

  return {
    days,
    quantitySoldDelta,
    viewsPerDay: viewsDelta / days,
    watcherDelta,
  };
}

export function buildScores(listing: ListingRecord): ScoreResult {
  const age = daysSince(listing.startTime ?? listing.createdAt);
  const views = numeric(listing.views);
  const watchers = numeric(listing.watchers);
  const quantitySold = numeric(listing.quantitySold);
  const price = numeric(listing.currentPrice);

  const opportunityFactors = {
    age: age >= 14 ? 30 : age >= 7 ? 18 : age >= 3 ? 8 : 0,
    interest: views >= 50 ? 25 : views >= 20 ? 15 : views >= 10 ? 8 : 0,
    watchers: watchers >= 15 ? 20 : watchers >= 8 ? 12 : watchers >= 3 ? 6 : 0,
    salesGap: quantitySold === 0 ? 20 : 0,
    scarcity: listing.quantity <= 3 ? 10 : 0,
    price: price >= 100 ? 10 : price >= 50 ? 5 : 0,
  };

  const opportunityScore = clamp(
    Object.values(opportunityFactors).reduce((sum, value) => sum + value, 0),
    0,
    100
  );

  const healthFactors = {
    freshness: age <= 7 ? 20 : age <= 14 ? 10 : age <= 21 ? 0 : -15,
    traffic: views >= 50 ? 20 : views >= 20 ? 10 : 0,
    watchers: watchers >= 10 ? 15 : watchers >= 3 ? 8 : 0,
    sales: quantitySold > 0 ? 20 : -10,
    pricing: price >= 100 && watchers < 3 ? -10 : 0,
  };

  const healthScore = clamp(
    50 + Object.values(healthFactors).reduce((sum, value) => sum + value, 0),
    0,
    100
  );

  return { healthScore, opportunityScore, healthFactors, opportunityFactors };
}

function computeRecommendationScore(listing: ListingRecord): RecommendationBreakdown {
  const age = daysSince(listing.startTime ?? listing.createdAt);
  const views = numeric(listing.views);
  const watchers = numeric(listing.watchers);
  const quantitySold = numeric(listing.quantitySold);
  const quantity = listing.quantity;
  const price = numeric(listing.currentPrice);

  const ageFactor = normalize(age, 7, 35);
  const viewsPerDay = age > 0 ? views / age : views;
  const viewsFactor = clamp(1 - normalize(viewsPerDay, 2, 30), 0, 1);
  const watchersFactor = clamp(1 - normalize(watchers, 0, 20), 0, 1);
  const salesGapFactor = quantitySold > 0 ? 0 : normalize(age, 0, 35);
  const priceFactor = clamp((price - 10) / 190, 0, 1);
  const formatFactor = listing.listingFormat === "Auction" ? 0.2 : listing.listingFormat === "FixedPrice" ? 1 : 0.6;
  const quantityFactor = normalize(quantity, 1, 10);
  const titleFactor = titleHealthScore(listing.title);

  const ageContribution = ageFactor * AGE_WEIGHT;
  const salesContribution = salesGapFactor * SALES_WEIGHT;
  const priceContribution = priceFactor * PRICE_WEIGHT;
  const formatContribution = formatFactor * FORMAT_WEIGHT;
  const quantityContribution = quantityFactor * QUANTITY_WEIGHT;
  const titleContribution = titleFactor * TITLE_WEIGHT;

  const viewsShield = (1 - viewsFactor) * ENGAGEMENT_VIEWS_WEIGHT;
  const watchersShield = (1 - watchersFactor) * ENGAGEMENT_WATCHERS_WEIGHT;
  const engagementShield = viewsShield + watchersShield;

  const baseRisk =
    ageContribution +
    salesContribution +
    priceContribution +
    formatContribution +
    quantityContribution +
    titleContribution;

  const rawScore = baseRisk - engagementShield;
  const score = clamp(rawScore, 0, 100);

  return {
    score,
    rawScore,
    factors: {
      ageRisk: Number(ageContribution.toFixed(2)),
      viewsShield: Number(viewsShield.toFixed(2)),
      watchersShield: Number(watchersShield.toFixed(2)),
      salesGapRisk: Number(salesContribution.toFixed(2)),
      priceRisk: Number(priceContribution.toFixed(2)),
      formatRisk: Number(formatContribution.toFixed(2)),
      quantityRisk: Number(quantityContribution.toFixed(2)),
      titleRisk: Number(titleContribution.toFixed(2)),
      engagementShield: Number(engagementShield.toFixed(2)),
      baseRisk: Number(baseRisk.toFixed(2)),
    },
    thresholds: {
      leaveAloneMax: RECOMMENDATION_SCORE_LEAVE_ALONE_MAX,
      lowerPriceMax: RECOMMENDATION_SCORE_LOWER_PRICE_MAX,
    },
  };
}

function formatSuggestedPrice(price: number, score: number) {
  const baseDrop = 0.05;
  const additional = Math.min(0.12, (score - 40) / 200);
  const dropRate = clamp(baseDrop + additional, 0.05, 0.20);
  const suggested = Math.max(1, Number((price * (1 - dropRate)).toFixed(2)));
  return suggested;
}

function buildConfidence(
  type: RecommendationType,
  score: number,
  listing: ListingRecord,
  compStats: CompStats | null
) {
  const views = numeric(listing.views);
  const watchers = numeric(listing.watchers);
  const quantitySold = numeric(listing.quantitySold);
  const age = daysSince(listing.startTime ?? listing.createdAt);

  let confidence = score * 0.6;
  if (compStats) {
    confidence += 20;
    confidence += Math.min(10, compStats.compCount * 2);
  }
  confidence += Math.min(10, views / 10);
  confidence += Math.min(10, watchers * 2);
  confidence += quantitySold > 0 ? 5 : 0;
  confidence += age >= 14 ? 0 : 5;

  if (type === "insufficient-data") {
    confidence = 20 + (compStats ? 15 : 0) + Math.min(10, views / 15);
  }

  if (type === "hold") {
    confidence = Math.min(90, confidence + 5);
  }

  return Math.round(clamp(confidence, 10, 95));
}

export function buildRecommendation(listing: ListingRecord, marketEvidence: MarketEvidence | null = null): RecommendationResult {
  const breakdown = computeRecommendationScore(listing);
  const score = breakdown.score;
  const price = positiveMoney(listing.currentPrice);
  const marketValue = marketEvidence ? positiveMoney(marketEvidence.marketValue) : null;

  if (price == null || marketValue == null || !marketEvidence) {
    return {
      type: "insufficient-data",
      suggestedPrice: null,
      reason: price == null
        ? "No reliable price recommendation: the current listing price is missing or invalid."
        : "Insufficient comp evidence: at least three fresh, validated sold comps with moderate or high confidence are required.",
      expectedProfitImpact: 0,
      confidence: 0,
      breakdown,
    };
  }

  const ratio = price / marketValue;
  const type: RecommendationType = ratio > 1.05 ? "lower-price" : ratio < 0.95 ? "raise-price" : "hold";
  const evidenceReason = `${marketEvidence.acceptedCompCount} ${marketEvidence.source}; ${marketEvidence.confidenceBand} confidence (${Math.round(marketEvidence.confidenceScore)}%); market value $${marketValue.toFixed(2)}.`;

  if (type === "hold") {
    return {
      type,
      suggestedPrice: null,
      reason: `Current price is within 5% of the supported market value. Evidence: ${evidenceReason}`,
      expectedProfitImpact: 0,
      confidence: Math.round(marketEvidence.confidenceScore),
      breakdown,
    };
  }

  const suggestedPrice = Number(marketValue.toFixed(2));
  return {
    type,
    suggestedPrice,
    reason: `${type === "raise-price" ? "Raise" : "Lower"} toward the supported market value. Evidence: ${evidenceReason}`,
    expectedProfitImpact: Number(Math.abs(suggestedPrice - price).toFixed(2)),
    confidence: Math.round(marketEvidence.confidenceScore),
    breakdown,
  };
}
