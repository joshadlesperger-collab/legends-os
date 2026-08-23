import nextEnv from "@next/env";
const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd(), true);
import { prisma } from "../lib/prisma.ts";

async function main() {
const operatorId = process.argv[2];
if (!operatorId) throw new Error("operator id required");

const rows = await prisma.ebayActionExecution.findMany({
  where: { operatorId },
  select: {
    status: true,
    oldEbayItemId: true,
    newEbayItemId: true,
    events: { select: { type: true, snapshot: true } },
  },
});
const lifetimeGovernedVerified = await prisma.ebayActionExecution.count({
  where: { action: "MIGRATE_LISTING", status: "verified" },
});

const resolved = rows.flatMap((row) =>
  row.events
    .filter((event) => event.type === "provider_result_resolved")
    .map((event) => event.snapshot as { resolution?: string }),
);

console.log(JSON.stringify({
  executions: rows.length,
  verified: rows.filter((row) => row.status === "verified").length,
  failed: rows.filter((row) => row.status === "failed").length,
  parserCaptured: resolved.filter((event) => event.resolution === "provider-item-id").length,
  skuReconciled: resolved.filter((event) => event.resolution === "sku-reconciled").length,
  lifetimeGovernedVerified,
  mappings: rows.flatMap((row) => row.newEbayItemId ? [{ source: row.oldEbayItemId, destination: row.newEbayItemId }] : []),
}, null, 2));

await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exitCode = 1;
});
