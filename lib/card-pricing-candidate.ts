import { validateComps, reviewedIdentity, refreshJobs, type CardRecord } from "./card-orchestrator.ts";

import { CURRENT_CARD_PRICE_POLICY } from "./card-price-policy.ts";
export const CANDIDATE_POLICY = CURRENT_CARD_PRICE_POLICY;
export { candidatePrice } from "./card-price-policy.ts";
import { candidatePrice } from "./card-price-policy.ts";

/** Read-only adapter: existing identity, date, serial, condition and duplicate guards remain authoritative.
 * Old approvals are deliberately not attached to candidate calculations. */
export function compareCardPrice(card: CardRecord, asOf: string) {
  const result = card.jobs.pricing.result;
  const old = result?.projection as { item?: number; shipping?: number; buyerTotal?: number; policyVersion?: string; overridden?: boolean } | undefined;
  const blockers: string[] = [];
  const base = { id: card.input.id, sku: card.input.sku, identity: reviewedIdentity(card) ?? card.input.identity,
    old: old ?? null, candidate: null as ReturnType<typeof candidatePrice> | null,
    evidence: result?.comps ?? null, adjustments: [] as unknown[], blockers,
    reviewStatus: "comparison-only; not approved", nextOwner: "pricing-evidence-review",
    shippingAssumption: "Retain historical proposed listing shipping for comparison; eligibility is not reverified.",
    canUpload: false, canPublish: false };
  if (card.input.override || old?.overridden) { blockers.push("Seller override preserved; not automatically recalculated"); return base; }
  // Refresh can invalidate completed stages, but cannot complete an unfinished stage.
  if (card.jobs.photos.state !== "done" || card.jobs.identity.state !== "done" || card.jobs.pricing.state !== "done") {
    blockers.push("Current photo/identity/pricing snapshot is incomplete or invalidated; saved evidence retained"); return base;
  }
  const current = structuredClone(card);
  refreshJobs(current, asOf);
  if (current.jobs.photos.state !== "done" || current.jobs.identity.state !== "done" || current.jobs.pricing.state !== "done") {
    blockers.push("Current photo/identity/pricing snapshot is incomplete or invalidated; saved evidence retained"); return base;
  }
  if (card.jobs.pricing.state !== "done" || !result?.comps || !old) { blockers.push("No completed saved pricing evidence/projection"); return base; }
  const identity = reviewedIdentity(card);
  if (!identity) { blockers.push("Current per-copy identity review required"); return base; }
  if (!amount(old.shipping)) { blockers.push("Listing shipping unknown"); return base; }
  try {
    const basis = result.basis ?? "exact";
    if (basis !== "exact" && basis !== "related-print-run") throw Error("Unsupported evidence basis");
    if (basis === "related-print-run" && !(typeof result.exactSearchEvidence === "string" && result.exactSearchEvidence.trim())) throw Error("Related estimate needs retained exact-search evidence");
    const validated = validateComps(identity, result.comps, asOf, basis);
    if (validated.comps.some(c => c.shipping === null)) throw Error("Comparable-sale shipping unknown; buyer total cannot be reconstructed");
    // Condition and special-premium adjustments apply to item value only. Related-run ratio
    // applies to the resulting source buyer total; carrier shipping is never condition-adjusted.
    const adjusted = validated.comps.map((c, i) => {
      if (!('soldDate' in c)) throw Error('Active-listing estimates must not enter sold-price comparisons');
      const d = validated.basisDetails[i];
      return { saleId: c.saleId, sourceUrl: c.sourceUrl, soldDate: c.soldDate,
        item: c.itemPrice, shipping: c.shipping!, conditionMultiplier: d.conditionMultiplier,
        specialMultiplier: d.premiumMultiplier, printRunMultiplier: d.multiplier,
        targetBuyerTotal: (c.itemPrice * d.conditionMultiplier * d.premiumMultiplier + c.shipping!) * d.multiplier };
    });
    base.adjustments = adjusted;
    // Preserve arithmetic-mean estimator for a controlled formula comparison. Not an automatic
    // market-value decision: active-market corroboration/outliers still require human review.
    const target = adjusted.reduce((n, c) => n + c.targetBuyerTotal, 0) / adjusted.length;
    base.candidate = candidatePrice(target, old.shipping);
    blockers.push("Candidate price requires review; historical approval does not transfer", "Fresh inventory/shipping and active-market corroboration required");
    if (adjusted.length < 3) blockers.push("Thin evidence: fewer than three independent sales");
    if (validated.reviewEstimate) blockers.push("Retained estimated/uncertain evidence; not verified exact value");
    if (base.candidate.economicsReview) blockers.push("$1.49 floor exceeds evidence-supported item value");
    if (adjusted.some(c => c.shipping > c.item)) blockers.push("Shipping-heavy comparable requires independent corroboration");
    if (typeof old.buyerTotal === "number" && base.candidate.buyerTotal < old.buyerTotal * .75) blockers.push("Reduction exceeds 25%; explicit price review required");
    base.nextOwner = "seller-price-review";
  } catch (error) { blockers.push(error instanceof Error ? error.message : "Evidence validation failed"); }
  return base;
}

const amount=(n:unknown):n is number=>typeof n==="number"&&Number.isFinite(n)&&n>=0&&n<=1_000_000;
