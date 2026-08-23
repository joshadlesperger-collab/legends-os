import { Prisma } from "@prisma/client";
import { prisma } from "./prisma.ts";
import { createTelemetry, mergeCompState } from "./comp-validation/engine.ts";
import { valueSubject, type ManualSoldEvidence } from "./comp-validation/valuation-service.ts";
import { getProviderStatus } from "./comp-validation/provider.ts";
import type { ValuationResult } from "./comp-validation/types.ts";
import type { InternalSaleEvidence } from "./pricing-evidence-acquisition.ts";
import { buildSingleValuationSnapshot, SINGLE_VALUATION_VERSION } from "./seller-single-valuation-domain.ts";
import { MONITORED_SELLERS } from "./seller-registry.ts";

function jsonObject(value: Prisma.JsonValue | null): Prisma.JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Prisma.JsonObject : {};
}

function reusableSnapshot(value: Prisma.JsonValue | null, currentBid: number) {
  const candidate = jsonObject(value).canonicalSingleValuation;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const row = candidate as Prisma.JsonObject;
  const valuedAt = typeof row.valuedAt === "string" ? Date.parse(row.valuedAt) : NaN;
  return row.version === SINGLE_VALUATION_VERSION && Number(row.currentBid) === currentBid && Number.isFinite(valuedAt) && Date.now() - valuedAt < 86_400_000 ? row : null;
}

function manualEvidence(value: Prisma.JsonObject): ManualSoldEvidence[] {
  const rows=value.manualSoldEvidence; if(!Array.isArray(rows))return[];
  return rows.flatMap(row=>row&&typeof row==="object"&&!Array.isArray(row)?[row as unknown as ManualSoldEvidence]:[]);
}

export async function valueLatestSellerSingles(options: { limit?: number; ebayItemIds?: string[]; force?: boolean } = {}) {
  const seller = MONITORED_SELLERS[0];
  const latestRun = await prisma.sellerOpportunityRun.findFirst({ where: { seller: seller.ebayUserId }, orderBy: { collectedAt: "desc" }, select: { id: true } });
  if (!latestRun) throw new Error("No completed seller-opportunity run is available.");
  const providerStatus = getProviderStatus();
  if (!providerStatus.liveReady) throw new Error("THE_CARD_API_KEY is required for live sold-comp valuation.");

  const [auctions, saleRows] = await Promise.all([
    prisma.sellerOpportunityAuction.findMany({
      where: { runId: latestRun.id, kind: "single", ...(options.ebayItemIds?.length ? { ebayItemId: { in: options.ebayItemIds } } : {}) },
      orderBy: [{ endTime: "asc" }, { ebayItemId: "asc" }],
      take: options.limit,
    }),
    prisma.saleEvent.findMany({ where: { status: { not: "cancelled" }, currency: "USD", orderLine: { isNot: null } }, select: { id: true, price: true, currency: true, status: true, soldAt: true, orderLine: { select: { title: true } } } }),
  ]);
  const sales: InternalSaleEvidence[] = saleRows.flatMap((row) => row.orderLine ? [{ id: row.id, title: row.orderLine.title, soldAt: row.soldAt, unitPrice: Number(row.price), currency: row.currency ?? "", status: row.status }] : []);
  const telemetry = createTelemetry();
  const identityResultCache = new Map<string, ValuationResult>();
  const summaries = [];

  for (const auction of auctions) {
    const cached = options.force ? null : reusableSnapshot(auction.itemSpecifics, Number(auction.currentBid));
    if (cached) {
      telemetry.cacheHits += 1;
      summaries.push({ ebayItemId: auction.ebayItemId, title: auction.title, estimatedMarketValue: cached.estimatedMarketValue ?? null, confidence: cached.compConfidence, recommendation: cached.recommendation, projectedGrossProfit: cached.projectedGrossProfit ?? null, cached: true });
      continue;
    }
    const itemSpecifics = jsonObject(auction.itemSpecifics);
    const listingQuality = mergeCompState(itemSpecifics, itemSpecifics.compValidation && typeof itemSpecifics.compValidation === "object" ? itemSpecifics.compValidation as Parameters<typeof mergeCompState>[1] : {});
    const { result } = await valueSubject({
      subject: { subjectType: "seller-opportunity", id: auction.id, storeId: `seller:${auction.seller}`, title: auction.title, currentPrice: Number(auction.currentBid), quantity: 1, quantitySold: 0, views: 0, watchers: 0, listingFormat: "AUCTION", condition: null, listingQuality },
      telemetry,
      identityResultCache,
      internalSales: sales,
      manualEvidence: manualEvidence(itemSpecifics),
      allowLiveProvider: true,
      providerStatusOverride: providerStatus,
    });
    const snapshot = buildSingleValuationSnapshot(result, Number(auction.currentBid), new Date(), { persistProviderRecords: false });
    const existingCanonical = itemSpecifics.canonicalSingleValuation;
    const history = Array.isArray(itemSpecifics.valuationAuditHistory) ? itemSpecifics.valuationAuditHistory : [];
    telemetry.dbWrites += 1;
    await prisma.sellerOpportunityAuction.update({ where: { id: auction.id }, data: { itemSpecifics: { ...itemSpecifics, ...(existingCanonical ? { valuationAuditHistory: [...history, existingCanonical] } : {}), canonicalSingleValuation: snapshot } as Prisma.InputJsonValue } });
    summaries.push({ ebayItemId: auction.ebayItemId, title: auction.title, estimatedMarketValue: snapshot.estimatedMarketValue, confidence: snapshot.compConfidence, canonicalConfidence: result.confidenceBand, recommendation: snapshot.recommendation, projectedGrossProfit: snapshot.projectedGrossProfit, parsedIdentity: snapshot.parsedIdentity, acceptedCompCount: snapshot.evidence.acceptedCompCount, exactMatchCount: result.exactMatchCount, nearExactMatchCount: result.nearExactMatchCount, proxyMatchCount: result.comps.filter((comp) => comp.inclusionStatus === "accepted" && comp.retrievalTier === "proxy").length, rejectedUnsafeMatches: result.comps.filter((comp) => comp.inclusionStatus === "excluded").length, queryAudit: result.queryAudit, exclusions: result.comps.map((comp) => ({ title: comp.soldTitle, price: comp.soldPrice, matchTier: comp.matchTier, retrievalTier: comp.retrievalTier, matchScore: comp.matchScore, reason: comp.exclusionReason })) });
  }
  return { runId: latestRun.id, processed: summaries.length, telemetry, summaries };
}
