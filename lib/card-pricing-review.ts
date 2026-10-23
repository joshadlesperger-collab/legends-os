import { SCARCITY_GUARD_VERSION, MIN_STRONG_EXACT_SALES } from "./card-scarcity-guard.ts";
import { canonicalCardKey, priceFromSoldComp, projectListing, type DraftCard } from "./card-listing-factory.ts";
import { CARD_POLICY_VERSION, calculateCardPrice, roundUpCardPrice } from "./card-orchestrator-policy.ts";

export type SoldComp = { id: string; sourceUrl: string; soldDate: string; itemPrice: number; shipping: number; notes: string; verified: boolean; identityKey?: string };
export type PricingReview = { comps: SoldComp[]; premiumPercent: number; needsTracked: boolean; envelopeEligible: boolean; patchCard?: boolean; generalPromotionPercent?: number; approvedSnapshot?: string };
export const emptyPricing = (): PricingReview => ({ comps: [], premiumPercent: 9, needsTracked: false, envelopeEligible: false, generalPromotionPercent: 3 });
const cents = (n: number, positive: boolean) => Number.isFinite(n) && (positive ? n > 0 : n >= 0) && n <= 1_000_000 && Math.abs(n * 100 - Math.round(n * 100)) < 0.000001;
const round = (n: number) => Math.round(n * 100) / 100;

export function roundUpListingPrice(value: number): number {
  return roundUpCardPrice(value);
}

export function projectPricing(draft: DraftCard, today = new Date().toISOString().slice(0, 10)) {
  const pricing = draft.pricing ?? emptyPricing();
  const reasons: string[] = [];
  if (!pricing.comps.length) reasons.push("Add at least one verified sold comp.");
  const urls = new Set<string>();
  pricing.comps.forEach((comp, index) => {
    const prefix = `Comp ${index + 1}: `;
    let url: URL | undefined;
    try { url = new URL(comp.sourceUrl); } catch { /* Report below. */ }
    if (!url || url.protocol !== "https:" || url.username || url.password) reasons.push(prefix + "add an HTTPS source link without credentials.");
    if (url) {
      url.hash = "";
      if (urls.has(url.href)) reasons.push(prefix + "duplicate source; use each sale only once.");
      urls.add(url.href);
    }
    const date = new Date(`${comp.soldDate}T00:00:00Z`);
    const age = (Date.parse(`${today}T00:00:00Z`) - date.getTime()) / 86400000;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(comp.soldDate) || !Number.isFinite(age) || date.toISOString().slice(0, 10) !== comp.soldDate || age < 0 || age > 90) reasons.push(prefix + "sale date must be valid and within the last 90 days.");
    if (!cents(comp.itemPrice, true)) reasons.push(prefix + "enter a positive sold item price in USD cents.");
    if (!cents(comp.shipping, false)) reasons.push(prefix + "enter known shipping in USD cents (0 for free).");
    if (!comp.verified || comp.identityKey !== canonicalCardKey(draft.identity)) reasons.push(prefix + "verify the sold price, date and matching card identity / parallel.");
  });
  if (!Number.isFinite(pricing.premiumPercent) || pricing.premiumPercent < 8 || pricing.premiumPercent > 10) reasons.push("Premium must be between 8% and 10%.");
  const evidenceValid = reasons.length === 0;
  if (draft.identity.numberedTo && pricing.comps.filter(comp => comp.verified && comp.identityKey === canonicalCardKey(draft.identity)).length < MIN_STRONG_EXACT_SALES) reasons.push("Numbered card needs five verified exact sales or the orchestrator scarcity review; a thin comp cannot bypass the scarcity guard.");
  const generalPromotionPercent = pricing.generalPromotionPercent ?? 3;
  const promotionValid = Number.isFinite(generalPromotionPercent) && (generalPromotionPercent === 0 || (generalPromotionPercent >= 3 && generalPromotionPercent <= 5));
  if (!promotionValid) reasons.push("General promotion must be off (0%) or between 3% and 5%; review any increase above the 3% default.");
  // Use the seller's arithmetic average; round only the final listing price.
  const compValue = evidenceValid ? pricing.comps.reduce((sum, comp) => sum + comp.itemPrice, 0) / pricing.comps.length : null;
  const premiumPrice = compValue === null ? null : compValue * (1 + pricing.premiumPercent / 100);
  const calculated = compValue === null ? null : calculateCardPrice(compValue, { premiumPercent: pricing.premiumPercent, tracked: !!draft.identity.graded || pricing.needsTracked, patch: pricing.patchCard });
  const listingPrice = calculated?.item ?? null;
  const tracked = !!draft.identity.graded || pricing.needsTracked || (calculated !== null && calculated.roundedBase >= 20);
  const shippingCharge = calculated?.shipping ?? null;
  if (!tracked && listingPrice !== null && !pricing.envelopeEligible) reasons.push("Verify envelope eligibility for the packaged card, or choose tracked shipping.");
  if (projectListing(draft).requiresReview) reasons.push("Confirm card identity and front/back photos first.");
  const { approvedSnapshot: _approval, ...savedInputs } = pricing;
  const inputs = { ...savedInputs, generalPromotionPercent };
  const estimatedPromotionFeeBeforeTax = listingPrice === null || shippingCharge === null || !promotionValid ? null : round((listingPrice + shippingCharge) * generalPromotionPercent / 100);
  const snapshot = JSON.stringify({ method: CARD_POLICY_VERSION, sanityVersion: SCARCITY_GUARD_VERSION, identity: canonicalCardKey(draft.identity), front: draft.frontImageId, back: draft.backImageId, quantity: draft.quantity, inputs, listingPrice, shippingCharge });
  const approved = reasons.length === 0 && pricing.approvedSnapshot === snapshot;
  return { compValue, premiumPrice, roundingAdjustment: calculated === null || premiumPrice === null ? null : calculated.roundedBase - premiumPrice,
    freeEnvelopeConversion: calculated?.freeEnvelopeConversion ?? false, roundedBase: calculated?.roundedBase ?? null,
    effectivePremiumPercent: listingPrice === null || compValue === null ? null : (listingPrice / compValue - 1) * 100,
    listingPrice, shippingCharge, generalPromotionPercent, estimatedPromotionFeeBeforeTax, buyerTotal: listingPrice === null || shippingCharge === null ? null : round(listingPrice + shippingCharge),
    lowPrice: compValue === null ? null : priceFromSoldComp(compValue, 8), highPrice: compValue === null ? null : priceFromSoldComp(compValue, 10),
    shippingMethod: tracked ? "Tracked shipping" : "Envelope (eligibility must be verified)",
    approved, snapshot, reviewReasons: reasons, inputs, currency: "USD", basis: "Arithmetic average sold item price excluding shipping; apply 8–10% premium, round upward to .49/.95; eligible rounded bases under $3 add exactly $1.49 with free shipping and no second rounding; buyer total excludes tax", warnings: pricing.comps.length === 1 ? ["Only one sold comp: limited evidence. Review carefully."] : [] };
}
