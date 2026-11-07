import { z } from "zod";
import type { CardCatalog } from "./card-knowledge.ts";

export const marketBatchSchema = z.object({
  version: z.literal(1), sourceUrl: z.string().url(), observedAt: z.string().datetime(),
  reviewStartedAt: z.string().datetime(), databaseImported: z.literal(false),
  rows: z.array(z.object({ n: z.number().int().positive(), title: z.string(), text: z.string(),
    flags: z.array(z.string()), auction: z.boolean(), rowId: z.string().regex(/^item[a-f0-9]+$/), price: z.string().optional(),
    sourceUrl: z.string().regex(/^https:\/\/www\.ebay\.com\/itm\/\d+$/).optional(), listingCheck: z.string().optional() })).max(240),
});
const normalize = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
/** Title-based routing is a proposal, never proof of a release or physical variant. */
export function productHint(title: string) {
  if (/2024[-/]?(?:2025|25)/i.test(title)) return "Other season";
  if (/Nico Collins|Texans/i.test(title)) return "Other sport";
  if (/\b(?:202[0-46-9]|201\d)\b/.test(title.replace(/2025[-/]2026/g, "2025"))) return "Other season";
  if (!/\b2025(?:[-/]26)?\b/.test(title)) return "Season unresolved";
  if (/\bBowman\b/i.test(title)) return "Bowman — release unverified";
  if (!/\bTopps\b/i.test(title) || !/\bChrome\b/i.test(title)) return "Product unresolved";
  if (/McDonald/i.test(title)) return "McDonald's All-American";
  if (/Cactus Jack/i.test(title)) return "Cactus Jack";
  if (/Sapphire/i.test(title)) return /Update/i.test(title) ? "Chrome Update Sapphire" : "Sapphire — release unverified";
  if (/Cosmic/i.test(title)) return "Chrome Cosmic";
  if (/Chrome Black/i.test(title)) return "Chrome Black";
  if (/Update/i.test(title)) return "Chrome Update";
  return "Chrome — release unverified";
}
/** Matches the described checklist identity only, independently of price/condition verification. */
export function matchChecklistTitle(title: string, catalog: CardCatalog) {
  if (productHint(title) !== "Chrome — release unverified") return { status: "outside_current_catalog", entryId: null, candidates: [] };
  const normalized = ` ${normalize(title)} `;
  const numbers = Array.from(title.matchAll(/#\s*([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)/g)).map(m => m[1].toUpperCase());
  let candidates = catalog.cards.filter(c => numbers.includes(c.cardNumber.toUpperCase()) && normalized.includes(` ${normalize(c.player)} `));
  const variation = /\b(?:image variation|photo variation|variation|variations)\b/i.test(title);
  if (variation) candidates = candidates.filter(c => c.section === "BASE CARD VARIATIONS");
  else candidates = candidates.filter(c => c.section !== "BASE CARD VARIATIONS");
  // Multiple named players or a mismatching insert label must not become a base-card match.
  const sections = Array.from(new Set(catalog.cards.map(c => c.section))).filter(s => !/^BASE/.test(s) && normalized.includes(` ${normalize(s)} `));
  if (sections.length) candidates = candidates.filter(c => sections.includes(c.section));
  const players = Array.from(new Set(catalog.cards.filter(c => normalized.includes(` ${normalize(c.player)} `)).map(c => c.player)));
  if (players.length !== 1 || /\blot\b|\+ base|you pick|pick your/i.test(title)) return { status: "ambiguous", entryId: null, candidates };
  return { status: candidates.length === 1 ? "title_matched" : candidates.length ? "ambiguous" : "unresolved", entryId: candidates.length === 1 ? candidates[0].id : null, candidates };
}
export function reviewMarketBatch(input: unknown, catalog: CardCatalog) {
  const batch = marketBatchSchema.parse(input);
  const counts = new Map<string, number>();
  batch.rows.forEach(r => counts.set(r.rowId, (counts.get(r.rowId) ?? 0) + 1));
  const rows = batch.rows.map(r => {
    const product = productHint(r.title);
    const match = matchChecklistTitle(r.title, catalog);
    const matches = match.candidates;
    const blockers = [...r.flags, ...(!r.sourceUrl ? ["individual_listing_url_not_retained"] : []), "condition_not_verified", "parallel_not_verified", "sale_status_not_verified", "own_purchase_not_checked"];
    if ((counts.get(r.rowId) ?? 0) > 1) blockers.push("duplicate_listing");
    if (product !== "Chrome — release unverified") blockers.push("separate_product_catalog_required");
    else if (matches.length !== 1) blockers.push(matches.length ? "ambiguous_checklist_entry" : "no_exact_checklist_match");
    else blockers.push("release_and_section_require_visual_confirmation");
    const priceStatus = r.auction ? "displayed_auction_result" : /Best Offer/i.test(r.text) ? "accepted_price_unknown" : "fixed_transaction_unverified";
    const parts = r.text.split(" | ");
    const displayPrices = (parts.find(p => /^\$/.test(p))?.match(/\$[\d,]+\.\d{2}/g) ?? []).map(p => Math.round(Number(p.replace(/[$,]/g, "")) * 100));
    const ship = r.text.match(/\+\$([\d,.]+) delivery/);
    return { ...r, originalCandidate: r.auction && r.flags.length === 0, productHint: product,
      checklistEntryId: match.entryId, checklistMatchStatus: match.status, checklistMatchBasis: "title-only; parallel and condition remain separate",
      proposedEntries: matches.map(c => ({ id: c.id, player: c.player, cardNumber: c.cardNumber, section: c.section, sourcePage: c.sourcePage })),
      priceStatus, displayedItemCents: displayPrices, verifiedItemCents: null,
      displayedShippingCents: /Free delivery/.test(r.text) ? 0 : ship ? Math.round(Number(ship[1].replace(/,/g, "")) * 100) : null,
      verifiedShippingCents: null, eligibleForPricing: false, blockers: Array.from(new Set(blockers)) };
  });
  return { version: 1 as const, sourceUrl: batch.sourceUrl, observedAt: batch.observedAt,
    reviewStartedAt: batch.reviewStartedAt, databaseImported: false as const, verifiedComps: 0,
    summary: { observations: rows.length, originalCandidates: rows.filter(r => r.originalCandidate).length,
      titleMatched: rows.filter(r => r.checklistEntryId !== null).length,
      outsideCurrentCatalog: rows.filter(r => r.checklistMatchStatus === "outside_current_catalog").length,
      originalCandidatesWithSingleChecklistProposal: rows.filter(r => r.originalCandidate && r.proposedEntries.length === 1).length,
      uncertainPrices: rows.filter(r => r.priceStatus !== "displayed_auction_result").length,
      products: Object.fromEntries(Array.from(new Set(rows.map(r => r.productHint))).map(p => [p, rows.filter(r => r.productHint === p).length])) as Record<string, number> }, rows };
}
