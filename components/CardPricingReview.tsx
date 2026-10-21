"use client";

import { canonicalCardKey, type DraftCard } from "@/lib/card-listing-factory";
import { emptyPricing, projectPricing, type PricingReview, type SoldComp } from "@/lib/card-pricing-review";

const money = (value: number | null) => value === null ? "Awaiting verified comps" : `$${value.toFixed(2)}`;
export default function CardPricingReview({ draft, onChange }: { draft: DraftCard; onChange: (value: PricingReview) => void }) {
  const pricing = draft.pricing ?? emptyPricing();
  const result = projectPricing(draft);
  const change = (patch: Partial<PricingReview>) => onChange({ ...pricing, ...patch, approvedSnapshot: undefined });
  const compChange = (id: string, patch: Partial<SoldComp>) => change({ comps: pricing.comps.map(comp => comp.id === id ? { ...comp, ...patch, verified: patch.verified ?? false } : comp) });
  return <section className="factory-pricing" aria-label="Pricing and shipping review">
    <h2>Pricing and shipping</h2>
    <p>Use eBay sold listings above for browser-assisted research; an API subscription is not needed for that workflow. The app does not automatically read your signed-in eBay tab. Connected-provider lookup is a separate option. All amounts are USD.</p>
    <p>We use the arithmetic average sold <strong>item price excluding shipping</strong>, applying the premium before rounding the final price. Record shipping separately to compare buyer totals. Verify exact year, set, player, parallel, print run and comparable condition; asking prices and hidden Best Offer prices are not verified sales.</p>
    {pricing.comps.map((comp, index) => <fieldset key={comp.id}>
      <legend>Sold comp {index + 1}</legend>
      <div className="factory-fields">
        <label>Source link<input type="url" value={comp.sourceUrl} onChange={event => compChange(comp.id, { sourceUrl: event.target.value })} /></label>
        <label>Sale date<input type="date" value={comp.soldDate} onChange={event => compChange(comp.id, { soldDate: event.target.value })} /></label>
        <label>Sold item price ($)<input type="number" min="0.01" step="0.01" value={Number.isFinite(comp.itemPrice) ? comp.itemPrice : ""} onChange={event => compChange(comp.id, { itemPrice: event.target.value === "" ? NaN : Number(event.target.value) })} /></label>
        <label>Comp shipping ($)<input type="number" min="0" step="0.01" value={Number.isFinite(comp.shipping) ? comp.shipping : ""} onChange={event => compChange(comp.id, { shipping: event.target.value === "" ? NaN : Number(event.target.value) })} /></label>
        <label>Match / condition notes<input value={comp.notes} onChange={event => compChange(comp.id, { notes: event.target.value })} /></label>
      </div>
      <p>Comp buyer total before tax: {money(Number.isFinite(comp.itemPrice) && Number.isFinite(comp.shipping) ? comp.itemPrice + comp.shipping : null)}</p>
      <label><span><input type="checkbox" checked={comp.verified && comp.identityKey === canonicalCardKey(draft.identity)} onChange={event => compChange(comp.id, { verified: event.target.checked, identityKey: canonicalCardKey(draft.identity) })} /> I verified this sold price, sale date and matching identity / parallel.</span></label>
      <button type="button" onClick={() => change({ comps: pricing.comps.filter(value => value.id !== comp.id) })}>Remove comp {index + 1}</button>
    </fieldset>)}
    <p><button type="button" disabled={pricing.comps.length >= 20} onClick={() => change({ comps: [...pricing.comps, { id: crypto.randomUUID(), sourceUrl: "", soldDate: "", itemPrice: NaN, shipping: NaN, notes: "", verified: false }] })}>Add sold comp</button></p>
    <div className="factory-fields">
      <label>Premium above comp (%)<input type="number" min="8" max="10" step="0.1" value={Number.isFinite(pricing.premiumPercent) ? pricing.premiumPercent : ""} onChange={event => change({ premiumPercent: event.target.value === "" ? NaN : Number(event.target.value) })} /></label>
      <label><span><input type="checkbox" checked={pricing.needsTracked} onChange={event => change({ needsTracked: event.target.checked })} /> Require tracked shipping (slab, thick card / patch, or operator choice)</span></label>
      <label><span><input type="checkbox" checked={pricing.patchCard ?? false} onChange={event => change({ patchCard: event.target.checked })} /> Raw patch / jersey card ($1.95 envelope charge when eligible, unless the under-$3 free-envelope rule applies)</span></label>
      <label><span><input type="checkbox" checked={pricing.envelopeEligible} onChange={event => change({ envelopeEligible: event.target.checked })} /> I verified current envelope service eligibility, packaged dimensions, weight and value.</span></label>
    </div>
    <p>Seller charge rules: a rounded base under $3 adds exactly $1.49 to the item price with free envelope shipping. Other cards under $10 → $1.49; $10–$19.99 or eligible raw patches → $1.95; $20+ or tracked → $6.29. These are proposed buyer charges, not purchased postage or verified carrier rates. Graded cards require tracked shipping.</p>
    <fieldset>
      <legend>General promotion</legend>
      <label><span><input type="checkbox" checked={result.generalPromotionPercent !== 0} onChange={event => change({ generalPromotionPercent: event.target.checked ? 3 : 0 })} /> Include General promotion (default 3%)</span></label>
      {result.generalPromotionPercent !== 0 && <label>General ad rate (%)<input type="number" min="3" max="5" step="0.1" value={Number.isFinite(result.generalPromotionPercent) ? result.generalPromotionPercent : ""} onChange={event => change({ generalPromotionPercent: event.target.value === "" ? NaN : Number(event.target.value) })} /></label>}
      <p>Use 3% by default. An increase up to 5% needs review and renewed financial approval. No automatic increases or Priority advertising.</p>
      <p>Estimated General promotion expense before tax: <strong>{money(result.estimatedPromotionFeeBeforeTax)}</strong>. This uses item price plus buyer shipping. eBay also includes applicable tax and other applicable fees in its fee basis when an attributed sale qualifies. This estimate is separate from other selling fees and is not profit. Promotion never raises the proposed card price.</p>
      <p>This saves a review setting; verify the rate in eBay before publishing. Local approval does not activate an eBay campaign.</p>
    </fieldset>
    <dl className="factory-price-summary">
      <div><dt>Verified comp average</dt><dd>{money(result.compValue)}</dd></div>
      <div><dt>8–10% before ending adjustment</dt><dd>{result.lowPrice === null ? "Awaiting verified comps" : `${money(result.lowPrice)}–${money(result.highPrice)}`}</dd></div>
      <div><dt>Proposed listing price</dt><dd>{money(result.listingPrice)}</dd></div>
      <div><dt>Buyer shipping charge</dt><dd>{money(result.shippingCharge)}</dd></div>
      <div><dt>Buyer total before tax</dt><dd>{money(result.buyerTotal)}</dd></div>
    </dl>
    <p>Apply the base premium, then round upward to the next .49 or .95 ending. For an eligible rounded base under $3, add exactly $1.49 and use free shipping without rounding again. This may put the final price above 10% over comp.</p>
    {result.freeEnvelopeConversion && <p>Rounded base {money(result.roundedBase)} + $1.49 included postage = {money(result.listingPrice)} with free buyer shipping.</p>}
    {result.effectivePremiumPercent !== null && <p>Before ending adjustment: {money(result.premiumPrice)}. Final premium above comp: {result.effectivePremiumPercent.toFixed(1)}%.</p>}
    {result.shippingCharge !== null && <p>{result.shippingMethod}</p>}
    {result.warnings.map(warning => <p key={warning} role="note">{warning}</p>)}
    {result.reviewReasons.length > 0 && <div role="status"><strong>Before price approval:</strong><ul>{result.reviewReasons.map(reason => <li key={reason}>{reason}</li>)}</ul></div>}
    <button type="button" disabled={result.reviewReasons.length > 0 || result.approved} onClick={() => { const latest = projectPricing(draft); if (!latest.reviewReasons.length) onChange({ ...pricing, approvedSnapshot: latest.snapshot }); }}>Approve price and shipping for local review</button>
    <p role="status">{result.approved ? "Price, shipping and promotion approved locally." : "Price, shipping and promotion awaiting approval."} Changes to comps, premium, shipping, promotion, identity or photos require approval again.</p>
    <button type="button" disabled>Create eBay draft — integration not connected</button>
    <p>Local approval does not authorize eBay publishing. No postage or marketplace action is performed.</p>
  </section>;
}
