import { prisma } from "../lib/prisma.ts";

async function main() {
  const [active, activeWithCost, lines, linkedLines, reconciliations, jobs, stores, duplicateSales, duplicateOrders, pendingOneDollar, pendingFixture] = await Promise.all([
    prisma.listing.count({ where: { listingStatus: "active" } }),
    prisma.listing.count({ where: { listingStatus: "active", costBasis: { isNot: null } } }),
    prisma.ebayOrderLine.count(),
    prisma.ebayOrderLine.count({ where: { listingId: { not: null } } }),
    prisma.orderLineReconciliation.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.syncJob.groupBy({ by: ["status"], _count: { _all: true }, where: { createdAt: { gte: new Date(Date.now() - 7 * 86_400_000) } } }),
    prisma.store.findMany({ where: { isActive: true }, select: { connectionStatus: true, orderAccessStatus: true, lastSyncAt: true, orderSyncCheckpoint: true } }),
    prisma.$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*)::bigint AS count FROM (SELECT "provider", "providerEventId" FROM "SaleEvent" WHERE "providerEventId" IS NOT NULL GROUP BY 1,2 HAVING COUNT(*) > 1) duplicates`,
    prisma.$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*)::bigint AS count FROM (SELECT "storeId", "providerOrderId" FROM "EbayOrder" GROUP BY 1,2 HAVING COUNT(*) > 1) duplicates`,
    prisma.recommendation.count({ where: { status: "pending", suggestedPrice: 1 } }),
    prisma.recommendation.count({ where: { status: "pending", reason: { contains: "fixture", mode: "insensitive" } } }),
  ]);
  console.log(JSON.stringify({ active, activeWithCost, costCoveragePct: active ? Number((activeWithCost * 100 / active).toFixed(2)) : 0, lines, linkedLines, linkagePct: lines ? Number((linkedLines * 100 / lines).toFixed(2)) : 0, reconciliations, jobs, stores, duplicateSales: Number(duplicateSales[0]?.count ?? 0), duplicateOrders: Number(duplicateOrders[0]?.count ?? 0), pendingOneDollar, pendingFixtureCheck: pendingFixture }, null, 2));
}

main().finally(() => prisma.$disconnect());
