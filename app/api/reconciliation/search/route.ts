import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(request: NextRequest) {
  const query = request.nextUrl.searchParams.get("q")?.trim();
  const storeId = request.nextUrl.searchParams.get("storeId")?.trim();
  if (!query || !storeId) return NextResponse.json({ listings: [] });
  const listings = await prisma.listing.findMany({ where: { storeId, OR: [{ ebayItemId: query }, { sku: query }, { title: { contains: query, mode: "insensitive" } }] }, take: 20, orderBy: { lastSyncedAt: "desc" }, select: { id: true, ebayItemId: true, sku: true, title: true, currentPrice: true, listingStatus: true } });
  return NextResponse.json({ listings });
}
