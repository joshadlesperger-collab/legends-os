import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  getValidAccessToken,
  getActiveListings,
  getSellerList,
  setStoredToken,
  EbayApiError,
  type EbayListingItem,
} from "@/lib/ebay";
import { Prisma } from "@prisma/client";

type SyncSource = "full" | "incremental";

// Thresholds and batching constants
const VIEW_CHANGE_THRESHOLD = 20; // views delta required to trigger a snapshot
const WATCHER_CHANGE_THRESHOLD = 3; // watchers delta required to trigger a snapshot
const QUANTITY_CHANGE_THRESHOLD = 1; // quantity available delta considered material
const UPDATE_CHUNK_SIZE = 100; // number of updates per $transaction chunk
const CREATE_MANY_CHUNK = 2000; // chunk size for createMany

function asDecimal(value: unknown): Prisma.Decimal {
  if (typeof value === "number") return new Prisma.Decimal(value);
  if (typeof value === "string") return new Prisma.Decimal(value);
  return new Prisma.Decimal(0);
}

function getPrice(item: EbayListingItem): Prisma.Decimal {
  return asDecimal(item.SellingStatus?.CurrentPrice?.["#text"]);
}

type ImportResult = {
  processed: number;
  telemetry: {
    received: number;
    new: number;
    unchanged: number;
    metadataChanged: number;
    snapshotWorthyChanged: number;
    listingsUpdated: number;
    snapshotsCreated: number;
  };
};

function chunk<T>(arr: T[], size: number) {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function importItems(params: {
  storeId: string;
  items: EbayListingItem[];
  source: SyncSource;
}): Promise<ImportResult> {
  const { storeId, items, source } = params;
  const telemetry = {
    received: items.length,
    new: 0,
    unchanged: 0,
    metadataChanged: 0,
    snapshotWorthyChanged: 0,
    listingsUpdated: 0,
    snapshotsCreated: 0,
  };

  if (items.length === 0) return { processed: 0, telemetry };

  // Build incoming map by ebayItemId
  const incomingByEbayId = new Map<string, EbayListingItem>();
  const ebayIds: string[] = [];
  for (const item of items) {
    const ebayItemId = String(item.ItemID);
    incomingByEbayId.set(ebayItemId, item);
    ebayIds.push(ebayItemId);
  }

  // Bulk-load existing listings and their latest snapshot
  const existingListings = await prisma.listing.findMany({
    where: { storeId, ebayItemId: { in: ebayIds } },
    include: { snapshots: { orderBy: { capturedAt: "desc" }, take: 1 } },
  });

  const existingByEbayId = new Map<string, (typeof existingListings)[number]>();
  for (const l of existingListings) existingByEbayId.set(l.ebayItemId, l);

  // Partition new vs existing
  const newItems: EbayListingItem[] = [];
  const existingItems: EbayListingItem[] = [];
  for (const ebayId of ebayIds) {
    const item = incomingByEbayId.get(ebayId)!;
    if (!existingByEbayId.has(ebayId)) newItems.push(item);
    else existingItems.push(item);
  }

  // Prepare creates for new listings
  const newListingDatas: any[] = [];
  for (const item of newItems) {
    const price = getPrice(item);
    const quantity = Number(item.QuantityAvailable ?? item.Quantity ?? 0);
    const quantitySold = Number(item.SellingStatus?.QuantitySold ?? 0);
    const watchers = Number(item.WatchCount ?? 0);
    const views = Number(item.HitCount ?? 0);
    const imageUrls: string[] = item.PictureDetails?.PictureURL
      ? Array.isArray(item.PictureDetails.PictureURL)
        ? item.PictureDetails.PictureURL
        : [item.PictureDetails.PictureURL]
      : [];

    const startTime = item.ListingDetails?.StartTime
      ? new Date(item.ListingDetails.StartTime)
      : null;
    const endTime = item.ListingDetails?.EndTime
      ? new Date(item.ListingDetails.EndTime)
      : null;

    newListingDatas.push({
      storeId,
      ebayItemId: String(item.ItemID),
      title: item.Title,
      description: item.Description,
      categoryId: item.PrimaryCategory?.CategoryID,
      currentPrice: price,
      quantity,
      quantitySold,
      condition: item.ConditionDisplayName,
      listingStatus: "active",
      listingFormat: item.ListingType,
      startTime,
      endTime,
      watchers,
      views,
      imageUrls,
      lastSyncedAt: new Date(),
    });
  }

  // Bulk create new listings (skip duplicates) in chunks
  if (newListingDatas.length > 0) {
    telemetry.new = newListingDatas.length;
    const chunks = chunk(newListingDatas, CREATE_MANY_CHUNK);
    for (const c of chunks) {
      await prisma.listing.createMany({ data: c, skipDuplicates: true });
    }
  }

  // Reload listings for mapping ids (includes newly created)
  const allRelevantListings = await prisma.listing.findMany({
    where: { storeId, ebayItemId: { in: ebayIds } },
    include: { snapshots: { orderBy: { capturedAt: "desc" }, take: 1 } },
  });
  const allByEbayId = new Map<string, (typeof allRelevantListings)[number]>();
  for (const l of allRelevantListings) allByEbayId.set(l.ebayItemId, l);

  // Prepare snapshot and update buckets
  const snapshotCreates: any[] = [];
  const listingUpdateActions: { id: string; data: any }[] = [];

  for (const item of items) {
    const ebayItemId = String(item.ItemID);
    const incomingPrice = getPrice(item);
    const incomingQuantity = Number(item.QuantityAvailable ?? item.Quantity ?? 0);
    const incomingQuantitySold = Number(item.SellingStatus?.QuantitySold ?? 0);
    const incomingWatchers = Number(item.WatchCount ?? 0);
    const incomingViews = Number(item.HitCount ?? 0);
    const imageUrls: string[] = item.PictureDetails?.PictureURL
      ? Array.isArray(item.PictureDetails.PictureURL)
        ? item.PictureDetails.PictureURL
        : [item.PictureDetails.PictureURL]
      : [];
    const startTime = item.ListingDetails?.StartTime
      ? new Date(item.ListingDetails.StartTime)
      : null;
    const endTime = item.ListingDetails?.EndTime
      ? new Date(item.ListingDetails.EndTime)
      : null;

    const existing = allByEbayId.get(ebayItemId);
    if (!existing) {
      // Should not happen as we reloaded, but guard
      telemetry.unchanged += 1;
      continue;
    }

    // Determine if snapshot-worthy
    const existingSnapshot = existing.snapshots && existing.snapshots[0];
    const existingPriceStr = existing.currentPrice ? String(existing.currentPrice) : null;
    const incomingPriceStr = String(incomingPrice);

    let snapshotWorthy = false;
    // price change
    if (existingPriceStr !== incomingPriceStr) snapshotWorthy = true;
    // quantity available material change
    if (Math.abs((existing.quantity ?? 0) - incomingQuantity) >= QUANTITY_CHANGE_THRESHOLD) snapshotWorthy = true;
    // quantitySold increase
    if ((existing.quantitySold ?? 0) < incomingQuantitySold) snapshotWorthy = true;
    // listing status change (we assume active by default)
    const incomingStatus = "active";
    if ((existing.listingStatus ?? "") !== incomingStatus) snapshotWorthy = true;
    // views/watchers only when meaningful
    if (Math.abs((existing.views ?? 0) - incomingViews) >= VIEW_CHANGE_THRESHOLD) snapshotWorthy = true;
    if (Math.abs((existing.watchers ?? 0) - incomingWatchers) >= WATCHER_CHANGE_THRESHOLD) snapshotWorthy = true;

    // Determine metadata-only changes
    const metadataChanges: any = {};
    if ((existing.title ?? "") !== (item.Title ?? "")) metadataChanges.title = item.Title;
    if ((existing.description ?? "") !== (item.Description ?? "")) metadataChanges.description = item.Description;
    if ((existing.categoryId ?? null) !== (item.PrimaryCategory?.CategoryID ?? null)) metadataChanges.categoryId = item.PrimaryCategory?.CategoryID;
    if ((existing.condition ?? null) !== (item.ConditionDisplayName ?? null)) metadataChanges.condition = item.ConditionDisplayName;
    if ((existing.listingFormat ?? null) !== (item.ListingType ?? null)) metadataChanges.listingFormat = item.ListingType;
    if ((existing.endTime?.toISOString() ?? null) !== (endTime?.toISOString() ?? null)) metadataChanges.endTime = endTime;
    if (JSON.stringify(existing.imageUrls ?? []) !== JSON.stringify(imageUrls)) metadataChanges.imageUrls = imageUrls;
    if ((existing.startTime?.toISOString() ?? null) !== (startTime?.toISOString() ?? null)) metadataChanges.startTime = startTime;

    // If nothing changed at all, count unchanged
    const hasMeta = Object.keys(metadataChanges).length > 0;
    const priceChanged = existingPriceStr !== incomingPriceStr;
    const quantityChanged = Math.abs((existing.quantity ?? 0) - incomingQuantity) >= QUANTITY_CHANGE_THRESHOLD;
    const quantitySoldIncreased = (existing.quantitySold ?? 0) < incomingQuantitySold;
    const statusChanged = (existing.listingStatus ?? "") !== incomingStatus;

    if (!hasMeta && !snapshotWorthy) {
      telemetry.unchanged += 1;
      // still update lastSyncedAt occasionally? skip to keep zero writes
      continue;
    }

    // Record metadata change
    if (hasMeta) telemetry.metadataChanged += 1;

    // If snapshot-worthy, prepare snapshot
    if (snapshotWorthy) {
      telemetry.snapshotWorthyChanged += 1;
      snapshotCreates.push({
        listingId: existing.id,
        storeId,
        currentPrice: incomingPrice,
        quantity: incomingQuantity,
        quantitySold: incomingQuantitySold,
        watchers: incomingWatchers,
        views: incomingViews,
        listingStatus: incomingStatus,
        source,
      });
    }

    // Prepare listing update if metadata changed or we want to update current pointers
    const updateData: any = {};
    if (hasMeta) Object.assign(updateData, metadataChanges);
    // Always update currentPrice/quantity/quantitySold/watchers/views/listingStatus on the listing row to keep pointers in sync
    if (priceChanged) updateData.currentPrice = incomingPrice;
    if (quantityChanged) updateData.quantity = incomingQuantity;
    if (quantitySoldIncreased) updateData.quantitySold = incomingQuantitySold;
    if (Math.abs((existing.watchers ?? 0) - incomingWatchers) >= 1) updateData.watchers = incomingWatchers;
    if (Math.abs((existing.views ?? 0) - incomingViews) >= 1) updateData.views = incomingViews;
    if (statusChanged) updateData.listingStatus = incomingStatus;
    updateData.lastSyncedAt = new Date();

    if (Object.keys(updateData).length > 0) {
      telemetry.listingsUpdated += 1;
      listingUpdateActions.push({ id: existing.id, data: updateData });
    }
  }

  // Create snapshots in chunks
  if (snapshotCreates.length > 0) {
    const chunks = chunk(snapshotCreates, CREATE_MANY_CHUNK);
    for (const c of chunks) {
      await prisma.listingSnapshot.createMany({ data: c });
      telemetry.snapshotsCreated += c.length;
    }
  }

  // Apply listing updates in chunked transactions
  if (listingUpdateActions.length > 0) {
    const updateChunks = chunk(listingUpdateActions, UPDATE_CHUNK_SIZE);
    for (const uc of updateChunks) {
      const tx = uc.map((u) => prisma.listing.update({ where: { id: u.id }, data: u.data }));
      await prisma.$transaction(tx);
    }
  }

  return { processed: items.length, telemetry };
}

async function logSyncError(params: {
  storeId: string;
  apiName: string;
  error: unknown;
}): Promise<void> {
  const { storeId, apiName, error } = params;
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof EbayApiError ? error.code ?? null : null;

  await prisma.apiErrorLog.create({
    data: {
      storeId,
      apiName,
      errorCode: code,
      message,
    },
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const store = await prisma.store.findUnique({ where: { id: params.id } });
  if (!store) {
    return NextResponse.json({ error: "Store not found" }, { status: 404 });
  }

  const mode = (request.nextUrl.searchParams.get("mode") as SyncSource) ?? "full";
  if (mode !== "full" && mode !== "incremental") {
    return NextResponse.json({ error: "mode must be full or incremental" }, { status: 400 });
  }

  const syncRun = await prisma.syncRun.create({
    data: {
      storeId: store.id,
      type: mode,
      status: "running",
    },
  });

  let imported = 0;
  const aggregateTelemetry = {
    received: 0,
    new: 0,
    unchanged: 0,
    metadataChanged: 0,
    snapshotWorthyChanged: 0,
    listingsUpdated: 0,
    snapshotsCreated: 0,
  };

  try {
    const { accessToken, refreshToken, expiresAt } = await getValidAccessToken(store);

    await prisma.store.update({
      where: { id: store.id },
      data: {
        oauthAccessToken: setStoredToken(accessToken),
        oauthRefreshToken: setStoredToken(refreshToken),
        tokenExpiresAt: expiresAt,
      },
    });

    const now = new Date();
    const lastSync = store.lastSyncAt;

    if (mode === "full") {
      for await (const page of getActiveListings(accessToken, 0)) {
        const result = await importItems({ storeId: store.id, items: page, source: "full" });
        imported += result.processed;
        aggregateTelemetry.received += result.telemetry.received;
        aggregateTelemetry.new += result.telemetry.new;
        aggregateTelemetry.unchanged += result.telemetry.unchanged;
        aggregateTelemetry.metadataChanged += result.telemetry.metadataChanged;
        aggregateTelemetry.snapshotWorthyChanged += result.telemetry.snapshotWorthyChanged;
        aggregateTelemetry.listingsUpdated += result.telemetry.listingsUpdated;
        aggregateTelemetry.snapshotsCreated += result.telemetry.snapshotsCreated;

        await prisma.syncRun.update({
          where: { id: syncRun.id },
          data: { listingsProcessed: imported },
        });
      }
    } else {
      const startFrom = lastSync ?? new Date(Date.now() - 60 * 60 * 1000);
      const startTo = now;

      for await (const page of getSellerList(accessToken, 0, { startFrom, startTo })) {
        const result = await importItems({ storeId: store.id, items: page, source: "incremental" });
        imported += result.processed;
        aggregateTelemetry.received += result.telemetry.received;
        aggregateTelemetry.new += result.telemetry.new;
        aggregateTelemetry.unchanged += result.telemetry.unchanged;
        aggregateTelemetry.metadataChanged += result.telemetry.metadataChanged;
        aggregateTelemetry.snapshotWorthyChanged += result.telemetry.snapshotWorthyChanged;
        aggregateTelemetry.listingsUpdated += result.telemetry.listingsUpdated;
        aggregateTelemetry.snapshotsCreated += result.telemetry.snapshotsCreated;

        await prisma.syncRun.update({
          where: { id: syncRun.id },
          data: { listingsProcessed: imported },
        });
      }

      const endFrom = lastSync ?? new Date(Date.now() - 60 * 60 * 1000);
      const endTo = now;

      for await (const page of getSellerList(accessToken, 0, { endFrom, endTo })) {
        const result = await importItems({ storeId: store.id, items: page, source: "incremental" });
        imported += result.processed;
        aggregateTelemetry.received += result.telemetry.received;
        aggregateTelemetry.new += result.telemetry.new;
        aggregateTelemetry.unchanged += result.telemetry.unchanged;
        aggregateTelemetry.metadataChanged += result.telemetry.metadataChanged;
        aggregateTelemetry.snapshotWorthyChanged += result.telemetry.snapshotWorthyChanged;
        aggregateTelemetry.listingsUpdated += result.telemetry.listingsUpdated;
        aggregateTelemetry.snapshotsCreated += result.telemetry.snapshotsCreated;

        await prisma.syncRun.update({
          where: { id: syncRun.id },
          data: { listingsProcessed: imported },
        });
      }
    }

    await prisma.store.update({
      where: { id: store.id },
      data: { lastSyncAt: new Date(), connectionStatus: "connected" },
    });

    await prisma.syncRun.update({
      where: { id: syncRun.id },
      data: { status: "completed", completedAt: new Date(), listingsProcessed: imported },
    });

    return NextResponse.json({ success: true, imported, syncRunId: syncRun.id, telemetry: aggregateTelemetry });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);

    if (err instanceof EbayApiError) {
      await logSyncError({ storeId: store.id, apiName: err.callName, error: err });
    } else {
      await logSyncError({ storeId: store.id, apiName: "SyncPipeline", error: err });
    }

    await prisma.syncRun.update({
      where: { id: syncRun.id },
      data: { status: "error", completedAt: new Date(), errorMessage: message },
    });

    return NextResponse.json({ error: message, imported }, { status: 500 });
  }
}

