import { Prisma } from "@prisma/client";
import { parseCardIdentity } from "./comp-validation/identity.ts";
import { prisma } from "./prisma.ts";

const AUTO_LINK_CONFIDENCE = 100;
const REVIEW_CANDIDATE_MINIMUM = 55;

export type ReconciliationListing = {
  id: string; storeId: string; ebayItemId: string; sku: string | null; title: string;
  currentPrice: number; startTime: Date | null; endTime: Date | null;
};
export type ReconciliationLine = {
  id: string; storeId: string; ebayItemId: string | null; sku: string | null; title: string;
  lineItemCost: number; soldAt: Date;
};
export type MatchCandidate = { listingId: string; confidence: number; tier: "deterministic" | "attribute"; reasons: string[] };

export function normalizeMatchText(value: string | null | undefined) {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

function tokens(value: string) {
  return new Set(normalizeMatchText(value).split(" ").filter((token) => token.length > 1));
}

function tokenSimilarity(left: string, right: string) {
  const a = tokens(left); const b = tokens(right);
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  Array.from(a).forEach((token) => { if (b.has(token)) intersection++; });
  return intersection / new Set(Array.from(a).concat(Array.from(b))).size;
}

export function scoreReconciliationCandidate(line: ReconciliationLine, listing: ReconciliationListing): MatchCandidate | null {
  if (line.storeId !== listing.storeId) return null;
  if (line.ebayItemId && line.ebayItemId === listing.ebayItemId) {
    return { listingId: listing.id, confidence: 100, tier: "deterministic", reasons: ["Exact eBay item ID"] };
  }
  if (line.sku && listing.sku && normalizeMatchText(line.sku) === normalizeMatchText(listing.sku)) {
    return { listingId: listing.id, confidence: 100, tier: "deterministic", reasons: ["Exact seller SKU"] };
  }

  const exactTitle = normalizeMatchText(line.title) === normalizeMatchText(listing.title);
  const similarity = tokenSimilarity(line.title, listing.title);
  if (!exactTitle && similarity < 0.55) return null;
  const left = parseCardIdentity(line.title); const right = parseCardIdentity(listing.title);
  let score = exactTitle ? 78 : Math.round(similarity * 62);
  const reasons = [exactTitle ? "Exact normalized title" : `${Math.round(similarity * 100)}% title-token overlap`];
  const identityFields: Array<[string, unknown, unknown, number]> = [
    ["year", left.year, right.year, 5], ["manufacturer", left.manufacturer, right.manufacturer, 4],
    ["card number", left.cardNumber, right.cardNumber, 7], ["parallel", left.parallel, right.parallel, 5],
    ["grade company", left.gradeCompany, right.gradeCompany, 4], ["grade", left.gradeValue, right.gradeValue, 4],
  ];
  for (const [label, a, b, weight] of identityFields) if (a != null && b != null && a === b) { score += weight; reasons.push(`Matching ${label}`); }
  const priceDelta = listing.currentPrice > 0 ? Math.abs(line.lineItemCost - listing.currentPrice) / listing.currentPrice : 1;
  if (priceDelta <= 0.02) { score += 5; reasons.push("Sale amount within 2% of listing price"); }
  else if (priceDelta <= 0.1) { score += 2; reasons.push("Sale amount within 10% of listing price"); }
  const inWindow = (!listing.startTime || line.soldAt >= listing.startTime) && (!listing.endTime || line.soldAt <= listing.endTime);
  if (inWindow && (listing.startTime || listing.endTime)) { score += 4; reasons.push("Sale date within listing timeframe"); }
  return { listingId: listing.id, confidence: Math.min(99, score), tier: "attribute", reasons };
}

export function rankReconciliationCandidates(line: ReconciliationLine, listings: ReconciliationListing[], limit = 5) {
  return listings.map((listing) => scoreReconciliationCandidate(line, listing)).filter((row): row is MatchCandidate => !!row)
    .sort((a, b) => b.confidence - a.confidence || a.listingId.localeCompare(b.listingId)).slice(0, limit);
}

export async function linkOrderLine(orderLineId: string, listingId: string, status: "auto_linked" | "accepted", matchTier: string, confidence: number | null, reasons: string[]) {
  return prisma.$transaction(async (tx) => {
    const line = await tx.ebayOrderLine.findUnique({ where: { id: orderLineId }, select: { storeId: true, listingId: true } });
    const listing = await tx.listing.findUnique({ where: { id: listingId }, select: { storeId: true } });
    if (!line || !listing || line.storeId !== listing.storeId) throw new Error("Order line and listing must belong to the same store");
    if (line.listingId && line.listingId !== listingId) throw new Error("Order line is already attributed to another listing");
    await tx.ebayOrderLine.update({ where: { id: orderLineId }, data: { listingId } });
    await tx.saleEvent.updateMany({ where: { orderLineId }, data: { listingId } });
    await tx.orderLineReconciliation.upsert({ where: { orderLineId }, create: { orderLineId, candidateListingId: listingId, status, matchTier, confidence, reasons, reviewedAt: status === "accepted" ? new Date() : null }, update: { candidateListingId: listingId, status, matchTier, confidence, reasons, reviewedAt: status === "accepted" ? new Date() : null } });
  });
}

export async function reconcileUnlinkedOrderLines(storeId?: string) {
  const listings = await prisma.listing.findMany({ where: storeId ? { storeId } : undefined, select: { id: true, storeId: true, ebayItemId: true, sku: true, title: true, currentPrice: true, startTime: true, endTime: true } });
  const lines = await prisma.ebayOrderLine.findMany({ where: { listingId: null, ...(storeId ? { storeId } : {}) }, select: { id: true, storeId: true, ebayItemId: true, sku: true, title: true, lineItemCost: true, order: { select: { creationDate: true } } } });
  const byStore = new Map<string, ReconciliationListing[]>();
  for (const listing of listings) { const rows = byStore.get(listing.storeId) ?? []; rows.push({ ...listing, currentPrice: Number(listing.currentPrice) }); byStore.set(listing.storeId, rows); }
  let autoLinked = 0, proposed = 0, unresolved = 0, prevented = 0;
  for (const line of lines) {
    const candidates = rankReconciliationCandidates({ ...line, lineItemCost: Number(line.lineItemCost), soldAt: line.order.creationDate }, byStore.get(line.storeId) ?? []);
    const best = candidates[0]; const tied = best ? candidates.filter((candidate) => candidate.confidence === best.confidence).length > 1 : false;
    if (best?.confidence === AUTO_LINK_CONFIDENCE && !tied) {
      await linkOrderLine(line.id, best.listingId, "auto_linked", best.tier, best.confidence, best.reasons); autoLinked++; continue;
    }
    const reviewable = best && best.confidence >= REVIEW_CANDIDATE_MINIMUM;
    await prisma.orderLineReconciliation.upsert({ where: { orderLineId: line.id }, create: { orderLineId: line.id, candidateListingId: reviewable ? best.listingId : null, status: reviewable ? "proposed" : "unresolved", matchTier: reviewable ? best.tier : null, confidence: reviewable ? best.confidence : null, reasons: reviewable ? { primary: best.reasons, candidates } : { primary: ["No conservative candidate"], candidates } }, update: { candidateListingId: reviewable ? best.listingId : null, status: reviewable ? "proposed" : "unresolved", matchTier: reviewable ? best.tier : null, confidence: reviewable ? best.confidence : null, reasons: reviewable ? { primary: best.reasons, candidates } : { primary: ["No conservative candidate"], candidates } } });
    if (reviewable) proposed++; else unresolved++;
    if (best && (best.confidence < AUTO_LINK_CONFIDENCE || tied)) prevented++;
  }
  return { examined: lines.length, autoLinked, proposed, unresolved, prevented };
}
