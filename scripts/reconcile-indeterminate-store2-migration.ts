import nextEnv from "@next/env";
const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd(), true);

import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.ts";
import { getActiveListings, getValidAccessToken, type EbayListingItem } from "../lib/ebay.ts";

const SOURCE_ITEM_ID = "358847683279";
const SKU = `MIG-${SOURCE_ITEM_ID}`;

const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const price = (item: EbayListingItem) => {
  const raw = item.SellingStatus?.CurrentPrice;
  return Number(raw && typeof raw === "object" ? raw["#text"] : raw);
};
const images = (item: EbayListingItem) => {
  const raw = item.PictureDetails?.PictureURL;
  return raw ? (Array.isArray(raw) ? raw : [raw]) : [];
};
const specifics = (item: EbayListingItem) => {
  const raw = item.ItemSpecifics?.NameValueList;
  if (!raw) return new Map<string, string>();
  const rows = Array.isArray(raw) ? raw : [raw];
  return new Map(rows.flatMap((row) => row.Name && row.Value
    ? [[row.Name.toLowerCase(), (Array.isArray(row.Value) ? row.Value : [row.Value]).join("|")]] as Array<[string, string]>
    : []));
};

async function appendEvent(executionId: string, type: string, snapshot: unknown) {
  const latest = await prisma.ebayActionExecutionEvent.findFirst({ where: { executionId }, orderBy: { sequence: "desc" }, select: { sequence: true } });
  await prisma.ebayActionExecutionEvent.create({ data: { executionId, sequence: (latest?.sequence ?? 0) + 1, type, snapshot: json(snapshot) } });
}

async function main() {
  const execution = await prisma.ebayActionExecution.findUnique({
    where: { idempotencyKey: `store2:${SOURCE_ITEM_ID}:destination:cms9lqhp4000115qjo6hq9pq3` },
    include: { listing: true },
  });
  if (!execution) throw new Error("Indeterminate migration execution was not found");
  const store = await prisma.store.findUnique({ where: { id: execution.storeId } });
  if (!store || !store.isActive || store.connectionStatus !== "connected") throw new Error("Destination store is not actively connected");
  const { accessToken } = await getValidAccessToken(store, { forceRefresh: true });

  const active: EbayListingItem[] = [];
  for await (const page of getActiveListings(accessToken)) active.push(...page);
  const ids = new Set(active.map((item) => String(item.ItemID)));
  if (ids.size !== active.length) throw new Error("Stable destination enumeration contains duplicate Item IDs");
  const matches = active.filter((item) => String(item.SKU ?? "").trim() === SKU);
  if (matches.length > 1) throw new Error(`DUPLICATE RISK: ${matches.length} active listings use ${SKU}`);

  const proposed = execution.proposedState as Record<string, unknown>;
  if (matches.length === 0) {
    await appendEvent(execution.id, "destination_sku_reconciled_zero_safe_retry", { sku: SKU, activeDestinationCount: active.length, enumeratedUnique: ids.size, sourceUntouched: true });
    console.log(JSON.stringify({ authentication: "HEALTHY", activeDestinationCount: active.length, uniqueDestinationCount: ids.size, sku: SKU, matches: 0, disposition: "SAFE_FOR_GOVERNED_RETRY", executionId: execution.id }, null, 2));
    return;
  }

  const item = matches[0];
  const diffs: string[] = [];
  if (item.Title !== proposed.title) diffs.push("title");
  if (Math.abs(price(item) - Number(proposed.price)) > 0.005) diffs.push("price");
  if (Number(item.QuantityAvailable) !== Number(proposed.quantity) && Number(item.Quantity) !== Number(proposed.quantity)) diffs.push("quantity");
  if (String(item.PrimaryCategory?.CategoryID ?? "") !== String(proposed.categoryId ?? "")) diffs.push("category");
  if (images(item).length !== Number(proposed.imageCount)) diffs.push("images");
  const actualSpecifics = specifics(item);
  for (const expected of (proposed.specifics as Array<{ name: string; value: string }> ?? [])) {
    if (actualSpecifics.get(expected.name.toLowerCase()) !== expected.value) diffs.push(`specific:${expected.name}`);
  }
  if (diffs.length) throw new Error(`MATERIAL RECONCILIATION DIFFERENCES: ${diffs.join(", ")}`);

  await prisma.$transaction([
    prisma.listing.update({ where: { id: execution.listingId }, data: { ebayItemId: String(item.ItemID), listingStatus: "active", title: item.Title, currentPrice: price(item), quantity: Number(proposed.quantity), categoryId: String(proposed.categoryId), condition: item.ConditionDisplayName ?? execution.listing.condition, imageUrls: images(item), authoritativeSource: "store2-migration-provider-verified", authoritativeObservedAt: new Date(), lastSyncedAt: new Date() } }),
    prisma.ebayActionExecution.update({ where: { id: execution.id }, data: { status: "verified", newEbayItemId: String(item.ItemID), providerVerifiedAt: new Date() } }),
  ]);
  await appendEvent(execution.id, "provider_verified_by_mandatory_sku_reconciliation", { sku: SKU, destinationItemId: String(item.ItemID), differences: [], activeDestinationCount: active.length, sourceUntouched: true });
  console.log(JSON.stringify({ authentication: "HEALTHY", activeDestinationCount: active.length, uniqueDestinationCount: ids.size, sku: SKU, matches: 1, destinationItemId: String(item.ItemID), disposition: "VERIFIED_EXISTING_DESTINATION", differences: [], executionId: execution.id }, null, 2));
}

main().finally(() => prisma.$disconnect()).catch((error) => { console.error(error instanceof Error ? error.stack ?? error.message : error); process.exitCode = 1; });
