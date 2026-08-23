import type { ListingCompletenessAssessment } from "./listing-completeness-agent.ts";
import type { SalesVelocityEvidence } from "./sales-velocity.ts";

export type WeekendSprintCohort = "A_COMPLETENESS" | "B_AD_TEST" | "C_CONTROL";
export type WeekendSprintRow = {
  cohort: WeekendSprintCohort; matchedFor: "A_COMPLETENESS" | "B_AD_TEST" | null;
  listingId: string; ebayItemId: string; title: string; currentPrice: number; currentAdRate: number | null;
  impressions: number; views: number; clickThroughRate: number | null; proposedAction: string; why: string;
  confidence: number; economicsWarning: string; categoryId: string;
};
export type WeekendTrafficSprint = { cohortA: WeekendSprintRow[]; cohortB: WeekendSprintRow[]; cohortC: WeekendSprintRow[]; excluded: Record<string, number> };
type Candidate = { row: SalesVelocityEvidence; assessment: ListingCompletenessAssessment; categoryId: string; impressions: number; views: number };

const SAFE_EXACT_FIELDS = new Set(["Sport", "Manufacturer", "Card Number"]);
const safePatch = (patch: ListingCompletenessAssessment["proposedPatch"][number]) => Boolean(patch.targetAspect) && (SAFE_EXACT_FIELDS.has(patch.targetAspect!) || patch.semanticFamily === "year");
const MAX_PILOT_SIZE = 100, MAX_PILOT_PRICE = 100, MAX_LOW_EXPOSURE_IMPRESSIONS = 25, MAX_LOW_EXPOSURE_VIEWS = 5;
const priceBand = (price: number) => price < 10 ? 0 : price < 25 ? 1 : price < 50 ? 2 : 3;
const safeIdentity = (assessment: ListingCompletenessAssessment) => Boolean(assessment.categoryId) && assessment.categoryRequirements.available && assessment.conflicts.length === 0 && assessment.malformedFields.length === 0 && !assessment.proposedPatch.some((patch) => patch.disposition !== "AUTO-FIX");
const economicsWarning = (row: SalesVelocityEvidence) => row.costComplete ? row.marginGuardrail : "Cost basis is incomplete; no advertising change may execute until margin is reviewed.";

function matchControls(treatments: WeekendSprintRow[], candidates: Candidate[], matchedFor: "A_COMPLETENESS" | "B_AD_TEST", used: Set<string>) {
  const controls: WeekendSprintRow[] = [];
  for (const treatment of treatments) {
    const pool = candidates.filter((candidate) => !used.has(candidate.row.listingId));
    pool.sort((left, right) => Number(left.categoryId !== treatment.categoryId) - Number(right.categoryId !== treatment.categoryId) || Math.abs(priceBand(left.row.currentPrice) - priceBand(treatment.currentPrice)) - Math.abs(priceBand(right.row.currentPrice) - priceBand(treatment.currentPrice)) || Math.abs(left.impressions - treatment.impressions) - Math.abs(right.impressions - treatment.impressions) || left.row.ebayItemId.localeCompare(right.row.ebayItemId));
    const selected = pool[0]; if (!selected) continue; used.add(selected.row.listingId);
    controls.push({ cohort: "C_CONTROL", matchedFor, listingId: selected.row.listingId, ebayItemId: selected.row.ebayItemId, title: selected.row.title, currentPrice: selected.row.currentPrice, currentAdRate: selected.row.advertising?.adRate ?? null, impressions: selected.impressions, views: selected.views, clickThroughRate: selected.row.traffic?.clickThroughRate ?? null, proposedAction: "NO INTERVENTION — CONTROL", why: `Matched ${matchedFor === "A_COMPLETENESS" ? "metadata" : "low-exposure ad"} control by category, price band, and traffic proximity.`, confidence: 99, economicsWarning: economicsWarning(selected.row), categoryId: selected.categoryId });
  }
  return controls;
}

export function buildWeekendTrafficSprint(rows: SalesVelocityEvidence[], assessments: ListingCompletenessAssessment[]): WeekendTrafficSprint {
  const assessmentById = new Map(assessments.map((assessment) => [assessment.listingId, assessment]));
  const excluded: Record<string, number> = { missingAssessment: 0, missingTraffic: 0, unsafeIdentity: 0, highValueAmbiguity: 0, adIneligible: 0, notLowExposure: 0 };
  const base: Candidate[] = rows.flatMap((row) => {
    const assessment = assessmentById.get(row.listingId); if (!assessment) { excluded.missingAssessment += 1; return []; }
    if (!row.traffic) { excluded.missingTraffic += 1; return []; }
    if (!safeIdentity(assessment)) { excluded.unsafeIdentity += 1; return []; }
    if (row.currentPrice > MAX_PILOT_PRICE) { excluded.highValueAmbiguity += 1; return []; }
    return [{ row, assessment, categoryId: assessment.categoryId!, impressions: row.traffic.impressions ?? 0, views: row.traffic.views ?? 0 }];
  });
  const cohortA = base.flatMap(({ row, assessment, categoryId, impressions, views }) => {
    const patches = assessment.proposedPatch.filter((patch) => patch.disposition === "AUTO-FIX" && patch.confidence >= 99 && safePatch(patch));
    if (!patches.length || assessment.disposition !== "AUTO-FIX") return [];
    return [{ cohort: "A_COMPLETENESS" as const, matchedFor: null, listingId: row.listingId, ebayItemId: row.ebayItemId, title: row.title, currentPrice: row.currentPrice, currentAdRate: row.advertising?.adRate ?? null, impressions, views, clickThroughRate: row.traffic?.clickThroughRate ?? null, proposedAction: patches.map((patch) => `${patch.targetAspect} → ${patch.proposed}`).join("; "), why: "Only missing, exact-Taxonomy-targeted, deterministic 99%-confidence metadata fields are proposed; no existing seller value or sensitive attribute is touched.", confidence: Math.min(...patches.map((patch) => patch.confidence)), economicsWarning: economicsWarning(row), categoryId }];
  }).sort((a, b) => a.impressions - b.impressions || a.ebayItemId.localeCompare(b.ebayItemId)).slice(0, MAX_PILOT_SIZE);
  const aIds = new Set(cohortA.map((row) => row.listingId));
  const adCandidates = base.filter(({ row }) => {
    if (aIds.has(row.listingId)) return false;
    const rate = row.advertising?.adRate, adStatus = row.advertising?.adStatus?.toUpperCase() ?? "", campaignStatus = row.advertising?.campaignStatus?.toUpperCase() ?? "";
    const eligible = row.advertising?.eligible === true && rate != null && Number.isFinite(rate) && rate >= 0 && rate <= 20 && !/(ENDED|DELETED|PAUSED)/.test(adStatus) && !/(ENDED|DELETED|PAUSED)/.test(campaignStatus);
    if (!eligible) { excluded.adIneligible += 1; return false; }
    const lowExposure = (row.ageDays ?? 0) >= 14 && (row.traffic?.impressions ?? Infinity) <= MAX_LOW_EXPOSURE_IMPRESSIONS && (row.traffic?.views ?? Infinity) <= MAX_LOW_EXPOSURE_VIEWS && (row.traffic?.transactions ?? Infinity) === 0 && row.units30 === 0;
    if (!lowExposure) excluded.notLowExposure += 1; return lowExposure;
  }).sort((left, right) => left.impressions - right.impressions || left.views - right.views || left.row.ebayItemId.localeCompare(right.row.ebayItemId));
  const cohortB: WeekendSprintRow[] = [], bControlCandidates: Candidate[] = [];
  for (let index = 0; index < adCandidates.length; index += 1) {
    const candidate = adCandidates[index]; if (index % 2 === 1 || cohortB.length >= MAX_PILOT_SIZE) { bControlCandidates.push(candidate); continue; }
    const { row, categoryId, impressions, views } = candidate;
    cohortB.push({ cohort: "B_AD_TEST", matchedFor: null, listingId: row.listingId, ebayItemId: row.ebayItemId, title: row.title, currentPrice: row.currentPrice, currentAdRate: row.advertising?.adRate ?? null, impressions, views, clickThroughRate: row.traffic?.clickThroughRate ?? null, proposedAction: `PROPOSE +3 points (${row.advertising!.adRate}% → ${(row.advertising!.adRate! + 3).toFixed(1)}%)`, why: `At least 14 days old with ${impressions} impressions, ${views} views, zero transactions, and zero 30-day sales; advertising is eBay-eligible.`, confidence: row.costComplete ? 95 : 82, economicsWarning: economicsWarning(row), categoryId });
  }
  const used = new Set([...cohortA, ...cohortB].map((row) => row.listingId));
  const aControls = matchControls(cohortA, base.filter(({ assessment }) => assessment.proposedPatch.length === 0), "A_COMPLETENESS", used);
  const bControls = matchControls(cohortB, bControlCandidates, "B_AD_TEST", used);
  return { cohortA, cohortB, cohortC: [...aControls, ...bControls], excluded };
}
