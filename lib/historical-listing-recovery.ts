import { Prisma, type HistoricalListingRecovery, type Store } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { EbayApiError, getItem, getValidAccessToken, type EbayListingItem } from "@/lib/ebay";
import { importItems } from "@/lib/ebay-sync-service";
import { normalizeItemSpecifics } from "@/lib/ebay-sync-domain";

export async function seedHistoricalListingRecoveries() {
  const lines = await prisma.ebayOrderLine.findMany({ where: { listingId: null, ebayItemId: { not: null } }, distinct: ["storeId", "ebayItemId"], select: { storeId: true, ebayItemId: true } });
  const candidates = lines.filter((line): line is { storeId: string; ebayItemId: string } => Boolean(line.ebayItemId));
  if (candidates.length) await prisma.historicalListingRecovery.createMany({ data: candidates.map((line) => ({ storeId: line.storeId, ebayItemId: line.ebayItemId })), skipDuplicates: true });
  return candidates.length;
}

export async function recoverHistoricalListing(recovery: HistoricalListingRecovery, store: Store) {
  const attemptedAt = new Date();
  try {
    const { accessToken } = await getValidAccessToken(store);
    const item = await getItem(accessToken, recovery.ebayItemId);
    await importItems({ storeId: store.id, items: [item], source: "historical-get-item", status: "ended", observedAt: attemptedAt });
    const listing = await prisma.listing.findUniqueOrThrow({ where: { storeId_ebayItemId: { storeId: store.id, ebayItemId: recovery.ebayItemId } }, select: { id: true } });
    const specifics = normalizeItemSpecifics(item);
    const relistedToEbayItemId = item.RelistedItemID == null ? null : String(item.RelistedItemID);
    const linked = await prisma.$transaction(async (tx) => {
      await tx.listing.update({ where: { id: listing.id }, data: { itemSpecifics: specifics ?? Prisma.JsonNull, authoritativeSource: "ebay-trading-get-item", authoritativeObservedAt: attemptedAt, relistedToEbayItemId } });
      const lines = await tx.ebayOrderLine.findMany({ where: { storeId: store.id, ebayItemId: recovery.ebayItemId, listingId: null }, select: { id: true } });
      if (lines.length) {
        await tx.ebayOrderLine.updateMany({ where: { id: { in: lines.map((line) => line.id) }, listingId: null }, data: { listingId: listing.id } });
        await tx.saleEvent.updateMany({ where: { orderLineId: { in: lines.map((line) => line.id) }, listingId: null }, data: { listingId: listing.id } });
        for (const line of lines) await tx.orderLineReconciliation.upsert({ where: { orderLineId: line.id }, create: { orderLineId: line.id, candidateListingId: listing.id, status: "auto_linked", matchTier: "deterministic", confidence: 100, reasons: ["Exact eBay ItemID recovered from Trading API"] }, update: { candidateListingId: listing.id, status: "auto_linked", matchTier: "deterministic", confidence: 100, reasons: ["Exact eBay ItemID recovered from Trading API"], reviewedAt: null } });
      }
      await tx.historicalListingRecovery.update({ where: { id: recovery.id }, data: { status: "recovered", attemptCount: { increment: 1 }, lastAttemptAt: attemptedAt, recoveredListingId: listing.id, errorCode: null, errorMessage: null } });
      return lines.length;
    });
    return { status: "recovered" as const, linked };
  } catch (error) {
    const permanent = error instanceof EbayApiError && ["17", "INVALID_ITEM_ID"].includes(error.code ?? "");
    const errorMessage = error instanceof EbayApiError ? error.message : error instanceof Error && /access token|encryption key|reauthorization/i.test(error.message) ? error.message : "Historical listing persistence failed";
    await prisma.historicalListingRecovery.update({ where: { id: recovery.id }, data: { status: permanent ? "not_found" : "retryable", attemptCount: { increment: 1 }, lastAttemptAt: attemptedAt, errorCode: error instanceof EbayApiError ? error.code : null, errorMessage: errorMessage.slice(0, 1000) } });
    return { status: permanent ? "not_found" as const : "retryable" as const, linked: 0 };
  }
}

export async function processHistoricalListingRecoveries(limit = 25) {
  await seedHistoricalListingRecoveries();
  const rows = await prisma.historicalListingRecovery.findMany({ where: { status: { in: ["pending", "retryable"] }, attemptCount: { lt: 3 } }, take: Math.max(1, Math.min(limit, 50)), orderBy: [{ attemptCount: "asc" }, { createdAt: "asc" }] });
  const stores = await prisma.store.findMany({ where: { id: { in: Array.from(new Set(rows.map((row) => row.storeId))) } } });
  const byStore = new Map(stores.map((store) => [store.id, store]));
  const result = { attempted: 0, recovered: 0, linked: 0, notFound: 0, retryable: 0, unavailableStore: 0 };
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(3, rows.length) }, async () => {
    for (;;) {
      const index = nextIndex; nextIndex += 1;
      const row = rows[index]; if (!row) return;
      const store = byStore.get(row.storeId);
      if (!store) { result.unavailableStore += 1; continue; }
      const outcome = await recoverHistoricalListing(row, store); result.attempted += 1; result.linked += outcome.linked;
      if (outcome.status === "recovered") result.recovered += 1; else if (outcome.status === "not_found") result.notFound += 1; else result.retryable += 1;
    }
  });
  await Promise.all(workers);
  return result;
}

export async function processHistoricalListingRecoveryChunk(storeId: string) {
  const recovery = await prisma.historicalListingRecovery.findFirst({ where: { storeId, status: { in: ["pending", "retryable"] }, attemptCount: { lt: 3 } }, orderBy: [{ attemptCount: "asc" }, { createdAt: "asc" }] });
  if (!recovery) return { attempted: 0, recovered: 0, linked: 0, remaining: 0 };
  const store = await prisma.store.findUniqueOrThrow({ where: { id: storeId } });
  const outcome = await recoverHistoricalListing(recovery, store);
  const remaining = await prisma.historicalListingRecovery.count({ where: { storeId, status: { in: ["pending", "retryable"] }, attemptCount: { lt: 3 } } });
  return { attempted: 1, recovered: outcome.status === "recovered" ? 1 : 0, linked: outcome.linked, remaining };
}
