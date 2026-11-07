/** Browser-safe current pricing contract. Legacy values remain audit evidence only. */
export const CURRENT_CARD_PRICE_POLICY = "buyer-total-no-buffer-tiered-floor149-condition10-25-v1";
export const MINIMUM_CARD_ITEM = 1.49;
/** Disabled offers have no thresholds to enter. Enabled offers must stay below Buy It Now. */
export function cardOfferSettings(item: number) {
  if (!Number.isFinite(item) || item < MINIMUM_CARD_ITEM || Math.abs(item * 100 - Math.round(item * 100)) > 1e-6) {
    throw new Error("Offer settings require an item price of at least $1.49 in whole cents");
  }
  if (item === MINIMUM_CARD_ITEM) return { offersEnabled: false, minimumOffer: undefined, autoAccept: undefined };
  const maximum = Math.round(item * 100) - 1;
  const threshold = (percent: number) => Math.min(maximum, Math.max(149, Math.ceil(item * percent - 1e-7))) / 100;
  return { offersEnabled: true, minimumOffer: threshold(80), autoAccept: threshold(90) };
}
export function currentEvidencePrice(p: {policy?:string;evidenceKey?:string;evidenceExpiresAt?:string;item:number;shipping:number|null;stale?:boolean}|null|undefined,now=Date.now()) {
 return !!p && p.policy===CURRENT_CARD_PRICE_POLICY && /^[a-f0-9]{64}$/.test(p.evidenceKey??"")
  && Number.isFinite(Date.parse(p.evidenceExpiresAt??"")) && Date.parse(p.evidenceExpiresAt!)>now
  && !p.stale && Number.isFinite(p.item) && p.item>=MINIMUM_CARD_ITEM
  && p.shipping!==null && Number.isFinite(p.shipping) && p.shipping>=0;
}

const cents = (n: number) => Math.round(n * 100) / 100;
const amount = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1_000_000;

/** Target is a reviewed market buyer total, never an item-only mean. Shipping is explicit. */
export function candidatePrice(targetTotal: number, shipping: number) {
  if (!amount(targetTotal) || targetTotal <= 0 || !amount(shipping)) throw Error("Known positive buyer total and nonnegative shipping required");
  const rawItem = targetTotal - shipping;
  const endings: number[] = [];
  const dollar = Math.max(1, Math.floor(rawItem));
  for (let d = Math.max(1, dollar - 1); d <= dollar + 1; d++) endings.push(d + .49, d + .95);
  const choices = endings.filter(n => n >= 1.49);
  const item = rawItem <= 3
    ? choices.sort((a, b) => { const delta = Math.abs(a - rawItem) - Math.abs(b - rawItem); return Math.abs(delta) < 1e-9 ? a - b : delta; })[0]
    : choices.filter(n => n + 1e-9 >= rawItem).sort((a, b) => a - b)[0];
  return { policyVersion: CURRENT_CARD_PRICE_POLICY, targetBuyerTotal: targetTotal, unroundedItem: rawItem,
    item: cents(item), shipping, buyerTotal: cents(item + shipping), roundingAdjustment: cents(item - rawItem),
    automaticBufferPercent: 0, economicsReview: rawItem < 1.49,
    approved: false as const, canUpload: false as const, canPublish: false as const };
}

