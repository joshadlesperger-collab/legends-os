import { z } from "zod";
import type { CardCatalog } from "./card-knowledge.ts";
import { matchChecklistTitle, productHint } from "./card-market-review.ts";

const saleSchema = z.object({
  item_id: z.string().regex(/^\d+$/), title: z.string(),
  price: z.number().finite().nonnegative().nullable().optional(),
  last_sold: z.string().nullable().optional(), url: z.string().optional(),
  shipping_cost: z.number().finite().nonnegative().nullable().optional(),
  units_sold: z.number().int().positive().nullable().optional(),
  best_offer: z.boolean().nullable().optional(), format: z.string().optional(),
  card: z.object({ flags: z.array(z.string()).optional(), graded: z.boolean().nullable().optional(),
    grader: z.string().nullable().optional(), grade: z.string().nullable().optional() }).passthrough().nullable().optional(),
});
const responseSchema = z.object({ ok: z.literal(true), items: z.array(z.unknown()).max(300) });

export function reviewCompsApiPilot(input: unknown, catalog: CardCatalog, existingIds: Set<string>, priorApiIds = new Set<string>()) {
  const response = responseSchema.parse(input);
  const seen = new Set<string>();
  let malformedRows = 0, duplicates = 0;
  const rows = [];
  for (const value of response.items) {
    const parsed = saleSchema.safeParse(value);
    if (!parsed.success) { malformedRows++; continue; }
    const item = parsed.data;
    if (seen.has(item.item_id)) { duplicates++; continue; }
    seen.add(item.item_id);
    const match = matchChecklistTitle(item.title, catalog);
    const canonicalUrl = `https://www.ebay.com/itm/${item.item_id}`;
    const flags = ["provider_reported_price_unverified", "condition_not_verified", "parallel_not_verified", "own_purchase_not_checked"];
    for (const flag of item.card?.flags ?? []) flags.push(`provider_${flag}`);
    if (item.card?.graded) flags.push("graded_card");
    if (/\b(?:sealed packs?|mega box|hobby box|blaster|booster)\b/i.test(item.title)) flags.push("sealed_product");
    if (item.units_sold !== 1) flags.push(item.units_sold ? "multi_unit_average" : "unit_count_unknown");
    if (item.best_offer === true) flags.push("provider_reported_accepted_offer_unverified");
    if (item.best_offer == null) flags.push("offer_status_unknown");
    if (item.price == null) flags.push("price_missing");
    if (item.shipping_cost == null) flags.push("shipping_unknown");
    if (!item.last_sold || Number.isNaN(Date.parse(item.last_sold))) flags.push("sale_date_missing_or_invalid");
    if (item.url !== canonicalUrl) flags.push("source_url_missing_or_noncanonical");
    if (!item.title.trim()) flags.push("title_missing");
    rows.push({ ...item, provider: "compsapi", marketplace: "ebay", observationKey: `ebay:${item.item_id}`,
      canonicalUrl, productHint: productHint(item.title), proposedChecklistEntryId: match.entryId,
      checklistMatchStatus: match.status, priceBasis: "provider_reported_average_per_unit_usd",
      overlapsSavedHtml: existingIds.has(item.item_id), overlapsPriorApi: priorApiIds.has(item.item_id),
      overlapsExisting: existingIds.has(item.item_id) || priorApiIds.has(item.item_id), flags, verifiedTransactionPrice: null, pricingEligible: false });
  }
  const products: Record<string, number> = {};
  for (const row of rows) products[row.productHint] = (products[row.productHint] ?? 0) + 1;
  return { summary: { returnedRows: response.items.length, uniqueListings: rows.length, malformedRows, duplicates,
    overlapsSavedHtml: rows.filter(r => r.overlapsSavedHtml).length,
    overlapsPriorApi: rows.filter(r => r.overlapsPriorApi).length,
    overlapsExisting: rows.filter(r => r.overlapsExisting).length,
    newListings: rows.filter(r => !r.overlapsExisting).length,
    titleMatches: rows.filter(r => r.proposedChecklistEntryId).length,
    providerReportedOffers: rows.filter(r => r.best_offer === true).length,
    aggregateOrUnknownUnitCounts: rows.filter(r => r.units_sold !== 1).length,
    uncertainPrices: rows.length, products, databaseImported: false, verifiedComps: 0 }, rows };
}
