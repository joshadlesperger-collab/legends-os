import type {
  CardIdentity,
  CompSale,
  ProviderStatus,
  ProviderWeightsConfig,
} from "./types.ts";

export type CompProviderAdapter = {
  providerId: string;
  providerName: string;
  searchSoldComps(input: {
    identity: CardIdentity;
    listingTitle: string;
    maxResults: number;
    query?: string;
  }): Promise<CompSale[]>;
};

export function getProviderStatus(): ProviderStatus {
  const hasTheCardApiKey = Boolean(process.env.THE_CARD_API_KEY);

  if (hasTheCardApiKey) {
    return {
      mode: "live",
      providerId: "the-card-api",
      providerName: "The Card API",
      liveReady: true,
      requirements: [
        "x-market-api-key header",
        "Respect daily sales-row limits by plan",
        "Respect lookback window by plan",
      ],
      notes: [
        "Live lookups are restricted to the validation cohort wiring.",
        "Fixture mode remains available as fallback.",
        "No scraping is permitted.",
      ],
    };
  }

  return {
    mode: "fixture",
    providerId: "fixture-ebay-completed",
    providerName: "Fixture Sold Data (Provider Simulation)",
    liveReady: false,
    requirements: [
      "No authorized sold-comp provider credentials detected for MVP live ingest",
      "Configure provider access first, then switch adapter",
    ],
    notes: [
      "Running in fixture mode by design for safe MVP validation.",
      "This enables algorithm and UI validation without scraping or unauthorized data use.",
    ],
  };
}

export function getProviderWeights(): ProviderWeightsConfig {
  const theCardWeight = Number(process.env.COMP_PROVIDER_WEIGHT_THE_CARD_API ?? "1.0");
  const fixtureWeight = Number(process.env.COMP_PROVIDER_WEIGHT_FIXTURE_EBAY ?? "0.9");
  return {
    "legends-internal-sales": 1.0,
    "the-card-api": Number.isFinite(theCardWeight) ? Math.max(0.1, Math.min(1.5, theCardWeight)) : 1.0,
    "fixture-ebay-completed": Number.isFinite(fixtureWeight) ? Math.max(0.1, Math.min(1.5, fixtureWeight)) : 0.9,
    "ebay-completed": Number(process.env.COMP_PROVIDER_WEIGHT_EBAY_COMPLETED ?? "1.0"),
    "auction-house": Number(process.env.COMP_PROVIDER_WEIGHT_AUCTION_HOUSE ?? "0.95"),
    "licensed-feed": Number(process.env.COMP_PROVIDER_WEIGHT_LICENSED_FEED ?? "0.8"),
  };
}
