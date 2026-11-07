import type { PrismaClient } from "@prisma/client";
import { readFile } from "node:fs/promises";
import { sellerSnapshotSchema, saleReviewsSchema, type SellerSale } from "./card-parallel-intake.ts";

/** No buyer fields, OAuth calls, migrations, or writes. Cap a product-specific 90-day read. */
export async function collectSellerSales(client: PrismaClient, now = new Date()) {
  const rows = await client.ebayOrderLine.findMany({
    where: { AND: [{ title: { contains: "Topps", mode: "insensitive" } }, { title: { contains: "Chrome", mode: "insensitive" } }],
      order: { creationDate: { gte: new Date(now.getTime() - 90 * 86400000), lte: now } } },
    orderBy: [{ order: { creationDate: "desc" } }, { id: "asc" }], take: 201,
    select: { storeId: true, providerLineItemId: true, ebayItemId: true, title: true, quantity: true, currency: true,
      lineItemCost: true, deliveryCost: true, tax: true, total: true, discount: true, updatedAt: true,
      order: { select: { providerOrderId: true, creationDate: true, lastModifiedDate: true, updatedAt: true, orderPaymentStatus: true, cancelStatus: true,
        currency: true, priceDiscount: true, deliveryDiscount: true, deliveryCost: true, tax: true, total: true,
        _count: { select: { refunds: true, lineItems: true } } } } },
  });
  const money = (v: { toString(): string } | null) => {
    if (v === null) return null;
    const value = v.toString();
    if (!/^\d+(\.\d{1,2})?$/.test(value)) return null;
    const [whole, fraction = ""] = value.split(".");
    const amount = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
    return Number.isSafeInteger(amount) ? amount : null;
  };
  const sales: SellerSale[] = rows.slice(0, 200).map(r => ({
    storeId: r.storeId, orderId: r.order.providerOrderId, lineId: r.providerLineItemId, itemId: r.ebayItemId && /^\d+$/.test(r.ebayItemId) ? r.ebayItemId : null,
    title: r.title, soldAt: r.order.creationDate.toISOString(), updatedAt: new Date(Math.max(r.updatedAt.getTime(), r.order.lastModifiedDate.getTime())).toISOString(),
    // Reading a stale database row is not a fresh marketplace status observation.
    observedAt: r.order.updatedAt.toISOString(),
    quantity: r.quantity, currency: r.currency, orderCurrency: r.order.currency, itemCents: money(r.lineItemCost),
    // Order amounts belong to this line only when it is the entire single-unit order.
    shippingCents: money(r.deliveryCost ?? (r.order._count.lineItems === 1 && r.quantity === 1 ? r.order.deliveryCost : null)),
    taxCents: money(r.tax ?? (r.order._count.lineItems === 1 && r.quantity === 1 ? r.order.tax : null)),
    totalCents: money(r.total ?? (r.order._count.lineItems === 1 && r.quantity === 1 ? r.order.total : null)),
    lineDiscountCents: money(r.discount), orderDiscountCents: money(r.order.priceDiscount), deliveryDiscountCents: money(r.order.deliveryDiscount),
    paymentStatus: r.order.orderPaymentStatus, cancelStatus: r.order.cancelStatus, refundCount: r.order._count.refunds,
  }));
  return sellerSnapshotSchema.parse({ version: 1, collectedAt: now.toISOString(), truncated: rows.length > 200, sales });
}

export async function loadSellerReviews() {
  try { return saleReviewsSchema.parse(JSON.parse(await readFile("artifacts/knowledge-graph/seller-sale-reviews.json", "utf8"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1 as const, reviews: [] }; throw error; }
}
