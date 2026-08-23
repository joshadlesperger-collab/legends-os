import { prisma } from "@/lib/prisma";
import { getProviderStatus } from "@/lib/comp-validation/provider";

const DAY = 86_400_000;
export type NoCandidateBucket = "historical_identity_unavailable" | "non_standard_item" | "multi_quantity_ambiguity" | "weak_title_identity" | "sku_absent" | "other";
export function classifyNoCandidate(input: { title: string; quantity: number; sku: string | null; ebayItemId: string | null; recoveryStatus?: string | null }): NoCandidateBucket {
  const title = input.title.toLowerCase();
  if (/\b(lot|box|pack|break|bundle|set)\b/.test(title)) return "non_standard_item";
  if (input.quantity > 1) return "multi_quantity_ambiguity";
  if (title.replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).length < 4) return "weak_title_identity";
  if (input.recoveryStatus === "not_found") return "historical_identity_unavailable";
  if (!input.sku) return "sku_absent";
  return "other";
}

export async function loadDailyOperations(now = new Date()) {
  const since7 = new Date(now.getTime() - 7 * DAY); const since30 = new Date(now.getTime() - 30 * DAY); const since90 = new Date(now.getTime() - 90 * DAY);
  const listingSelect = { id: true, title: true, currentPrice: true, quantity: true, views: true, watchers: true, startTime: true, costBasis: { select: { id: true } }, saleEvents: { where: { provider: "ebay-fulfillment", status: { not: "cancelled" } }, orderBy: { soldAt: "desc" as const }, take: 1, select: { soldAt: true } }, _count: { select: { saleEvents: { where: { provider: "ebay-fulfillment", status: { not: "cancelled" } } } } } };
  const [strongVelocity, noRecentSales, highValueStale, missingCost, unresolvedRows, proposed, exceptions, actionablePricing, pricingEvidenceUnavailable, totalLines, linkedLines, recent7Lines, recent7Linked, recent30Lines, recent30Linked, recoveryGroups] = await Promise.all([
    prisma.listing.findMany({ where: { listingStatus: "active", saleEvents: { some: { provider: "ebay-fulfillment", status: { not: "cancelled" }, soldAt: { gte: since30 } } } }, orderBy: { saleEvents: { _count: "desc" } }, take: 20, select: listingSelect }),
    prisma.listing.findMany({ where: { listingStatus: "active", saleEvents: { none: { provider: "ebay-fulfillment", status: { not: "cancelled" }, soldAt: { gte: since90 } } } }, orderBy: [{ views: "desc" }, { currentPrice: "desc" }], take: 20, select: listingSelect }),
    prisma.listing.findMany({ where: { listingStatus: "active", currentPrice: { gte: 50 }, saleEvents: { none: { provider: "ebay-fulfillment", status: { not: "cancelled" }, soldAt: { gte: since90 } } } }, orderBy: { currentPrice: "desc" }, take: 20, select: listingSelect }),
    prisma.listing.findMany({ where: { listingStatus: "active", costBasis: null }, orderBy: [{ currentPrice: "desc" }, { views: "desc" }], take: 20, select: listingSelect }),
    prisma.orderLineReconciliation.findMany({ where: { status: "unresolved" }, select: { orderLine: { select: { storeId: true, ebayItemId: true, sku: true, title: true, quantity: true } } } }),
    prisma.orderLineReconciliation.count({ where: { status: "proposed" } }),
    prisma.saleEvent.count({ where: { provider: "ebay-fulfillment", status: { in: ["cancelled", "refunded", "partially_refunded"] }, soldAt: { gte: since30 } } }),
    prisma.recommendation.findMany({ where: { status: "pending", type: { in: ["raise-price", "lower-price"] }, suggestedPrice: { not: null }, confidence: { gte: 60 }, actionQueue: { some: { status: "pending" } } }, orderBy: [{ expectedProfitImpact: "desc" }, { confidence: "desc" }], take: 8, select: { id: true, type: true, suggestedPrice: true, confidence: true, reason: true, listing: { select: { id: true, title: true, currentPrice: true, listingQuality: true } } } }),
    prisma.recommendation.count({ where: { status: "pending", type: "insufficient-data", suggestedPrice: null } }),
    prisma.ebayOrderLine.count(), prisma.ebayOrderLine.count({ where: { listingId: { not: null } } }),
    prisma.ebayOrderLine.count({ where: { order: { creationDate: { gte: since7 } } } }), prisma.ebayOrderLine.count({ where: { listingId: { not: null }, order: { creationDate: { gte: since7 } } } }),
    prisma.ebayOrderLine.count({ where: { order: { creationDate: { gte: since30 } } } }), prisma.ebayOrderLine.count({ where: { listingId: { not: null }, order: { creationDate: { gte: since30 } } } }),
    prisma.historicalListingRecovery.groupBy({ by: ["status"], _count: { _all: true } }),
  ]);
  const recoveryKeys = unresolvedRows.flatMap((row) => row.orderLine.ebayItemId ? [{ storeId: row.orderLine.storeId, ebayItemId: row.orderLine.ebayItemId }] : []);
  const recoveries = recoveryKeys.length ? await prisma.historicalListingRecovery.findMany({ where: { OR: recoveryKeys }, select: { storeId: true, ebayItemId: true, status: true } }) : [];
  const recoveryByIdentity = new Map(recoveries.map((row) => [`${row.storeId}:${row.ebayItemId}`, row.status]));
  const noCandidateBuckets = Object.fromEntries(["historical_identity_unavailable", "non_standard_item", "multi_quantity_ambiguity", "weak_title_identity", "sku_absent", "other"].map((bucket) => [bucket, 0])) as Record<NoCandidateBucket, number>;
  for (const row of unresolvedRows) { const line = row.orderLine; noCandidateBuckets[classifyNoCandidate({ ...line, recoveryStatus: line.ebayItemId ? recoveryByIdentity.get(`${line.storeId}:${line.ebayItemId}`) : null })] += 1; }
  const recoveryHealth = Object.fromEntries(recoveryGroups.map((row) => [row.status, row._count._all]));
  const pct = (linked: number, total: number) => total ? Number((linked * 100 / total).toFixed(2)) : 0;
  const actionCandidates = [
    ...(proposed ? [{ id: "quality:review", category: "Data quality", title: `Review ${proposed} candidate sales matches`, score: 98, factors: ["Candidate evidence available", "Manual decision required", "Improves inventory attribution"] }] : []),
    ...(exceptions ? [{ id: "exceptions:refunds", category: "Exceptions", title: `Review ${exceptions} recent refunds or cancellations`, score: 94, factors: ["Authoritative provider exception", "Occurred in the last 30 days", "May affect margin and inventory decisions"] }] : []),
    ...strongVelocity.map((row) => ({ id: `velocity:${row.id}`, category: "Sales momentum", title: row.title, score: Math.min(100, 35 + row._count.saleEvents * 8 + Math.min(25, Number(row.currentPrice) / 10)), factors: [`${row._count.saleEvents} authoritative sales`, `${Math.round(Number(row.currentPrice))} dollar listing value`, "Recent sale evidence"] })),
    ...highValueStale.map((row) => { const age = row.startTime ? Math.floor((now.getTime() - row.startTime.getTime()) / DAY) : 0; return { id: `stale:${row.id}`, category: "Stale inventory", title: row.title, score: Math.min(100, 30 + Math.min(30, Number(row.currentPrice) / 5) + Math.min(25, age / 10) + (row.views < 10 ? 10 : 0)), factors: [`${Math.round(Number(row.currentPrice))} dollars tied up`, `${age} days listed`, "No authoritative sale in 90 days"] }; }),
    ...missingCost.slice(0, 10).map((row) => ({ id: `cost:${row.id}`, category: "Profitability", title: row.title, score: Math.min(90, 25 + Math.min(40, Number(row.currentPrice) / 5) + row._count.saleEvents * 5), factors: [`${Math.round(Number(row.currentPrice))} dollar listing value`, `${row._count.saleEvents} linked sales`, "Cost basis missing"] })),
  ].sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  const leaders = Array.from(new Map(actionCandidates.map((action) => [action.category, action])).values());
  const leaderIds = new Set(leaders.map((action) => action.id));
  const actions = leaders.concat(actionCandidates.filter((action) => !leaderIds.has(action.id)).slice(0, Math.max(0, 20 - leaders.length))).sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  const pricingActions = actionablePricing.map((row) => {
    const quality = row.listing.listingQuality && typeof row.listing.listingQuality === "object" ? row.listing.listingQuality as Record<string, unknown> : {};
    const cache = ((quality.compValidation as Record<string, unknown> | undefined)?.cache ?? {}) as Record<string, { result?: Record<string, unknown> }>;
    const summary = Object.values(cache).at(-1)?.result ?? {};
    return { id: row.id, listingId: row.listing.id, title: row.listing.title, type: row.type, currentPrice: Number(row.listing.currentPrice), suggestedPrice: Number(row.suggestedPrice), confidence: row.confidence ?? 0, reason: row.reason, marketValue: Number(summary.weightedRecentMarketValue ?? row.suggestedPrice), compCount: Number(summary.acceptedCompCount ?? 0), evidenceWindowDays: Number(summary.evidenceWindowDays ?? 0), medianSoldPrice: summary.medianSoldPrice == null ? null : Number(summary.medianSoldPrice) };
  });
  return { generatedAt: now, strongVelocity, noRecentSales, highValueStale, missingCost, unresolved: unresolvedRows.length, proposed, exceptions, actionablePricing: actionablePricing.length, pricingActions, pricingEvidenceUnavailable, noCandidateBuckets, actions, linkageHealth: { totalLines, linkedLines, unlinkedLines: totalLines - linkedLines, percent: pct(linkedLines, totalLines), recent7: { total: recent7Lines, linked: recent7Linked, percent: pct(recent7Linked, recent7Lines) }, recent30: { total: recent30Lines, linked: recent30Linked, percent: pct(recent30Linked, recent30Lines) }, recoveryPending: (recoveryHealth.pending ?? 0) + (recoveryHealth.retryable ?? 0), recoverySucceeded: recoveryHealth.recovered ?? 0, permanentMisses: recoveryHealth.not_found ?? 0 } };
}

export async function loadDataHealth(now = new Date()) {
  const staleBefore = new Date(now.getTime() - DAY);
  const [stores, activeListings, activeWithCost, openReconciliation, failedJobs, staleJobs, pendingPricing, livePricing] = await Promise.all([
    prisma.store.findMany({ where: { isActive: true }, select: { ebaySellerUsername: true, lastSyncAt: true, orderSyncCheckpoint: true, connectionStatus: true, orderAccessStatus: true } }),
    prisma.listing.count({ where: { listingStatus: "active" } }),
    prisma.listing.count({ where: { listingStatus: "active", costBasis: { isNot: null } } }),
    prisma.orderLineReconciliation.count({ where: { status: { in: ["proposed", "unresolved"] } } }),
    prisma.syncJob.count({ where: { status: "failed", createdAt: { gte: new Date(now.getTime() - 7 * DAY) } } }),
    prisma.syncJob.count({ where: { status: "running", OR: [{ heartbeatAt: { lt: staleBefore } }, { heartbeatAt: null, startedAt: { lt: staleBefore } }] } }),
    prisma.recommendation.count({ where: { status: "pending", type: { in: ["raise-price", "lower-price", "insufficient-data"] } } }),
    prisma.recommendation.count({ where: { status: "pending", type: { in: ["raise-price", "lower-price"] }, confidence: { gte: 60 }, suggestedPrice: { not: null } } }),
  ]);
  const provider = getProviderStatus();
  const newestListingSync = stores.map((store) => store.lastSyncAt).filter((value): value is Date => value != null).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  const newestOrderSync = stores.map((store) => store.orderSyncCheckpoint).filter((value): value is Date => value != null).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  const ageHours = (value: Date | null) => value == null ? null : Math.round((now.getTime() - value.getTime()) / 3_600_000);
  return { provider, activeListings, activeWithCost, costCoveragePct: activeListings ? Number((activeWithCost * 100 / activeListings).toFixed(1)) : 0, openReconciliation, failedJobs, staleJobs, pendingPricing, livePricing, pricingCoveragePct: activeListings ? Number((livePricing * 100 / activeListings).toFixed(2)) : 0, listingSyncAgeHours: ageHours(newestListingSync), orderSyncAgeHours: ageHours(newestOrderSync), connectedStores: stores.filter((store) => store.connectionStatus === "connected").length, orderReadyStores: stores.filter((store) => store.orderAccessStatus === "ready").length, totalStores: stores.length };
}
