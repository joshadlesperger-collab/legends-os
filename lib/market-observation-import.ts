import { createHash } from "node:crypto";
import type { PrismaClient, Prisma } from "@prisma/client";
import { z } from "zod";
import { matchChecklistTitle, productHint } from "./card-market-review.ts";
import type { CardCatalog } from "./card-knowledge.ts";
const packetSchema = z.object({ sourceSha256: z.string().regex(/^[a-f0-9]{64}$/), analyzedAt: z.string().datetime({ offset: true }), captureTimeVerified: z.literal(false),
  rows: z.array(z.object({ itemId: z.string().regex(/^\d+$/), sourceUrl: z.string().url(), title: z.string().min(1), soldDateText: z.string(), displayedPrices: z.array(z.string()),
    priceStatus: z.enum(["displayed_auction_result", "accepted_price_unknown", "fixed_transaction_unverified"]), displayedShippingCents: z.number().int().nonnegative().nullable(),
    bids: z.number().int().nonnegative().nullable(), flags: z.array(z.string()),
    sourceSnapshots: z.array(z.string().regex(/^[a-f0-9]{64}$/)).optional() })).max(10000) });
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
/** Collapse identical listing observations across files, preserving their source hashes. */
export function mergeMarketPackets(inputs: unknown[]) {
  if (!inputs.length) throw Error("No source packets");
  const packets = inputs.map(input => packetSchema.parse(input));
  const rows = new Map<string, z.infer<typeof packetSchema>["rows"][number]>();
  for (const packet of packets) for (const row of packet.rows) {
    if (row.sourceUrl !== `https://www.ebay.com/itm/${row.itemId}`) throw Error("Listing URL does not match item ID");
    const previous = rows.get(row.itemId);
    const identity = (r: typeof row) => JSON.stringify([r.title, r.soldDateText, r.displayedPrices, r.priceStatus, r.displayedShippingCents, r.bids]);
    if (previous && identity(previous) !== identity(row)) throw Error("Conflicting listing snapshots require review");
    rows.set(row.itemId, { ...row,
      flags: Array.from(new Set([...(previous?.flags ?? []), ...row.flags])).sort(),
      sourceSnapshots: Array.from(new Set([...(previous?.sourceSnapshots ?? []), ...(row.sourceSnapshots ?? []), packet.sourceSha256])).sort() });
  }
  const hashes = Array.from(new Set(packets.map(p => p.sourceSha256))).sort();
  return { sourceSha256: hash(JSON.stringify(hashes)), analyzedAt: new Date().toISOString(), captureTimeVerified: false as const,
    rows: Array.from(rows.values()).sort((a, b) => a.itemId.localeCompare(b.itemId)) };
}
/** Archives all products without requiring catalog/variant foreign keys or approving prices. */
export function prepareMarketObservationImport(input: unknown, catalog: CardCatalog) {
  const packet = packetSchema.parse(input), seen = new Set<string>();
  const rows = packet.rows.map(row => {
    if (seen.has(row.itemId)) throw Error("Duplicate item ID in snapshot");
    seen.add(row.itemId);
    if (row.sourceUrl !== `https://www.ebay.com/itm/${row.itemId}`) throw Error("Listing URL does not match item ID");
    const match = matchChecklistTitle(row.title, catalog);
    return { ...row, provider: "ebay", observationKey: `ebay:${row.itemId}`, productHint: productHint(row.title),
      proposedChecklistEntryId: match.entryId, checklistMatchStatus: match.status, verifiedTransactionPrice: null,
      pricingEligible: false, captureTimeVerified: false, sourceSha256: packet.sourceSha256 };
  }).sort((a,b) => a.itemId.localeCompare(b.itemId));
  // A later snapshot is another observation of an item, never another independent sale.
  const digest = hash(JSON.stringify({ sourceSha256: packet.sourceSha256, rows }));
  const importId = `market-${digest}`;
  const counts = { marketObservations: rows.length, titleMatches: rows.filter(r => r.proposedChecklistEntryId).length,
    uncertainPrices: rows.filter(r => r.priceStatus !== "displayed_auction_result").length };
  return { importId, digest, counts, records: rows.map(row => ({ id: hash(`${importId}:${row.itemId}`), importId,
    sourceTable: "ebay_saved_search_observations", sourceKey: row.observationKey,
    raw: row as Prisma.InputJsonObject, reviewStatus: "observed-market-data" })) };
}
export async function importMarketObservations(client: PrismaClient, input: unknown, catalog: CardCatalog) {
  const plan = prepareMarketObservationImport(input, catalog);
  return client.$transaction(async tx => {
    if (await tx.knowledgeImport.findUnique({ where: { id: plan.importId }, select: { id: true } })) return { status: "unchanged", ...plan.counts };
    await tx.knowledgeImport.create({ data: { id: plan.importId, sourceSha256: plan.digest, recordCounts: plan.counts } });
    for (let offset = 0; offset < plan.records.length; offset += 100) await tx.knowledgeLegacyRecord.createMany({ data: plan.records.slice(offset, offset + 100) });
    return { status: "imported-observations", ...plan.counts };
  }, { isolationLevel: "Serializable", timeout: 120000 });
}
