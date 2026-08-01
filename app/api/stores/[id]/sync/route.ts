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

function asDecimal(value: unknown): Prisma.Decimal {
  if (typeof value === "number") return new Prisma.Decimal(value);
  if (typeof value === "string") return new Prisma.Decimal(value);
  return new Prisma.Decimal(0);
}

function getPrice(item: EbayListingItem): Prisma.Decimal {
  return asDecimal(item.SellingStatus?.CurrentPrice?.["#text"]);
}

async function importItems(params: {
  storeId: string;
  items: EbayListingItem[];
  source: SyncSource;
}): Promise<number> {
  const { storeId, items, source } = params;
  for (const item of items) {
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

    const ebayItemId = String(item.ItemID);

    const listing = await prisma.listing.upsert({
      where: {
        storeId_ebayItemId: {
          storeId,
          ebayItemId,
        },
      },
      create: {
        storeId,
        ebayItemId,
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
      },
      update: {
        title: item.Title,
        description: item.Description,
        categoryId: item.PrimaryCategory?.CategoryID,
        currentPrice: price,
        quantity,
        quantitySold,
        condition: item.ConditionDisplayName,
        listingFormat: item.ListingType,
        endTime,
        watchers,
        views,
        imageUrls,
        lastSyncedAt: new Date(),
      },
    });

    await prisma.listingSnapshot.create({
      data: {
        listingId: listing.id,
        storeId,
        currentPrice: price,
        quantity,
        quantitySold,
        watchers,
        views,
        listingStatus: "active",
        source,
      },
    });
  }
  return items.length;
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
        const count = await importItems({ storeId: store.id, items: page, source: "full" });
        imported += count;

        await prisma.syncRun.update({
          where: { id: syncRun.id },
          data: { listingsProcessed: imported },
        });
      }
    } else {
      const startFrom = lastSync ?? new Date(Date.now() - 60 * 60 * 1000);
      const startTo = now;

      for await (const page of getSellerList(accessToken, 0, { startFrom, startTo })) {
        const count = await importItems({ storeId: store.id, items: page, source: "incremental" });
        imported += count;

        await prisma.syncRun.update({
          where: { id: syncRun.id },
          data: { listingsProcessed: imported },
        });
      }

      const endFrom = lastSync ?? new Date(Date.now() - 60 * 60 * 1000);
      const endTo = now;

      for await (const page of getSellerList(accessToken, 0, { endFrom, endTo })) {
        const count = await importItems({ storeId: store.id, items: page, source: "incremental" });
        imported += count;

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

    return NextResponse.json({ success: true, imported, syncRunId: syncRun.id });
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

