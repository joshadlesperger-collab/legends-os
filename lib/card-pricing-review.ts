import { canonicalCardKey, priceFromSoldComp, projectListing, suggestedShipping, type DraftCard } from "./card-listing-factory.ts";

export type SoldComp = { id: string; sourceUrl: string; soldDate: string; itemPrice: number; shipping: number; notes: string; verified: boolean; identityKey?: string };
export type PricingReview = { comps: SoldComp[]; premiumPercent: number; needsTracked: boolean; envelopeEligible: boolean; approvedSnapshot?: string };
export const emptyPricing = (): PricingReview => ({ comps: [], premiumPercent: 9, needsTracked: false, envelopeEligible: false });
const cents = (n: number, positive: boolean) => Number.isFinite(n) && (positive ? n > 0 : n >= 0) && n <= 1_000_000 && Math.abs(n * 100 - Math.round(n * 100)) < 0.000001;
const round = (n: number) => Math.round(n * 100) / 100;

export function roundUpListingPrice(value: number): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error("Listing price must be positive and finite.");
  const minimumCents = Math.ceil(value * 100 - 0.0000001);
  const dollars = Math.floor(minimumCents / 100) * 100;
  const ending = minimumCents - dollars;
  return (ending <= 49 ? dollars + 49 : ending <= 95 ? dollars + 95 : dollars + 149) / 100;
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
  // Use the seller's arithmetic average; round only the final listing price.
  const compValue = evidenceValid ? pricing.comps.reduce((sum, comp) => sum + comp.itemPrice, 0) / pricing.comps.length : null;
  const premiumPrice = compValue === null ? null : compValue * (1 + pricing.premiumPercent / 100);
  const listingPrice = premiumPrice === null ? null : roundUpListingPrice(premiumPrice);
  const tracked = !!draft.identity.graded || pricing.needsTracked || (listingPrice !== null && listingPrice >= 20);
  const shippingCharge = listingPrice === null ? null : suggestedShipping(listingPrice, tracked);
  if (!tracked && listingPrice !== null && !pricing.envelopeEligible) reasons.push("Verify envelope eligibility for the packaged card, or choose tracked shipping.");
  if (projectListing(draft).requiresReview) reasons.push("Confirm card identity and front/back photos first.");
  const { approvedSnapshot: _approval, ...inputs } = pricing;
  const snapshot = JSON.stringify({ method: "mean-endings-up-v2", identity: canonicalCardKey(draft.identity), front: draft.frontImageId, back: draft.backImageId, quantity: draft.quantity, inputs, listingPrice, shippingCharge });
  const approved = reasons.length === 0 && pricing.approvedSnapshot === snapshot;
  return { compValue, premiumPrice, roundingAdjustment: listingPrice === null || premiumPrice === null ? null : listingPrice - premiumPrice,
    effectivePremiumPercent: listingPrice === null || compValue === null ? null : (listingPrice / compValue - 1) * 100,
    listingPrice, shippingCharge, buyerTotal: listingPrice === null || shippingCharge === null ? null : round(listingPrice + shippingCharge),
    lowPrice: compValue === null ? null : priceFromSoldComp(compValue, 8), highPrice: compValue === null ? null : priceFromSoldComp(compValue, 10),
    shippingMethod: tracked ? "Tracked shipping" : "Envelope (eligibility must be verified)",
    approved, snapshot, reviewReasons: reasons, inputs, currency: "USD", basis: "Arithmetic average sold item price excluding shipping; apply 8–10% base premium, then round up to next .49 or .95 for all cards; buyer total excludes tax", warnings: pricing.comps.length === 1 ? ["Only one sold comp: limited evidence. Review carefully."] : [] };
}
