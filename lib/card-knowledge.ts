import { createHash } from "node:crypto";
import { z } from "zod";
import { recommendedEbayTitle } from "./card-knowledge-title.ts";

const id = z.string().min(1).max(150);
export const catalogSchema = z.object({
  version: z.literal(1),
  product: z.object({ id, name: z.string(), season: z.string(), printedYear: z.number().int(), manufacturer: z.string(), sport: z.string(), expectedBaseCards: z.number().int(), status: z.literal("source-backed"), productUrl: z.string().url() }),
  sources: z.array(z.object({ id, kind: z.enum(["checklist", "odds"]), url: z.string().url(), sha256: z.string().regex(/^[a-f0-9]{64}$/), retrievedAt: z.string().datetime(), publisher: z.string() })),
  cards: z.array(z.object({ id, productId: id, section: z.string(), category: z.string(), cardNumber: z.string(), player: z.string(), subjectId: id, team: z.string().nullable(), rookie: z.boolean(), sourceId: id, sourcePage: z.number().int().positive(), raw: z.string() })),
  odds: z.array(z.object({ id, label: z.string(), raw: z.string(), sourceId: id, sourcePage: z.number().int().positive(), ratios: z.array(z.string()), formatMapping: z.literal("requires-review") })),
  unresolved: z.array(z.object({ page: z.number().int().positive(), raw: z.string(), reason: z.string() })),
  limitations: z.array(z.string()),
});
export type CardCatalog = z.infer<typeof catalogSchema>;
export function validateCatalog(input: unknown): CardCatalog {
  const catalog = catalogSchema.parse(input);
  const sources = new Set(catalog.sources.map(s => s.id));
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const card of catalog.cards) {
    const key = JSON.stringify([card.section, card.cardNumber]);
    if (ids.has(card.id) || keys.has(key)) throw Error("Duplicate checklist entry");
    if (card.productId !== catalog.product.id || !sources.has(card.sourceId)) throw Error("Broken checklist provenance");
    ids.add(card.id); keys.add(key);
  }
  if (catalog.cards.filter(c => c.section === "BASE CARDS").length !== catalog.product.expectedBaseCards) throw Error("Base checklist count mismatch");
  for (const odds of catalog.odds) {
    if (!sources.has(odds.sourceId) || ids.has(odds.id)) throw Error("Broken odds provenance or duplicate ID");
    ids.add(odds.id);
  }
  if (sources.size !== catalog.sources.length) throw Error("Duplicate sources");
  return catalog;
}

export function searchCatalog(catalog: CardCatalog, query = "", section = "", offset = 0, limit = 50) {
  const normalized = query.normalize("NFC").toLocaleLowerCase().trim();
  const matches = catalog.cards.filter(c => (!section || c.section === section) &&
    (!normalized || [c.player, c.team ?? "", c.cardNumber, c.section].some(s => s.toLocaleLowerCase().includes(normalized))));
  const start = Math.max(0, Math.floor(Number.isFinite(offset) ? offset : 0));
  const take = Math.min(100, Math.max(1, Math.floor(Number.isFinite(limit) ? limit : 50)));
  return { total: matches.length, offset: start, limit: take, cards: matches.slice(start, start + take).map(c => ({ ...c, recommendedEbayTitle: recommendedEbayTitle(catalog.product, c) })) };
}

/** A bounded, provenance-bearing graph. These edges describe a catalog, never inventory. */
export function catalogGraph(catalog: CardCatalog, query = "", section = "") {
  const selected = searchCatalog(catalog, query, section, 0, 50);
  const nodes = new Map<string, { id: string; kind: string; label: string }>();
  const edges: { from: string; to: string; relation: string; sourceId: string; sourcePage?: number }[] = [];
  nodes.set(catalog.product.id, { id: catalog.product.id, kind: "product", label: catalog.product.name });
  for (const source of catalog.sources) nodes.set(source.id, { id: source.id, kind: "source", label: source.url });
  for (const card of selected.cards) {
    nodes.set(card.id, { id: card.id, kind: "checklist-entry", label: `${card.section} #${card.cardNumber}` });
    nodes.set(card.subjectId, { id: card.subjectId, kind: "subject", label: card.player });
    const evidence = { sourceId: card.sourceId, sourcePage: card.sourcePage };
    edges.push({ from: catalog.product.id, to: card.id, relation: "contains", ...evidence },
      { from: card.id, to: card.subjectId, relation: "depicts", ...evidence },
      { from: card.sourceId, to: card.id, relation: "documents", ...evidence });
  }
  return { nodes: Array.from(nodes.values()), edges, matchingEntries: selected.total, truncated: selected.total > selected.cards.length };
}

/** Do not infer a release from copyright year alone, or merge unknown parallel fields. */
export const variantSchema = z.object({
  productId: id, entryId: id, parallel: z.string().trim().min(1), language: z.string().trim().min(1),
  finish: z.string().trim().min(1), printRun: z.number().int().positive().nullable(),
  numbering: z.enum(["numbered", "unnumbered", "unknown"]),
}).refine(v => v.numbering === "numbered" ? v.printRun !== null : v.printRun === null, "Print run and numbering disagree");
export function variantIdentity(input: unknown) {
  const value = variantSchema.parse(input);
  if (value.numbering === "unknown") throw Error("Numbering requires review before matching variants");
  return createHash("sha256").update(JSON.stringify([value.productId, value.entryId,
    value.parallel.normalize("NFC").toLowerCase(), value.language.toLowerCase(), value.finish.toLowerCase(), value.numbering, value.printRun])).digest("hex");
}

export type MarketObservation = {
  provider: string; saleId: string; variantId: string; sourceUrl: string; soldAt: string;
  observedAt: string; itemCents: number; shippingCents: number | null; currency: string;
  condition: string; identityVerified: boolean; conditionVerified: boolean;
  kind: "sold" | "asking" | "aggregate"; ownPurchase: boolean; hiddenPrice: boolean;
};
/** Eligibility only. Existing seller pricing/approval policy remains authoritative. */
export function eligibleObservations(rows: MarketObservation[], target: { variantId: string; condition: string; currency: string }, now: Date, maxAgeDays = 90) {
  if (!Number.isFinite(now.getTime()) || !Number.isInteger(maxAgeDays) || maxAgeDays < 1 || maxAgeDays > 3650) throw Error("Invalid evidence window");
  const counts = new Map<string, number>();
  for (const row of rows) { const key = JSON.stringify([row.provider.trim().toLowerCase(), row.saleId.trim()]); counts.set(key, (counts.get(key) ?? 0) + 1); }
  return rows.map(row => {
    const blockers: string[] = [];
    const sold = Date.parse(row.soldAt), observed = Date.parse(row.observedAt);
    if (!row.provider.trim() || !row.saleId.trim() || !/^https:\/\//.test(row.sourceUrl)) blockers.push("sale-provenance-missing");
    if ((counts.get(JSON.stringify([row.provider.trim().toLowerCase(), row.saleId.trim()])) ?? 0) > 1) blockers.push("duplicate-sale-requires-reconciliation");
    if (row.kind !== "sold" || row.hiddenPrice || row.ownPurchase) blockers.push("not-independent-visible-sale");
    if (!row.identityVerified || !row.conditionVerified || row.variantId !== target.variantId || row.condition !== target.condition) blockers.push("identity-or-condition-mismatch");
    if (row.currency !== target.currency || !/^[A-Z]{3}$/.test(row.currency)) blockers.push("currency-mismatch");
    if (!Number.isFinite(sold) || !Number.isFinite(observed) || sold > observed || observed > now.getTime() || now.getTime() - sold > maxAgeDays * 86400000) blockers.push("invalid-or-stale-date");
    if (!Number.isSafeInteger(row.itemCents) || row.itemCents <= 0 || row.shippingCents === null || !Number.isSafeInteger(row.shippingCents) || row.shippingCents < 0 || !Number.isSafeInteger(row.itemCents + (row.shippingCents ?? 0))) blockers.push("landed-price-incomplete");
    return { observation: row, eligible: blockers.length === 0, blockers, landedCents: blockers.length ? null : row.itemCents + row.shippingCents! };
  });
}
