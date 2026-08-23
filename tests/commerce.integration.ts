import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "../lib/prisma";
import { setStoredToken } from "../lib/ebay";
import { acquireSyncRun, runStoreSync, SyncAlreadyRunningError } from "../lib/ebay-sync-service";
import { ingestOrder, runOrderSync } from "../lib/ebay-order-ingestion";
import { getOrders } from "../lib/ebay-orders";
import { claimNextJob, enqueueSyncJob, ensureHistoricalRecoveryJobs, processAvailableJobs, processSyncJob, recoverAbandonedJobs } from "../lib/sync-jobs";
import { loadCommerceDashboard } from "../lib/commerce-dashboard";
import { classifyNoCandidate } from "../lib/daily-operations";
import { recoverActiveListingEvidenceChunk } from "../lib/active-listing-evidence-recovery";
import { buildGovernedProposal, createGovernedExecution, executeGovernedAction, type EbayWriteProvider } from "../lib/governed-ebay-actions";

if (process.env.LEGENDS_INTEGRATION_TEST !== "disposable-local-postgres") throw new Error("Integration safety marker is missing");

const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const accountId = `integration-account-${suffix}`;
const storeId = `integration-store-${suffix}`;

function activeResponse(itemId: string | null, price = "25.00") {
  const item = itemId ? `<Item><ItemID>${itemId}</ItemID><Title>Redacted test card</Title><Quantity>2</Quantity><QuantityAvailable>2</QuantityAvailable><SellingStatus><CurrentPrice currencyID="USD">${price}</CurrentPrice><QuantitySold>0</QuantitySold></SellingStatus></Item>` : "";
  return `<GetMyeBaySellingResponse><Ack>Success</Ack><ActiveList><ItemArray>${item}</ItemArray><PaginationResult><TotalNumberOfPages>1</TotalNumberOfPages></PaginationResult></ActiveList></GetMyeBaySellingResponse>`;
}

async function newRun(mode: "full" | "incremental" = "full") {
  const store = await prisma.store.findUniqueOrThrow({ where: { id: storeId } });
  return { store, run: await acquireSyncRun(storeId, mode) };
}

test.before(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = "11".repeat(32);
  await prisma.account.create({ data: { id: accountId, name: "Disposable integration account", stores: { create: {
    id: storeId, connectionStatus: "connected", orderAccessStatus: "ready", oauthAccessToken: setStoredToken("redacted-test-token"),
    oauthRefreshToken: setStoredToken("redacted-test-refresh"), tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
  } } } });
});

test.after(async () => {
  await prisma.ebayActionExecutionEvent.deleteMany({ where: { execution: { storeId } } });
  await prisma.ebayActionExecution.deleteMany({ where: { storeId } });
  await prisma.outcomeObservation.deleteMany({ where: { decision: { listing: { storeId } } } });
  await prisma.operatorDecision.deleteMany({ where: { listing: { storeId } } });
  await prisma.saleEvent.deleteMany({ where: { orderLine: { storeId } } });
  await prisma.ebayRefund.deleteMany({ where: { storeId } });
  await prisma.ebayOrderLine.deleteMany({ where: { storeId } });
  await prisma.ebayOrder.deleteMany({ where: { storeId } });
  await prisma.priceChange.deleteMany({ where: { listing: { storeId } } });
  await prisma.listingSnapshot.deleteMany({ where: { storeId } });
  await prisma.syncJob.deleteMany({ where: { storeId } });
  await prisma.syncRun.deleteMany({ where: { storeId } });
  await prisma.apiErrorLog.deleteMany({ where: { storeId } });
  await prisma.historicalListingRecovery.deleteMany({ where: { storeId } });
  await prisma.listingCostBasis.deleteMany({ where: { listing: { storeId } } });
  await prisma.listing.deleteMany({ where: { storeId } });
  await prisma.store.delete({ where: { id: storeId } });
  await prisma.account.delete({ where: { id: accountId } });
  await prisma.$disconnect();
});

test("database lock blocks competitors and recovers stale locks", async () => {
  const first = await acquireSyncRun(storeId, "full");
  await assert.rejects(acquireSyncRun(storeId, "full"), (error) => error instanceof SyncAlreadyRunningError && error.syncRunId === first.id);
  await prisma.syncRun.update({ where: { id: first.id }, data: { startedAt: new Date(Date.now() - 3 * 60 * 60 * 1000) } });
  const recovered = await acquireSyncRun(storeId, "full");
  assert.equal((await prisma.syncRun.findUniqueOrThrow({ where: { id: first.id } })).status, "failed");
  await prisma.syncRun.update({ where: { id: recovered.id }, data: { status: "completed", completedAt: new Date() } });
});

test("durable jobs deduplicate, claim atomically, and recover abandoned work", async () => {
  const first = await enqueueSyncJob(storeId, "listing_full");
  const duplicate = await enqueueSyncJob(storeId, "orders_incremental");
  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.job.id, first.job.id);
  const claimed = await claimNextJob();
  assert.equal(claimed?.id, first.job.id);
  assert.equal(claimed?.attemptCount, 1);
  await prisma.syncJob.update({ where: { id: first.job.id }, data: { leaseExpiresAt: new Date(Date.now() - 1000) } });
  assert.equal(await recoverAbandonedJobs(), 1);
  assert.equal((await prisma.syncJob.findUniqueOrThrow({ where: { id: first.job.id } })).status, "retryable");
  await prisma.syncJob.update({ where: { id: first.job.id }, data: { status: "completed", completedAt: new Date() } });
});

function orderPayload(orderId: string, lineId: string, refundId?: string) {
  return {
    orderId, creationDate: "2026-08-13T10:00:00.000Z", lastModifiedDate: "2026-08-13T10:05:00.000Z",
    orderPaymentStatus: refundId ? "FULLY_REFUNDED" : "PAID", orderFulfillmentStatus: "FULFILLED",
    cancelStatus: { cancelState: "NONE_REQUESTED" }, pricingSummary: { total: { value: "25.00", currency: "USD" } },
    paymentSummary: refundId ? { refunds: [{ refundId, refundStatus: "REFUNDED", amount: { value: "25.00", currency: "USD" } }] } : undefined,
    lineItems: [{ lineItemId: lineId, legacyItemId: "listing-1", title: "Redacted resumable test card", quantity: 1,
      lineItemCost: { value: "25.00", currency: "USD" }, listingMarketplaceId: "EBAY_US" }],
  };
}

test("order jobs resume page-by-page, replay persisted pages idempotently, and checkpoint only at the end", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  await prisma.syncJob.deleteMany({ where: { storeId } });
  await prisma.saleEvent.deleteMany({ where: { orderLine: { storeId } } });
  await prisma.ebayRefund.deleteMany({ where: { storeId } });
  await prisma.ebayOrderLine.deleteMany({ where: { storeId } });
  await prisma.ebayOrder.deleteMany({ where: { storeId } });
  await prisma.store.update({ where: { id: storeId }, data: { orderSyncCheckpoint: null } });

  // Represents production-style data committed before a crash but before the page cursor advanced.
  await ingestOrder(storeId, orderPayload("resume-order-1", "resume-line-1", "resume-refund-1"));
  globalThis.fetch = async (input) => {
    const offset = Number(new URL(String(input)).searchParams.get("offset"));
    if (offset === 0) return Response.json({ total: 2, next: "page-2", orders: [orderPayload("resume-order-1", "resume-line-1", "resume-refund-1")] });
    if (offset === 1) return Response.json({ total: 2, orders: [orderPayload("resume-order-2", "resume-line-2")] });
    throw new Error(`Unexpected offset ${offset}`);
  };

  const queued = await enqueueSyncJob(storeId, "orders_incremental");
  const fixedStart = new Date("2026-08-13T10:00:00.000Z");
  const fixedEnd = new Date(fixedStart.getTime() + 60 * 60 * 1000 - 1);
  await prisma.syncJob.update({ where: { id: queued.job.id }, data: { orderWindowStart: fixedStart, orderWindowEnd: fixedEnd, orderSliceStart: fixedStart, orderSliceEnd: fixedEnd } });
  assert.equal((await processAvailableJobs(1))[0]?.status, "pending");
  let job = await prisma.syncJob.findUniqueOrThrow({ where: { id: queued.job.id } });
  assert.equal(job.status, "pending");
  assert.equal(job.orderNextOffset, 1);
  assert.ok(job.orderWindowStart && job.orderWindowEnd);
  assert.equal(job.orderSliceTotal, 2);
  assert.equal((await prisma.store.findUniqueOrThrow({ where: { id: storeId } })).orderSyncCheckpoint, null);
  assert.equal(await prisma.ebayOrder.count({ where: { storeId } }), 1);
  assert.equal(await prisma.ebayOrderLine.count({ where: { storeId } }), 1);
  assert.equal(await prisma.ebayRefund.count({ where: { storeId } }), 1);
  assert.equal(await prisma.saleEvent.count({ where: { orderLine: { storeId } } }), 1);

  await prisma.syncJob.update({ where: { id: job.id }, data: { scheduledAt: new Date() } });
  assert.equal((await processAvailableJobs(1))[0]?.status, "completed");
  job = await prisma.syncJob.findUniqueOrThrow({ where: { id: job.id } });
  assert.equal(job.status, "completed");
  assert.equal(job.orderNextOffset, 1);
  assert.equal(job.progress, 2);
  assert.equal(job.attemptCount, 2);
  assert.equal(job.failureCount, 0);
  assert.equal(job.orderCompletedSlices, 1);
  assert.equal((await prisma.store.findUniqueOrThrow({ where: { id: storeId } })).orderSyncCheckpoint?.toISOString(), job.orderWindowEnd?.toISOString());
  assert.equal(await prisma.ebayOrder.count({ where: { storeId } }), 2);
  assert.equal(await prisma.ebayOrderLine.count({ where: { storeId } }), 2);
  assert.equal(await prisma.ebayRefund.count({ where: { storeId } }), 1);
  assert.equal(await prisma.saleEvent.count({ where: { orderLine: { storeId } } }), 2);
  await prisma.saleEvent.deleteMany({ where: { orderLine: { storeId } } });
  await prisma.ebayRefund.deleteMany({ where: { storeId } });
  await prisma.ebayOrderLine.deleteMany({ where: { storeId } });
  await prisma.ebayOrder.deleteMany({ where: { storeId } });
});

test("dense slices split before ingestion and changing totals restart only the active slice", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  await prisma.syncJob.deleteMany({ where: { storeId } });
  await prisma.saleEvent.deleteMany({ where: { orderLine: { storeId } } });
  await prisma.ebayRefund.deleteMany({ where: { storeId } });
  await prisma.ebayOrderLine.deleteMany({ where: { storeId } });
  await prisma.ebayOrder.deleteMany({ where: { storeId } });
  await prisma.store.update({ where: { id: storeId }, data: { orderSyncCheckpoint: null } });
  const start = new Date("2026-08-13T00:00:00.000Z");
  const end = new Date(start.getTime() + 2 * 60 * 60 * 1000 - 1);
  const queued = await enqueueSyncJob(storeId, "orders_incremental");
  await prisma.syncJob.update({ where: { id: queued.job.id }, data: { orderWindowStart: start, orderWindowEnd: end, orderSliceStart: start, orderSliceEnd: end } });
  let calls = 0;
  globalThis.fetch = async (input) => {
    calls += 1;
    const offset = Number(new URL(String(input)).searchParams.get("offset"));
    if (calls === 1) return Response.json({ total: 51, next: "next", orders: [orderPayload("split-not-ingested", "split-line")] });
    if (calls === 2 && offset === 0) return Response.json({ total: 51, next: "next", orders: [orderPayload("stable-order", "stable-line")] });
    if (calls === 3 && offset === 1) return Response.json({ total: 50, next: "shifted", orders: [orderPayload("shifted-order", "shifted-line")] });
    throw new Error(`Unexpected call ${calls} offset ${offset}`);
  };
  await processAvailableJobs(1);
  let job = await prisma.syncJob.findUniqueOrThrow({ where: { id: queued.job.id } });
  assert.equal(job.orderSliceSplitCount, 1);
  assert.equal(job.orderNextOffset, 0);
  assert.equal(await prisma.ebayOrder.count({ where: { storeId } }), 0);
  await prisma.syncJob.update({ where: { id: job.id }, data: { scheduledAt: new Date() } });
  await processAvailableJobs(1);
  job = await prisma.syncJob.findUniqueOrThrow({ where: { id: job.id } });
  assert.equal(job.orderNextOffset, 1);
  assert.equal(job.orderSliceTotal, 51);
  assert.equal(await prisma.ebayOrder.count({ where: { storeId } }), 1);
  await prisma.syncJob.update({ where: { id: job.id }, data: { scheduledAt: new Date() } });
  await processAvailableJobs(1);
  job = await prisma.syncJob.findUniqueOrThrow({ where: { id: job.id } });
  assert.equal(job.status, "pending");
  assert.equal(job.orderNextOffset, 0);
  assert.equal(job.orderSliceTotal, null);
  assert.equal(job.orderSliceRestartCount, 1);
  assert.equal(job.orderCompletedSlices, 0);
  assert.equal((await prisma.store.findUniqueOrThrow({ where: { id: storeId } })).orderSyncCheckpoint, null);
  assert.equal(await prisma.ebayOrder.count({ where: { storeId } }), 1);
  assert.equal(await prisma.ebayOrder.findUnique({ where: { storeId_providerOrderId: { storeId, providerOrderId: "shifted-order" } } }), null);
  await prisma.saleEvent.deleteMany({ where: { orderLine: { storeId } } });
  await prisma.ebayOrderLine.deleteMany({ where: { storeId } });
  await prisma.ebayOrder.deleteMany({ where: { storeId } });
});

test("multiple adjacent time slices complete one logical sync and checkpoint only after the last", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  await prisma.syncJob.deleteMany({ where: { storeId } });
  await prisma.store.update({ where: { id: storeId }, data: { orderSyncCheckpoint: null } });
  const start = new Date("2026-08-01T00:00:00.000Z");
  const end = new Date("2026-08-09T00:00:00.000Z");
  const queued = await enqueueSyncJob(storeId, "orders_incremental");
  await prisma.syncJob.update({ where: { id: queued.job.id }, data: { orderWindowStart: start, orderWindowEnd: end } });
  globalThis.fetch = async () => Response.json({ total: 0, orders: [] });
  assert.equal((await processAvailableJobs(1))[0]?.status, "pending");
  let job = await prisma.syncJob.findUniqueOrThrow({ where: { id: queued.job.id } });
  assert.equal(job.orderCompletedSlices, 1);
  assert.equal((await prisma.store.findUniqueOrThrow({ where: { id: storeId } })).orderSyncCheckpoint, null);
  assert.equal(job.orderSliceStart?.getTime(), new Date("2026-08-08T00:00:00.000Z").getTime());
  await prisma.syncJob.update({ where: { id: job.id }, data: { scheduledAt: new Date() } });
  assert.equal((await processAvailableJobs(1))[0]?.status, "completed");
  job = await prisma.syncJob.findUniqueOrThrow({ where: { id: job.id } });
  assert.equal(job.orderCompletedSlices, 2);
  assert.equal((await prisma.store.findUniqueOrThrow({ where: { id: storeId } })).orderSyncCheckpoint?.getTime(), end.getTime());
});

test("only one concurrent worker claims a chunk and an expired lease is recoverable", async () => {
  await prisma.syncJob.deleteMany({ where: { storeId } });
  const queued = await enqueueSyncJob(storeId, "orders_incremental");
  const claims = await Promise.all([claimNextJob(), claimNextJob()]);
  assert.equal(claims.filter((claim) => claim?.id === queued.job.id).length, 1);
  const claimed = claims.find((claim) => claim?.id === queued.job.id)!;
  assert.ok(claimed.leaseToken);
  await prisma.syncJob.update({ where: { id: queued.job.id }, data: { leaseExpiresAt: new Date(Date.now() - 1000) } });
  assert.equal(await recoverAbandonedJobs(), 1);
  const recovered = await prisma.syncJob.findUniqueOrThrow({ where: { id: queued.job.id } });
  assert.equal(recovered.status, "retryable");
  assert.equal(recovered.leaseToken, null);
  assert.equal(recovered.completedAt, null);
  await prisma.syncJob.update({ where: { id: queued.job.id }, data: { status: "completed", completedAt: new Date() } });
});

test("listing persistence is idempotent, historical, reversible, and safely reconciled", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response(activeResponse("listing-1"), { status: 200 });
  let current = await newRun();
  await runStoreSync(current.store, "full", current.run.id);
  assert.equal(await prisma.listing.count({ where: { storeId } }), 1);
  assert.equal(await prisma.listingSnapshot.count({ where: { storeId } }), 1);

  current = await newRun();
  await runStoreSync(current.store, "full", current.run.id);
  assert.equal(await prisma.listingSnapshot.count({ where: { storeId } }), 1);

  globalThis.fetch = async () => new Response(activeResponse("listing-1", "30.00"), { status: 200 });
  current = await newRun();
  await runStoreSync(current.store, "full", current.run.id);
  assert.equal(await prisma.priceChange.count({ where: { listing: { storeId } } }), 1);

  globalThis.fetch = async () => new Response(activeResponse(null), { status: 200 });
  current = await newRun();
  await runStoreSync(current.store, "full", current.run.id);
  assert.equal((await prisma.listing.findFirstOrThrow({ where: { storeId } })).listingStatus, "ended");

  globalThis.fetch = async () => new Response(activeResponse("listing-1", "30.00"), { status: 200 });
  current = await newRun();
  await runStoreSync(current.store, "full", current.run.id);
  assert.equal((await prisma.listing.findFirstOrThrow({ where: { storeId } })).listingStatus, "active");

  globalThis.fetch = async () => new Response("<GetMyeBaySellingResponse><Ack>PartialSuccess</Ack><Errors><ErrorCode>1</ErrorCode></Errors></GetMyeBaySellingResponse>", { status: 200 });
  current = await newRun();
  await assert.rejects(runStoreSync(current.store, "full", current.run.id));
  assert.equal((await prisma.listing.findFirstOrThrow({ where: { storeId } })).listingStatus, "active");
  assert.equal((await prisma.syncRun.findUniqueOrThrow({ where: { id: current.run.id } })).status, "failed");
});

test("authoritative orders update idempotently and create one sale event per line", async () => {
  const base = { orderId: "order-1", creationDate: "2026-08-13T10:00:00.000Z", lastModifiedDate: "2026-08-13T10:05:00.000Z",
    orderPaymentStatus: "FULLY_PAID", orderFulfillmentStatus: "NOT_STARTED", cancelStatus: { cancelState: "NONE_REQUESTED" },
    pricingSummary: { total: { value: "45.00", currency: "USD" } }, lineItems: [
      { lineItemId: "line-1", legacyItemId: "listing-1", title: "Redacted card", quantity: 2, lineItemCost: { value: "40.00", currency: "USD" }, listingMarketplaceId: "EBAY_US" },
      { lineItemId: "line-2", legacyItemId: "not-yet-local", title: "Redacted card two", quantity: 1, lineItemCost: { value: "5.00", currency: "USD" } },
    ] };
  await ingestOrder(storeId, base);
  await ingestOrder(storeId, base);
  assert.equal(await prisma.ebayOrder.count({ where: { storeId } }), 1);
  assert.equal(await prisma.ebayOrderLine.count({ where: { storeId } }), 2);
  assert.equal(await prisma.saleEvent.count({ where: { orderLine: { storeId } } }), 2);
  assert.ok((await prisma.ebayOrderLine.findUniqueOrThrow({ where: { storeId_providerLineItemId: { storeId, providerLineItemId: "line-1" } } })).listingId);
  assert.equal((await prisma.ebayOrderLine.findUniqueOrThrow({ where: { storeId_providerLineItemId: { storeId, providerLineItemId: "line-2" } } })).listingId, null);

  await ingestOrder(storeId, { ...base, lastModifiedDate: "2026-08-13T11:00:00.000Z", orderPaymentStatus: "FULLY_REFUNDED",
    paymentSummary: { refunds: [{ refundId: "refund-1", refundStatus: "REFUNDED", refundDate: "2026-08-13T11:00:00.000Z", amount: { value: "45.00", currency: "USD" } }] } });
  assert.equal(await prisma.ebayRefund.count({ where: { storeId } }), 1);
  assert.deepEqual((await prisma.saleEvent.findMany({ where: { orderLine: { storeId } }, select: { status: true }, orderBy: { providerEventId: "asc" } })).map((row) => row.status), ["refunded", "refunded"]);
});

test("historical GetItem recovery archives exact identity and links authoritative sales", async (t) => {
  t.after(async () => {
    const line = await prisma.ebayOrderLine.findUnique({ where: { storeId_providerLineItemId: { storeId, providerLineItemId: `history-line-${suffix}` } }, select: { id: true, listingId: true } });
    if (line) { await prisma.orderLineReconciliation.deleteMany({ where: { orderLineId: line.id } }); await prisma.saleEvent.deleteMany({ where: { orderLineId: line.id } }); await prisma.ebayOrderLine.delete({ where: { id: line.id } }); }
    await prisma.ebayOrder.deleteMany({ where: { storeId, providerOrderId: `history-order-${suffix}` } });
    await prisma.historicalListingRecovery.deleteMany({ where: { storeId, ebayItemId: "123456789012" } });
    if (line?.listingId) { await prisma.listingSnapshot.deleteMany({ where: { listingId: line.listingId } }); await prisma.listing.deleteMany({ where: { id: line.listingId } }); }
  });
  await ingestOrder(storeId, { ...orderPayload(`history-order-${suffix}`, `history-line-${suffix}`), lineItems: [{ lineItemId: `history-line-${suffix}`, legacyItemId: "123456789012", title: "Recovered historical card", quantity: 1, lineItemCost: { value: "44.00", currency: "USD" } }] });
  const recovery = await prisma.historicalListingRecovery.findUniqueOrThrow({ where: { storeId_ebayItemId: { storeId, ebayItemId: "123456789012" } } });
  const originalFetch = globalThis.fetch; t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response("<GetItemResponse><Ack>Success</Ack><Item><ItemID>123456789012</ItemID><SKU>ARCHIVE-1</SKU><Title>Recovered historical card</Title><Quantity>1</Quantity><QuantityAvailable>0</QuantityAvailable><ListingDetails><StartTime>2026-07-01T00:00:00.000Z</StartTime><EndTime>2026-08-01T00:00:00.000Z</EndTime></ListingDetails><SellingStatus><CurrentPrice>44.00</CurrentPrice><QuantitySold>1</QuantitySold></SellingStatus><ItemSpecifics><NameValueList><Name>Year</Name><Value>2020</Value></NameValueList></ItemSpecifics></Item></GetItemResponse>", { status: 200 });
  assert.equal(await ensureHistoricalRecoveryJobs(), 1);
  const queued = await prisma.syncJob.findFirstOrThrow({ where: { storeId, type: "historical_recovery", status: "pending" } });
  const job = await prisma.syncJob.update({ where: { id: queued.id }, data: { status: "running", leaseToken: "history-test-lease", leaseExpiresAt: new Date(Date.now() + 60_000) } });
  const result = await processSyncJob(job);
  const persistedRecovery = await prisma.historicalListingRecovery.findUniqueOrThrow({ where: { id: recovery.id } });
  assert.equal(result.status, "completed", persistedRecovery.errorMessage ?? undefined); assert.equal(result.progress, 1);
  const line = await prisma.ebayOrderLine.findUniqueOrThrow({ where: { storeId_providerLineItemId: { storeId, providerLineItemId: `history-line-${suffix}` } }, include: { listing: true, reconciliation: true } });
  assert.equal(line.listing?.ebayItemId, "123456789012"); assert.equal(line.listing?.authoritativeSource, "ebay-trading-get-item");
  assert.equal(line.reconciliation?.status, "auto_linked"); assert.equal(line.reconciliation?.confidence, 100);
});

test("active evidence recovery caches authoritative listing details without marketplace writes", async (t) => {
  const ebayItemId = "987654321012";
  await prisma.listing.updateMany({ where: { storeId, listingStatus: "active", authoritativeObservedAt: null }, data: { authoritativeObservedAt: new Date(), authoritativeSource: "integration-prior-evidence" } });
  const listing = await prisma.listing.create({ data: { storeId, ebayItemId, title: "Original provider title", currentPrice: 25, quantity: 1, imageUrls: [], listingStatus: "active" } });
  t.after(async () => { await prisma.listing.deleteMany({ where: { id: listing.id } }); });
  const originalFetch = globalThis.fetch; t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (_url, init) => {
    const body = String(init?.body ?? "");
    assert.match(body, /<GetItemRequest/);
    assert.doesNotMatch(body, /ReviseItem|EndItem|AddFixedPriceItem/);
    return new Response(`<GetItemResponse><Ack>Success</Ack><Item><ItemID>${ebayItemId}</ItemID><Title>2024 Topps Shohei Ohtani #1</Title><Quantity>1</Quantity><QuantityAvailable>1</QuantityAvailable><ListingType>FixedPriceItem</ListingType><PrimaryCategory><CategoryID>261328</CategoryID></PrimaryCategory><SellingStatus><CurrentPrice>25.00</CurrentPrice><QuantitySold>0</QuantitySold></SellingStatus><ItemSpecifics><NameValueList><Name>Year</Name><Value>2024</Value></NameValueList><NameValueList><Name>Player/Athlete</Name><Value>Shohei Ohtani</Value></NameValueList></ItemSpecifics></Item></GetItemResponse>`, { status: 200 });
  };
  const store = await prisma.store.findUniqueOrThrow({ where: { id: storeId } });
  const result = await recoverActiveListingEvidenceChunk(store, 1);
  assert.equal(result.recovered, 1);
  const persisted = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } });
  assert.equal(persisted.authoritativeSource, "ebay-trading-get-item");
  assert.equal(persisted.categoryId, "261328");
  assert.equal(persisted.listingFormat, "FixedPriceItem");
  assert.deepEqual(persisted.itemSpecifics, { Year: ["2024"], "Player/Athlete": ["Shohei Ohtani"] });
});

test("governed price execution requires approval, revalidates, verifies, and appends immutable events",async(t)=>{
  const ebayItemId="876543210123";const listing=await prisma.listing.create({data:{storeId,ebayItemId,title:"2024 Topps Shohei Ohtani #1",currentPrice:80,quantity:1,imageUrls:[],listingStatus:"active",listingFormat:"FixedPriceItem",categoryId:"261328",startTime:new Date(Date.now()-120*86_400_000),views:1,itemSpecifics:{Year:["2024"],"Player/Athlete":["Shohei Ohtani"],Set:["Topps"],"Card Number":["1"]},authoritativeSource:"ebay-trading-get-item",authoritativeObservedAt:new Date()}});
  const recommendation=await prisma.recommendation.create({data:{listingId:listing.id,storeId,type:"lower-price",suggestedPrice:35,reason:"integration supported comp",confidence:94}});let decisionId:string|undefined;let executionId:string|undefined;
  t.after(async()=>{if(executionId)await prisma.ebayActionExecutionEvent.deleteMany({where:{executionId}});if(executionId)await prisma.ebayActionExecution.deleteMany({where:{id:executionId}});if(decisionId)await prisma.operatorDecision.deleteMany({where:{id:decisionId}});await prisma.recommendation.deleteMany({where:{id:recommendation.id}});await prisma.priceChange.deleteMany({where:{listingId:listing.id}});await prisma.listingSnapshot.deleteMany({where:{listingId:listing.id}});await prisma.listing.deleteMany({where:{id:listing.id}});});
  const proposal=await buildGovernedProposal(listing.id);assert.equal(proposal?.action,"LOWER_PRICE");assert.deepEqual(proposal?.after,{price:35});
  const decision=await prisma.operatorDecision.create({data:{listingId:listing.id,operatorId:"integration-operator",recommendedAction:"LOWER_PRICE",doctrineVersion:proposal!.doctrineVersion,decision:"follow_recommendation",beforeState:JSON.parse(JSON.stringify(proposal!.before)),evidenceSnapshot:JSON.parse(JSON.stringify({proposal})),observationWindowDays:30}});decisionId=decision.id;
  const execution=await createGovernedExecution(decision.id,"integration-operator");executionId=execution.id;let livePrice=80;let writes=0;
  const item=()=>({ItemID:ebayItemId,Title:listing.title,Quantity:1,QuantityAvailable:1,ListingType:"FixedPriceItem",PrimaryCategory:{CategoryID:"261328"},SellingStatus:{CurrentPrice:livePrice,QuantitySold:0},ItemSpecifics:{NameValueList:[{Name:"Year",Value:"2024"}]}});
  const provider:EbayWriteProvider={getItem:async()=>item(),revisePrice:async(_token,_id,price)=>{writes++;livePrice=price;return{itemId:ebayItemId};},reviseTitle:async()=>{throw new Error("unexpected title write");},endListing:async()=>{throw new Error("unexpected end write");},verifyRelist:async()=>{throw new Error("unexpected verify relist");},relist:async()=>{throw new Error("unexpected relist");}};
  const result=await executeGovernedAction(execution.id,"integration-operator",provider,{writesEnabled:true});assert.equal(result.status,"verified");assert.equal(writes,1);assert.equal(Number((await prisma.listing.findUniqueOrThrow({where:{id:listing.id}})).currentPrice),35);
  assert.deepEqual((await prisma.ebayActionExecutionEvent.findMany({where:{executionId:execution.id},orderBy:{sequence:"asc"},select:{type:true}})).map(row=>row.type),["approved","server_revalidated","execution_started","provider_verified"]);
  await executeGovernedAction(execution.id,"integration-operator",provider,{writesEnabled:true});assert.equal(writes,1);
});

test("governed End and Sell Similar verifies before ending, preserves remaining quantity, and resumes without ending twice",async(t)=>{
  const oldItemId="765432101234",newItemId="765432101235";const listing=await prisma.listing.create({data:{storeId,ebayItemId:oldItemId,title:"2024 Topps Shohei Ohtani #1",currentPrice:25,quantity:1,imageUrls:[],listingStatus:"active",listingFormat:"FixedPriceItem",categoryId:"261328",startTime:new Date(Date.now()-120*86_400_000),views:1,itemSpecifics:{Year:["2024"],"Player/Athlete":["Shohei Ohtani"],Set:["Topps"],"Card Number":["1"]},authoritativeSource:"ebay-trading-get-item",authoritativeObservedAt:new Date()}});const recommendation=await prisma.recommendation.create({data:{listingId:listing.id,storeId,type:"lower-price",suggestedPrice:24,reason:"integration pricing checked with no material mismatch",confidence:82}});let decisionId:string|undefined;let executionId:string|undefined;
  t.after(async()=>{if(executionId)await prisma.ebayActionExecutionEvent.deleteMany({where:{executionId}});if(executionId)await prisma.ebayActionExecution.deleteMany({where:{id:executionId}});if(decisionId)await prisma.operatorDecision.deleteMany({where:{id:decisionId}});await prisma.recommendation.deleteMany({where:{id:recommendation.id}});const ids=(await prisma.listing.findMany({where:{storeId,ebayItemId:{in:[oldItemId,newItemId]}},select:{id:true}})).map(row=>row.id);await prisma.priceChange.deleteMany({where:{listingId:{in:ids}}});await prisma.listingSnapshot.deleteMany({where:{listingId:{in:ids}}});await prisma.listing.deleteMany({where:{id:{in:ids}}});});
  const proposal=await buildGovernedProposal(listing.id);assert.equal(proposal?.action,"END_SELL_SIMILAR");const decision=await prisma.operatorDecision.create({data:{listingId:listing.id,operatorId:"integration-operator",recommendedAction:"END_SELL_SIMILAR",doctrineVersion:proposal!.doctrineVersion,decision:"follow_recommendation",beforeState:JSON.parse(JSON.stringify(proposal!.before)),evidenceSnapshot:JSON.parse(JSON.stringify({proposal})),observationWindowDays:30}});decisionId=decision.id;const execution=await createGovernedExecution(decision.id,"integration-operator");executionId=execution.id;
  let endCalls=0,verifyCalls=0,relistCalls=0,relisted=false;const oldItem=()=>({ItemID:oldItemId,Title:listing.title,Description:"preserved",Quantity:3,QuantityAvailable:2,ListingType:"FixedPriceItem",PrimaryCategory:{CategoryID:"261328"},SellingStatus:{CurrentPrice:25,QuantitySold:1,ListingStatus:relisted?"Completed":"Active"},ItemSpecifics:{NameValueList:[{Name:"Year",Value:"2024"}]},SellerProfiles:{SellerShippingProfile:{ShippingProfileID:"1"}}});const newItem=()=>({...oldItem(),ItemID:newItemId,Quantity:2,QuantityAvailable:2,SellingStatus:{CurrentPrice:25,QuantitySold:0,ListingStatus:"Active"}});
  const provider:EbayWriteProvider={getItem:async(_token,id)=>id===newItemId?newItem():oldItem(),revisePrice:async()=>{throw new Error("unexpected price write");},reviseTitle:async()=>{throw new Error("unexpected title write");},endListing:async()=>{endCalls++;return{itemId:oldItemId};},verifyRelist:async(_token,_id,quantity)=>{verifyCalls++;assert.equal(quantity,2);return{itemId:oldItemId,ack:"Success",warnings:[]};},relist:async(_token,_id,quantity)=>{relistCalls++;assert.equal(quantity,2);if(relistCalls===1)throw new Error("transient relist failure");relisted=true;return{oldItemId,newItemId};}};
  await assert.rejects(executeGovernedAction(execution.id,"integration-operator",provider,{writesEnabled:true}),/transient relist failure/);assert.equal((await prisma.ebayActionExecution.findUniqueOrThrow({where:{id:execution.id}})).status,"partial_failure");assert.equal(verifyCalls,1);assert.equal(endCalls,1);
  const recovered=await executeGovernedAction(execution.id,"integration-operator",provider,{writesEnabled:true});assert.equal(recovered.status,"verified");assert.equal(endCalls,1);assert.equal(verifyCalls,1);assert.equal(recovered.newEbayItemId,newItemId);assert.equal((await prisma.listing.findUniqueOrThrow({where:{id:listing.id}})).relistedToEbayItemId,newItemId);
});

test("ended BIN cleanup is approval-gated, internal-only, and preserves listing history",async(t)=>{
  const listing=await prisma.listing.create({data:{storeId,ebayItemId:"654321012345",title:"Ended BIN history",currentPrice:20,quantity:0,imageUrls:[],listingStatus:"ended",listingFormat:"FixedPriceItem",endTime:new Date(Date.now()-40*86_400_000)}});let decisionId:string|undefined;let executionId:string|undefined;t.after(async()=>{if(executionId)await prisma.ebayActionExecutionEvent.deleteMany({where:{executionId}});if(executionId)await prisma.ebayActionExecution.deleteMany({where:{id:executionId}});if(decisionId)await prisma.operatorDecision.deleteMany({where:{id:decisionId}});await prisma.listing.deleteMany({where:{id:listing.id}});});
  const proposal=await buildGovernedProposal(listing.id);assert.equal(proposal?.action,"ENDED_BIN_CLEANUP");assert.equal(proposal?.ready,true);const decision=await prisma.operatorDecision.create({data:{listingId:listing.id,operatorId:"integration-operator",recommendedAction:"ENDED_BIN_CLEANUP",doctrineVersion:proposal!.doctrineVersion,decision:"follow_recommendation",beforeState:JSON.parse(JSON.stringify(proposal!.before)),evidenceSnapshot:JSON.parse(JSON.stringify({proposal})),observationWindowDays:0}});decisionId=decision.id;const execution=await createGovernedExecution(decision.id,"integration-operator");executionId=execution.id;
  const noProvider:EbayWriteProvider={getItem:async()=>{throw new Error("provider must not be called");},revisePrice:async()=>{throw new Error("provider must not be called");},reviseTitle:async()=>{throw new Error("provider must not be called");},endListing:async()=>{throw new Error("provider must not be called");},verifyRelist:async()=>{throw new Error("provider must not be called");},relist:async()=>{throw new Error("provider must not be called");}};
  assert.equal((await executeGovernedAction(execution.id,"integration-operator",noProvider,{writesEnabled:false})).status,"verified");assert.equal((await prisma.listing.findUniqueOrThrow({where:{id:listing.id}})).listingStatus,"ended");
});

test("no-candidate classification uses explainable data-quality buckets", () => {
  assert.equal(classifyNoCandidate({ title: "Card lot of five", quantity: 1, sku: null, ebayItemId: "1", recoveryStatus: "not_found" }), "non_standard_item");
  assert.equal(classifyNoCandidate({ title: "2024 Topps Chrome Player", quantity: 2, sku: null, ebayItemId: "2", recoveryStatus: "not_found" }), "multi_quantity_ambiguity");
  assert.equal(classifyNoCandidate({ title: "2024 Topps Chrome Player", quantity: 1, sku: null, ebayItemId: "3", recoveryStatus: "not_found" }), "historical_identity_unavailable");
});

test("order pagination retries transient failures and checkpoints only complete ingestion", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let calls = 0;
  globalThis.fetch = async (_url) => {
    calls += 1;
    if (calls === 1) return new Response("temporary", { status: 503 });
    if (calls === 2) return Response.json({ total: 2, next: "next", orders: [{ orderId: "page-1" }] });
    return Response.json({ total: 2, orders: [{ orderId: "page-2" }] });
  };
  const ids: string[] = [];
  for await (const page of getOrders("redacted-test-token", new Date("2026-08-01T00:00:00Z"), new Date("2026-08-13T00:00:00Z"))) ids.push(...page.map((order) => order.orderId!));
  assert.deepEqual(ids, ["page-1", "page-2"]);
  assert.equal(calls, 3);

  await prisma.store.update({ where: { id: storeId }, data: { orderSyncCheckpoint: null } });
  globalThis.fetch = async () => Response.json({ total: 0, orders: [], warnings: [{ category: "WARNING" }] });
  await assert.rejects(runOrderSync(await prisma.store.findUniqueOrThrow({ where: { id: storeId } })), /checkpoint was not advanced/);
  assert.equal((await prisma.store.findUniqueOrThrow({ where: { id: storeId } })).orderSyncCheckpoint, null);

  globalThis.fetch = async () => Response.json({ total: 0, orders: [] });
  await runOrderSync(await prisma.store.findUniqueOrThrow({ where: { id: storeId } }));
  assert.ok((await prisma.store.findUniqueOrThrow({ where: { id: storeId } })).orderSyncCheckpoint);
});

test("listing cost basis is optional, per-unit, and updates without changing inventory", async () => {
  const listing = await prisma.listing.findFirstOrThrow({ where: { storeId } });
  const before = { quantity: listing.quantity, currentPrice: listing.currentPrice.toString() };
  await prisma.listingCostBasis.upsert({ where: { listingId: listing.id }, create: {
    listingId: listing.id, unitAcquisitionCost: "8.00", unitGradingCost: "2.00", unitSuppliesCost: "0.50",
  }, update: { unitAcquisitionCost: "8.00", unitGradingCost: "2.00", unitSuppliesCost: "0.50" } });
  const cost = await prisma.listingCostBasis.findUniqueOrThrow({ where: { listingId: listing.id } });
  assert.equal(cost.currency, "USD");
  assert.equal(cost.unitAcquisitionCost?.toString(), "8");
  assert.equal(cost.unitGradingCost?.toString(), "2");
  assert.equal(cost.unitSuppliesCost?.toString(), "0.5");
  const after = await prisma.listing.findUniqueOrThrow({ where: { id: listing.id } });
  assert.deepEqual({ quantity: after.quantity, currentPrice: after.currentPrice.toString() }, before);
});

test("commerce dashboard reports authoritative sales, coverage, and known costs without buyer data", async () => {
  const dashboard = await loadCommerceDashboard(new Date("2026-08-14T12:00:00.000Z"));
  assert.equal(dashboard.summary.orders, 1);
  assert.equal(dashboard.summary.units, 3);
  assert.equal(dashboard.summary.grossSales, 45);
  assert.equal(dashboard.summary.refunds, 45);
  assert.equal(dashboard.coverage.lineCount, 2);
  assert.equal(dashboard.coverage.linkedLines, 1);
  assert.equal(dashboard.coverage.unlinkedLines, 1);
  assert.equal(dashboard.coverage.linkedPercent, 50);
  assert.ok(dashboard.recentSales.every((sale) => !("buyer" in sale) && !("email" in sale) && !("address" in sale)));
  const costed = dashboard.bestSellers.find((row) => row.listingId != null);
  assert.equal(costed?.knownUnitCost, 10.5);
  assert.equal(costed?.knownCostMargin, 19);
});
