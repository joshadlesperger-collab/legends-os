import { CARD_POLICY } from "./card-orchestrator-policy.ts";

/** Worker contract, not a claim that a report or the remote graph was read. */
export const PRICING_SOURCE_FIRST = Object.freeze({
  order: ["active-listings", "sold-listings", "knowledge-graph"] as const,
  requiredBeforeExternalResearch: true,
  stopWhenFreshValidatedEvidenceExists: true,
  soldEvidenceMaxAgeDays: CARD_POLICY.compMaxAgeDays,
  activeSnapshotMaxAgeMinutes: CARD_POLICY.reconciliationMaxAgeMinutes,
  pricingTimeboxSeconds: CARD_POLICY.researchLimitSeconds,
  fallback: {basis:"active-lowest",label:"active-listing estimate",match:"lowest verified exact single-card Buy It Now total including shipping",exclude:["own listings","auctions","lots","unselected variations","conditional discounts","unknown shipping","condition or variant mismatches"],preserveItemFloor:true,exactCents:true},
  historyWindow: "all-available" as const,
  instructions: [
    "Check saved active listings, seller sold history, and the local knowledge graph before external research. Record each source as checked with evidence, no match, stale, or unavailable; never imply unavailable sources were checked.",
    "Match exact product/year/card number/parallel, language, condition and single-card versus lot; preserve per-copy and serial exclusions. A title or player match alone is insufficient.",
    "Retain a matching current seller-set active price as an asking price, never as a sold comp. An old inventory snapshot requires a targeted refresh, not an inventory-wide browser scan.",
    "Keep all available sold history, including last year and older, for identity and context. Only validated sales within the supported freshness window enter current automatic calculations; use sale dates, not report download dates.",
    "Knowledge-graph prices inherit original evidence dates and provenance. Refreshing a cache or model agreement cannot make old or weak evidence fresh. Conflicts, missing shipping and a lone unvalidated comp are unresolved gaps.",
    "Once the three source checks are recorded and sufficient fresh validated evidence or a current matching seller-set price exists, reuse it and STOP external pricing research. Preserve current pricing mathematics and estimate labels.",
    "Research only documented gaps for up to30 seconds. If sold evidence remains insufficient, use the lowest verified exact active single-card Buy It Now total including known shipping as an active-listing estimate. Preserve the item floor and shipping eligibility; match cents without sold-price rounding. Exclude own listings, auctions, lots, unselected variations, conditional discounts and condition/variant mismatches. If no exact active match is verified, hand off unpriced. Do not reset the research clock for repeated searches.",
  ],
});
