import type { EbayListingItem } from "@/lib/ebay";

export type ListingObservationStatus = "active" | "ended";

export type ExistingListingState = {
  sku?: string | null;
  title?: string;
  description?: string | null;
  categoryId?: string | null;
  condition?: string | null;
  listingFormat?: string | null;
  startTime?: Date | null;
  endTime?: Date | null;
  imageUrls?: string[];
  currentPrice: string;
  quantity: number;
  quantitySold: number;
  watchers: number;
  views: number;
  listingStatus: string;
};

export type NormalizedListingObservation = {
  ebayItemId: string;
  sku: string | null;
  title: string;
  description: string | null;
  categoryId: string | null;
  currentPrice: string;
  quantity: number;
  quantitySold: number;
  condition: string | null;
  listingStatus: ListingObservationStatus;
  listingFormat: string | null;
  startTime: Date | null;
  endTime: Date | null;
  watchers: number | null;
  views: number | null;
  imageUrls: string[];
  itemSpecifics: Record<string, string[]> | null;
};

const VIEW_SNAPSHOT_THRESHOLD = 20;
const WATCHER_SNAPSHOT_THRESHOLD = 3;
export const INCREMENTAL_OVERLAP_MS = 5 * 60 * 1000;
export const STALE_RUNNING_SYNC_MS = 2 * 60 * 60 * 1000;

export function getSyncLockDisposition(startedAt: Date, now: Date): "blocked" | "stale" {
  return now.getTime() - startedAt.getTime() >= STALE_RUNNING_SYNC_MS ? "stale" : "blocked";
}

export function getSyncRunTerminalStatus(outcome: "success" | "failure"): "completed" | "failed" {
  return outcome === "success" ? "completed" : "failed";
}

function countValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (value && typeof value === "object") {
    return countValue((value as Record<string, unknown>)["#text"]);
  }
  return null;
}

function validDate(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function normalizeItemSpecifics(item: EbayListingItem): Record<string, string[]> | null {
  const raw = item.ItemSpecifics?.NameValueList;
  const rows = raw ? (Array.isArray(raw) ? raw : [raw]) : [];
  const entries = rows.flatMap((row) => {
    const name = row.Name?.trim();
    if (!name) return [];
    const values = (Array.isArray(row.Value) ? row.Value : row.Value == null ? [] : [row.Value])
      .map(String).map((value) => value.trim()).filter(Boolean);
    return values.length ? [[name, Array.from(new Set(values))] as const] : [];
  });
  return entries.length ? Object.fromEntries(entries) : null;
}

export function dedupeEbayItems(items: EbayListingItem[]): EbayListingItem[] {
  const byId = new Map<string, EbayListingItem>();
  for (const item of items) {
    const id = String(item.ItemID ?? "").trim();
    if (id) byId.set(id, item);
  }
  return Array.from(byId.values());
}

export function normalizeEbayItem(
  item: EbayListingItem,
  listingStatus: ListingObservationStatus
): NormalizedListingObservation {
  const record = item as unknown as Record<string, unknown>;
  const details = (record.ListingDetails as Record<string, unknown> | undefined) ?? {};
  const selling = (record.SellingStatus as Record<string, unknown> | undefined) ?? {};
  const pictures = item.PictureDetails?.PictureURL;

  const currentPrice = countValue(item.SellingStatus?.CurrentPrice);
  if (currentPrice == null || currentPrice < 0) {
    throw new Error(`eBay item ${String(item.ItemID)} has an invalid current price`);
  }

  return {
    ebayItemId: String(item.ItemID),
    sku: item.SKU?.trim() || null,
    title: item.Title ?? "",
    description: item.Description ?? null,
    categoryId: item.PrimaryCategory?.CategoryID == null ? null : String(item.PrimaryCategory.CategoryID),
    currentPrice: String(currentPrice),
    quantity: Math.max(0, countValue(item.QuantityAvailable ?? item.Quantity) ?? 0),
    quantitySold: Math.max(0, countValue(item.SellingStatus?.QuantitySold) ?? 0),
    condition: item.ConditionDisplayName ?? null,
    listingStatus,
    listingFormat: item.ListingType ?? null,
    startTime: validDate(item.ListingDetails?.StartTime),
    endTime: validDate(item.ListingDetails?.EndTime),
    watchers:
      countValue(record.WatchCount) ??
      countValue(record.WatcherCount) ??
      countValue(record.InterestedBidders),
    views:
      countValue(record.HitCount) ??
      countValue(record.HitCounter) ??
      countValue(details.HitCount) ??
      countValue(details.ViewCount) ??
      countValue(selling.HitCount),
    imageUrls: pictures ? (Array.isArray(pictures) ? pictures : [pictures]) : [],
    itemSpecifics: normalizeItemSpecifics(item),
  };
}

export function classifyObservation(
  existing: ExistingListingState | null,
  observation: NormalizedListingObservation
): {
  kind: "new" | "unchanged" | "changed" | "reappeared" | "ended";
  snapshotWorthy: boolean;
  priceChanged: boolean;
} {
  if (!existing) {
    return { kind: "new", snapshotWorthy: true, priceChanged: false };
  }

  const priceChanged = existing.currentPrice !== observation.currentPrice;
  const statusChanged = existing.listingStatus !== observation.listingStatus;
  const materialChanged =
    priceChanged ||
    existing.quantity !== observation.quantity ||
    existing.quantitySold !== observation.quantitySold ||
    (observation.views != null && Math.abs(existing.views - observation.views) >= VIEW_SNAPSHOT_THRESHOLD) ||
    (observation.watchers != null && Math.abs(existing.watchers - observation.watchers) >= WATCHER_SNAPSHOT_THRESHOLD);
  const metadataChanged =
    existing.title !== undefined &&
    (existing.title !== observation.title ||
      existing.sku !== observation.sku ||
      existing.description !== observation.description ||
      existing.categoryId !== observation.categoryId ||
      existing.condition !== observation.condition ||
      existing.listingFormat !== observation.listingFormat ||
      (existing.startTime?.toISOString() ?? null) !== (observation.startTime?.toISOString() ?? null) ||
      (existing.endTime?.toISOString() ?? null) !== (observation.endTime?.toISOString() ?? null) ||
      JSON.stringify(existing.imageUrls ?? []) !== JSON.stringify(observation.imageUrls));

  if (statusChanged && observation.listingStatus === "active") {
    return { kind: "reappeared", snapshotWorthy: true, priceChanged };
  }
  if (statusChanged && observation.listingStatus === "ended") {
    return { kind: "ended", snapshotWorthy: true, priceChanged };
  }
  if (materialChanged || metadataChanged) {
    return { kind: "changed", snapshotWorthy: materialChanged, priceChanged };
  }
  return { kind: "unchanged", snapshotWorthy: false, priceChanged: false };
}

export function getIncrementalWindowStart(lastSyncAt: Date | null, now: Date): Date {
  const fallback = now.getTime() - 60 * 60 * 1000;
  const base = lastSyncAt?.getTime() ?? fallback;
  return new Date(Math.min(now.getTime(), base) - INCREMENTAL_OVERLAP_MS);
}
