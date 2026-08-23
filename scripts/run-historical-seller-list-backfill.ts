import { prisma } from "../lib/prisma.ts";
import { getSellerList, getValidAccessToken } from "../lib/ebay.ts";
import { importItems } from "../lib/ebay-sync-service.ts";
import { reconcileUnlinkedOrderLines } from "../lib/reconciliation.ts";

const rawUrl = process.env.DATABASE_URL;
let target: URL | null = null;
try { target = rawUrl ? new URL(rawUrl) : null; } catch { target = null; }
if (process.env.LEGENDS_SELLER_LIST_BACKFILL !== "approved" || !target || target.hostname !== "db.prisma.io") throw new Error("Refusing seller-list backfill: production target or approval marker is missing");

const SLICE_MS = 7 * 24 * 60 * 60 * 1000;
async function main() {
  const lines = await prisma.ebayOrderLine.findMany({ where: { listingId: null, ebayItemId: { not: null } }, select: { storeId: true, ebayItemId: true, order: { select: { creationDate: true } } } });
  const byStore = new Map<string, typeof lines>();
  for (const line of lines) { const rows = byStore.get(line.storeId) ?? []; rows.push(line); byStore.set(line.storeId, rows); }
  let received = 0, exactRecovered = 0;
  for (const [storeId, rows] of Array.from(byStore.entries())) {
    const store = await prisma.store.findUnique({ where: { id: storeId } }); if (!store?.oauthAccessToken || store.connectionStatus !== "connected") continue;
    const targets = new Set(rows.map((row) => row.ebayItemId).filter((id): id is string => Boolean(id)));
    const now = new Date(); const earliestOrder = Math.min(...rows.map((row) => row.order.creationDate.getTime()));
    let start = new Date(Math.max(now.getTime() - 90 * 24 * 60 * 60 * 1000, earliestOrder - 24 * 60 * 60 * 1000));
    const { accessToken } = await getValidAccessToken(store);
    while (start < now) {
      const end = new Date(Math.min(now.getTime(), start.getTime() + SLICE_MS));
      for await (const page of getSellerList(accessToken, 0, { endFrom: start, endTo: end })) {
        received += page.length; const matches = page.filter((item) => targets.has(String(item.ItemID))); if (!matches.length) continue;
        await importItems({ storeId, items: matches, source: "historical-get-seller-list", status: "ended", observedAt: new Date() });
        for (const item of matches) {
          const ebayItemId = String(item.ItemID); const listing = await prisma.listing.findUniqueOrThrow({ where: { storeId_ebayItemId: { storeId, ebayItemId } }, select: { id: true } });
          await prisma.$transaction([
            prisma.listing.update({ where: { id: listing.id }, data: { authoritativeSource: "ebay-trading-get-seller-list", authoritativeObservedAt: new Date() } }),
            prisma.historicalListingRecovery.updateMany({ where: { storeId, ebayItemId }, data: { status: "recovered", recoveredListingId: listing.id, errorCode: null, errorMessage: null } }),
          ]);
          targets.delete(ebayItemId); exactRecovered += 1;
        }
      }
      start = new Date(end.getTime() + 1);
    }
  }
  const reconciliation = await reconcileUnlinkedOrderLines();
  console.log(JSON.stringify({ providerListingsScanned: received, exactHistoricalListingsRecovered: exactRecovered, reconciliation }, null, 2));
}

main().finally(() => prisma.$disconnect());
