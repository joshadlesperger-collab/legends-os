export const ORDER_OVERLAP_MS = 10 * 60 * 1000;
export const ORDER_SLICE_MS = 7 * 24 * 60 * 60 * 1000;
export const MIN_ORDER_SLICE_MS = 60 * 60 * 1000;

export function getOrderWindowStart(checkpoint: Date | null, now: Date) {
  const earliest = now.getTime() - 90 * 24 * 60 * 60 * 1000;
  const base = checkpoint?.getTime() ?? earliest;
  return new Date(Math.max(earliest, Math.min(now.getTime(), base) - ORDER_OVERLAP_MS));
}

export function getOrderSliceEnd(start: Date, logicalEnd: Date, durationMs = ORDER_SLICE_MS) {
  return new Date(Math.min(logicalEnd.getTime(), start.getTime() + Math.max(1, durationMs) - 1));
}

export function getNextOrderSlice(currentEnd: Date, logicalEnd: Date, durationMs = ORDER_SLICE_MS) {
  if (currentEnd.getTime() >= logicalEnd.getTime()) return null;
  const start = new Date(currentEnd.getTime() + 1);
  return { start, end: getOrderSliceEnd(start, logicalEnd, durationMs) };
}

export function getNarrowerOrderSliceEnd(start: Date, end: Date) {
  const inclusiveDuration = end.getTime() - start.getTime() + 1;
  if (inclusiveDuration <= MIN_ORDER_SLICE_MS) return null;
  const narrowedDuration = Math.max(MIN_ORDER_SLICE_MS, Math.floor(inclusiveDuration / 2));
  return getOrderSliceEnd(start, end, narrowedDuration);
}

export function getSaleStatus(cancelState: string | undefined, paymentStatus: string | undefined) {
  if (cancelState === "CANCELED") return "cancelled";
  if (paymentStatus === "FULLY_REFUNDED") return "refunded";
  if (paymentStatus === "PARTIALLY_REFUNDED") return "partially_refunded";
  return "confirmed";
}
