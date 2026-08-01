import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { buildRecommendation, buildScores, ListingRecord, RecommendationResult } from "@/lib/recommendations";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const storeId = typeof body.storeId === "string" ? body.storeId : undefined;

  const listings = await prisma.listing.findMany({
    where: {
      ...(storeId ? { storeId } : {}),
      listingStatus: "active",
    },
    include: { store: { select: { accountId: true } } },
  });

  if (listings.length === 0) {
    return NextResponse.json({ generated: 0, skipped: 0 });
  }

  const storeIds = Array.from(new Set(listings.map((listing) => listing.storeId)));
  const scoreRuns = await prisma.$transaction(
    storeIds.map((id) => prisma.scoreRun.create({ data: { storeId: id, status: "completed" } }))
  );

  const scoreRunByStore = new Map(scoreRuns.map((scoreRun) => [scoreRun.storeId, scoreRun.id]));
  const listingIds = listings.map((listing) => listing.id);

  const existingPending = await prisma.recommendation.findMany({
    where: { listingId: { in: listingIds }, status: "pending" },
  });
  const existingByListing = new Map<string, (typeof existingPending[number])[]>(
    existingPending.map((recommendation) => [recommendation.listingId, [] as (typeof existingPending[number])[]])
  );
  for (const recommendation of existingPending) {
    const list = existingByListing.get(recommendation.listingId);
    if (list) list.push(recommendation);
  }

  const createdRecommendations: Array<{
    id: string;
    listingId: string;
    storeId: string;
    accountId: string;
    expectedProfitImpact: number;
  }> = [];
  let skippedCount = 0;

  for (const listing of listings) {
    const scoreRunId = scoreRunByStore.get(listing.storeId);
    if (!scoreRunId) continue;

    const score = buildScores(listing as ListingRecord);
    await prisma.listingScore.create({
      data: {
        listingId: listing.id,
        scoreRunId,
        healthScore: score.healthScore,
        opportunityScore: score.opportunityScore,
        healthFactors: score.healthFactors,
        opportunityFactors: score.opportunityFactors,
      },
    });

    const recommendation = buildRecommendation(listing as ListingRecord);
    if (!recommendation) {
      skippedCount += 1;
      continue;
    }

    const existingList = existingByListing.get(listing.id) ?? [];
    const duplicate = existingList.some((existing) => {
      return (
        existing.type === recommendation.type &&
        String(existing.suggestedPrice ?? null) === String(recommendation.suggestedPrice ?? null) &&
        existing.reason === recommendation.reason
      );
    });

    if (duplicate) {
      skippedCount += 1;
      continue;
    }

    const newRecommendation = await prisma.recommendation.create({
      data: {
        listingId: listing.id,
        storeId: listing.storeId,
        type: recommendation.type,
        suggestedPrice:
          recommendation.suggestedPrice !== null
            ? new Prisma.Decimal(recommendation.suggestedPrice)
            : undefined,
        reason: recommendation.reason,
        expectedProfitImpact: new Prisma.Decimal(recommendation.expectedProfitImpact),
        confidence: recommendation.confidence,
        status: "pending",
      },
    });

    createdRecommendations.push({
      id: newRecommendation.id,
      listingId: listing.id,
      storeId: listing.storeId,
      accountId: listing.store.accountId,
      expectedProfitImpact: recommendation.expectedProfitImpact,
    });
  }

  const sortedRecommendations = [...createdRecommendations].sort(
    (a, b) => b.expectedProfitImpact - a.expectedProfitImpact
  );

  await prisma.$transaction(
    sortedRecommendations.map((recommendation, index) =>
      prisma.actionQueue.create({
        data: {
          recommendationId: recommendation.id,
          accountId: recommendation.accountId,
          storeId: recommendation.storeId,
          rank: index + 1,
          status: "pending",
        },
      })
    )
  );

  return NextResponse.json({
    generated: createdRecommendations.length,
    skipped: skippedCount,
  });
}
