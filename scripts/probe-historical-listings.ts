import { prisma } from "../lib/prisma.ts";
import { EbayApiError, getItem, getValidAccessToken } from "../lib/ebay.ts";

const rawUrl = process.env.DATABASE_URL;
let target: URL | null = null;
try { target = rawUrl ? new URL(rawUrl) : null; } catch { target = null; }
if (process.env.LEGENDS_HISTORICAL_PROBE !== "approved" || !target || target.hostname !== "db.prisma.io") {
  throw new Error("Refusing historical probe: production target or approval marker is missing");
}

async function main() {
  const lines = await prisma.ebayOrderLine.findMany({
    where: { listingId: null, ebayItemId: { not: null }, store: { oauthAccessToken: { not: null }, connectionStatus: "connected" } },
    distinct: ["storeId", "ebayItemId"], take: 20, orderBy: [{ storeId: "asc" }, { ebayItemId: "asc" }],
    select: { storeId: true, ebayItemId: true },
  });
  const stores = await prisma.store.findMany({ where: { id: { in: Array.from(new Set(lines.map((line) => line.storeId))) } } });
  const byStore = new Map(stores.map((store) => [store.id, store]));
  const outcomes = new Map<string, number>();
  let recovered = 0;
  let exactIdentities = 0;
  for (const line of lines) {
    const store = byStore.get(line.storeId);
    if (!store || !line.ebayItemId) continue;
    try {
      const { accessToken } = await getValidAccessToken(store);
      const item = await getItem(accessToken, line.ebayItemId);
      recovered += 1;
      if (String(item.ItemID) === line.ebayItemId) exactIdentities += 1;
    } catch (error) {
      const key = error instanceof EbayApiError ? `${error.callName}:${error.code ?? "unknown"}` : error instanceof Error ? error.message.slice(0, 160) : "unknown";
      outcomes.set(key, (outcomes.get(key) ?? 0) + 1);
    }
  }
  console.log(JSON.stringify({ attempted: lines.length, recovered, exactIdentities, failures: Object.fromEntries(outcomes) }, null, 2));
}

main().finally(() => prisma.$disconnect());
