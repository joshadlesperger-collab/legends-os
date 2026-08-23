import nextEnv from "@next/env";
const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd(), true);

import { prisma } from "../lib/prisma.ts";
import { getActiveListings, getValidAccessToken, type EbayListingItem } from "../lib/ebay.ts";

async function main() {
  const store = await prisma.store.findFirst({
    where: { isActive: true, connectionStatus: "connected" },
  });
  if (!store) throw new Error("No connected destination store");

  const { accessToken } = await getValidAccessToken(store);
  const destination: EbayListingItem[] = [];
  for await (const page of getActiveListings(accessToken)) destination.push(...page);

  const itemIds = destination.map((item) => String(item.ItemID));
  const uniqueItemIds = new Set(itemIds);
  if (uniqueItemIds.size !== destination.length) {
    throw new Error("Fail closed: complete enumeration contained duplicate item IDs");
  }

  const migrationSkus = new Set(
    destination.map((item) => String(item.SKU ?? "")).filter((sku) => sku.startsWith("MIG-")),
  );
  const verified = await prisma.ebayActionExecution.findMany({
    where: { action: "MIGRATE_LISTING", status: "verified" },
    select: { oldEbayItemId: true, newEbayItemId: true },
  });
  const activeVerifiedDestinations = verified.filter(
    (execution) => execution.newEbayItemId && uniqueItemIds.has(execution.newEbayItemId),
  ).length;

  console.log(JSON.stringify({
    tradingApiHealth: "HEALTHY",
    stableEnumeration: true,
    activeDestinationCount: destination.length,
    uniqueDestinationItemIds: uniqueItemIds.size,
    duplicateItemIds: destination.length - uniqueItemIds.size,
    activeMigrationSkuCount: migrationSkus.size,
    verifiedMigrationExecutions: verified.length,
    activeVerifiedDestinations,
    checkedAt: new Date().toISOString(),
    writesPerformed: 0,
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
