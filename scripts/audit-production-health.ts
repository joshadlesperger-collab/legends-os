import { prisma } from "../lib/prisma";
import { loadInventoryHealth } from "../lib/inventory-health-data";

async function main() {
  const [duplicateOrders, duplicateEvents, duplicateLines, oneDollar, liveOneDollar, oneDollarGroups, fixtureRecommendations, activeListings, snapshotCount, inventoryHealth] = await Promise.all([
    prisma.$queryRaw<Array<{ count: number }>>`SELECT COUNT(*)::int AS count FROM (SELECT "storeId","providerOrderId" FROM "EbayOrder" GROUP BY 1,2 HAVING COUNT(*)>1) x`,
    prisma.$queryRaw<Array<{ count: number }>>`SELECT COUNT(*)::int AS count FROM (SELECT provider,"providerEventId" FROM "SaleEvent" WHERE "providerEventId" IS NOT NULL GROUP BY 1,2 HAVING COUNT(*)>1) x`,
    prisma.$queryRaw<Array<{ count: number }>>`SELECT COUNT(*)::int AS count FROM (SELECT "orderLineId" FROM "SaleEvent" WHERE "orderLineId" IS NOT NULL GROUP BY 1 HAVING COUNT(*)>1) x`,
    prisma.recommendation.count({ where: { suggestedPrice: 1, type: { in: ["raise-price", "lower-price"] } } }),
    prisma.recommendation.count({ where: { suggestedPrice: 1, status: "pending", type: { in: ["raise-price", "lower-price"] }, actionQueue: { some: { status: "pending" } } } }),
    prisma.recommendation.groupBy({ by: ["status", "type"], where: { suggestedPrice: 1 }, _count: { _all: true }, orderBy: [{ status: "asc" }, { type: "asc" }] }),
    prisma.recommendation.count({ where: { reason: { contains: "fixture", mode: "insensitive" } } }),
    prisma.listing.count({ where: { listingStatus: "active" } }),
    prisma.inventoryHealthSnapshot.count(),
    loadInventoryHealth(),
  ]);
  const trafficEvidence = Object.fromEntries(["recent-window", "lifetime-total", "unavailable"].map(kind => [kind, inventoryHealth.rows.filter(row => row.trafficEvidence === kind).length]));
  const topActions=inventoryHealth.rows.slice().sort((a,b)=>b.priorityScore-a.priorityScore).slice(0,10).map(row=>({title:row.title,action:row.recommendedAction,priority:row.priorityScore,health:row.healthScore,exposure:row.listedExposure,knownCapital:row.knownCapital,why:row.recommendationWhy}));
  console.log(JSON.stringify({ duplicateOrders: duplicateOrders[0]?.count ?? 0, duplicateProviderEvents: duplicateEvents[0]?.count ?? 0, duplicateOrderLineEvents: duplicateLines[0]?.count ?? 0, historicalOneDollarRecommendations: oneDollar, liveQueuedOneDollarRecommendations: liveOneDollar, oneDollarGroups, fixtureRecommendations, activeListings, snapshotCount, trafficEvidence, health: { listingWeighted: Math.round(inventoryHealth.portfolio.listingWeightedHealth), economicallyWeighted: Math.round(inventoryHealth.portfolio.economicallyWeightedHealth) },states:inventoryHealth.portfolio.states,pareto:inventoryHealth.portfolio.pareto,topActions }));
}
main().finally(() => prisma.$disconnect());
