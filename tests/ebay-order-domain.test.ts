import assert from "node:assert/strict";
import test from "node:test";
import { getNextOrderSlice, getNarrowerOrderSliceEnd, getOrderSliceEnd, getOrderWindowStart, getSaleStatus, MIN_ORDER_SLICE_MS, ORDER_OVERLAP_MS, ORDER_SLICE_MS } from "../lib/ebay-order-domain.ts";

test("order windows overlap a checkpoint and never exceed eBay's 90-day history", () => {
  const now = new Date("2026-08-13T12:00:00.000Z");
  const checkpoint = new Date("2026-08-13T11:30:00.000Z");
  assert.equal(ORDER_OVERLAP_MS, 10 * 60 * 1000);
  assert.equal(getOrderWindowStart(checkpoint, now).toISOString(), "2026-08-13T11:20:00.000Z");
  assert.equal(getOrderWindowStart(null, now).toISOString(), "2026-05-15T12:00:00.000Z");
  assert.equal(getOrderWindowStart(new Date("2027-01-01T00:00:00.000Z"), now).toISOString(), "2026-08-13T11:50:00.000Z");
});

test("order slices are adjacent at millisecond precision and bounded by the logical window", () => {
  const start = new Date("2026-05-16T00:00:00.000Z");
  const logicalEnd = new Date("2026-06-16T12:00:00.000Z");
  const firstEnd = getOrderSliceEnd(start, logicalEnd);
  assert.equal(ORDER_SLICE_MS, 7 * 24 * 60 * 60 * 1000);
  assert.equal(firstEnd.toISOString(), "2026-05-22T23:59:59.999Z");
  const next = getNextOrderSlice(firstEnd, logicalEnd)!;
  assert.equal(next.start.getTime(), firstEnd.getTime() + 1);
  assert.equal(next.end.toISOString(), "2026-05-29T23:59:59.999Z");
  let current = next;
  while (current.end < logicalEnd) current = getNextOrderSlice(current.end, logicalEnd)!;
  assert.equal(current.end.toISOString(), logicalEnd.toISOString());
  assert.equal(getNextOrderSlice(logicalEnd, logicalEnd), null);
  const learned = getNextOrderSlice(firstEnd, logicalEnd, 24 * 60 * 60 * 1000)!;
  assert.equal(learned.end.getTime() - learned.start.getTime() + 1, 24 * 60 * 60 * 1000);
});

test("dense order slices narrow deterministically but never below one hour", () => {
  const start = new Date("2026-08-01T00:00:00.000Z");
  let end = getOrderSliceEnd(start, new Date("2026-08-10T00:00:00.000Z"));
  let splits = 0;
  while (getNarrowerOrderSliceEnd(start, end)) { end = getNarrowerOrderSliceEnd(start, end)!; splits += 1; }
  assert.ok(splits > 0);
  assert.equal(end.getTime() - start.getTime() + 1, MIN_ORDER_SLICE_MS);
});

test("sale status reflects cancellation and refund state deterministically", () => {
  assert.equal(getSaleStatus("CANCELED", "FULLY_PAID"), "cancelled");
  assert.equal(getSaleStatus(undefined, "FULLY_REFUNDED"), "refunded");
  assert.equal(getSaleStatus(undefined, "PARTIALLY_REFUNDED"), "partially_refunded");
  assert.equal(getSaleStatus(undefined, "FULLY_PAID"), "confirmed");
});
