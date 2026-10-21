import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { prisma } from "../lib/prisma.ts";
import { callTradingApi, getItem, getValidAccessToken, reviseFixedPrice, type EbayListingItem } from "../lib/ebay.ts";

const EXECUTE_FLAG = "--execute-approved-weekend-evidence-reprice";
const DOCTRINE_VERSION = "weekend-item-only-math-2026-10-20-v1";
const FREE_SHIPPING_POLICY_ID = "248164605010";

type Candidate = {
  itemId: string;
  expectedPrice: number;
  expectedShipping: number;
  price: number;
  shipping: number;
};

const CANDIDATES: Candidate[] = [
  { itemId: "128141754982", expectedPrice: 5.95, expectedShipping: 1.49, price: 2.98, shipping: 0 },
  { itemId: "128141754983", expectedPrice: 6.49, expectedShipping: 1.49, price: 4.49, shipping: 1.49 },
  { itemId: "128141754985", expectedPrice: 6.49, expectedShipping: 1.49, price: 2.98, shipping: 0 },
  { itemId: "128141754988", expectedPrice: 9.49, expectedShipping: 1.49, price: 4.44, shipping: 0 },
  { itemId: "128141754990", expectedPrice: 3.95, expectedShipping: 1.49, price: 2.44, shipping: 0 },
];

const money = (value: unknown): number => {
  const raw = value && typeof value === "object"
    ? ((value as Record<string, unknown>)["#text"] ?? (value as Record<string, unknown>).value)
    : value;
  return Number(raw);
};

const price = (item: EbayListingItem) => money(item.SellingStatus?.CurrentPrice);
const shipping = (item: EbayListingItem): number | null => {
  const details = item.ShippingDetails as Record<string, unknown> | undefined;
  const raw = details?.ShippingServiceOptions;
  const options = Array.isArray(raw) ? raw : raw ? [raw] : [];
  for (const option of options as Array<Record<string, unknown>>) {
    const amount = money(option.ShippingServiceCost);
    if (Number.isFinite(amount)) return amount;
  }
  return null;
};

const stableWithoutPriceAndShipping = (item: EbayListingItem) => JSON.stringify({
  itemId: String(item.ItemID),
  title: item.Title,
  description: item.Description ?? null,
  quantity: item.Quantity,
  quantityAvailable: item.QuantityAvailable,
  quantitySold: item.SellingStatus?.QuantitySold ?? null,
  listingStatus: item.SellingStatus?.ListingStatus ?? null,
  listingType: item.ListingType ?? null,
  condition: item.ConditionDisplayName ?? null,
  category: item.PrimaryCategory ?? null,
  pictures: item.PictureDetails?.PictureURL ?? null,
  itemSpecifics: item.ItemSpecifics ?? null,
});

const stableWithoutPrice = (item: EbayListingItem) => JSON.stringify({
  stable: stableWithoutPriceAndShipping(item),
  sellerProfiles: item.SellerProfiles ?? null,
  shippingDetails: item.ShippingDetails ?? null,
});

async function revisePriceAndFreeShipping(accessToken: string, candidate: Candidate) {
  const messageId = `${DOCTRINE_VERSION}:${candidate.itemId}:${candidate.price.toFixed(2)}:free`;
  const xml = `<ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><MessageID>${messageId}</MessageID><Item><ItemID>${candidate.itemId}</ItemID><StartPrice>${candidate.price.toFixed(2)}</StartPrice><SellerProfiles><SellerShippingProfile><ShippingProfileID>${FREE_SHIPPING_POLICY_ID}</ShippingProfileID></SellerShippingProfile></SellerProfiles></Item></ReviseFixedPriceItemRequest>`;
  await callTradingApi({ callName: "ReviseFixedPriceItem", siteId: 0, accessToken, xmlBody: xml, retryMode: "single-attempt" });
}

async function main() {
  const execute = process.argv.includes(EXECUTE_FLAG);
  const store = await prisma.store.findFirstOrThrow({
    where: { isActive: true, connectionStatus: "connected", ebaySellerUsername: "imaydit58" },
  });
  const { accessToken } = await getValidAccessToken(store);
  const results: Array<Record<string, unknown>> = [];

  for (const candidate of CANDIDATES) {
    try {
      const before = await getItem(accessToken, candidate.itemId);
      const beforePrice = price(before);
      const beforeShipping = shipping(before);
      if (String(before.SellingStatus?.ListingStatus ?? "").toLowerCase() !== "active") throw new Error("Provider listing is not active");
      if (!/prizm black/i.test(before.Title)) throw new Error("Provider title is outside the approved evidence-backed scope");
      if (Math.abs(beforePrice - candidate.expectedPrice) > 0.005) throw new Error(`Provider price changed: ${beforePrice}`);
      if (beforeShipping == null || Math.abs(beforeShipping - candidate.expectedShipping) > 0.005) throw new Error(`Provider shipping changed: ${beforeShipping}`);
      const changeShipping = Math.abs(beforeShipping - candidate.shipping) > 0.005;

      if (!execute) {
        results.push({ itemId: candidate.itemId, status: "ready", title: before.Title, beforePrice, beforeShipping, afterPrice: candidate.price, afterShipping: candidate.shipping, changeShipping });
        continue;
      }

      if (changeShipping) await revisePriceAndFreeShipping(accessToken, candidate);
      else await reviseFixedPrice(accessToken, candidate.itemId, candidate.price, `${DOCTRINE_VERSION}:${candidate.itemId}:${candidate.price.toFixed(2)}`);

      const after = await getItem(accessToken, candidate.itemId);
      const afterPrice = price(after);
      const afterShipping = shipping(after);
      if (Math.abs(afterPrice - candidate.price) > 0.005) throw new Error(`Provider price readback failed: ${afterPrice}`);
      if (afterShipping == null || Math.abs(afterShipping - candidate.shipping) > 0.005) throw new Error(`Provider shipping readback failed: ${afterShipping}`);
      const unrelatedUnchanged = changeShipping
        ? stableWithoutPriceAndShipping(before) === stableWithoutPriceAndShipping(after)
        : stableWithoutPrice(before) === stableWithoutPrice(after);
      if (!unrelatedUnchanged) throw new Error("Provider changed unrelated listing state");
      results.push({ itemId: candidate.itemId, status: "verified", title: after.Title, beforePrice, beforeShipping, afterPrice, afterShipping, unrelatedStateUnchanged: true });
    } catch (error) {
      results.push({ itemId: candidate.itemId, status: "failed", error: error instanceof Error ? error.message : String(error) });
    }
  }

  const receipt = {
    mode: execute ? "execute" : "preflight",
    observedAt: new Date().toISOString(),
    selected: CANDIDATES.length,
    ready: results.filter(row => row.status === "ready").length,
    verified: results.filter(row => row.status === "verified").length,
    failed: results.filter(row => row.status === "failed").length,
    results,
  };
  const directory = resolve("artifacts", "weekend-reprice-20261020");
  mkdirSync(directory, { recursive: true });
  const output = resolve(directory, `${receipt.mode}-receipt.json`);
  writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify({ output, ...receipt }, null, 2));
}

main().finally(() => prisma.$disconnect()).catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
