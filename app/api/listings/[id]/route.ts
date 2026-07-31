import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(
  _request: Request,
  { params }: { params: { id: string } }
) {
  const listing = await prisma.listing.findUnique({
    where: { id: params.id },
    include: {
      snapshots: { orderBy: { capturedAt: "desc" }, take: 50 },
      priceChanges: { orderBy: { changedAt: "desc" }, take: 50 },
      saleEvents: { orderBy: { soldAt: "desc" }, take: 50 },
      scores: { orderBy: { calculatedAt: "desc" }, take: 1 },
      recommendations: { orderBy: { generatedAt: "desc" }, take: 10 },
    },
  });

  if (!listing) {
    return NextResponse.json({ error: "Listing not found" }, { status: 404 });
  }

  return NextResponse.json({ listing });
}
