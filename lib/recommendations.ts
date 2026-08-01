export type RecommendationType = "lower-price" | "end-relist" | "leave-alone";

export type ListingRecord = {
  id: string;
  storeId: string;
  currentPrice: unknown;
  views: number | null;
  watchers: number | null;
  quantitySold: number | null;
  quantity: number;
  startTime: Date | string | null;
  createdAt: Date | string;
  store: { accountId: string };
};

export type ScoreResult = {
  healthScore: number;
  opportunityScore: number;
  healthFactors: Record<string, number>;
  opportunityFactors: Record<string, number>;
};

export type RecommendationResult = {
  type: RecommendationType;
  suggestedPrice: number | null;
  reason: string;
  expectedProfitImpact: number;
  confidence: number;
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function numeric(value: unknown) {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export function daysSince(value: Date | string | null | undefined) {
  if (!value) return 0;
  const timestamp = typeof value === "string" ? new Date(value).getTime() : value.getTime();
  if (!Number.isFinite(timestamp)) return 0;
  return Math.max(0, Math.floor((Date.now() - timestamp) / (1000 * 60 * 60 * 24)));
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

export function buildRecommendation(listing: ListingRecord): RecommendationResult | null {
  const age = daysSince(listing.startTime ?? listing.createdAt);
  const views = numeric(listing.views);
  const watchers = numeric(listing.watchers);
  const quantitySold = numeric(listing.quantitySold);
  const quantity = listing.quantity;
  const price = numeric(listing.currentPrice);
  const sellRatio = quantitySold > 0 ? quantitySold / Math.max(1, quantity + quantitySold) : 0;

  const lowerPriceCandidate =
    quantitySold === 0 && age >= 7 && (views >= 20 || watchers >= 8) && price >= 5;
  const relistCandidate =
    quantitySold === 0 && age >= 14 && (watchers >= 3 || views >= 15);
  const leaveCandidate = quantitySold > 0 && age <= 30 && sellRatio >= 0.25;

  if (lowerPriceCandidate) {
    const suggestedPrice = Number(Math.max(price * 0.92, price - 5).toFixed(2));
    const expectedProfitImpact = Number(
      Math.max(1, (views * 0.08 + watchers * 0.5 + age * 0.25) / 4).toFixed(2)
    );
    const confidence = clamp(40 + watchers * 4 + (views >= 20 ? 10 : 0) + Math.min(age, 20), 0, 95);

    return {
      type: "lower-price",
      suggestedPrice,
      reason: `High interest with no sales over ${age} day${age === 1 ? "" : "s"}; lower price slightly to boost conversion.`,
      expectedProfitImpact,
      confidence,
    };
  }

  if (relistCandidate) {
    const expectedProfitImpact = Number(Math.max(1, (watchers * 0.7 + age * 0.35) / 3).toFixed(2));
    const confidence = clamp(35 + watchers * 3 + Math.min(age, 20), 0, 90);

    return {
      type: "end-relist",
      suggestedPrice: null,
      reason: `Stale listing with ongoing interest but no sales; end and relist to refresh visibility.`,
      expectedProfitImpact,
      confidence,
    };
  }

  if (leaveCandidate) {
    const expectedProfitImpact = 0;
    const confidence = clamp(40 + quantitySold * 6 + watchers * 3, 0, 90);

    return {
      type: "leave-alone",
      suggestedPrice: null,
      reason: `Listing has recent sales and healthy interest; keep it active as-is.`,
      expectedProfitImpact,
      confidence,
    };
  }

  return null;
}
