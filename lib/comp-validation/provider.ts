import type {
  CardIdentity,
  CompSale,
  ProviderStatus,
  ProviderWeightsConfig,
} from "@/lib/comp-validation/types";

export type CompProviderAdapter = {
  providerId: string;
  providerName: string;
  searchSoldComps(input: {
    identity: CardIdentity;
    listingTitle: string;
    maxResults: number;
  }): Promise<CompSale[]>;
};

export function getProviderStatus(): ProviderStatus {
  const hasLiveEbaySignals = Boolean(process.env.EBAY_FINDING_APP_ID) || Boolean(process.env.EBAY_BROWSE_CLIENT_ID);

  if (hasLiveEbaySignals) {
    return {
      mode: "live",
      providerId: "ebay-completed",
      providerName: "eBay Completed Listings",
      liveReady: false,
      requirements: [
        "Authorized completed/sold listing API access",
        "Provider-specific credentials configured",
        "Quota/price plan verified",
      ],
      notes: [
        "Live provider integration is intentionally gated until explicit authorization is validated.",
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
  const fixtureWeight = Number(process.env.COMP_PROVIDER_WEIGHT_FIXTURE_EBAY ?? "0.9");
  return {
    "fixture-ebay-completed": Number.isFinite(fixtureWeight) ? Math.max(0.1, Math.min(1.5, fixtureWeight)) : 0.9,
    "ebay-completed": Number(process.env.COMP_PROVIDER_WEIGHT_EBAY_COMPLETED ?? "1.0"),
    "auction-house": Number(process.env.COMP_PROVIDER_WEIGHT_AUCTION_HOUSE ?? "0.95"),
    "licensed-feed": Number(process.env.COMP_PROVIDER_WEIGHT_LICENSED_FEED ?? "0.8"),
  };
}
