import type { CardCatalog } from "./card-knowledge.ts";
import { matchChecklistTitle, productHint } from "./card-market-review.ts";

export type MarketIndexEntry = {
  itemId: string; observationKey: string; title: string; productHint: string;
  proposedChecklistEntryId: string | null; flags: string[]; sourceRefs: string[];
  verifiedTransactionPrice: null; pricingEligible: false;
};
export function addMarketIndexObservation(index: Map<string, MarketIndexEntry>, observation: {
  itemId: string; title: string; flags: string[]; sourceRef: string;
}, catalog: CardCatalog) {
  if (!/^\d+$/.test(observation.itemId) || !observation.title.trim()) throw Error("Invalid listing identity");
  const previous = index.get(observation.itemId);
  const match = matchChecklistTitle(observation.title, catalog);
  const flags = new Set([...(previous?.flags ?? []), ...observation.flags, "sale_status_not_verified", "price_not_independently_verified"]);
  const titleConflict = !!previous && previous.title !== observation.title;
  if (titleConflict) flags.add("source_title_conflict");
  const entry: MarketIndexEntry = {
    itemId: observation.itemId, observationKey: `ebay:${observation.itemId}`,
    title: previous?.title ?? observation.title,
    productHint: titleConflict || previous?.productHint === "Conflicting source titles" ? "Conflicting source titles" : productHint(observation.title),
    proposedChecklistEntryId: flags.has("source_title_conflict") ? null : match.entryId,
    flags: Array.from(flags).sort(), sourceRefs: Array.from(new Set([...(previous?.sourceRefs ?? []), observation.sourceRef])).sort(),
    verifiedTransactionPrice: null, pricingEligible: false,
  };
  index.set(observation.itemId, entry);
  return !previous;
}
export function summarizeMarketIndex(index: Map<string, MarketIndexEntry>) {
  const rows = Array.from(index.values()), products: Record<string, number> = {}, flags: Record<string, number> = {};
  for (const row of rows) {
    products[row.productHint] = (products[row.productHint] ?? 0) + 1;
    for (const flag of row.flags) flags[flag] = (flags[flag] ?? 0) + 1;
  }
  return { uniqueListings: rows.length, titleMatches: rows.filter(r=>r.proposedChecklistEntryId).length,
    uncertainPrices: rows.length, products, flags, verifiedComps: 0, databaseImported: false };
}
