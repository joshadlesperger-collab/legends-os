import { Prisma, type Store } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { EbayApiError, getActiveListings, getItem, getSellerList, getValidAccessToken, setStoredToken, type EbayListingItem } from "@/lib/ebay";
import { classifyObservation, dedupeEbayItems, getIncrementalWindowStart, getSyncRunTerminalStatus, normalizeEbayItem, normalizeItemSpecifics, STALE_RUNNING_SYNC_MS, type ListingObservationStatus } from "@/lib/ebay-sync-domain";

export type SyncMode = "full" | "incremental";
export type SyncTelemetry = Record<"received" | "unique" | "new" | "unchanged" | "changed" | "reappeared" | "ended" | "reconciledEnded" | "listingsUpdated" | "snapshotsCreated" | "priceChangesCreated", number>;
function emptyTelemetry(): SyncTelemetry {
  return { received: 0, unique: 0, new: 0, unchanged: 0, changed: 0, reappeared: 0, ended: 0, reconciledEnded: 0, listingsUpdated: 0, snapshotsCreated: 0, priceChangesCreated: 0 };
}

function mergeTelemetry(target: SyncTelemetry, source: SyncTelemetry) {
  for (const key of Object.keys(target) as Array<keyof SyncTelemetry>) target[key] += source[key];
}

const ACTIVE_CATEGORY_LOOKAHEAD_DAYS = 119;
const MAX_CATEGORY_GET_ITEM_FALLBACKS = 50;

export async function loadAuthoritativeActiveCategoryIds(accessToken: string, observedAt = new Date()) {
  const categories = new Map<string, string>();
  const endFrom = new Date(observedAt.getTime() - 5 * 60 * 1000);
  const endTo = new Date(observedAt.getTime() + ACTIVE_CATEGORY_LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000);

  for await (const page of getSellerList(accessToken, 0, { endFrom, endTo })) {
    for (const item of page) {
      const itemId = String(item.ItemID ?? "").trim();
      const categoryId = item.PrimaryCategory?.CategoryID == null
        ? ""
        : String(item.PrimaryCategory.CategoryID).trim();
      if (itemId && categoryId) categories.set(itemId, categoryId);
    }
  }

  return categories;
}

export async function recoverMissingActiveCategories(storeId: string, accessToken: string, itemIds: string[]) {
  if (itemIds.length > MAX_CATEGORY_GET_ITEM_FALLBACKS) {
    throw new EbayApiError("GetItem", `Category enrichment left ${itemIds.length} active IDs unresolved; refusing an unbounded per-item fallback`, "CATEGORY_ENRICHMENT_INCOMPLETE");
  }
  const unresolved: string[] = [];
  let recovered = 0;
  for (const itemId of itemIds) {
    try {
      const item = await getItem(accessToken, itemId);
      const categoryId = item.PrimaryCategory?.CategoryID == null ? "" : String(item.PrimaryCategory.CategoryID).trim();
      if (!categoryId) { unresolved.push(itemId); continue; }
      const observedAt = new Date();
      await prisma.listing.updateMany({
        where: { storeId, ebayItemId: itemId, listingStatus: "active" },
        data: {
          categoryId,
          title: item.Title,
          condition: item.ConditionDisplayName ?? undefined,
          listingFormat: item.ListingType ?? undefined,
          itemSpecifics: normalizeItemSpecifics(item) ?? Prisma.JsonNull,
          authoritativeSource: "ebay-trading-get-item",
          authoritativeObservedAt: observedAt,
          lastSyncedAt: observedAt,
        },
      });
      recovered += 1;
    } catch (error) {
      const permanent = error instanceof EbayApiError && ["17", "INVALID_ITEM_ID", "MISSING_ITEM"].includes(error.code ?? "");
      if (!permanent) throw error;
      unresolved.push(itemId);
    }
  }
  return { attempted: itemIds.length, recovered, unresolved };
}

export class SyncAlreadyRunningError extends Error {
  constructor(public readonly syncRunId: string) {
    super("A synchronization is already running for this store");
    this.name = "SyncAlreadyRunningError";
  }
}

export async function acquireSyncRun(storeId: string, mode: SyncMode) {
  const staleBefore = new Date(Date.now() - STALE_RUNNING_SYNC_MS);
  try {
    const result = await prisma.$transaction(async (tx) => {
      await tx.syncRun.updateMany({
        where: { storeId, status: "running", startedAt: { lt: staleBefore } },
        data: { status: "failed", completedAt: new Date(), errorMessage: "Synchronization lock expired before completion" },
      });
      const running = await tx.syncRun.findFirst({ where: { storeId, status: "running" }, orderBy: { startedAt: "desc" }, select: { id: true } });
      if (running) return { existingId: running.id, created: null };
      const created = await tx.syncRun.create({ data: { storeId, type: mode, status: "running" } });
      return { existingId: null, created };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    if (result.existingId) throw new SyncAlreadyRunningError(result.existingId);
    return result.created!;
  } catch (error) {
    if (error instanceof SyncAlreadyRunningError) throw error;
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
      const running = await prisma.syncRun.findFirst({ where: { storeId, status: "running" }, orderBy: { startedAt: "desc" }, select: { id: true } });
      if (running) throw new SyncAlreadyRunningError(running.id);
    }
    throw error;
  }
}

export async function importItems(params: { storeId: string; items: EbayListingItem[]; source: string; status: ListingObservationStatus; observedAt: Date }): Promise<SyncTelemetry> {
  const telemetry = emptyTelemetry();
  telemetry.received = params.items.length;
  const items = dedupeEbayItems(params.items);
  telemetry.unique = items.length;
  if (!items.length) return telemetry;

  const observations = items.map((item) => normalizeEbayItem(item, params.status));
  const ebayIds = observations.map((item) => item.ebayItemId);
  const existingRows = await prisma.listing.findMany({ where: { storeId: params.storeId, ebayItemId: { in: ebayIds } } });
  const existingById = new Map(existingRows.map((row) => [row.ebayItemId, row]));
  const newRows = observations.filter((row) => !existingById.has(row.ebayItemId));

  if (newRows.length) {
    await prisma.listing.createMany({
      data: newRows.map((row) => ({
        storeId: params.storeId, ebayItemId: row.ebayItemId, sku: row.sku, title: row.title, description: row.description,
        categoryId: row.categoryId, currentPrice: new Prisma.Decimal(row.currentPrice), quantity: row.quantity,
        quantitySold: row.quantitySold, condition: row.condition, listingStatus: row.listingStatus,
        listingFormat: row.listingFormat, startTime: row.startTime, endTime: row.endTime,
        watchers: row.watchers ?? 0, views: row.views ?? 0, imageUrls: row.imageUrls, lastSyncedAt: params.observedAt,
        itemSpecifics: row.itemSpecifics ?? Prisma.JsonNull,
      })), skipDuplicates: true,
    });
  }

  const currentRows = await prisma.listing.findMany({ where: { storeId: params.storeId, ebayItemId: { in: ebayIds } } });
  const currentById = new Map(currentRows.map((row) => [row.ebayItemId, row]));
  const newIds = new Set(newRows.map((row) => row.ebayItemId));
  const snapshots: Prisma.ListingSnapshotCreateManyInput[] = [];
  const priceChanges: Prisma.PriceChangeCreateManyInput[] = [];
  const updates: Array<{ id: string; data: Prisma.ListingUpdateInput }> = [];
  const unchangedIds: string[] = [];

  for (const observation of observations) {
    const current = currentById.get(observation.ebayItemId);
    if (!current) throw new Error(`Listing ${observation.ebayItemId} was not persisted`);
    const previous = existingById.get(observation.ebayItemId) ?? null;
    const classification = classifyObservation(previous ? {
      title: previous.title, sku: previous.sku, description: previous.description, categoryId: previous.categoryId,
      condition: previous.condition, listingFormat: previous.listingFormat, startTime: previous.startTime,
      endTime: previous.endTime, imageUrls: previous.imageUrls,
      currentPrice: String(previous.currentPrice), quantity: previous.quantity, quantitySold: previous.quantitySold,
      watchers: previous.watchers, views: previous.views, listingStatus: previous.listingStatus,
    } : null, observation);
    telemetry[classification.kind] += 1;

    if (newIds.has(observation.ebayItemId) || classification.snapshotWorthy) {
      snapshots.push({ listingId: current.id, storeId: params.storeId, capturedAt: params.observedAt,
        currentPrice: new Prisma.Decimal(observation.currentPrice), quantity: observation.quantity,
        quantitySold: observation.quantitySold, watchers: observation.watchers ?? current.watchers,
        views: observation.views ?? current.views, listingStatus: observation.listingStatus, source: params.source });
    }
    if (previous && classification.priceChanged) {
      priceChanges.push({ listingId: current.id, oldPrice: previous.currentPrice,
        newPrice: new Prisma.Decimal(observation.currentPrice), changedAt: params.observedAt, source: params.source });
    }
    if (!previous) continue;
    if (classification.kind === "unchanged") { unchangedIds.push(current.id); continue; }
    updates.push({ id: current.id, data: {
      title: observation.title, sku: observation.sku, description: observation.description, categoryId: observation.categoryId,
      currentPrice: new Prisma.Decimal(observation.currentPrice), quantity: observation.quantity,
      quantitySold: observation.quantitySold, condition: observation.condition, listingStatus: observation.listingStatus,
      listingFormat: observation.listingFormat, startTime: observation.startTime, endTime: observation.endTime,
      watchers: observation.watchers ?? current.watchers, views: observation.views ?? current.views,
      imageUrls: observation.imageUrls, lastSyncedAt: params.observedAt,
      ...(observation.itemSpecifics ? { itemSpecifics: observation.itemSpecifics } : {}),
    }});
  }

  const operations: Array<Prisma.PrismaPromise<unknown>> = [];
  if (snapshots.length) operations.push(prisma.listingSnapshot.createMany({ data: snapshots }));
  if (priceChanges.length) operations.push(prisma.priceChange.createMany({ data: priceChanges }));
  if (unchangedIds.length) operations.push(prisma.listing.updateMany({ where: { id: { in: unchangedIds } }, data: { lastSyncedAt: params.observedAt } }));
  for (const update of updates) operations.push(prisma.listing.update({ where: { id: update.id }, data: update.data }));
  if (operations.length) await prisma.$transaction(operations);
  telemetry.listingsUpdated = updates.length + unchangedIds.length + newRows.length;
  telemetry.snapshotsCreated = snapshots.length;
  telemetry.priceChangesCreated = priceChanges.length;
  return telemetry;
}

async function reconcileMissingActiveListings(storeId: string, fullSyncStartedAt: Date) {
  const missing = await prisma.listing.findMany({
    where: { storeId, listingStatus: "active", lastSyncedAt: { lt: fullSyncStartedAt } },
    select: { id: true, currentPrice: true, quantity: true, quantitySold: true, watchers: true, views: true },
  });
  if (!missing.length) return 0;
  const observedAt = new Date();
  await prisma.$transaction([
    prisma.listingSnapshot.createMany({ data: missing.map((row) => ({ listingId: row.id, storeId, capturedAt: observedAt,
      currentPrice: row.currentPrice, quantity: row.quantity, quantitySold: row.quantitySold, watchers: row.watchers,
      views: row.views, listingStatus: "ended", source: "full-reconciliation" })) }),
    prisma.listing.updateMany({ where: { id: { in: missing.map((row) => row.id) }, listingStatus: "active" }, data: { listingStatus: "ended" } }),
  ]);
  return missing.length;
}

async function logSyncError(storeId: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  await prisma.apiErrorLog.create({ data: { storeId, apiName: error instanceof EbayApiError ? error.callName : "SyncPipeline",
    errorCode: error instanceof EbayApiError ? error.code ?? null : null, message: message.slice(0, 2000) } });
}

export async function runStoreSync(store: Store, mode: SyncMode, syncRunId: string) {
  const telemetry = emptyTelemetry();
  let categoryEnrichment = { sellerListCategories: 0, getItemAttempted: 0, getItemRecovered: 0, unresolvedItemIds: [] as string[] };
  let processed = 0;
  try {
    const { accessToken, refreshToken, expiresAt } = await getValidAccessToken(store);
    await prisma.store.update({ where: { id: store.id }, data: { oauthAccessToken: setStoredToken(accessToken), oauthRefreshToken: setStoredToken(refreshToken), tokenExpiresAt: expiresAt } });
    const syncStartedAt = new Date();
    const syncTo = new Date();
    if (mode === "full") {
      // GetMyeBaySelling is the complete active-population authority but omits
      // PrimaryCategory. GetSellerList returns the seller-authored category, so
      // enrich only the exact active IDs enumerated by GetMyeBaySelling.
      const persistedCategories = new Map(
        (await prisma.listing.findMany({
          where: { storeId: store.id, listingStatus: "active", categoryId: { not: null } },
          select: { ebayItemId: true, categoryId: true },
        })).flatMap((row) => row.categoryId ? [[row.ebayItemId, row.categoryId] as const] : [])
      );
      const authoritativeCategories = await loadAuthoritativeActiveCategoryIds(accessToken, syncStartedAt);
      categoryEnrichment.sellerListCategories = authoritativeCategories.size;
      const unresolvedCategoryIds: string[] = [];
      for await (const page of getActiveListings(accessToken, 0)) {
        const enrichedPage = page.map((item) => {
          const categoryId = authoritativeCategories.get(String(item.ItemID)) ?? persistedCategories.get(String(item.ItemID));
          if (!categoryId) unresolvedCategoryIds.push(String(item.ItemID));
          return categoryId ? { ...item, PrimaryCategory: { ...item.PrimaryCategory, CategoryID: categoryId } } : item;
        });
        const result = await importItems({ storeId: store.id, items: enrichedPage, source: "full", status: "active", observedAt: new Date() });
        mergeTelemetry(telemetry, result); processed += result.unique;
        await prisma.syncRun.update({ where: { id: syncRunId }, data: { listingsProcessed: processed } });
      }
      const fallback = await recoverMissingActiveCategories(store.id, accessToken, Array.from(new Set(unresolvedCategoryIds)));
      categoryEnrichment = { sellerListCategories: authoritativeCategories.size, getItemAttempted: fallback.attempted, getItemRecovered: fallback.recovered, unresolvedItemIds: fallback.unresolved };
      const reconciled = await reconcileMissingActiveListings(store.id, syncStartedAt);
      telemetry.reconciledEnded += reconciled; telemetry.ended += reconciled; telemetry.snapshotsCreated += reconciled;
    } else {
      const windowStart = getIncrementalWindowStart(store.lastSyncAt, syncTo);
      for await (const page of getSellerList(accessToken, 0, { startFrom: windowStart, startTo: syncTo })) {
        const result = await importItems({ storeId: store.id, items: page, source: "incremental-started", status: "active", observedAt: new Date() });
        mergeTelemetry(telemetry, result); processed += result.unique;
      }
      for await (const page of getSellerList(accessToken, 0, { endFrom: windowStart, endTo: syncTo })) {
        const result = await importItems({ storeId: store.id, items: page, source: "incremental-ended", status: "ended", observedAt: new Date() });
        mergeTelemetry(telemetry, result); processed += result.unique;
      }
    }
    await prisma.$transaction([
      prisma.store.update({ where: { id: store.id }, data: { lastSyncAt: syncTo, connectionStatus: "connected" } }),
      prisma.syncRun.update({ where: { id: syncRunId }, data: { status: getSyncRunTerminalStatus("success"), completedAt: new Date(), listingsProcessed: processed } }),
    ]);
    return { imported: processed, telemetry, categoryEnrichment };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await logSyncError(store.id, error).catch(() => undefined);
    await prisma.syncRun.update({ where: { id: syncRunId }, data: { status: getSyncRunTerminalStatus("failure"), completedAt: new Date(), errorMessage: message.slice(0, 2000) } });
    throw error;
  }
}
