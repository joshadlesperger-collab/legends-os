import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ACTIONABLE_PRICING_TYPES } from "@/lib/recommendation-queue";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const accountId = searchParams.get("accountId");

  const listingScope = accountId ? { store: { accountId } } : undefined;
  const actionableWhere = {
    status: "pending",
    type: { in: [...ACTIONABLE_PRICING_TYPES] },
    suggestedPrice: { not: null },
    confidence: { gte: 60 },
    actionQueue: { some: { status: "pending" } },
    ...(listingScope ? { listing: listingScope } : {}),
  };
  const unavailableWhere = {
    status: "pending",
    type: "insufficient-data",
    suggestedPrice: null,
    ...(listingScope ? { listing: listingScope } : {}),
  };

  const [actionable, actionableTotal, evidenceUnavailableTotal, evidenceUnavailable, legacyPendingExcluded, activeListings, analyzedListings] = await Promise.all([
    prisma.recommendation.findMany({ where: actionableWhere, include: { listing: true }, orderBy: [{ expectedProfitImpact: "desc" }, { confidence: "desc" }], take: 50 }),
    prisma.recommendation.count({ where: actionableWhere }),
    prisma.recommendation.count({ where: unavailableWhere }),
    prisma.recommendation.findMany({ where: unavailableWhere, include: { listing: true }, orderBy: { generatedAt: "desc" }, take: 20 }),
    prisma.recommendation.count({ where: { status: "pending", type: { notIn: [...ACTIONABLE_PRICING_TYPES, "insufficient-data", "hold"] }, ...(listingScope ? { listing: listingScope } : {}) } }),
    prisma.listing.count({ where: { listingStatus: "active", ...(accountId ? { store: { accountId } } : {}) } }),
    prisma.recommendation.findMany({ where: { status: "pending", type: { in: [...ACTIONABLE_PRICING_TYPES, "insufficient-data", "hold"] }, ...(listingScope ? { listing: listingScope } : {}) }, select: { listingId: true }, distinct: ["listingId"] }),
  ]);

  return NextResponse.json({
    date: new Date().toISOString().slice(0, 10),
    actionableTotal,
    raise: actionable.filter((row) => row.type === "raise-price"),
    lower: actionable.filter((row) => row.type === "lower-price"),
    pricingEvidenceUnavailable: { total: evidenceUnavailableTotal, items: evidenceUnavailable },
    legacyPendingExcluded,
    pricingCoverage: { activeListings, analyzedListings: analyzedListings.length, supportedListings: actionableTotal, insufficientListings: evidenceUnavailableTotal, notAnalyzedListings: Math.max(0, activeListings - analyzedListings.length), supportedPct: activeListings ? Number((actionableTotal * 100 / activeListings).toFixed(2)) : 0 },
  });
}
