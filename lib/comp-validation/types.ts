export type ListingForComp = {
  id: string;
  storeId: string;
  title: string;
  currentPrice: number;
  quantity: number;
  quantitySold: number;
  views: number;
  watchers: number;
  listingFormat: string | null;
  condition: string | null;
  listingQuality?: unknown;
};

export type CardIdentity = {
  player: string | null;
  year: number | null;
  manufacturer: string | null;
  setName: string | null;
  cardNumber: string | null;
  parallel: string | null;
  variation: string | null;
  rookie: boolean;
  autograph: boolean;
  patch: boolean;
  serialNumbered: boolean;
  gradeCompany: string | null;
  gradeValue: number | null;
  rawOrGraded: "raw" | "graded";
  identityHash: string;
  baseCardKey: string;
};

export type MatchTier = "exact" | "near-exact" | "fallback";

export type ProviderMode = "fixture" | "live";

export type ProviderStatus = {
  mode: ProviderMode;
  providerId: string;
  providerName: string;
  liveReady: boolean;
  requirements: string[];
  notes: string[];
};

export type CompSale = {
  compKey: string;
  providerId: string;
  providerName: string;
  sourceItemId: string;
  sourceUrl: string | null;
  soldTitle: string;
  soldDate: string;
  soldPrice: number;
  shipping: number | null;
  buyerPremium: number | null;
  totalBuyerCost: number | null;
  isAuction: boolean;
  attributes: {
    rawOrGraded: "raw" | "graded";
    gradeCompany: string | null;
    gradeValue: number | null;
    rookie: boolean;
    autograph: boolean;
    patch: boolean;
    parallel: string | null;
    variation: string | null;
    serialNumbered: boolean;
  };
};

export type CompEvaluation = {
  compKey: string;
  providerId: string;
  providerName: string;
  sourceItemId: string;
  sourceUrl: string | null;
  soldTitle: string;
  soldDate: string;
  soldPrice: number;
  shipping: number | null;
  buyerPremium: number | null;
  totalBuyerCost: number | null;
  matchTier: MatchTier;
  matchScore: number;
  inclusionStatus: "accepted" | "excluded";
  inclusionReason: string;
  exclusionReason: string | null;
  recencyWeight: number;
  providerWeight: number;
  finalWeight: number;
  duplicateGroupId: string | null;
};

export type ConfidenceBand = "high" | "moderate" | "low" | "insufficient";

export type ValuationResult = {
  listingId: string;
  listingTitle: string;
  parsedIdentity: CardIdentity;
  provider: ProviderStatus;
  currentPrice: number;
  targetShipping: number | null;
  targetShippingKnown: boolean;
  recommendedPrice: number | null;
  weightedRecentMarketValue: number | null;
  lowMarketRange: number | null;
  highMarketRange: number | null;
  trendDirection: "up" | "down" | "flat";
  trendPct: number;
  confidenceScore: number;
  confidenceBand: ConfidenceBand;
  recommendationType: "raise-price" | "lower-price" | "hold" | "insufficient-data";
  acceptedCompCount: number;
  excludedCompCount: number;
  comps: CompEvaluation[];
  notes: string[];
  stateHash: string;
};

export type ProviderWeightsConfig = {
  [providerId: string]: number;
};

export type TelemetryCounters = {
  dbReads: number;
  dbWrites: number;
  identitiesProcessed: number;
  cacheHits: number;
  cacheMisses: number;
  externalProviderCalls: number;
  compsRetrieved: number;
};

export type CohortBand = ">=100" | "50-99.99" | "20-49.99" | "edge-case";

export type CohortItem = {
  listingId: string;
  title: string;
  currentPrice: number;
  quantity: number;
  quantitySold: number;
  views: number;
  watchers: number;
  condition: string | null;
  listingFormat: string | null;
  band: CohortBand;
  complexityScore: number;
  expectedDollarImpact: number | null;
};

export type CompFeedbackEntry = {
  excluded: boolean;
  reason: string;
  updatedAt: string;
};
