import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { parseCardIdentity } from "../lib/comp-validation/identity.ts";
import { prisma } from "../lib/prisma.ts";
import { buildRecommendation, getReliableMarketEvidence, type ListingRecord } from "../lib/recommendations.ts";

const apply = process.argv.includes("--apply");

async function main() {
  const affected = await prisma.recommendation.findMany({
    where: {
      status: "pending",
      type: { in: ["raise-price", "lower-price"] },
      suggestedPrice: new Prisma.Decimal(1),
    },
    include: {
      listing: {
        include: {
          store: { select: { accountId: true } },
          snapshots: { orderBy: { capturedAt: "desc" }, take: 2 },
        },
      },
      actionQueue: { where: { status: "pending" } },
    },
    orderBy: { generatedAt: "asc" },
  });

  const replacements = affected.map((row) => {
    const identityHash = parseCardIdentity(row.listing.title).identityHash;
    const evidence = getReliableMarketEvidence(row.listing.listingQuality, identityHash);
    const result = buildRecommendation(row.listing as ListingRecord, evidence);
    return { row, result };
  });

  const unsafe = replacements.filter(({ result }) => result.suggestedPrice === 1);
  if (unsafe.length > 0) {
    throw new Error(`Repair stopped: ${unsafe.length} rows still recompute to $1.00`);
  }

  const summary = {
    mode: apply ? "apply" : "dry-run",
    affected: affected.length,
    replacementPricing: replacements.filter(({ result }) => result.suggestedPrice != null).length,
    replacementInsufficient: replacements.filter(({ result }) => result.type === "insufficient-data").length,
  };

  if (!apply || affected.length === 0) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  await prisma.$transaction(async (tx) => {
    const recommendationIds = affected.map((row) => row.id);
    await tx.actionQueue.updateMany({
      where: { recommendationId: { in: recommendationIds }, status: "pending" },
      data: { status: "invalidated" },
    });
    await tx.recommendation.updateMany({
      where: { id: { in: recommendationIds }, status: "pending" },
      data: { status: "invalidated" },
    });

    let nextRank = (await tx.actionQueue.aggregate({ _max: { rank: true } }))._max.rank ?? 0;
    for (const { row, result } of replacements) {
      const recommendationId = randomUUID();
      await tx.recommendation.create({
        data: {
          id: recommendationId,
          listingId: row.listingId,
          storeId: row.storeId,
          type: result.type,
          suggestedPrice: result.suggestedPrice == null ? null : new Prisma.Decimal(result.suggestedPrice),
          reason: result.reason,
          expectedProfitImpact: new Prisma.Decimal(result.expectedProfitImpact),
          confidence: result.confidence,
          status: "pending",
        },
      });
      await tx.actionQueue.create({
        data: {
          recommendationId,
          accountId: row.listing.store.accountId,
          storeId: row.storeId,
          rank: ++nextRank,
          status: "pending",
        },
      });
    }
  }, { timeout: 60_000 });

  console.log(JSON.stringify(summary, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
