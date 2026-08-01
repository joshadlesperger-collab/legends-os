import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  buildValidationCohort,
  buildValuation,
  createTelemetry,
  updateExpectedDollarImpact,
} from "@/lib/comp-validation/engine";
import { getProviderStatus, getProviderWeights } from "@/lib/comp-validation/provider";

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
    expectedDollarImpact: number | null;
  }> = [];

  const cohortWithImpact = [...cohort];

  if (includeValuations && cohort.length > 0) {
    const listingById = new Map(listings.map((row) => [row.id, row]));
    const identityResultCache = new Map();

    for (let i = 0; i < cohortWithImpact.length; i += 1) {
      const item = cohortWithImpact[i];
      const listing = listingById.get(item.listingId);
      if (!listing) continue;

      const { result } = await buildValuation({
        listing,
        telemetry,
        identityResultCache,
      });

      const updated = updateExpectedDollarImpact(item, result.recommendedPrice);
      cohortWithImpact[i] = updated;

      valuationSummaries.push({
        listingId: item.listingId,
        recommendedPrice: result.recommendedPrice,
        confidenceScore: result.confidenceScore,
        confidenceBand: result.confidenceBand,
        recommendationType: result.recommendationType,
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
