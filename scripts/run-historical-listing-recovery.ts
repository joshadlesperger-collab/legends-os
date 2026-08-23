import { prisma } from "../lib/prisma.ts";
import { processHistoricalListingRecoveries } from "../lib/historical-listing-recovery.ts";
import { reconcileUnlinkedOrderLines } from "../lib/reconciliation.ts";

const rawUrl = process.env.DATABASE_URL;
let target: URL | null = null;
try { target = rawUrl ? new URL(rawUrl) : null; } catch { target = null; }
if (process.env.LEGENDS_HISTORICAL_RECOVERY !== "approved" || !target || target.hostname !== "db.prisma.io") throw new Error("Refusing historical recovery: production target or approval marker is missing");

async function metrics() {
  const [total, linked, listings, recoveries, failures, queue] = await Promise.all([
    prisma.ebayOrderLine.count(), prisma.ebayOrderLine.count({ where: { listingId: { not: null } } }), prisma.listing.count(),
    prisma.historicalListingRecovery.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.historicalListingRecovery.groupBy({ by: ["status", "errorCode"], where: { status: { in: ["retryable", "not_found"] } }, _count: { _all: true } }),
    prisma.orderLineReconciliation.groupBy({ by: ["status", "confidence"], _count: { _all: true } }),
  ]);
  return { total, linked, unlinked: total - linked, linkagePercent: total ? Number((linked * 100 / total).toFixed(2)) : 0, listings, recoveries: Object.fromEntries(recoveries.map((row) => [row.status, row._count._all])), failures: failures.map((row) => ({ status: row.status, code: row.errorCode, count: row._count._all })), queue };
}

async function main() {
  const before = await metrics();
  if (process.argv.includes("--audit")) { console.log(JSON.stringify({ current: before }, null, 2)); return; }
  const totals = { attempted: 0, recovered: 0, linked: 0, notFound: 0, retryable: 0, unavailableStore: 0 };
  for (;;) {
    const batch = await processHistoricalListingRecoveries(10);
    for (const key of Object.keys(totals) as Array<keyof typeof totals>) totals[key] += batch[key];
    console.error(`Historical recovery progress: attempted=${totals.attempted} recovered=${totals.recovered} linked=${totals.linked}`);
    if (batch.attempted === 0) break;
  }
  const reconciliation = await reconcileUnlinkedOrderLines();
  const after = await metrics();
  console.log(JSON.stringify({ before, recovery: totals, reconciliation, after }, null, 2));
}

main().finally(() => prisma.$disconnect());
