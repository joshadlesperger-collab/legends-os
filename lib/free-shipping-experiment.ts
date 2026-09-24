import { ebayGetJson } from "./ebay-readonly.ts";
import type { EbayListingItem } from "./ebay.ts";

export const FREE_SHIPPING_PHASE1_VERSION = "free-shipping-phase1-2026-09-24-v1";

export const FREE_SHIPPING_PHASE1_ITEM_IDS = [
"128018386484","128018372339","128018386389","128018372363","128018372357","128018372365","128018372380","128018372375","128018372385","128018386436","128018372392","128018377418","128018386526","128018377253","128018377254","128018390317","128018377258","128018377264","128018377342","128018377277","128018390436","128018377366","128018390311","128018386475","128018386514","128018386364","128018377326","128018386407","128018377343","128018390393","128018377356","128018386456","128018386332","128018377396","128018377397","128018386454","128018390335","128018377425","128018377438","128018390334","128018386369","128018390326","128018386357","128018386485","128018386376","128018386380","128018386383","128018386385","128018386493","128018386489","128018386391","128018386396","128018386398","128018386399","128018386408","128018386428","128018386449","128018386471","128018386460","128018386515","128018386487","128018386492","128018390280","128018390290","128018390309","128018386524","128018390390","128018386528","128018390308","128018390471","128018390333","128018390373","128018390354","128018390419","128018390386"
] as const;

type MoneyLike = number | string | { "#text"?: number | string; value?: number | string } | null | undefined;

function money(value: MoneyLike): number | null {
  const raw = typeof value === "object" && value !== null ? (value["#text"] ?? value.value) : value;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

export function providerPrice(item: EbayListingItem): number | null {
  return money(item.SellingStatus?.CurrentPrice as MoneyLike);
}

export function providerShippingCharge(item: EbayListingItem): number | null {
  const details = item.ShippingDetails as Record<string, unknown> | undefined;
  const rawOptions = details?.ShippingServiceOptions;
  const options = Array.isArray(rawOptions) ? rawOptions : rawOptions ? [rawOptions] : [];
  for (const raw of options) {
    const option = raw as Record<string, unknown>;
    const cost = money(option.ShippingServiceCost as MoneyLike);
    if (cost !== null) return cost;
  }
  return null;
}

export function providerShippingProfileId(item: EbayListingItem): string | null {
  const sellerProfiles = item.SellerProfiles as Record<string, unknown> | undefined;
  const shippingProfile = sellerProfiles?.SellerShippingProfile as Record<string, unknown> | undefined;
  const value = shippingProfile?.ShippingProfileID;
  return value == null ? null : String(value);
}

export function providerIsActive(item: EbayListingItem): boolean {
  return String(item.SellingStatus?.ListingStatus ?? "").toLowerCase() === "active";
}

export function cents(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function proposedFreeShippingPrice(price: number, shipping: number): number {
  return cents(price + shipping);
}

export function deliveredPricePreserved(price: number, shipping: number, proposedPrice: number): boolean {
  return Math.abs(cents(price + shipping) - cents(proposedPrice)) < 0.005;
}

export type FulfillmentPolicy = {
  fulfillmentPolicyId?: string;
  name?: string;
  handlingTime?: { value?: number; unit?: string };
  shippingOptions?: Array<{
    optionType?: string;
    costType?: string;
    shippingServices?: Array<{ shippingCost?: { value?: string }; freeShipping?: boolean }>;
  }>;
};

export async function getFulfillmentPolicies(accessToken: string, fetcher?: typeof fetch) {
  const data = await ebayGetJson<{ fulfillmentPolicies?: FulfillmentPolicy[] }>(
    "account-fulfillment-policies",
    "/sell/account/v1/fulfillment_policy?marketplace_id=EBAY_US",
    accessToken,
    fetcher
  );
  return data.fulfillmentPolicies ?? [];
}

export function freeShippingPolicies(policies: FulfillmentPolicy[]) {
  return policies.filter(policy =>
    (policy.shippingOptions ?? []).some(option =>
      (option.shippingServices ?? []).some(service =>
        service.freeShipping === true || Number(service.shippingCost?.value) === 0
      )
    )
  );
}

export type FreeShippingDryRunRow = {
  itemId: string;
  title: string | null;
  currentPrice: number | null;
  currentShipping: number | null;
  proposedPrice: number | null;
  currentDelivered: number | null;
  proposedDelivered: number | null;
  shippingProfileId: string | null;
  adRate: number | null;
  ready: boolean;
  blockers: string[];
};

export function evaluateFreeShippingCandidate(input: {
  itemId: string;
  item: EbayListingItem;
  persistedTitle?: string | null;
  persistedPrice?: number | null;
  adRate?: number | null;
}): FreeShippingDryRunRow {
  const blockers: string[] = [];
  const currentPrice = providerPrice(input.item);
  const currentShipping = providerShippingCharge(input.item);
  const title = input.item.Title ?? null;

  if (!providerIsActive(input.item)) blockers.push("Live listing is not active");
  if (input.persistedTitle && title !== input.persistedTitle) blockers.push("Live title differs from persisted title");
  if (input.persistedPrice != null && currentPrice != null && Math.abs(currentPrice - input.persistedPrice) > 0.005) blockers.push("Live price differs from persisted price");
  if (currentPrice == null || currentPrice <= 0) blockers.push("Live price is unavailable");
  if (currentShipping == null) blockers.push("Live shipping charge is unavailable");
  else if (![1.49, 1.95].some(value => Math.abs(currentShipping - value) < 0.005)) blockers.push("Live shipping charge is outside the approved Phase 1 cohort");
  if (input.adRate == null) blockers.push("Current promoted-listing ad rate is unavailable");
  else if (Math.abs(input.adRate - 5) > 0.001) blockers.push("Current promoted-listing ad rate is not 5.0%");

  const proposedPrice = currentPrice != null && currentShipping != null ? proposedFreeShippingPrice(currentPrice, currentShipping) : null;
  if (currentPrice != null && currentShipping != null && proposedPrice != null && !deliveredPricePreserved(currentPrice, currentShipping, proposedPrice)) blockers.push("Delivered-price preservation check failed");

  return {
    itemId: input.itemId,
    title,
    currentPrice,
    currentShipping,
    proposedPrice,
    currentDelivered: currentPrice != null && currentShipping != null ? cents(currentPrice + currentShipping) : null,
    proposedDelivered: proposedPrice,
    shippingProfileId: providerShippingProfileId(input.item),
    adRate: input.adRate ?? null,
    ready: blockers.length === 0,
    blockers,
  };
}
