import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getValidAccessToken, getActiveListings, setStoredToken } from "@/lib/ebay";
import { Prisma } from "@prisma/client";

export async function POST(
  _request: Request,
  { params }: { params: { id: string } }
) {
  const store = await prisma.store.findUnique({ where: { id: params.id } });
  if (!store) {
    return NextResponse.json({ error: "Store not found" }, { status: 404 });
  }

  const syncRun = await prisma.syncRun.create({
    data: {
      storeId: store.id,
      type: "full",
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

    for await (const page of getActiveListings(accessToken, 0)) {
      for (const item of page) {
        const price = new Prisma.Decimal(
          typeof item.SellingStatus?.CurrentPrice?.["#text"] === "number"
            ? item.SellingStatus.CurrentPrice["#text"]
            : 0
        );
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

        const listing = await prisma.listing.upsert({
          where: {
            storeId_ebayItemId: {
              storeId: store.id,
              ebayItemId: item.ItemID,
            },
          },
          create: {
            storeId: store.id,
            ebayItemId: item.ItemID,
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
            storeId: store.id,
            currentPrice: price,
            quantity,
            quantitySold,
            watchers,
            views,
            listingStatus: "active",
            source: "full",
          },
        });

        imported += 1;
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

    await prisma.apiErrorLog.create({
      data: {
        storeId: store.id,
        apiName: "GetMyeBaySelling",
        message,
      },
    });

    await prisma.syncRun.update({
      where: { id: syncRun.id },
      data: { status: "error", completedAt: new Date(), errorMessage: message },
    });

    return NextResponse.json({ error: message, imported }, { status: 500 });
  }
}
