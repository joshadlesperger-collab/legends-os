import type { CompProviderAdapter } from "@/lib/comp-validation/provider";
import type { CompSale } from "@/lib/comp-validation/types";

function seedFromString(value: string) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return Math.abs(hash >>> 0);
}

function pseudoRandom(seed: number) {
  let state = seed % 2147483647;
  if (state <= 0) state += 2147483646;
  return () => {
    state = (state * 48271) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

function round2(value: number) {
  return Math.round(value * 100) / 100;
}

export const fixtureCompProvider: CompProviderAdapter = {
  providerId: "fixture-ebay-completed",
  providerName: "Fixture Sold Data (Provider Simulation)",
  async searchSoldComps({ identity, listingTitle, maxResults }) {
    const seed = seedFromString(`${identity.identityHash}|${listingTitle}`);
    const rand = pseudoRandom(seed);

    const base = Math.max(2, 8 + (seed % 40));
    const count = Math.max(6, Math.min(maxResults, 14));
    const now = Date.now();

    const sales: CompSale[] = [];

    for (let i = 0; i < count; i += 1) {
      const isAuction = rand() > 0.55;
      const daysAgo = Math.floor(rand() * 180);
      const soldDate = new Date(now - daysAgo * 24 * 60 * 60 * 1000).toISOString();
      const swing = (rand() - 0.5) * 0.34;
      const soldPrice = round2(base * (1 + swing));

      const shippingKnown = rand() > 0.18;
      const shipping = shippingKnown ? round2(Math.max(0, (rand() * 6) + (soldPrice < 10 ? 1.5 : 0))) : null;
      const premium = isAuction && rand() > 0.75 ? round2(soldPrice * 0.12) : null;

      const totalBuyerCost = shipping == null ? null : round2(soldPrice + shipping + (premium ?? 0));

      const maybeDifferentGrade = identity.rawOrGraded === "graded" && rand() > 0.8;
      const gradeDelta = maybeDifferentGrade ? (rand() > 0.5 ? 0.5 : -0.5) : 0;
      const gradeValue = identity.gradeValue == null ? null : Math.max(1, Math.min(10, identity.gradeValue + gradeDelta));

      sales.push({
        compKey: `fixture-${identity.identityHash.slice(0, 8)}-${i}`,
        providerId: "fixture-ebay-completed",
        providerName: "Fixture Sold Data (Provider Simulation)",
        sourceItemId: `ITEM-${seed % 10000}-${i}`,
        sourceUrl: `https://example.invalid/item/${seed % 10000}-${i}`,
        soldTitle: `${listingTitle} Sold Example ${i + 1}`,
        soldDate,
        soldPrice,
        shipping,
        buyerPremium: premium,
        totalBuyerCost,
        isAuction,
        attributes: {
          rawOrGraded: identity.rawOrGraded,
          gradeCompany: identity.gradeCompany,
          gradeValue,
          rookie: identity.rookie,
          autograph: identity.autograph,
          patch: identity.patch,
          parallel: identity.parallel,
          variation: identity.variation,
          serialNumbered: identity.serialNumbered,
        },
      });
    }

    if (sales.length >= 4) {
      const outlierHigh = { ...sales[0] };
      outlierHigh.compKey = `${outlierHigh.compKey}-high-outlier`;
      outlierHigh.soldPrice = round2(outlierHigh.soldPrice * 2.3);
      outlierHigh.totalBuyerCost = outlierHigh.shipping == null ? null : round2(outlierHigh.soldPrice + outlierHigh.shipping + (outlierHigh.buyerPremium ?? 0));
      sales.push(outlierHigh);

      const outlierLow = { ...sales[1] };
      outlierLow.compKey = `${outlierLow.compKey}-low-outlier`;
      outlierLow.soldPrice = round2(Math.max(0.5, outlierLow.soldPrice * 0.35));
      outlierLow.totalBuyerCost = outlierLow.shipping == null ? null : round2(outlierLow.soldPrice + outlierLow.shipping + (outlierLow.buyerPremium ?? 0));
      outlierLow.isAuction = true;
      sales.push(outlierLow);
    }

    if (sales.length >= 3) {
      const duplicate = { ...sales[2] };
      duplicate.compKey = `${duplicate.compKey}-duplicate-provider`;
      duplicate.providerId = "licensed-feed";
      duplicate.providerName = "Licensed Feed (Simulated)";
      duplicate.sourceItemId = `${duplicate.sourceItemId}-dup`;
      sales.push(duplicate);
    }

    return sales.slice(0, maxResults);
  },
};
