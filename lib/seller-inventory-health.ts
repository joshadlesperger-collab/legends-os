import { enumerateSellerAuctionsEndingBefore, getEbayApplicationAccessToken, type EbayBrowseItemSummary } from "./ebay-browse";
import { classifySellerListing } from "./seller-opportunity-domain";
import { MONITORED_SELLERS } from "./seller-registry";

export type SellerInventoryHealth = {
  observedAt: string; horizonDays: number; sellerWideStatus: "Unavailable / Not Comparable";
  monitoredApiIndicator: number; monitoredRetrieved: number; monitoredUnique: number; duplicateCount: number;
  outsideWindowCount: number; scopeMismatchCount: number; horizonTotal: number; singleCount: number; lotCount: number;
  classificationReconciles: boolean; bucketReconciles: boolean; stablePasses: boolean; discrepancy: string | null;
  days: Array<{ date: string; total: number; singles: number; lots: number }>;
};

let cache: { key: string; expires: number; value: Promise<SellerInventoryHealth> } | null = null;
const ctDate = (value: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).format(value);
function offset(date: string) { const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", timeZoneName: "longOffset" }).formatToParts(new Date(`${date}T12:00:00Z`)); const match = String(parts.find(part => part.type === "timeZoneName")?.value).match(/GMT([+-])(\d{2}):(\d{2})/); if (!match) throw new Error("Central Time offset unavailable"); return (Number(match[2]) * 60 + Number(match[3])) * (match[1] === "+" ? 1 : -1); }
function midnight(date: string) { const value = new Date(`${date}T00:00:00Z`); value.setUTCMinutes(value.getUTCMinutes() - offset(date)); return value; }
function addDays(date: string, days: number) { const value = new Date(`${date}T12:00:00Z`); value.setUTCDate(value.getUTCDate() + days); return ctDate(value); }
const identity = (item: Pick<EbayBrowseItemSummary, "itemId" | "legacyItemId">) => String(item.legacyItemId ?? item.itemId.split("|")[1] ?? item.itemId);
const signature = (items: EbayBrowseItemSummary[]) => Array.from(new Set(items.map(identity))).sort().join("|");

export async function loadSellerInventoryHealth(horizonDays = 7, now = new Date()): Promise<SellerInventoryHealth> {
  const days = Math.max(1, Math.min(14, Math.trunc(horizonDays) || 7)), startDate = ctDate(now), key = `${startDate}:${days}`;
  if (cache?.key === key && cache.expires > Date.now()) return cache.value;
  const value = (async () => {
    const seller = MONITORED_SELLERS[0], token = await getEbayApplicationAccessToken(), endDate = addDays(startDate, days), end = midnight(endDate), start = midnight(startDate);
    let monitored = await enumerateSellerAuctionsEndingBefore(token, seller.ebayUserId, seller.browseCategoryIds, end), stablePasses = false;
    for (let attempt = 0; attempt < 3; attempt += 1) { const check = await enumerateSellerAuctionsEndingBefore(token, seller.ebayUserId, seller.browseCategoryIds, end); if (signature(check.items) === signature(monitored.items)) { monitored = check; stablePasses = true; break; } monitored = check; }
    if (!stablePasses) throw new Error("Seller health horizon did not stabilize across repeated complete passes");
    const outsideWindowCount = monitored.items.filter(item => { const time = new Date(String(item.itemEndDate)).getTime(); return time < start.getTime() || time >= end.getTime(); }).length;
    const scopeMismatchCount = monitored.items.filter(item => item.seller?.username?.toLowerCase() !== seller.ebayUserId.toLowerCase() || !item.buyingOptions?.includes("AUCTION") || !item.categories?.some(category => category.categoryId === "212")).length;
    const within = monitored.items.filter(item => { const time = new Date(String(item.itemEndDate)).getTime(); return time >= start.getTime() && time < end.getTime(); }), ids = within.map(identity), uniqueItems = Array.from(new Map(within.map(item => [identity(item), item])).values());
    const grouped = new Map<string, { total: number; singles: number; lots: number }>(); for (let index = 0; index < days; index += 1) grouped.set(addDays(startDate, index), { total: 0, singles: 0, lots: 0 });
    let singleCount = 0, lotCount = 0;
    for (const item of uniqueItems) { const day = ctDate(new Date(String(item.itemEndDate))), entry = grouped.get(day); if (!entry) continue; entry.total += 1; if (classifySellerListing(item.title).kind === "single") { entry.singles += 1; singleCount += 1; } else { entry.lots += 1; lotCount += 1; } }
    const horizonTotal = uniqueItems.length, daily = Array.from(grouped).map(([date, counts]) => ({ date, ...counts })), bucketReconciles = daily.reduce((sum, day) => sum + day.total, 0) === horizonTotal, classificationReconciles = singleCount + lotCount === horizonTotal, duplicateCount = within.length - new Set(ids).size, issues: string[] = [];
    if (duplicateCount) issues.push(`${duplicateCount} duplicate IDs were returned`); if (outsideWindowCount) issues.push(`${outsideWindowCount} records fell outside the CT horizon`); if (scopeMismatchCount) issues.push(`${scopeMismatchCount} records failed seller/category/auction scope validation`); if (!bucketReconciles) issues.push("daily buckets do not reconcile"); if (!classificationReconciles) issues.push("Singles and Lots do not reconcile");
    return { observedAt: new Date().toISOString(), horizonDays: days, sellerWideStatus: "Unavailable / Not Comparable" as const, monitoredApiIndicator: monitored.reportedTotal, monitoredRetrieved: within.length, monitoredUnique: new Set(ids).size, duplicateCount, outsideWindowCount, scopeMismatchCount, horizonTotal, singleCount, lotCount, classificationReconciles, bucketReconciles, stablePasses, discrepancy: issues.length ? issues.join("; ") : null, days: daily };
  })();
  cache = { key, expires: Date.now() + 5 * 60 * 1000, value }; try { return await value; } catch (error) { cache = null; throw error; }
}
