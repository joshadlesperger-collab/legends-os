import { createHash } from "node:crypto";
import { z } from "zod";
import { variantIdentity, type CardCatalog } from "./card-knowledge.ts";
import { analyzeParallel, parallelPacketSchema, type ParallelPacket, type ParallelSale } from "./card-parallel.ts";

const text = z.string().trim().min(1).max(200);
const cents = z.number().int().nonnegative().safe().nullable();
export const sellerSaleSchema = z.object({
  storeId: text, orderId: text, lineId: text, itemId: z.string().regex(/^\d+$/).nullable(), title: z.string().max(1000),
  soldAt: z.string().datetime(), updatedAt: z.string().datetime(), observedAt: z.string().datetime(),
  quantity: z.number().int().positive(), currency: z.string().regex(/^[A-Z]{3}$/), orderCurrency: z.string().regex(/^[A-Z]{3}$/),
  itemCents: cents, shippingCents: cents, taxCents: cents, totalCents: cents,
  lineDiscountCents: cents, orderDiscountCents: cents, deliveryDiscountCents: cents,
  paymentStatus: text, cancelStatus: text, refundCount: z.number().int().nonnegative(),
});
export type SellerSale = z.infer<typeof sellerSaleSchema>;
export const sellerSnapshotSchema = z.object({ version: z.literal(1), collectedAt: z.string().datetime(), truncated: z.boolean(), sales: z.array(sellerSaleSchema).max(200) });
export const saleReviewSchema = z.object({
  key: text, fingerprint: z.string().regex(/^[a-f0-9]{64}$/), entryId: text,
  language: text, condition: z.enum(["raw-nm", "raw-excellent", "raw-very-good"]),
  variant: parallelPacketSchema.shape.scope.shape.target,
  identityVerified: z.boolean(), conditionVerified: z.boolean(), variantVerified: z.boolean(),
  ordinaryCopy: z.boolean(), singleCard: z.boolean(), reviewedAt: z.string().datetime(),
  evidence: z.string().trim().min(10).max(2000),
});
export const saleReviewsSchema = z.object({ version: z.literal(1), reviews: z.array(saleReviewSchema).max(10000) });
export type SaleReview = z.infer<typeof saleReviewSchema>;
export const sellerSaleKey = (s: SellerSale) => `${s.storeId}:${s.lineId}`;
// Retrieval time changes on each read; all actual evidence fields invalidate prior review when changed.
export function saleFingerprint(input: SellerSale) {
  const { observedAt: _observedAt, ...evidence } = sellerSaleSchema.parse(input);
  return createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
}
export function sellerSaleBlockers(s: SellerSale, now: Date) {
  const blockers: string[] = [];
  if (s.paymentStatus !== "PAID" || s.cancelStatus !== "NONE_REQUESTED" || s.refundCount > 0) blockers.push("payment-cancellation-or-refund-review");
  if (s.quantity !== 1) blockers.push("multi-quantity-not-independent-sales");
  if (!s.itemId) blockers.push("missing-source-item");
  if (s.currency !== s.orderCurrency) blockers.push("currency-mismatch");
  if ([s.lineDiscountCents, s.orderDiscountCents, s.deliveryDiscountCents].some(v => v !== null && v !== 0)) blockers.push("discount-allocation-review");
  if (s.itemCents === null || s.itemCents <= 0 || s.shippingCents === null || s.taxCents === null || s.totalCents === null || s.itemCents + s.shippingCents + s.taxCents !== s.totalCents) blockers.push("line-total-or-shipping-unresolved");
  if (Date.parse(s.soldAt) > Date.parse(s.observedAt) || Date.parse(s.updatedAt) > now.getTime() || Date.parse(s.observedAt) > now.getTime() || now.getTime() - Date.parse(s.soldAt) > 90 * 86400000) blockers.push("invalid-or-stale-date");
  if (now.getTime() - Date.parse(s.observedAt) > 7 * 86400000) blockers.push("refresh-order-status-before-use");
  return blockers;
}
const words = (s: string) => ` ${s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
export function suggestEntries(sale: SellerSale, catalog: CardCatalog) {
  const title = words(sale.title);
  // Suggestions only: ambiguous editions, inserts and parallels always require review.
  return catalog.cards.filter(c => title.includes(words(c.player)) && title.includes(words(c.cardNumber))).slice(0, 8).map(c => ({ entryId: c.id, player: c.player, section: c.section, cardNumber: c.cardNumber }));
}

export function prepareSellerEvidence(snapshotInput: unknown, reviewsInput: unknown, catalog: CardCatalog, now = new Date()) {
  if (!Number.isFinite(now.getTime())) throw Error("Invalid analysis time");
  const snapshot = sellerSnapshotSchema.parse(snapshotInput), { reviews } = saleReviewsSchema.parse(reviewsInput);
  const counts = new Map<string, number>();
  const orders = new Map<string, number>();
  snapshot.sales.forEach(s => counts.set(sellerSaleKey(s), (counts.get(sellerSaleKey(s)) ?? 0) + 1));
  snapshot.sales.forEach(s => { const order = `${s.storeId}:${s.orderId}`; orders.set(order, (orders.get(order) ?? 0) + 1); });
  const accepted: ParallelSale[] = [];
  const rows = snapshot.sales.map(s => {
    const key = sellerSaleKey(s), fingerprint = saleFingerprint(s), matches = reviews.filter(r => r.key === key);
    const blockers = sellerSaleBlockers(s, now), review = matches.length === 1 ? matches[0] : undefined;
    if (counts.get(key)! > 1) blockers.push("duplicate-transaction");
    if (orders.get(`${s.storeId}:${s.orderId}`)! > 1) blockers.push("same-order-lines-require-independent-sale-review");
    if (!review) blockers.push(matches.length > 1 ? "conflicting-reviews" : "catalog-and-copy-review-required");
    const entry = review && catalog.cards.find(c => c.id === review.entryId);
    if (review) {
      if (review.fingerprint !== fingerprint) blockers.push("sale-changed-since-review");
      if (!entry) blockers.push("unknown-checklist-entry");
      if (!review.identityVerified || !review.variantVerified || !review.conditionVerified || !review.singleCard || !review.ordinaryCopy) blockers.push("copy-or-identity-not-verified");
      if (Date.parse(review.reviewedAt) > now.getTime() || Date.parse(review.reviewedAt) < Date.parse(s.updatedAt)) blockers.push("review-date-invalid");
    }
    if (!blockers.length && review && entry) {
      accepted.push({ provider: "ebay-seller-orders", saleId: key, sourceUrl: `https://www.ebay.com/itm/${s.itemId}`,
        variantId: variantIdentity({ ...review.variant, productId: catalog.product.id, entryId: entry.id, language: review.language }),
        soldAt: s.soldAt, observedAt: s.observedAt, itemCents: s.itemCents!, shippingCents: s.shippingCents, currency: s.currency,
        condition: review.condition, identityVerified: true, conditionVerified: true, kind: "sold", ownPurchase: false, hiddenPrice: false,
        productId: catalog.product.id, section: entry.section, language: review.language, entryId: entry.id, subjectId: entry.subjectId,
        variant: review.variant, variantVerified: true, ordinaryCopy: true });
    }
    return { key, fingerprint, title: s.title, soldAt: s.soldAt, sourceUrl: s.itemId ? `https://www.ebay.com/itm/${s.itemId}` : null, blockers, suggestions: suggestEntries(s, catalog) };
  });
  return { collectedAt: snapshot.collectedAt, truncated: snapshot.truncated, accepted, rows, heldCount: rows.filter(r => r.blockers.length).length };
}

/** Separate each condition/currency/language/section and compare every observed variant to Base. */
export function buildSellerRelationships(sales: ParallelSale[], now = new Date()) {
  const variantKey = (v: ParallelSale["variant"]) => JSON.stringify([v.parallel.toLowerCase(), v.finish.toLowerCase(), v.numbering, v.printRun]);
  const groups = new Map<string, ParallelSale[]>();
  for (const sale of sales) {
    const key = JSON.stringify([sale.productId, sale.section, sale.language, sale.condition, sale.currency]);
    groups.set(key, [...(groups.get(key) ?? []), sale]);
  }
  const packets: ParallelPacket[] = [];
  for (const group of Array.from(groups.values())) {
    const variants = new Map(group.map(s => [variantKey(s.variant), s.variant]));
    const baseline = { parallel: "Base", finish: "Chrome", numbering: "unnumbered" as const, printRun: null };
    const first = group[0];
    for (const target of Array.from(variants.values())) {
      if (variantKey(target) === variantKey(baseline)) continue;
      packets.push({ scope: { productId: first.productId, section: first.section, language: first.language, condition: first.condition, currency: first.currency, baseline, target }, sales: group });
    }
  }
  return packets.map(packet => ({ packet, result: analyzeParallel(packet, now) }));
}
