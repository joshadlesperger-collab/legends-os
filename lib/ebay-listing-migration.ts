import { EbayApiError, type EbayAddFixedPriceItemResult, type EbayListingItem } from "./ebay.ts";

export type MigrationCreateProvider = {
  createOnce(): Promise<EbayAddFixedPriceItemResult>;
  getByItemId(itemId: string): Promise<EbayListingItem>;
  findActiveBySku(sku: string): Promise<EbayListingItem[]>;
};

export type MigrationCreateResolution = {
  item: EbayListingItem;
  itemId: string;
  resolution: "provider-item-id" | "destination-sku";
  providerResult: EbayAddFixedPriceItemResult | null;
  providerError: string | null;
};

function active(item: EbayListingItem) {
  return String(item.SellingStatus?.ListingStatus ?? "").toLowerCase() === "active";
}

function matchingSku(item: EbayListingItem, sku: string) {
  return String(item.SKU ?? "").trim() === sku;
}

async function reconcileUniqueSku(provider: MigrationCreateProvider, sku: string) {
  const matches = (await provider.findActiveBySku(sku)).filter(item => active(item) && matchingSku(item, sku));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new EbayApiError("AddFixedPriceItem", `Duplicate-risk condition: ${matches.length} active destination listings use migration SKU ${sku}`, "DUPLICATE_RISK");
  }
  throw new EbayApiError("AddFixedPriceItem", `Creation outcome is recoverable but unresolved: no active destination listing uses migration SKU ${sku}; operator review is required before any retry`, "RECOVERABLE_INDETERMINATE_CREATE");
}

export async function createListingOnceWithMandatorySkuRecovery(provider: MigrationCreateProvider, sku: string): Promise<MigrationCreateResolution> {
  if (!/^MIG-\d+$/.test(sku)) throw new EbayApiError("AddFixedPriceItem", "Invalid unique migration SKU", "INVALID_INPUT");
  let providerResult: EbayAddFixedPriceItemResult | null = null;
  let providerError: string | null = null;
  try {
    providerResult = await provider.createOnce();
  } catch (error) {
    providerError = error instanceof Error ? error.message : String(error);
  }

  if (providerResult?.itemId) {
    try {
      const exact = await provider.getByItemId(providerResult.itemId);
      if (active(exact) && matchingSku(exact, sku)) {
        return { item: exact, itemId: providerResult.itemId, resolution: "provider-item-id", providerResult, providerError };
      }
      providerError = `Provider ItemID ${providerResult.itemId} did not reconcile as the active listing for SKU ${sku}`;
    } catch (error) {
      providerError = error instanceof Error ? error.message : String(error);
    }
  }

  const recovered = await reconcileUniqueSku(provider, sku);
  return { item: recovered, itemId: String(recovered.ItemID), resolution: "destination-sku", providerResult, providerError };
}
