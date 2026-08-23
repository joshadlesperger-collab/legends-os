import { prisma } from "../lib/prisma";
import { loadInventoryHealth } from "../lib/inventory-health-data";

async function main() {
  const [total, recovered, unavailable, pending, jobs, health, executions] = await Promise.all([
    prisma.listing.count({ where: { listingStatus: "active" } }),
    prisma.listing.count({ where: { listingStatus: "active", authoritativeSource: "ebay-trading-get-item" } }),
    prisma.listing.count({ where: { listingStatus: "active", authoritativeSource: "ebay-trading-get-item-unavailable" } }),
    prisma.listing.count({ where: { listingStatus: "active", authoritativeObservedAt: null } }),
    prisma.syncJob.findMany({ where: { type: "active_evidence_recovery" }, orderBy: { createdAt: "desc" }, take: 3, select: { status: true, progress: true, failureCount: true, errorMessage: true, updatedAt: true } }),
    loadInventoryHealth(),
    prisma.ebayActionExecution.groupBy({ by: ["status"], _count: { _all: true } }),
  ]);
  const actionableAfterRecovery = health.rows.filter((row) => row.doctrine.interventionSelected !== "MORE_EVIDENCE" && row.doctrine.interventionSelected !== "LEARNING" && row.doctrine.interventionSelected !== "LEAVE_ALONE").length;
  const stillMoreEvidence = health.rows.filter((row) => row.doctrine.interventionSelected === "MORE_EVIDENCE").length;
  console.log(JSON.stringify({ totalBlocked: total, recovered, pending, permanentOrUnavailable: unavailable, actionableAfterRecovery, stillMoreEvidence, executions, jobs }, null, 2));
}

main().finally(() => prisma.$disconnect());
