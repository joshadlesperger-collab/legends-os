import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateCatalog } from "../lib/card-knowledge.ts";
import { prepareSellerEvidence, saleFingerprint, sellerSaleKey, buildSellerRelationships, type SellerSale, type SaleReview } from "../lib/card-parallel-intake.ts";
import { collectSellerSales } from "../lib/card-parallel-sales-store.ts";
import type { PrismaClient } from "@prisma/client";

const catalog = validateCatalog(JSON.parse(readFileSync("data/card-catalog/topps-chrome-basketball-2025-26.json", "utf8")));
const now = new Date("2026-10-24T12:00:00Z");
const base = { parallel: "Base", finish: "Chrome", numbering: "unnumbered" as const, printRun: null };
const ray = { parallel: "RayWave", finish: "Refractor", numbering: "unnumbered" as const, printRun: null };
function sale(id = "1"): SellerSale {
  return { storeId: "store", orderId: `order-${id}`, lineId: id, itemId: "123456789012", title: "2025 Topps Chrome Basketball",
    soldAt: "2026-10-20T12:00:00Z", updatedAt: "2026-10-21T12:00:00Z", observedAt: "2026-10-24T10:00:00Z",
    quantity: 1, currency: "USD", orderCurrency: "USD", itemCents: 900, shippingCents: 100, taxCents: 80, totalCents: 1080,
    lineDiscountCents: null, orderDiscountCents: null, deliveryDiscountCents: null, paymentStatus: "PAID", cancelStatus: "NONE_REQUESTED", refundCount: 0 };
}
function review(s: SellerSale, entryId = catalog.cards[0].id): SaleReview {
  return { key: sellerSaleKey(s), fingerprint: saleFingerprint(s), entryId, language: "English", condition: "raw-nm", variant: base,
    identityVerified: true, conditionVerified: true, variantVerified: true, ordinaryCopy: true, singleCard: true, reviewedAt: "2026-10-24T11:00:00Z", evidence: "Test fixture: inspected retained identity and sale evidence" };
}
const prepare = (sales: SellerSale[], reviews: SaleReview[]) => prepareSellerEvidence({ version: 1, collectedAt: now.toISOString(), truncated: false, sales }, { version: 1, reviews }, catalog, now);
test("own seller sales require explicit review; catalog supplies player, never a title guess", () => {
  const s = sale();
  assert.equal(prepare([s], []).accepted.length, 0);
  const good = prepare([s], [review(s)]).accepted[0];
  assert.equal(good.subjectId, catalog.cards[0].subjectId);
  assert.equal(good.itemCents + good.shippingCents!, 1000);
  assert.equal(good.ownPurchase, false);
  assert.equal(prepare([s], [{ ...review(s), singleCard: false }]).accepted.length, 0);
});
test("financial, refund, duplicate, stale and ambiguous records are held", () => {
  for (const patch of [{ quantity: 3 }, { paymentStatus: "PENDING" }, { cancelStatus: "IN_PROGRESS" }, { refundCount: 1 }, { shippingCents: null }, { taxCents: null }, { totalCents: 999 }, { orderDiscountCents: 10 }, { currency: "CAD" }, { observedAt: "2026-10-15T12:00:00Z" }]) {
    const s = { ...sale(), ...patch };
    assert.equal(prepare([s], [review(s)]).accepted.length, 0, JSON.stringify(patch));
  }
  const s = sale();
  assert.equal(prepare([s,s], [review(s)]).accepted.length, 0);
  assert.equal(prepare([s], [review(s),review(s)]).accepted.length, 0);
  const other = { ...sale("2"), orderId: s.orderId };
  assert.equal(prepare([s,other], [review(s),review(other)]).accepted.length, 0);
});
test("review fingerprints invalidate changed source facts but allow a fresh identical read", () => {
  const s = sale(), r = review(s);
  assert.equal(prepare([{ ...s, observedAt: now.toISOString() }], [r]).accepted.length, 1);
  assert.equal(prepare([{ ...s, itemCents: 901, totalCents: 1081 }], [r]).accepted.length, 0);
  assert.equal(prepare([s], [{ ...r, entryId: "invented-entry" }]).accepted.length, 0);
});
test("reviewed transactions train separated relationships and expose missing pairs", () => {
  const sales: SellerSale[] = [], reviews: SaleReview[] = [];
  const entries = catalog.cards.filter(c => c.section === "BASE CARDS").slice(0,3);
  for (const [i,entry] of Array.from(entries.entries())) for (const variant of [base,ray]) for (let n=0;n<3;n++) {
    const s = sale(`${i}-${variant.parallel}-${n}`);
    if (variant === ray) { s.itemCents = 1050; s.totalCents = 1230; }
    sales.push(s); reviews.push({ ...review(s,entry.id), variant });
  }
  const accepted = prepare(sales,reviews).accepted;
  const [study] = buildSellerRelationships(accepted,now);
  assert.equal(study.result.status,"research-estimate");
  assert.equal(study.result.multiplier,1.15);
  assert.equal(study.result.coverage[0].missingTarget,0);
  const [sparse] = buildSellerRelationships(accepted.filter(s=>s.variant.parallel!=="Base"),now);
  assert.equal(sparse.result.status,"insufficient-evidence");
  assert.equal(sparse.result.coverage[0].missingBaseline,3);
  assert.equal(buildSellerRelationships(accepted.map(s=>({...s,variant:{...base,parallel:"base"}})),now).length,0);
});
test("collector is bounded, excludes buyer fields and never substitutes missing shipping", async () => {
  let query: Record<string, unknown> = {};
  const row = { storeId: "store", providerLineItemId: "line", ebayItemId: "123456789012", title: "Topps Chrome", quantity: 1, currency: "USD",
    lineItemCost: "9.99", deliveryCost: null, tax: "0", total: "9.99", discount: null, updatedAt: new Date("2026-10-23T00:00:00Z"),
    order: { providerOrderId: "order", creationDate: new Date("2026-10-20T00:00:00Z"), lastModifiedDate: new Date("2026-10-21T00:00:00Z"), updatedAt: new Date("2026-10-23T00:00:00Z"), orderPaymentStatus: "PAID", cancelStatus: "NONE_REQUESTED", currency: "USD", priceDiscount: null, deliveryDiscount: null, deliveryCost: "1.49", tax: "0", total: "11.48", _count: { refunds: 0, lineItems: 2 } } };
  const client = { ebayOrderLine: { findMany: async (input: Record<string, unknown>) => { query = input; return Array.from({length:201},()=>row); } } } as unknown as PrismaClient;
  const result = await collectSellerSales(client,now);
  assert.equal(query.take,201);
  assert.equal(JSON.stringify(query).includes("buyer"),false);
  assert.equal(result.sales.length,200); assert.equal(result.truncated,true);
  assert.equal(result.sales[0].itemCents,999); assert.equal(result.sales[0].shippingCents,null);
  assert.equal(result.sales[0].taxCents,0);
  assert.equal(result.sales[0].observedAt,"2026-10-23T00:00:00.000Z");
  row.order._count.lineItems = 1;
  const single = await collectSellerSales(client,now);
  assert.equal(single.sales[0].shippingCents,149);
  // Preserve contradictory line totals so the intake holds rather than silently correcting them.
  assert.equal(single.sales[0].totalCents,999);
});
