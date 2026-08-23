import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  buildValidationCohort,
  createTelemetry,
  updateExpectedDollarImpact,
} from "@/lib/comp-validation/engine";
import { getProviderStatus, getProviderWeights } from "@/lib/comp-validation/provider";
import { parseCardIdentity } from "@/lib/comp-validation/identity";

type CachedValuationSummary = {
  recommendedPrice: number | null;
  confidenceScore: number;
  confidenceBand: string;
  recommendationType: string;
  acceptedCompCount: number;
  excludedCompCount: number;
};

function getCachedSummary(listingQuality: unknown, identityHash: string): CachedValuationSummary | null {
  if (!listingQuality || typeof listingQuality !== "object") return null;
  const root = listingQuality as Record<string, unknown>;
  const compValidation = root.compValidation;
  if (!compValidation || typeof compValidation !== "object") return null;

  const state = compValidation as Record<string, unknown>;
  const cache = state.cache;
  if (!cache || typeof cache !== "object") return null;

  const cacheRecord = cache as Record<string, unknown>;
  const byIdentity = cacheRecord[identityHash];
  if (!byIdentity || typeof byIdentity !== "object") return null;

  const entry = byIdentity as Record<string, unknown>;
  const result = entry.result;
  if (!result || typeof result !== "object") return null;

  const summary = result as Record<string, unknown>;
  return {
    recommendedPrice: typeof summary.recommendedPrice === "number" ? summary.recommendedPrice : null,
    confidenceScore: typeof summary.confidenceScore === "number" ? summary.confidenceScore : 0,
    confidenceBand: typeof summary.confidenceBand === "string" ? summary.confidenceBand : "insufficient",
    recommendationType: typeof summary.recommendationType === "string" ? summary.recommendationType : "insufficient-data",
    acceptedCompCount: typeof summary.acceptedCompCount === "number" ? summary.acceptedCompCount : 0,
    excludedCompCount: typeof summary.excludedCompCount === "number" ? summary.excludedCompCount : 0,
  };
}

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const includeValuations = searchParams.get("includeValuations") !== "0";

  const telemetry = createTelemetry();
  telemetry.dbReads += 1;

  const rows = await prisma.listing.findMany({
    where: { listingStatus: "active" },
    orderBy: { currentPrice: "desc" },
    take: 1000,
    select: {
      id: true,
      storeId: true,
      title: true,
      currentPrice: true,
      quantity: true,
      quantitySold: true,
      views: true,
      watchers: true,
      listingFormat: true,
      condition: true,
      listingQuality: true,
    },
  });

  const listings = rows.map((row) => ({
    id: row.id,
    storeId: row.storeId,
    title: row.title,
    currentPrice: Number(row.currentPrice),
    quantity: row.quantity,
    quantitySold: row.quantitySold,
    views: row.views,
    watchers: row.watchers,
    listingFormat: row.listingFormat,
    condition: row.condition,
    listingQuality: row.listingQuality,
  }));

  const cohort = buildValidationCohort(listings);

  const valuationSummaries: Array<{
    listingId: string;
    recommendedPrice: number | null;
    confidenceScore: number;
    confidenceBand: string;
    recommendationType: string;
    acceptedCompCount: number;
    excludedCompCount: number;
    expectedDollarImpact: number | null;
  }> = [];

  const cohortWithImpact = [...cohort];

  if (includeValuations && cohort.length > 0) {
    const listingById = new Map(listings.map((row) => [row.id, row]));

    for (let i = 0; i < cohortWithImpact.length; i += 1) {
      const item = cohortWithImpact[i];
      const listing = listingById.get(item.listingId);
      if (!listing) continue;

      telemetry.identitiesProcessed += 1;
      const identity = parseCardIdentity(listing.title);
      const cached = getCachedSummary(listing.listingQuality, identity.identityHash);

      if (!cached) {
        telemetry.cacheMisses += 1;
        continue;
      }

      telemetry.cacheHits += 1;

      const updated = updateExpectedDollarImpact(item, cached.recommendedPrice);
      cohortWithImpact[i] = updated;

      valuationSummaries.push({
        listingId: item.listingId,
        recommendedPrice: cached.recommendedPrice,
        confidenceScore: cached.confidenceScore,
        confidenceBand: cached.confidenceBand,
        recommendationType: cached.recommendationType,
        acceptedCompCount: cached.acceptedCompCount,
        excludedCompCount: cached.excludedCompCount,
        expectedDollarImpact: updated.expectedDollarImpact,
      });
    }

    cohortWithImpact.sort((a, b) => {
      const aImpact = a.expectedDollarImpact ?? -1;
      const bImpact = b.expectedDollarImpact ?? -1;
      if (aImpact !== bImpact) return bImpact - aImpact;
      if (a.band !== b.band) return a.band.localeCompare(b.band);
      return b.currentPrice - a.currentPrice;
    });
  }

  return NextResponse.json({
    mode: getProviderStatus(),
    providerWeights: getProviderWeights(),
    cohortCounts: {
      highValue: cohort.filter((row) => row.band === ">=100").length,
      midValue: cohort.filter((row) => row.band === "50-99.99").length,
      lowValue: cohort.filter((row) => row.band === "20-49.99").length,
      edgeCases: cohort.filter((row) => row.band === "edge-case").length,
      total: cohort.length,
    },
    cohort: cohortWithImpact,
    valuationSummaries,
    telemetry,
  });
}
