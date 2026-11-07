import { CURRENT_CARD_PRICE_POLICY, candidatePrice, cardOfferSettings } from "./card-price-policy.ts";
/** The current, explicitly reconfirmed listing-chat rule. No network or account writes. */
export const CARD_POLICY_VERSION = CURRENT_CARD_PRICE_POLICY;
// Formula changes do not discard validated evidence, reopen holds or reset worker attempts.
export const CARD_EVIDENCE_VERSION = "item-only-9pct-49-95-under3-plus149-v1";
export const CARD_POLICY = Object.freeze({
  version: CARD_POLICY_VERSION,
  seller: "imaydit58",
  marketplace: "EBAY_US",
  premiumPercent: 0,
  specialPremiumPercent: 15,
  minimumDirectColorMatchSales: 2,
  researchLimitSeconds: 30,
  leaseSeconds: 300,
  maxAttemptsPerInput: 2,
  compMaxAgeDays: 90,
  reconciliationMaxAgeMinutes: 60,
  generalPromotionPercent: 3,
  priorityPromotion: false,
  mode: "local-preparation-only",
});

export type PremiumIdentity = { serial?: string; printRun?: number | null; colorMatch?: { matches: boolean; evidence: string } };
/** Seller-authorized normalization of lower-condition raw sales to Near Mint inventory. */
export function conditionCompAdjustment(target: string, source: string) {
  const percent = target === "Near mint or better" ? source === "Excellent" ? 10 : source === "Very good" ? 25 : 0 : 0;
  if (source !== "Unknown" && source !== target && !percent) throw new Error("Unsupported condition conversion");
  return { percent, multiplier: 1 + percent / 100 };
}
export function cardPremiumReasons(identity: PremiumIdentity): string[] {
  const reasons: string[] = [], serial = /^(\d+)\/(\d+)$/.exec(identity.serial?.trim() ?? "");
  if (serial && identity.printRun && Number(serial[2]) === identity.printRun && Number(serial[1]) >= 1 && Number(serial[1]) <= identity.printRun) {
    if (Number(serial[1]) === 1) reasons.push("First on print");
    if (Number(serial[1]) === identity.printRun) reasons.push("Last on print");
  }
  if (identity.colorMatch?.matches && identity.colorMatch.evidence.trim()) reasons.push("Verified color match");
  return reasons;
}

/** Ordinary sources support a single 15% uplift. Comparable premiums already in sold prices are retained once. */
export function premiumCompAdjustment(target: PremiumIdentity, source: PremiumIdentity, directColorMatch = false) {
  const targetReasons = cardPremiumReasons(target), sourceReasons = cardPremiumReasons(source);
  const targetSerial=targetReasons.some(r=>r!=="Verified color match"),sourceSerial=sourceReasons.some(r=>r!=="Verified color match");
  const targetColor=targetReasons.includes("Verified color match"),sourceColor=sourceReasons.includes("Verified color match");
  if ((sourceSerial&&!targetSerial)||(sourceColor&&!targetColor)) throw new Error("Premium comp cannot price an ordinary copy; use a matching non-premium sold comparison");
  const uplift=(targetSerial&&!sourceSerial)||(targetColor&&!directColorMatch&&!sourceColor);
  return { targetReasons, sourceReasons, premiumPercent: uplift ? CARD_POLICY.specialPremiumPercent : 0,
    multiplier: uplift ? 1 + CARD_POLICY.specialPremiumPercent / 100 : 1 };
}

export function roundUpCardPrice(value: number) {
  if (!Number.isFinite(value) || value <= 0 || value > 1_100_000) throw new Error("Invalid positive price");
  const cents = Math.ceil(value * 100 - 1e-7), dollars = Math.floor(cents / 100) * 100;
  return [dollars + 49, dollars + 95, dollars + 149].find(x => x >= cents)! / 100;
}

export function calculateCardPrice(mean: number, options: {
  premiumPercent?: number; patch?: boolean; tracked?: boolean;
  override?: { item: number; shipping: number; evidence: string };
} = {}) {
  const premium = options.premiumPercent ?? 0;
  if (!Number.isFinite(mean) || mean <= 0 || mean > 1_000_000 || premium !== 0) throw new Error("Known positive buyer-total basis and no automatic buffer required");
  const shipping = options.tracked || mean >= 20 ? 6.29 : mean < 3 ? 0 : options.patch || mean >= 10 ? 1.95 : 1.49;
  const proposal = candidatePrice(mean, shipping);
  let item = proposal.item, buyerShipping = shipping;
  if (options.override) {
    const o = options.override;
    if (!o.evidence.trim() || !money(o.item, true) || o.item < 1.49 || !money(o.shipping)) throw new Error("Price override needs evidence, item floor $1.49 and valid shipping");
    item = o.item; buyerShipping = o.shipping;
  }
  return { policyVersion: CARD_POLICY_VERSION, compMean: mean, targetBuyerTotal:mean, premiumPercent: 0, premiumAdjusted: mean,
    roundedBase: proposal.item, item, shipping:buyerShipping, buyerTotal: Math.round((item + buyerShipping) * 100) / 100,
    ...cardOfferSettings(item),
    freeEnvelopeConversion: false, overridden: !!options.override };

}

export function money(value: unknown, positive = false): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= (positive ? 0.01 : 0) && value <= 1_000_000 && Math.abs(value * 100 - Math.round(value * 100)) < 1e-6;
}
