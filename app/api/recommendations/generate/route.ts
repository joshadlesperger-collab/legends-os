import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { buildRecommendation, buildScores, daysSince, getReliableMarketEvidence, ListingRecord, RecommendationResult, ScoreResult } from "@/lib/recommendations";
import { parseCardIdentity } from "@/lib/comp-validation/identity";
import { isActionablePricingRecommendation } from "@/lib/recommendation-queue";
import { randomUUID } from "crypto";

const SCORE_CHANGE_THRESHOLD = 3;
const FACTOR_CHANGE_THRESHOLD = 5;

function normalizeFactorRecord(value: unknown): Record<string, number> {
  if (value === null || value === undefined || Array.isArray(value) || typeof value !== "object") {
    return {};
  }

  const record: Record<string, number> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    if (typeof rawValue === "number" && Number.isFinite(rawValue)) {
      record[key] = rawValue;
      continue;
    }

    if (typeof rawValue === "string") {
      const parsed = Number(rawValue);
      if (!Number.isNaN(parsed) && Number.isFinite(parsed)) {
        record[key] = parsed;
      }
      continue;
    }

    if (typeof rawValue === "boolean") {
      record[key] = rawValue ? 1 : 0;
    }
  }

  return record;
}

function normalizeDecimalValue(value: Prisma.Decimal | number | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "number") {
    return String(value);
  }

  if (typeof value === "object" && value !== null && typeof (value as { toString?: unknown }).toString === "function") {
    return String((value as { toString: () => string }).toString());
  }

  return null;
}

function hasMeaningfulScoreChange(
  existing: { healthScore: number; opportunityScore: number; healthFactors: Record<string, number>; opportunityFactors: Record<string, number> } | undefined,
  next: ScoreResult
) {
  if (!existing) return true;
  if (Math.abs(existing.healthScore - next.healthScore) >= SCORE_CHANGE_THRESHOLD) return true;
  if (Math.abs(existing.opportunityScore - next.opportunityScore) >= SCORE_CHANGE_THRESHOLD) return true;

  const factorKeys = [
    ...Object.keys(existing.healthFactors),
    ...Object.keys(next.healthFactors),
    ...Object.keys(existing.opportunityFactors),
    ...Object.keys(next.opportunityFactors),
  ].filter((value, index, array) => array.indexOf(value) === index);

  for (const key of factorKeys) {
    const existingHealth = existing.healthFactors[key] ?? 0;
    const nextHealth = next.healthFactors[key] ?? 0;
    if (Math.abs(existingHealth - nextHealth) >= FACTOR_CHANGE_THRESHOLD) return true;

    const existingOpp = existing.opportunityFactors[key] ?? 0;
    const nextOpp = next.opportunityFactors[key] ?? 0;
    if (Math.abs(existingOpp - nextOpp) >= FACTOR_CHANGE_THRESHOLD) return true;
  }

  return false;
}

function recommendationIsIdentical(
  existing: { type: string; suggestedPrice: Prisma.Decimal | null; reason: string; expectedProfitImpact: Prisma.Decimal | number | null; confidence: number | null },
  next: RecommendationResult
) {
  return (
    existing.type === next.type &&
    normalizeDecimalValue(existing.suggestedPrice) === normalizeDecimalValue(next.suggestedPrice) &&
    existing.reason === next.reason &&
    normalizeDecimalValue(existing.expectedProfitImpact) === normalizeDecimalValue(next.expectedProfitImpact) &&
    existing.confidence === next.confidence
  );
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const storeId = typeof body.storeId === "string" ? body.storeId : undefined;

  const listings = await prisma.listing.findMany({
    where: {
      ...(storeId ? { storeId } : {}),
      listingStatus: "active",
    },
    include: {
      store: { select: { accountId: true } },
      snapshots: { orderBy: { capturedAt: "desc" }, take: 2 },
    },
  });

  if (listings.length === 0) {
    return NextResponse.json({ generated: 0, skipped: 0 });
  }

  const listingIds = listings.map((listing) => listing.id);
  const existingPending = await prisma.recommendation.findMany({
    where: { listingId: { in: listingIds }, status: "pending" },
  });
  const existingQueueRows = await prisma.actionQueue.findMany({
    where: { recommendationId: { in: existingPending.map((recommendation) => recommendation.id) } },
  });
  const existingScores = await prisma.listingScore.findMany({
    where: { listingId: { in: listingIds } },
    orderBy: [{ listingId: "asc" }, { calculatedAt: "desc" }],
  });

  const existingByListing = new Map<string, typeof existingPending[number][]>();
  for (const recommendation of existingPending) {
    const list = existingByListing.get(recommendation.listingId) ?? [];
    list.push(recommendation);
    existingByListing.set(recommendation.listingId, list);
  }

  const queueByRecommendationId = new Map<string, typeof existingQueueRows[number]>();
  for (const row of existingQueueRows) {
    queueByRecommendationId.set(row.recommendationId, row);
  }

  const latestScoreByListing = new Map<string, typeof existingScores[number]>();
  for (const score of existingScores) {
    if (!latestScoreByListing.has(score.listingId)) {
      latestScoreByListing.set(score.listingId, score);
    }
  }

  const scoreCreates: Array<{
    listingId: string;
    storeId: string;
    healthScore: number;
    opportunityScore: number;
    healthFactors: Record<string, number>;
    opportunityFactors: Record<string, number>;
  }> = [];
  const recommendationCreates: Array<{
    id: string;
    listingId: string;
    storeId: string;
    type: string;
    suggestedPrice: string | null;
    reason: string;
    expectedProfitImpact: string;
    confidence: number;
    status: string;
  }> = [];
  const recommendationUpdates: Array<{
    id: string;
    data: {
      type: string;
      suggestedPrice: Prisma.Decimal | null;
      reason: string;
      expectedProfitImpact: Prisma.Decimal;
      confidence: number;
    };
  }> = [];
  const queueCreates: Array<{
    recommendationId: string;
    accountId: string;
    storeId: string;
    rank: number;
    status: string;
  }> = [];
  const missingQueueRows: Array<{
    recommendationId: string;
    accountId: string;
    storeId: string;
    rank: number;
    status: string;
  }> = [];
  const queueRecommendationIdsToInvalidate = new Set<string>();

  let skippedCount = 0;
  let nextRank = Math.max(0, ...existingQueueRows.map((row) => row.rank)) + 1;
  const changedScoreStoreIds = new Set<string>();

  for (const listing of listings) {
    const existingScore = latestScoreByListing.get(listing.id);
    const normalizedExistingScore = existingScore
      ? {
          healthScore: existingScore.healthScore,
          opportunityScore: existingScore.opportunityScore,
          healthFactors: normalizeFactorRecord(existingScore.healthFactors),
          opportunityFactors: normalizeFactorRecord(existingScore.opportunityFactors),
        }
      : undefined;
    const score = buildScores(listing as ListingRecord);
    if (hasMeaningfulScoreChange(normalizedExistingScore, score)) {
      scoreCreates.push({
        listingId: listing.id,
        storeId: listing.storeId,
        healthScore: score.healthScore,
        opportunityScore: score.opportunityScore,
        healthFactors: score.healthFactors,
        opportunityFactors: score.opportunityFactors,
      });
      changedScoreStoreIds.add(listing.storeId);
    }

    const identityHash = parseCardIdentity(listing.title).identityHash;
    const marketEvidence = getReliableMarketEvidence(listing.listingQuality, identityHash);
    const recommendation = buildRecommendation(listing as ListingRecord, marketEvidence);
    if (!recommendation) {
      skippedCount += 1;
      continue;
    }

    const existingList = existingByListing.get(listing.id) ?? [];
    const matchingExistingRecommendation = existingList.find((existing) => recommendationIsIdentical(existing, recommendation));
    if (matchingExistingRecommendation) {
      const actionable = isActionablePricingRecommendation(recommendation);
      if (actionable && !queueByRecommendationId.has(matchingExistingRecommendation.id)) {
        missingQueueRows.push({
          recommendationId: matchingExistingRecommendation.id,
          accountId: listing.store.accountId,
          storeId: listing.storeId,
          rank: nextRank++,
          status: "pending",
        });
      } else if (!actionable && queueByRecommendationId.has(matchingExistingRecommendation.id)) {
        queueRecommendationIdsToInvalidate.add(matchingExistingRecommendation.id);
      }
      skippedCount += 1;
      continue;
    }

    if (existingList.length > 0) {
      const existingRecommendation = existingList[0];
      recommendationUpdates.push({
        id: existingRecommendation.id,
        data: {
          type: recommendation.type,
          suggestedPrice:
            recommendation.suggestedPrice !== null
              ? new Prisma.Decimal(recommendation.suggestedPrice)
              : null,
          reason: recommendation.reason,
          expectedProfitImpact: new Prisma.Decimal(recommendation.expectedProfitImpact),
          confidence: recommendation.confidence,
        },
      });

      const actionable = isActionablePricingRecommendation(recommendation);
      if (actionable && !queueByRecommendationId.has(existingRecommendation.id)) {
        missingQueueRows.push({
          recommendationId: existingRecommendation.id,
          accountId: listing.store.accountId,
          storeId: listing.storeId,
          rank: nextRank++,
          status: "pending",
        });
      } else if (!actionable && queueByRecommendationId.has(existingRecommendation.id)) {
        queueRecommendationIdsToInvalidate.add(existingRecommendation.id);
      }
      continue;
    }

    const id = randomUUID();
    recommendationCreates.push({
      id,
      listingId: listing.id,
      storeId: listing.storeId,
      type: recommendation.type,
      suggestedPrice:
        recommendation.suggestedPrice !== null ? String(recommendation.suggestedPrice) : null,
      reason: recommendation.reason,
      expectedProfitImpact: String(recommendation.expectedProfitImpact),
      confidence: recommendation.confidence,
      status: "pending",
    });
    if (isActionablePricingRecommendation(recommendation)) {
      queueCreates.push({
        recommendationId: id,
        accountId: listing.store.accountId,
        storeId: listing.storeId,
        rank: nextRank++,
        status: "pending",
      });
    }
  }

  const scoreRunByStore = new Map<string, string>();
  if (changedScoreStoreIds.size > 0) {
    const scoreRuns = await prisma.$transaction(
      Array.from(changedScoreStoreIds).map((storeId) =>
        prisma.scoreRun.create({ data: { storeId, status: "completed" } })
      )
    );
    for (const scoreRun of scoreRuns) {
      scoreRunByStore.set(scoreRun.storeId, scoreRun.id);
    }
  }

  if (scoreCreates.length > 0) {
    await prisma.listingScore.createMany({
      data: scoreCreates.map((scoreCreate) => ({
        ...scoreCreate,
        scoreRunId: scoreRunByStore.get(scoreCreate.storeId) ?? "",
      })),
    });
  }

  const dbOperations: Array<Prisma.PrismaPromise<unknown>> = [];

  for (const update of recommendationUpdates) {
    dbOperations.push(
      prisma.recommendation.update({
        where: { id: update.id },
        data: update.data,
      })
    );
  }

  if (recommendationCreates.length > 0) {
    dbOperations.push(prisma.recommendation.createMany({ data: recommendationCreates }));
  }

  if (queueCreates.length > 0) {
    dbOperations.push(prisma.actionQueue.createMany({ data: queueCreates }));
  }

  if (missingQueueRows.length > 0) {
    dbOperations.push(prisma.actionQueue.createMany({ data: missingQueueRows }));
  }

  if (queueRecommendationIdsToInvalidate.size > 0) {
    dbOperations.push(prisma.actionQueue.updateMany({
      where: { recommendationId: { in: Array.from(queueRecommendationIdsToInvalidate) }, status: "pending" },
      data: { status: "invalidated" },
    }));
  }

  if (dbOperations.length > 0) {
    await prisma.$transaction(dbOperations);
  }

  return NextResponse.json({
    generated: recommendationCreates.length,
    skipped: skippedCount,
  });
}
