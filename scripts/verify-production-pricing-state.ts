import { prisma } from "../lib/prisma.ts";

async function main() {
  const [supported, active, unavailable, oneDollar, jobs, failed] = await Promise.all([
    prisma.recommendation.findMany({
      where: { status: "pending", type: { in: ["raise-price", "lower-price"] }, suggestedPrice: { not: null }, confidence: { gte: 50 } },
      select: { type: true, suggestedPrice: true, confidence: true, reason: true, listing: { select: { title: true, currentPrice: true, listingQuality: true } } },
      orderBy: { confidence: "desc" },
    }),
    prisma.listing.count({ where: { listingStatus: "active" } }),
    prisma.recommendation.count({ where: { status: "pending", type: "insufficient-data", suggestedPrice: null } }),
    prisma.recommendation.count({ where: { status: "pending", suggestedPrice: 1 } }),
    prisma.syncJob.groupBy({ by: ["status"], _count: { _all: true }, where: { createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } } }),
    prisma.syncJob.findMany({ where: { status: "failed", createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } }, select: { type: true, createdAt: true, errorMessage: true }, take: 10, orderBy: { createdAt: "desc" } }),
  ]);

  console.log(JSON.stringify({
    active,
    unavailable,
    oneDollar,
    supported: supported.map((row) => ({
      title: row.listing.title,
      currentPrice: Number(row.listing.currentPrice),
      suggestedPrice: Number(row.suggestedPrice),
      type: row.type,
      confidence: row.confidence,
      reason: row.reason,
      compState: (row.listing.listingQuality as Record<string, unknown> | null)?.compValidation,
    })),
    jobs,
    failed: failed.map((row) => ({ type: row.type, createdAt: row.createdAt, error: row.errorMessage?.slice(0, 160) })),
  }, null, 2));
}

main().finally(() => prisma.$disconnect());
