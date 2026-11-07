import { z } from "zod";
import { eligibleObservations, type MarketObservation } from "./card-knowledge.ts";

export const PARALLEL_METHOD = "matched-card-premium-v1";
const text = z.string().trim().min(1).max(160);
const variant = z.object({ parallel: text, finish: text, numbering: z.enum(["numbered", "unnumbered"]), printRun: z.number().int().positive().nullable() })
  .refine(v => v.numbering === "numbered" ? v.printRun !== null : v.printRun === null, "Numbering and print run disagree");
export const parallelPacketSchema = z.object({
  scope: z.object({ productId: text, section: text, language: text, condition: text, currency: z.string().regex(/^[A-Z]{3}$/), baseline: variant, target: variant }),
  sales: z.array(z.object({
    provider: text, saleId: text, variantId: text, sourceUrl: z.string().url(), soldAt: z.string().datetime(), observedAt: z.string().datetime(),
    itemCents: z.number().int().positive(), shippingCents: z.number().int().nonnegative().nullable(), currency: text, condition: text,
    identityVerified: z.boolean(), conditionVerified: z.boolean(), kind: z.enum(["sold", "asking", "aggregate"]), ownPurchase: z.boolean(), hiddenPrice: z.boolean(),
    productId: text, section: text, language: text, entryId: text, subjectId: text, variant, variantVerified: z.boolean(), ordinaryCopy: z.boolean(),
  })).max(10000),
});
export type ParallelPacket = z.infer<typeof parallelPacketSchema>;
export type ParallelSale = ParallelPacket["sales"][number];
const descriptor = (v: ParallelPacket["scope"]["baseline"]) => JSON.stringify([v.parallel.toLowerCase(), v.finish.toLowerCase(), v.numbering, v.printRun]);
const median = (values: number[]) => { const v = [...values].sort((a,b) => a-b); return v.length % 2 ? v[Math.floor(v.length/2)] : (v[v.length/2-1]+v[v.length/2])/2; };
const quantile = (values: number[], p: number) => { const v = [...values].sort((a,b) => a-b), n = (v.length-1)*p, i = Math.floor(n); return v[i]+(v[Math.min(i+1,v.length-1)]-v[i])*(n-i); };
const saleKey = (sale: MarketObservation) => `${sale.provider.trim().toLowerCase()}:${sale.saleId.trim()}`;

/** Equal weight per player prevents frequently traded stars from dominating the relationship. */
export function analyzeParallel(input: unknown, now = new Date(), excludedEntryId?: string) {
  const packet = parallelPacketSchema.parse(input), { scope } = packet;
  if (descriptor(scope.baseline) === descriptor(scope.target)) throw Error("Choose two distinct parallels");
  if (!Number.isFinite(now.getTime())) throw Error("Invalid analysis date");
  const eligibility = eligibleObservations(packet.sales, { variantId: "", condition: scope.condition, currency: scope.currency }, now);
  const groups = new Map<string, { subjectId: string; base: ParallelSale[]; target: ParallelSale[] }>();
  let rejectedSales = 0;
  // A conflicting entry-to-player mapping is held, never merged into a cohort.
  const subjects = new Map<string, Set<string>>();
  packet.sales.forEach(s => { const ids = subjects.get(s.entryId) ?? new Set<string>(); ids.add(s.subjectId); subjects.set(s.entryId, ids); });
  packet.sales.forEach((sale, index) => {
    const side = descriptor(sale.variant) === descriptor(scope.baseline) ? "base" : descriptor(sale.variant) === descriptor(scope.target) ? "target" : null;
    // Re-evaluate identity against each sale's variant; keep global duplicate detection.
    const valid = eligibleObservations([sale], { variantId: sale.variantId, condition: scope.condition, currency: scope.currency }, now)[0].eligible;
    if (!valid || eligibility[index].blockers.includes("duplicate-sale-requires-reconciliation") || !side || !sale.variantVerified || !sale.ordinaryCopy ||
      sale.productId !== scope.productId || sale.section !== scope.section || sale.language !== scope.language || subjects.get(sale.entryId)!.size !== 1 || sale.entryId === excludedEntryId) { rejectedSales++; return; }
    const group = groups.get(sale.entryId) ?? { subjectId: sale.subjectId, base: [], target: [] };
    group[side].push(sale); groups.set(sale.entryId, group);
  });
  const pairs: { entryId: string; subjectId: string; ratio: number; baselineCents: number; targetCents: number; saleKeys: string[]; sourceUrls: string[] }[] = [];
  const coverage: { entryId: string; subjectId: string; baselineSales: number; targetSales: number; missingBaseline: number; missingTarget: number }[] = [];
  for (const [entryId, group] of Array.from(groups)) {
    // Pair recent sales in a shared 14-day window rather than comparing distant market regimes.
    const end = Math.max(...group.base.concat(group.target).map(s => Date.parse(s.soldAt)));
    const recent = (rows: ParallelSale[]) => rows.filter(s => end-Date.parse(s.soldAt) <= 14*86400000);
    const base = recent(group.base), target = recent(group.target);
    coverage.push({ entryId, subjectId: group.subjectId, baselineSales: base.length, targetSales: target.length, missingBaseline: Math.max(0,3-base.length), missingTarget: Math.max(0,3-target.length) });
    if (base.length < 3 || target.length < 3) continue;
    const baselineCents = median(base.map(s => s.itemCents+s.shippingCents!)), targetCents = median(target.map(s => s.itemCents+s.shippingCents!));
    pairs.push({ entryId, subjectId: group.subjectId, ratio: targetCents/baselineCents, baselineCents, targetCents, saleKeys: base.concat(target).map(saleKey), sourceUrls: base.concat(target).map(s => s.sourceUrl) });
  }
  const byPlayer = new Map<string, number[]>();
  pairs.forEach(pair => byPlayer.set(pair.subjectId, [...(byPlayer.get(pair.subjectId) ?? []), pair.ratio]));
  const ratios = Array.from(byPlayer.values()).map(median), multiplier = ratios.length ? median(ratios) : null;
  const low = ratios.length ? quantile(ratios, .25) : null, high = ratios.length ? quantile(ratios, .75) : null;
  const blockers = [];
  if (ratios.length < 3) blockers.push("Need at least 3 different players, each with 3 baseline and 3 parallel sales within a shared 14-day window.");
  if (multiplier !== null && (high!-low!)/multiplier > .5) blockers.push("Player premiums vary too widely for a shared fallback.");
  return { method: PARALLEL_METHOD, scope, asOf: now.toISOString(), expiresAt: new Date(now.getTime()+7*86400000).toISOString(),
    status: blockers.length ? "insufficient-evidence" as const : "research-estimate" as const,
    confidence: blockers.length ? "insufficient" : ratios.length >= 10 ? "moderate" : "low",
    multiplier, premiumPercent: multiplier === null ? null : (multiplier-1)*100, ratioLow: low, ratioHigh: high,
    playerCount: ratios.length, pairCount: pairs.length, saleCount: pairs.reduce((sum,p) => sum+p.saleKeys.length,0), rejectedSales, blockers, pairs, coverage,
    priceBasis: "buyer total excluding tax", listingApproved: false as const };
}

/** Recomputes without the priced entry to avoid using its own outcomes to train its fallback. */
export function estimateParallel(input: unknown, entryId: string, now = new Date()) {
  const packet = parallelPacketSchema.parse(input);
  const exact = (which: "baseline" | "target") => {
    const candidates = packet.sales.filter(s => s.entryId === entryId && s.productId === packet.scope.productId && s.section === packet.scope.section && s.language === packet.scope.language && descriptor(s.variant) === descriptor(packet.scope[which]));
    const allKeys = new Map<string, number>(); packet.sales.forEach(s => allKeys.set(saleKey(s), (allKeys.get(saleKey(s)) ?? 0)+1));
    return candidates.filter(s => s.variantVerified && s.ordinaryCopy && allKeys.get(saleKey(s)) === 1 && eligibleObservations([s], { variantId: s.variantId, condition: packet.scope.condition, currency: packet.scope.currency }, now)[0].eligible);
  };
  const direct = exact("target"), model = analyzeParallel(packet, now, entryId);
  if (direct.length) return { basis: "direct-comps", estimatedBuyerTotalCents: Math.round(median(direct.map(s => s.itemCents+s.shippingCents!))), saleKeys: direct.map(saleKey), model, blockers: [], listingApproved: false };
  const anchors = exact("baseline"), blockers = [...model.blockers];
  if (anchors.length < 3) blockers.push("Need 3 verified baseline sales for this card; an inferred price cannot be an anchor.");
  const anchor = anchors.length ? median(anchors.map(s => s.itemCents+s.shippingCents!)) : null;
  return { basis: "parallel-fallback", estimatedBuyerTotalCents: blockers.length ? null : Math.round(anchor!*model.multiplier!), saleKeys: anchors.map(saleKey), model, blockers, listingApproved: false };
}
