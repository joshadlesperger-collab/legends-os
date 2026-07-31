import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const accountId = searchParams.get("accountId");

  const where: {
    status: string;
    listing?: {
      store?: {
        accountId?: string;
      };
    };
  } = { status: "pending" };

  if (accountId) {
    where.listing = {
      store: { accountId },
    };
  }

  const recommendations = await prisma.recommendation.findMany({
    where,
    include: { listing: true },
    orderBy: [{ expectedProfitImpact: "desc" }, { confidence: "desc" }],
    take: 50,
  });

  const grouped = {
    lower: [] as typeof recommendations,
    relist: [] as typeof recommendations,
    leave: [] as typeof recommendations,
  };

  for (const rec of recommendations) {
    if (rec.type === "lower-price") grouped.lower.push(rec);
    else if (rec.type === "end-relist") grouped.relist.push(rec);
    else if (rec.type === "leave-alone") grouped.leave.push(rec);
  }

  return NextResponse.json({
    date: new Date().toISOString().slice(0, 10),
    ...grouped,
  });
}
