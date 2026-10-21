/** The current, explicitly reconfirmed listing-chat rule. No network or account writes. */
export const CARD_POLICY_VERSION = "item-only-9pct-49-95-under3-plus149-v1";
export const CARD_POLICY = Object.freeze({
  version: CARD_POLICY_VERSION,
  seller: "imaydit58",
  marketplace: "EBAY_US",
  premiumPercent: 9,
  researchLimitSeconds: 90,
  leaseSeconds: 300,
  maxAttemptsPerInput: 2,
  compMaxAgeDays: 90,
  reconciliationMaxAgeMinutes: 60,
  generalPromotionPercent: 3,
  priorityPromotion: false,
  mode: "local-preparation-only",
});

export function roundUpCardPrice(value: number) {
  if (!Number.isFinite(value) || value <= 0 || value > 1_100_000) throw new Error("Invalid positive price");
  const cents = Math.ceil(value * 100 - 1e-7), dollars = Math.floor(cents / 100) * 100;
  return [dollars + 49, dollars + 95, dollars + 149].find(x => x >= cents)! / 100;
}

export function calculateCardPrice(mean: number, options: {
  premiumPercent?: number; patch?: boolean; tracked?: boolean;
  override?: { item: number; shipping: number; evidence: string };
} = {}) {
  const premium = options.premiumPercent ?? CARD_POLICY.premiumPercent;
  if (!Number.isFinite(mean) || mean <= 0 || mean > 1_000_000 || !Number.isFinite(premium) || premium < 8 || premium > 10) throw new Error("Invalid comp basis or premium");
  const target = mean * (1 + premium / 100), base = roundUpCardPrice(target);
  // A low-price card requiring tracked shipping cannot use the free-envelope conversion.
  const converted = base < 3 && !options.tracked;
  let item = Math.round((base + (converted ? 1.49 : 0)) * 100) / 100;
  let shipping = options.tracked || base >= 20 ? 6.29 : converted ? 0 : options.patch || base >= 10 ? 1.95 : 1.49;
  if (options.override) {
    const o = options.override;
    if (!o.evidence.trim() || !money(o.item, true) || !money(o.shipping)) throw new Error("Price override needs explicit evidence and valid item/shipping amounts");
    item = o.item; shipping = o.shipping;
  }
  return { policyVersion: CARD_POLICY_VERSION, compMean: mean, premiumPercent: premium, premiumAdjusted: target,
    roundedBase: base, item, shipping, buyerTotal: Math.round((item + shipping) * 100) / 100,
    minimumOffer: Math.min(item, Math.max(shipping === 0 ? 1.49 : 0, Math.ceil(item * 80 - 1e-7) / 100)),
    autoAccept: Math.min(item, Math.max(shipping === 0 ? 1.49 : 0, Math.ceil(item * 90 - 1e-7) / 100)),
    freeEnvelopeConversion: converted && !options.override, overridden: !!options.override };
}

export function money(value: unknown, positive = false): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= (positive ? 0.01 : 0) && value <= 1_000_000 && Math.abs(value * 100 - Math.round(value * 100)) < 1e-6;
}
