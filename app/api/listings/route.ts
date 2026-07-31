import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const storeId = searchParams.get("storeId");
  const status = searchParams.get("status");

  const where: {
    storeId?: string;
    listingStatus?: string;
  } = {};
  if (storeId) where.storeId = storeId;
  if (status) where.listingStatus = status;

  const listings = await prisma.listing.findMany({
    where,
    orderBy: { lastSyncedAt: "desc" },
    take: 100,
    include: {
      scores: {
        orderBy: { calculatedAt: "desc" },
        take: 1,
      },
      store: { select: { ebaySellerUsername: true } },
    },
  });

  return NextResponse.json({ listings });
}
