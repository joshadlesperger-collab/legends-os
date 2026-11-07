import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { validateCatalog, type CardCatalog } from "./card-knowledge.ts";
import { KNOWLEDGE_TITLE_POLICY, recommendedEbayTitle } from "./card-knowledge-title.ts";

export const catalogDigest = (catalog: CardCatalog) => createHash("sha256").update(JSON.stringify(catalog)).digest("hex");

/** Explicitly invoked only after approved migration. No startup or request-time writes. */
export async function importCardCatalog(client: PrismaClient, input: unknown) {
  const catalog = validateCatalog(input), digest = catalogDigest(catalog);
  const entries = catalog.cards.map(({ player, ...c }) => ({ ...c, playerName: player,
    recommendedEbayTitle: recommendedEbayTitle(catalog.product, { ...c, player }), titleNeedsReview: true }));
  return client.$transaction(async tx => {
    const existing = await tx.knowledgeProduct.findUnique({ where: { id: catalog.product.id }, select: { catalogDigest: true, titlePolicyVersion: true } });
    if (existing?.catalogDigest === digest) {
      if (existing.titlePolicyVersion === KNOWLEDGE_TITLE_POLICY) return { status: "unchanged", productId: catalog.product.id };
      if (existing.titlePolicyVersion !== "pending") throw Error("Existing title policy requires explicit revision review");
      for (const entry of entries) {
        const result = await tx.knowledgeEntry.updateMany({ where: { id: entry.id, productId: catalog.product.id, recommendedEbayTitle: "", playerName: "" }, data: { playerName: entry.playerName, recommendedEbayTitle: entry.recommendedEbayTitle, titleNeedsReview: true } });
        if (result.count !== 1) throw Error("Title backfill encountered existing edits or a missing entry; no changes applied");
      }
      await tx.knowledgeProduct.update({ where: { id: catalog.product.id }, data: { titlePolicyVersion: KNOWLEDGE_TITLE_POLICY } });
      return { status: "titles-added", productId: catalog.product.id, entries: entries.length };
    }
    if (existing) throw Error("Catalog source changed; prepare a reviewed revision instead of overwriting existing knowledge");
    const { expectedBaseCards: _count, status: _status, ...product } = catalog.product;
    await tx.knowledgeProduct.create({ data: { ...product, catalogDigest: digest, titlePolicyVersion: KNOWLEDGE_TITLE_POLICY } });
    await tx.knowledgeSource.createMany({ data: catalog.sources.map(s => ({ ...s, productId: product.id })) });
    const subjects = Array.from(new Map(catalog.cards.map(c => [c.subjectId, { id: c.subjectId, name: c.player }])).values());
    await tx.knowledgeSubject.createMany({ data: subjects });
    for (let offset = 0; offset < catalog.cards.length; offset += 250) {
      await tx.knowledgeEntry.createMany({ data: entries.slice(offset, offset + 250) });
    }
    for (let offset = 0; offset < catalog.odds.length; offset += 250) {
      await tx.knowledgeOdds.createMany({ data: catalog.odds.slice(offset, offset + 250).map(o => ({ ...o, productId: product.id })) });
    }
    if (catalog.unresolved.length) await tx.knowledgeReviewItem.createMany({ data: catalog.unresolved.map((r, i) => ({ ...r, id: `${product.id}:review:${i}`, productId: product.id })) });
    return { status: "imported", productId: product.id, entries: catalog.cards.length, odds: catalog.odds.length };
  }, { isolationLevel: "Serializable", timeout: 60000 });
}

const legacyTables: Record<string, string> = { source_records: "card_id", card_variants: "variant_id", inventory: "card_id", evidence_summaries: "evidence_id", market_observations: "observation_id", price_recommendations: "recommendation_id", listing_records: "card_id", pilot: "card_id" };
export function prepareLegacyImport(input: unknown) {
  if (!input || typeof input !== "object") throw Error("Invalid recovery snapshot");
  const packet = input as { version: number; sourceSha256: string; tables: Record<string, unknown> };
  if (packet.version !== 1 || !/^[a-f0-9]{64}$/.test(packet.sourceSha256) || !packet.tables || Object.keys(packet.tables).sort().join() !== Object.keys(legacyTables).sort().join()) throw Error("Invalid recovery provenance");
  const records: { id: string; importId: string; sourceTable: string; sourceKey: string; raw: Prisma.InputJsonObject }[] = [];
  const counts: Record<string, number> = {};
  for (const [table, key] of Object.entries(legacyTables)) {
    const rows = packet.tables[table];
    if (!Array.isArray(rows) || rows.length > 100000) throw Error("Invalid recovery table");
    counts[table] = rows.length;
    const seen = new Set<string>();
    for (const row of rows) {
      if (!row || typeof row !== "object" || typeof row[key] !== "string" || !row[key] || seen.has(row[key])) throw Error("Invalid or duplicate legacy key");
      seen.add(row[key]);
      records.push({ id: createHash("sha256").update(JSON.stringify([packet.sourceSha256, table, row[key]])).digest("hex"), importId: packet.sourceSha256, sourceTable: table, sourceKey: row[key], raw: row });
    }
  }
  return { importId: packet.sourceSha256, counts, records };
}

/** Propose checklist links only; a name/number match never validates a parallel or copy. */
export function reconcileLegacyEntries(catalog: CardCatalog, input: unknown) {
  const plan = prepareLegacyImport(input);
  const norm = (value: unknown) => typeof value === "string" ? value.normalize("NFC").trim().toLowerCase() : "";
  const productName = norm(catalog.product.name.replace(catalog.product.season, ""));
  const candidates = plan.records.filter(r => r.sourceTable === "card_variants" && norm(r.raw.product) === productName);
  return candidates.map(record => {
    const row = record.raw;
    const releaseMatches = norm(row.season) === norm(catalog.product.season) && norm(row.manufacturer) === norm(catalog.product.manufacturer);
    const matches = releaseMatches ? catalog.cards.filter(c => norm(c.player) === norm(row.player) && norm(c.cardNumber) === norm(row.card_number) && (!norm(row.subset_insert) || norm(c.section) === norm(row.subset_insert))) : [];
    return { legacyVariantId: record.sourceKey, entryIds: matches.map(c => c.id),
      status: matches.length === 1 ? "candidate" : matches.length > 1 ? "ambiguous" : "unmatched",
      reason: !releaseMatches ? "Exact release/manufacturer requires review" : matches.length !== 1 ? "Player, card number or section requires review" : "Checklist candidate only; original capture, parallel, numbering, language and condition remain unverified",
      physicalInventoryChanged: false, priceApproved: false };
  });
}
export async function importLegacyKnowledge(client: PrismaClient, input: unknown) {
  const plan = prepareLegacyImport(input);
  return client.$transaction(async tx => {
    if (await tx.knowledgeImport.findUnique({ where: { id: plan.importId }, select: { id: true } })) return { status: "unchanged" };
    await tx.knowledgeImport.create({ data: { id: plan.importId, sourceSha256: plan.importId, recordCounts: plan.counts } });
    for (let offset = 0; offset < plan.records.length; offset += 100) await tx.knowledgeLegacyRecord.createMany({ data: plan.records.slice(offset, offset + 100) });
    return { status: "imported", records: plan.records.length };
  }, { isolationLevel: "Serializable", timeout: 120000 });
}
