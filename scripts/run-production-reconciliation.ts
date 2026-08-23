import { prisma } from "../lib/prisma.ts";
import { reconcileUnlinkedOrderLines } from "../lib/reconciliation.ts";

const databaseUrl = process.env.DATABASE_URL;
let target: URL | null = null;
try { target = databaseUrl ? new URL(databaseUrl) : null; } catch { target = null; }

if (process.env.LEGENDS_PRODUCTION_RECONCILIATION !== "approved") {
  throw new Error("Production reconciliation approval marker is missing");
}
if (!target || !["postgres:", "postgresql:"].includes(target.protocol) || target.hostname !== "db.prisma.io") {
  throw new Error("Refusing reconciliation: DATABASE_URL is not the approved production host");
}

async function snapshot() {
  const [totalLines, linkedLines, orders, listings, saleEvents, stores, activeJobs, allJobs, statuses] = await Promise.all([
    prisma.ebayOrderLine.count(),
    prisma.ebayOrderLine.count({ where: { listingId: { not: null } } }),
    prisma.ebayOrder.count(),
    prisma.listing.count(),
    prisma.saleEvent.count(),
    prisma.store.count(),
    prisma.syncJob.count({ where: { status: { in: ["pending", "running", "retryable", "paused"] } } }),
    prisma.syncJob.count(),
    prisma.orderLineReconciliation.groupBy({ by: ["status"], _count: { _all: true } }),
  ]);
  return {
    totalLines, linkedLines, unlinkedLines: totalLines - linkedLines,
    linkagePercent: totalLines ? Number((linkedLines * 100 / totalLines).toFixed(2)) : 0,
    orders, listings, saleEvents, stores, activeJobs, allJobs,
    reconciliationStatuses: Object.fromEntries(statuses.map((row) => [row.status, row._count._all])),
  };
}

function reasonDistribution(rows: Array<{ reasons: unknown }>) {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const value = row.reasons as { primary?: unknown } | string[] | null;
    const reasons = Array.isArray(value) ? value : Array.isArray(value?.primary) ? value.primary : [];
    for (const reason of reasons) {
      const label = String(reason).replace(/^\d+% title-token overlap$/, "Title-token overlap");
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
  }
  return Object.fromEntries(Array.from(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

async function main() {
  try {
    const before = await snapshot();
    const startedAt = new Date();
    const result = await reconcileUnlinkedOrderLines();
    const [after, newRows, confidence] = await Promise.all([
      snapshot(),
      prisma.orderLineReconciliation.findMany({ where: { createdAt: { gte: startedAt } }, select: { reasons: true } }),
      prisma.orderLineReconciliation.groupBy({ by: ["status", "matchTier", "confidence"], _count: { _all: true }, orderBy: [{ status: "asc" }, { confidence: "desc" }] }),
    ]);
    console.log(JSON.stringify({
      before,
      engine: result,
      after,
      jobsUnchanged: before.activeJobs === after.activeJobs && before.allJobs === after.allJobs,
      confidenceDistribution: confidence.map((row) => ({ status: row.status, tier: row.matchTier, confidence: row.confidence, count: row._count._all })),
      matchReasonDistribution: reasonDistribution(newRows),
    }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

void main();
