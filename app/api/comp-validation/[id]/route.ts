import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  buildValidationCohort,
  createTelemetry,
  mergeCompState,
} from "@/lib/comp-validation/engine";
import { valueSubject } from "@/lib/comp-validation/valuation-service";

export const dynamic = "force-dynamic";

function toInputJsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

async function isListingInValidationCohort(listingId: string): Promise<boolean> {
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
  }));

  const cohort = buildValidationCohort(listings);
  return cohort.some((item) => item.listingId === listingId);
}

export async function GET(
  _request: Request,
  { params }: { params: { id: string } }
) {
  const telemetry = createTelemetry();
  telemetry.dbReads += 1;

  const row = await prisma.listing.findUnique({
    where: { id: params.id },
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
      saleEvents: { where: { provider: "ebay-fulfillment", status: { not: "cancelled" } }, orderBy: { soldAt: "desc" }, take: 50, select: { soldAt: true, price: true, quantity: true, status: true } },
    },
  });

  if (!row) {
    return NextResponse.json({ error: "Listing not found" }, { status: 404 });
  }
  if (!(await isListingInValidationCohort(row.id))) {
    return NextResponse.json({ error: "Listing is outside the live Comp Validation cohort." }, { status: 403 });
  }

  const listing = {
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
  };

  const identityResultCache = new Map();
  const internalEvidence = row.saleEvents.map((sale, index) => ({ id: `${row.id}:${index}:${sale.soldAt.toISOString()}`, title: row.title, soldAt: sale.soldAt, unitPrice: Number(sale.price), currency: "USD", status: sale.status }));
  const { result, compState } = await valueSubject({
    subject: { ...listing, subjectType: "inventory" },
    telemetry,
    identityResultCache,
    internalSales: internalEvidence,
    allowLiveProvider: true,
  });

  const existing = compState.cache?.[result.parsedIdentity.identityHash];
  const canPersistEvidence = result.provider.mode === "live" && result.provider.liveReady && result.provider.providerId === "the-card-api";
  if (canPersistEvidence && (!existing || existing.stateHash !== result.stateHash)) {
    const nextCompState = {
      ...compState,
      cache: {
        ...(compState.cache ?? {}),
        [result.parsedIdentity.identityHash]: {
          stateHash: result.stateHash,
          updatedAt: new Date().toISOString(),
          result: {
            recommendedPrice: result.recommendedPrice,
            weightedRecentMarketValue: result.weightedRecentMarketValue,
            lowMarketRange: result.lowMarketRange,
            highMarketRange: result.highMarketRange,
            confidenceScore: result.confidenceScore,
            confidenceBand: result.confidenceBand,
            trendDirection: result.trendDirection,
            trendPct: result.trendPct,
            recommendationType: result.recommendationType,
            acceptedCompCount: result.acceptedCompCount,
            excludedCompCount: result.excludedCompCount,
            newestCompDate: result.newestCompDate,
            oldestCompDate: result.oldestCompDate,
            evidenceSources: result.evidenceSources,
            evidenceWindowDays: result.evidenceWindowDays,
            medianSoldPrice: result.medianSoldPrice,
            meanSoldPrice: result.meanSoldPrice,
            priceDispersionPct: result.priceDispersionPct,
            exactMatchCount: result.exactMatchCount,
            nearExactMatchCount: result.nearExactMatchCount,
            confidenceComponents: result.confidenceComponents,
            evidenceObservedAt: result.evidenceObservedAt,
            providerId: result.provider.providerId,
          },
        },
      },
    };

    telemetry.dbWrites += 1;
    const mergedListingQuality = mergeCompState(row.listingQuality, nextCompState);
    await prisma.listing.update({
      where: { id: listing.id },
      data: {
        listingQuality: toInputJsonValue(mergedListingQuality),
      },
    });
  }

  const internalPrices = row.saleEvents.flatMap((sale) => Array.from({ length: Math.max(1, sale.quantity) }, () => Number(sale.price))).sort((a, b) => a - b);
  const internalMedian = internalPrices.length ? internalPrices.length % 2 ? internalPrices[Math.floor(internalPrices.length / 2)] : (internalPrices[internalPrices.length / 2 - 1] + internalPrices[internalPrices.length / 2]) / 2 : null;
  const internalSales = { source: "Legends authoritative eBay order history", saleCount: row.saleEvents.length, units: row.saleEvents.reduce((sum, sale) => sum + sale.quantity, 0), medianSoldPrice: internalMedian, meanSoldPrice: internalPrices.length ? internalPrices.reduce((sum, price) => sum + price, 0) / internalPrices.length : null, newestSaleDate: row.saleEvents[0]?.soldAt ?? null, sales: row.saleEvents.slice(0, 20).map((sale) => ({ soldAt: sale.soldAt, unitPrice: Number(sale.price), quantity: sale.quantity, status: sale.status })) };
  return NextResponse.json({ result: { ...result, internalSales }, telemetry });
}
