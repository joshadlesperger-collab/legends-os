import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { buildValuation, createTelemetry, mergeCompState } from "@/lib/comp-validation/engine";

export const dynamic = "force-dynamic";

function toInputJsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
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
    },
  });

  if (!row) {
    return NextResponse.json({ error: "Listing not found" }, { status: 404 });
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
  const { result, compState } = await buildValuation({ listing, telemetry, identityResultCache });

  const existing = compState.cache?.[result.parsedIdentity.identityHash];
  if (!existing || existing.stateHash !== result.stateHash) {
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

  return NextResponse.json({ result, telemetry });
}
