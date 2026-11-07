import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateCatalog, searchCatalog, catalogGraph, variantIdentity, eligibleObservations, type MarketObservation } from "../lib/card-knowledge.ts";
import { importCardCatalog, importLegacyKnowledge, prepareLegacyImport, reconcileLegacyEntries } from "../lib/card-knowledge-import.ts";
import type { PrismaClient } from "@prisma/client";
import { KNOWLEDGE_TITLE_POLICY, recommendedEbayTitle } from "../lib/card-knowledge-title.ts";

const catalog = validateCatalog(JSON.parse(readFileSync(new URL("../data/card-catalog/topps-chrome-basketball-2025-26.json", import.meta.url), "utf8")));
test("official base checklist retains its missing number instead of inventing a 300th card", () => {
  const base = catalog.cards.filter(c => c.section === "BASE CARDS");
  assert.equal(base.length, 299);
  assert.equal(base.some(c => c.cardNumber === "226"), false);
  assert.equal(base.find(c => c.cardNumber === "251")?.player, "Cooper Flagg");
  assert.equal(catalog.product.printedYear, 2025);
  assert.equal(catalog.product.season, "2025-26");
  assert.equal(catalog.cards.length, 1300);
  assert.ok(catalog.cards.filter(c => c.section === "ROCK STARS").every(c => c.team === null));
  assert.equal(catalog.unresolved.length, 20);
});
test("bad provenance and duplicate identities fail before import", () => {
  const duplicate = structuredClone(catalog); duplicate.cards.push(duplicate.cards[0]);
  assert.throws(() => validateCatalog(duplicate), /Duplicate/);
  const orphan = structuredClone(catalog); orphan.cards[0].sourceId = "missing";
  assert.throws(() => validateCatalog(orphan), /provenance/);
});
test("search and graph are bounded and every edge has an existing source and endpoint", () => {
  assert.equal(searchCatalog(catalog, "Cooper Flagg", "BASE CARDS").total, 1);
  assert.equal(searchCatalog(catalog, "no-such-player").total, 0);
  assert.equal(searchCatalog(catalog, "", "", NaN, Infinity).cards.length, 50);
  assert.equal(searchCatalog(catalog, "", "", -1, 100000).cards.length, 100);
  const graph = catalogGraph(catalog);
  assert.equal(graph.truncated, true);
  const nodes = new Set(graph.nodes.map(n => n.id));
  assert.ok(graph.edges.every(e => nodes.has(e.from) && nodes.has(e.to) && nodes.has(e.sourceId)));
});
test("variant matching separates products, finishes, languages and print runs; unknown numbering holds", () => {
  const variant = { productId: catalog.product.id, entryId: "251", parallel: "Gold", finish: "Refractor", language: "English", numbering: "numbered", printRun: 50 };
  const key = variantIdentity(variant);
  for (const change of [{ productId: "sapphire" }, { finish: "Wave" }, { language: "Japanese" }, { printRun: 25 }]) assert.notEqual(variantIdentity({ ...variant, ...change }), key);
  assert.throws(() => variantIdentity({ ...variant, numbering: "unknown", printRun: null }), /review/);
  assert.throws(() => variantIdentity({ ...variant, numbering: "unnumbered" }));
});
const observation: MarketObservation = { provider: "ebay", saleId: "sale-1", variantId: "variant-1", sourceUrl: "https://www.ebay.com/itm/1", soldAt: "2026-10-01T12:00:00Z", observedAt: "2026-10-02T12:00:00Z", itemCents: 100, shippingCents: 149, currency: "USD", condition: "raw-nm", identityVerified: true, conditionVerified: true, kind: "sold", ownPurchase: false, hiddenPrice: false };
const target = { variantId: "variant-1", condition: "raw-nm", currency: "USD" }, now = new Date("2026-10-23T12:00:00Z");
test("sale re-observations cannot inflate exact comps", () => {
  const result = eligibleObservations([observation, { ...observation, observedAt: "2026-10-03T12:00:00Z" }], target, now);
  assert.ok(result.every(r => !r.eligible && r.blockers.includes("duplicate-sale-requires-reconciliation")));
});
test("landed evidence rejects unknown shipping, own purchases, hidden prices, stale dates and mismatches", () => {
  assert.equal(eligibleObservations([observation], target, now)[0].landedCents, 249);
  const failures: Partial<MarketObservation>[] = [{ shippingCents: null }, { itemCents: -10 }, { shippingCents: 1.1 }, { kind: "aggregate" }, { kind: "asking" }, { ownPurchase: true }, { hiddenPrice: true }, { currency: "EUR" }, { condition: "PSA 10" }, { variantId: "other" }, { identityVerified: false }, { conditionVerified: false }, { soldAt: "2020-01-01" }, { soldAt: "invalid" }, { observedAt: "2030-01-01" }, { saleId: "" }];
  for (const change of failures) assert.equal(eligibleObservations([{ ...observation, ...change }], target, now)[0].eligible, false, JSON.stringify(change));
});
function fakeClient() {
  const writes: string[] = [], products = new Map<string, { catalogDigest: string; titlePolicyVersion: string }>(), imports = new Set<string>();
  const createMany = (name: string) => ({ createMany: async ({ data }: { data: unknown[] }) => { writes.push(name); assert.ok(data.length <= 1300); } });
  const tx = {
    knowledgeProduct: { findUnique: async ({ where }: { where: { id: string } }) => products.get(where.id), create: async ({ data }: { data: { id: string; catalogDigest: string; titlePolicyVersion: string } }) => { writes.push("product"); products.set(data.id, data); } },
    knowledgeSource: createMany("sources"), knowledgeSubject: createMany("subjects"), knowledgeEntry: createMany("entries"), knowledgeOdds: createMany("odds"), knowledgeReviewItem: createMany("reviews"),
    knowledgeImport: { findUnique: async ({ where }: { where: { id: string } }) => imports.has(where.id) ? { id: where.id } : null, create: async ({ data }: { data: { id: string } }) => { writes.push("import"); imports.add(data.id); } },
    knowledgeLegacyRecord: createMany("legacy"),
  };
  return { writes, client: { $transaction: async (fn: (db: typeof tx) => Promise<unknown>) => fn(tx) } as unknown as PrismaClient };
}
test("catalog import is idempotent and refuses changed sources rather than silently overwriting", async () => {
  const db = fakeClient();
  assert.equal((await importCardCatalog(db.client, catalog)).status, "imported");
  const writes = db.writes.length;
  assert.equal((await importCardCatalog(db.client, catalog)).status, "unchanged");
  assert.equal(db.writes.length, writes);
  const changed = structuredClone(catalog); changed.cards[0].team = "Edited";
  await assert.rejects(importCardCatalog(db.client, changed), /reviewed revision/);
  assert.equal(db.writes.length, writes);
});

test("every checklist entry gets a bounded recommended title retaining full player and card number", () => {
  for (const card of catalog.cards) {
    const title = recommendedEbayTitle(catalog.product, card);
    assert.ok(title.length <= 80, title);
    assert.ok(title.includes(card.player.normalize("NFC")), title);
    assert.ok(title.includes(card.cardNumber), title);
    assert.ok(title.includes("Topps Chrome"), title);
    assert.equal(/\b(?:PSA|BGS|Mint|NM|SSP)\b|\/\d+/.test(title), false, title);
    if (card.rookie) assert.ok(title.endsWith("RC"));
  }
  const base = catalog.cards.find(c => c.section === "BASE CARDS" && c.cardNumber === "251")!;
  assert.equal(recommendedEbayTitle(catalog.product, base), "2025-26 Topps Chrome Cooper Flagg #251 RC");
  const variation = catalog.cards.find(c => c.section === "BASE CARD VARIATIONS" && c.cardNumber === "251")!;
  assert.match(recommendedEbayTitle(catalog.product, variation), /Base Variation/);
  assert.equal(KNOWLEDGE_TITLE_POLICY, "catalog-ebay-title-v1");
});
test("legacy recovery preserves historical raw values without inventory mutations and rejects duplicate source keys", async () => {
  const tables = Object.fromEntries(["source_records", "card_variants", "inventory", "evidence_summaries", "market_observations", "price_recommendations", "listing_records", "pilot"].map(t => [t, [] as object[]]));
  tables.inventory = [{ card_id: "copy-1", quantity_recorded: "3", condition_recorded: "unknown" }];
  tables.price_recommendations = [{ recommendation_id: "legacy-1", user_override_recorded: "8.49" }];
  const packet = { version: 1, sourceSha256: "a".repeat(64), tables };
  const plan = prepareLegacyImport(packet);
  assert.deepEqual(plan.records.find(r => r.sourceTable === "inventory")?.raw, tables.inventory[0]);
  const db = fakeClient();
  assert.equal((await importLegacyKnowledge(db.client, packet)).status, "imported");
  assert.equal((await importLegacyKnowledge(db.client, packet)).status, "unchanged");
  assert.deepEqual(db.writes, ["import", "legacy"]);
  tables.card_variants = [{ variant_id: "v-1", product: "Topps Chrome Basketball", season: "2025-26", manufacturer: "Topps", player: "Cooper Flagg", card_number: "251", subset_insert: "BASE CARDS" }];
  const links = reconcileLegacyEntries(catalog, packet);
  assert.equal(links[0].status, "candidate");
  assert.equal(links[0].physicalInventoryChanged, false);
  assert.equal(reconcileLegacyEntries(catalog, { ...packet, tables: { ...tables, card_variants: [{ ...(tables.card_variants[0] as object), subset_insert: "" }] } })[0].status, "ambiguous");
  tables.card_variants = [{ ...(tables.card_variants[0] as object), season: "2025" }];
  assert.equal(reconcileLegacyEntries(catalog, packet)[0].status, "unmatched");
  tables.inventory.push(tables.inventory[0]);
  assert.throws(() => prepareLegacyImport(packet), /duplicate legacy key/);
});
