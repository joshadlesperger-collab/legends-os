import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { prisma } from "../lib/prisma.ts";
import { getSellerList, getValidAccessToken, type EbayListingItem } from "../lib/ebay.ts";

const START = new Date("2026-10-17T05:00:00.000Z");
const END = new Date("2026-10-19T05:00:00.000Z");

const money = (value: unknown): number | null => {
  const raw = value && typeof value === "object"
    ? ((value as Record<string, unknown>)["#text"] ?? (value as Record<string, unknown>).value)
    : value;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
};

const shipping = (item: EbayListingItem): number | null => {
  const details = item.ShippingDetails as Record<string, unknown> | undefined;
  const raw = details?.ShippingServiceOptions;
  const options = Array.isArray(raw) ? raw : raw ? [raw] : [];
  for (const option of options as Array<Record<string, unknown>>) {
    const amount = money(option.ShippingServiceCost);
    if (amount != null) return amount;
  }
  return null;
};

async function main() {
  const store = await prisma.store.findFirstOrThrow({
    where: { isActive: true, connectionStatus: "connected", ebaySellerUsername: "imaydit58" },
  });
  const { accessToken } = await getValidAccessToken(store);
  const rows: Array<Record<string, unknown>> = [];
  let fetched = 0;

  for await (const page of getSellerList(accessToken, 0, { startFrom: START, startTo: END })) {
    fetched += page.length;
    for (const item of page) {
      if (String(item.SellingStatus?.ListingStatus ?? "").toLowerCase() !== "active") continue;
      rows.push({
        itemId: String(item.ItemID),
        title: item.Title,
        sku: item.SKU ?? null,
        startTime: item.ListingDetails?.StartTime ?? null,
        price: money(item.SellingStatus?.CurrentPrice),
        shipping: shipping(item),
        quantity: Number(item.QuantityAvailable ?? item.Quantity),
        viewItemUrl: item.ListingDetails?.ViewItemURL ?? null,
      });
    }
  }

  rows.sort((a, b) => String(a.startTime).localeCompare(String(b.startTime)) || String(a.itemId).localeCompare(String(b.itemId)));
  const receipt = {
    observedAt: new Date().toISOString(),
    localWindow: "2026-10-17 00:00 through 2026-10-18 23:59:59 America/Chicago",
    utcWindow: { startInclusive: START.toISOString(), endExclusive: END.toISOString() },
    fetched,
    active: rows.length,
    rows,
  };
  const directory = resolve("artifacts", "weekend-reprice-20261020");
  mkdirSync(directory, { recursive: true });
  const output = resolve(directory, "provider-weekend-live-snapshot.json");
  writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify({ output, fetched, active: rows.length }, null, 2));
}

main().finally(() => prisma.$disconnect()).catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
