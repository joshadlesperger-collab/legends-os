import { Prisma, type Store, type SyncJob } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getValidAccessToken } from "@/lib/ebay";
import { getOrders, getOrdersPage, getOrderWindowStart, type EbayAmount, type EbayOrderPayload, type EbayRefundPayload } from "@/lib/ebay-orders";
import { getNextOrderSlice, getNarrowerOrderSliceEnd, getOrderSliceEnd, getSaleStatus } from "@/lib/ebay-order-domain";

function amount(value: EbayAmount | undefined): Prisma.Decimal | null {
  if (!value?.value || !Number.isFinite(Number(value.value))) return null;
  return new Prisma.Decimal(value.value);
}
function currency(...values: Array<EbayAmount | undefined>) { return values.find((entry) => entry?.currency)?.currency ?? "USD"; }
function date(value: string | undefined, field: string) { const parsed = value ? new Date(value) : null; if (!parsed || Number.isNaN(parsed.getTime())) throw new Error(`Order has invalid ${field}`); return parsed; }
function sumAmounts(values: Array<EbayAmount | undefined>) { const present = values.map(amount).filter((v): v is Prisma.Decimal => v != null); return present.length ? present.reduce((sum, value) => sum.add(value), new Prisma.Decimal(0)) : null; }
function refundKey(refund: EbayRefundPayload) { return refund.refundId ?? refund.refundReferenceId ?? null; }

export async function ingestOrder(storeId: string, payload: EbayOrderPayload) {
  if (!payload.orderId) throw new Error("Order is missing orderId");
  const lines = payload.lineItems ?? [];
  if (!lines.every((line) => line.lineItemId && line.lineItemCost?.value && line.quantity && line.quantity > 0)) throw new Error(`Order ${payload.orderId} has malformed line items`);
  const orderCurrency = currency(payload.pricingSummary?.total, payload.pricingSummary?.priceSubtotal, lines[0]?.lineItemCost);

  return prisma.$transaction(async (tx) => {
    const missingHistoricalItemIds = new Set<string>();
    const order = await tx.ebayOrder.upsert({
      where: { storeId_providerOrderId: { storeId, providerOrderId: payload.orderId! } },
      create: { storeId, providerOrderId: payload.orderId!, creationDate: date(payload.creationDate, "creationDate"), lastModifiedDate: date(payload.lastModifiedDate, "lastModifiedDate"),
        orderPaymentStatus: payload.orderPaymentStatus ?? "UNKNOWN", orderFulfillmentStatus: payload.orderFulfillmentStatus ?? "UNKNOWN",
        cancelStatus: payload.cancelStatus?.cancelState ?? "NONE_REQUESTED", marketplace: lines[0]?.listingMarketplaceId ?? null, currency: orderCurrency,
        priceSubtotal: amount(payload.pricingSummary?.priceSubtotal), deliveryCost: amount(payload.pricingSummary?.deliveryCost),
        priceDiscount: amount(payload.pricingSummary?.priceDiscount), deliveryDiscount: amount(payload.pricingSummary?.deliveryDiscount), tax: amount(payload.pricingSummary?.tax),
        total: amount(payload.pricingSummary?.total), totalDueSeller: amount(payload.paymentSummary?.totalDueSeller), totalMarketplaceFee: amount(payload.totalMarketplaceFee) },
      update: { lastModifiedDate: date(payload.lastModifiedDate, "lastModifiedDate"), orderPaymentStatus: payload.orderPaymentStatus ?? "UNKNOWN",
        orderFulfillmentStatus: payload.orderFulfillmentStatus ?? "UNKNOWN", cancelStatus: payload.cancelStatus?.cancelState ?? "NONE_REQUESTED",
        priceSubtotal: amount(payload.pricingSummary?.priceSubtotal), deliveryCost: amount(payload.pricingSummary?.deliveryCost), priceDiscount: amount(payload.pricingSummary?.priceDiscount),
        deliveryDiscount: amount(payload.pricingSummary?.deliveryDiscount), tax: amount(payload.pricingSummary?.tax), total: amount(payload.pricingSummary?.total),
        totalDueSeller: amount(payload.paymentSummary?.totalDueSeller), totalMarketplaceFee: amount(payload.totalMarketplaceFee) },
    });

    for (const line of lines) {
      const listing = line.legacyItemId ? await tx.listing.findUnique({ where: { storeId_ebayItemId: { storeId, ebayItemId: line.legacyItemId } }, select: { id: true } }) : null;
      if (!listing && line.legacyItemId && /^\d+$/.test(line.legacyItemId)) missingHistoricalItemIds.add(line.legacyItemId);
      const lineCurrency = currency(line.lineItemCost, line.total);
      const orderLine = await tx.ebayOrderLine.upsert({
        where: { storeId_providerLineItemId: { storeId, providerLineItemId: line.lineItemId! } },
        create: { orderId: order.id, storeId, listingId: listing?.id, providerLineItemId: line.lineItemId!, ebayItemId: line.legacyItemId,
          sku: line.sku, title: line.title ?? "Untitled order line", quantity: line.quantity!, currency: lineCurrency,
          lineItemCost: new Prisma.Decimal(line.lineItemCost!.value!), total: amount(line.total), deliveryCost: amount(line.deliveryCost),
          discount: sumAmounts((line.appliedPromotions ?? []).map((promotion) => promotion.discountAmount)), tax: sumAmounts((line.taxes ?? []).map((tax) => tax.amount)),
          fulfillmentStatus: line.lineItemFulfillmentStatus, marketplace: line.listingMarketplaceId },
        update: { orderId: order.id, listingId: listing?.id, sku: line.sku, title: line.title ?? "Untitled order line", quantity: line.quantity!, currency: lineCurrency,
          lineItemCost: new Prisma.Decimal(line.lineItemCost!.value!), total: amount(line.total), deliveryCost: amount(line.deliveryCost),
          discount: sumAmounts((line.appliedPromotions ?? []).map((promotion) => promotion.discountAmount)), tax: sumAmounts((line.taxes ?? []).map((tax) => tax.amount)),
          fulfillmentStatus: line.lineItemFulfillmentStatus, marketplace: line.listingMarketplaceId },
      });

      const saleStatus = getSaleStatus(payload.cancelStatus?.cancelState, payload.orderPaymentStatus);
      await tx.saleEvent.upsert({
        where: { orderLineId: orderLine.id },
        create: { listingId: listing?.id, orderLineId: orderLine.id, provider: "ebay-fulfillment", providerEventId: line.lineItemId!, quantity: line.quantity!,
          price: new Prisma.Decimal(line.lineItemCost!.value!).div(line.quantity!), currency: lineCurrency, status: saleStatus, soldAt: date(payload.creationDate, "creationDate") },
        update: { listingId: listing?.id, quantity: line.quantity!, price: new Prisma.Decimal(line.lineItemCost!.value!).div(line.quantity!), currency: lineCurrency, status: saleStatus },
      });

      for (const refund of line.refunds ?? []) await upsertRefund(tx, storeId, order.id, orderLine.id, refund);
    }
    for (const refund of payload.paymentSummary?.refunds ?? []) await upsertRefund(tx, storeId, order.id, null, refund);
    if (missingHistoricalItemIds.size) await tx.historicalListingRecovery.createMany({ data: Array.from(missingHistoricalItemIds).map((ebayItemId) => ({ storeId, ebayItemId })), skipDuplicates: true });
    return order;
  });
}

async function upsertRefund(tx: Prisma.TransactionClient, storeId: string, orderId: string, orderLineId: string | null, refund: EbayRefundPayload) {
  const key = refundKey(refund); if (!key) return;
  await tx.ebayRefund.upsert({ where: { storeId_providerRefundId: { storeId, providerRefundId: key } },
    create: { storeId, orderId, orderLineId, providerRefundId: key, status: refund.refundStatus ?? "UNKNOWN", amount: amount(refund.amount), currency: refund.amount?.currency, refundDate: refund.refundDate ? date(refund.refundDate, "refundDate") : null },
    update: { status: refund.refundStatus ?? "UNKNOWN", amount: amount(refund.amount), currency: refund.amount?.currency, refundDate: refund.refundDate ? date(refund.refundDate, "refundDate") : null } });
}

export async function runOrderSync(store: Store, onProgress?: (processed: number) => Promise<void>) {
  if (store.orderAccessStatus !== "ready") throw new Error("Store requires eBay reauthorization for order access");
  const { accessToken } = await getValidAccessToken(store);
  const syncTo = new Date(); const from = getOrderWindowStart(store.orderSyncCheckpoint, syncTo); let processed = 0;
  for await (const page of getOrders(accessToken, from, syncTo)) {
    for (const order of page) { await ingestOrder(store.id, order); processed += 1; }
    if (onProgress) await onProgress(processed);
  }
  await prisma.store.update({ where: { id: store.id }, data: { orderSyncCheckpoint: syncTo } });
  return { processed, checkpoint: syncTo };
}

const LEASE_EXTENSION_MS = 55_000;

export class SyncJobLeaseLostError extends Error {
  constructor() { super("Order sync execution lease was lost"); this.name = "SyncJobLeaseLostError"; }
}

async function heartbeat(jobId: string, leaseToken: string) {
  const now = new Date();
  const result = await prisma.syncJob.updateMany({
    where: { id: jobId, status: "running", leaseToken },
    data: { heartbeatAt: now, leaseExpiresAt: new Date(now.getTime() + LEASE_EXTENSION_MS) },
  });
  if (result.count !== 1) throw new SyncJobLeaseLostError();
}

export type OrderSyncChunkResult = { status: "pending" | "completed"; processed: number; nextOffset: number | null; total: number };

/** Process exactly one provider page. Cursor advancement and final Store checkpoint
 * advancement happen only after every order on the page has committed. */
export async function runOrderSyncChunk(job: SyncJob, store: Store, leaseToken: string): Promise<OrderSyncChunkResult> {
  if (store.orderAccessStatus !== "ready") throw new Error("Store requires eBay reauthorization for order access");
  if (job.type !== "orders_incremental") throw new Error("Job is not an order sync");

  let windowStart = job.orderWindowStart;
  let windowEnd = job.orderWindowEnd;
  let offset = job.orderNextOffset;
  let sliceStart = job.orderSliceStart;
  let sliceEnd = job.orderSliceEnd;
  let sliceTotal = job.orderSliceTotal;
  let completedCount = job.orderCompletedCount;
  if ((windowStart == null) !== (windowEnd == null)) throw new Error("Order sync job has an incomplete persisted window");
  if (windowStart == null || windowEnd == null) {
    windowEnd = new Date();
    windowStart = getOrderWindowStart(store.orderSyncCheckpoint, windowEnd);
    offset = 0;
    const initialized = await prisma.syncJob.updateMany({
      where: { id: job.id, status: "running", leaseToken, orderWindowStart: null, orderWindowEnd: null },
      data: { orderWindowStart: windowStart, orderWindowEnd: windowEnd, orderNextOffset: 0, orderTotal: null, progress: 0 },
    });
    if (initialized.count !== 1) throw new SyncJobLeaseLostError();
  }

  if ((sliceStart == null) !== (sliceEnd == null)) throw new Error("Order sync job has an incomplete persisted slice");
  if (sliceStart == null || sliceEnd == null) {
    sliceStart = windowStart;
    sliceEnd = getOrderSliceEnd(sliceStart, windowEnd);
    offset = 0;
    sliceTotal = null;
    completedCount = 0;
    const initialized = await prisma.syncJob.updateMany({
      where: { id: job.id, status: "running", leaseToken, orderSliceStart: null, orderSliceEnd: null },
      data: { orderSliceStart: sliceStart, orderSliceEnd: sliceEnd, orderSliceTotal: null, orderNextOffset: 0,
        orderTotal: null, orderCompletedCount: 0, orderCompletedSlices: 0, progress: 0 },
    });
    if (initialized.count !== 1) throw new SyncJobLeaseLostError();
  }

  await heartbeat(job.id, leaseToken);
  const { accessToken } = await getValidAccessToken(store);
  const page = await getOrdersPage(accessToken, sliceStart, sliceEnd, offset);

  if (offset === 0 && page.nextOffset != null) {
    const narrowerEnd = getNarrowerOrderSliceEnd(sliceStart, sliceEnd);
    if (narrowerEnd) {
      const narrowed = await prisma.syncJob.updateMany({ where: { id: job.id, status: "running", leaseToken, orderNextOffset: 0 }, data: {
        status: "pending", orderSliceEnd: narrowerEnd, orderSliceTotal: null, orderTotal: null,
        progress: completedCount, scheduledAt: new Date(Date.now() + 30_000), errorMessage: null,
        orderSliceSplitCount: { increment: 1 }, leaseToken: null, leaseExpiresAt: null, heartbeatAt: new Date(),
      }});
      if (narrowed.count !== 1) throw new SyncJobLeaseLostError();
      return { status: "pending", processed: 0, nextOffset: 0, total: page.total };
    }
  }

  if (offset > 0 && sliceTotal != null && page.total !== sliceTotal) {
    const restarted = await prisma.syncJob.updateMany({ where: { id: job.id, status: "running", leaseToken, orderNextOffset: offset, orderSliceTotal: sliceTotal }, data: {
      status: "pending", orderNextOffset: 0, orderSliceTotal: null, orderTotal: null, progress: completedCount,
      scheduledAt: new Date(Date.now() + 30_000), errorMessage: "Provider total changed; replaying current time slice",
      orderSliceRestartCount: { increment: 1 }, leaseToken: null, leaseExpiresAt: null, heartbeatAt: new Date(),
    }});
    if (restarted.count !== 1) throw new SyncJobLeaseLostError();
    return { status: "pending", processed: 0, nextOffset: 0, total: page.total };
  }

  for (const order of page.orders) {
    await heartbeat(job.id, leaseToken);
    await ingestOrder(store.id, order);
  }
  await heartbeat(job.id, leaseToken);

  return prisma.$transaction(async (tx) => {
    const owned = await tx.syncJob.findFirst({ where: { id: job.id, status: "running", leaseToken }, select: { id: true, orderNextOffset: true, orderSliceStart: true, orderSliceEnd: true } });
    if (!owned || owned.orderNextOffset !== offset || owned.orderSliceStart?.getTime() !== sliceStart.getTime() || owned.orderSliceEnd?.getTime() !== sliceEnd.getTime()) throw new SyncJobLeaseLostError();
    if (page.nextOffset == null) {
      const newCompletedCount = completedCount + page.total;
      const learnedSliceDuration = sliceEnd.getTime() - sliceStart.getTime() + 1;
      const nextSlice = getNextOrderSlice(sliceEnd, windowEnd, learnedSliceDuration);
      if (!nextSlice) {
        await tx.store.update({ where: { id: store.id }, data: { orderSyncCheckpoint: windowEnd } });
        await tx.syncJob.update({ where: { id: job.id }, data: {
          status: "completed", progress: newCompletedCount, orderTotal: newCompletedCount, orderSliceTotal: page.total,
          orderCompletedCount: newCompletedCount, orderCompletedSlices: { increment: 1 }, completedAt: new Date(), errorMessage: null,
          leaseToken: null, leaseExpiresAt: null, heartbeatAt: new Date(),
        } });
        return { status: "completed" as const, processed: page.orders.length, nextOffset: null, total: newCompletedCount };
      }
      await tx.syncJob.update({ where: { id: job.id }, data: {
        status: "pending", progress: newCompletedCount, orderCompletedCount: newCompletedCount, orderCompletedSlices: { increment: 1 },
        orderSliceStart: nextSlice.start, orderSliceEnd: nextSlice.end, orderSliceTotal: null, orderNextOffset: 0, orderTotal: null,
        scheduledAt: new Date(Date.now() + 30_000), errorMessage: null, leaseToken: null, leaseExpiresAt: null, heartbeatAt: new Date(),
      } });
      return { status: "pending" as const, processed: page.orders.length, nextOffset: 0, total: newCompletedCount };
    }
    await tx.syncJob.update({ where: { id: job.id }, data: {
      status: "pending", progress: completedCount + page.nextOffset, orderNextOffset: page.nextOffset,
      orderTotal: page.total, orderSliceTotal: page.total,
      scheduledAt: new Date(Date.now() + 30_000), errorMessage: null,
      leaseToken: null, leaseExpiresAt: null, heartbeatAt: new Date(),
    } });
    return { status: "pending" as const, processed: page.orders.length, nextOffset: page.nextOffset, total: page.total };
  });
}
