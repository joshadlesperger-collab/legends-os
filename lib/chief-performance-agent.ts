import type { SalesVelocityData, SalesVelocityEvidence } from "./sales-velocity.ts";

export const CHIEF_PERFORMANCE_AGENT_VERSION = "cpa-v1.0.0";
export type PerformanceHypothesis = {
  listingId: string; ebayItemId: string; category: "visibility" | "conversion" | "pricing" | "evidence";
  priority: number; reason: string; proposedResearch: string; requiresApproval: boolean;
};
export type PerformanceReportCard = {
  version: string; generatedAt: string; listings: number; sales30: number; sales90: number;
  listingsWithTraffic: number; listingsMissingTraffic: number; completeEvidence: number;
  providerFailures: string[]; hypotheses: PerformanceHypothesis[]; readOnly: true;
};
function classify(row: SalesVelocityEvidence): PerformanceHypothesis {
  const impressions = row.traffic?.impressions;
  const views = row.traffic?.views;
  if (impressions == null || views == null) return {listingId:row.listingId,ebayItemId:row.ebayItemId,category:"evidence",priority:90,reason:"Traffic evidence unavailable; no inference of zero impressions",proposedResearch:"Retrieve authorized eBay traffic report and verify source freshness",requiresApproval:false};
  if (impressions < 25 && row.units30 === 0) return {listingId:row.listingId,ebayItemId:row.ebayItemId,category:"visibility",priority:75,reason:"Low measured search exposure and no recent sales",proposedResearch:"Compare Best Match visibility, title, item specifics and comparable listings",requiresApproval:false};
  if (views >= 10 && row.units30 === 0) return {listingId:row.listingId,ebayItemId:row.ebayItemId,category:"conversion",priority:70,reason:"Measured views without a sale",proposedResearch:"Compare delivered price, images, shipping, demand and buyer alternatives",requiresApproval:false};
  if (row.valuation.action && row.valuation.confidence != null && row.valuation.confidence >= 60) return {listingId:row.listingId,ebayItemId:row.ebayItemId,category:"pricing",priority:55,reason:"Existing valuation doctrine identifies a supported pricing review",proposedResearch:"Validate recent sold comps and contribution margin; prepare governed proposal",requiresApproval:true};
  return {listingId:row.listingId,ebayItemId:row.ebayItemId,category:"evidence",priority:10,reason:"No sufficiently supported intervention",proposedResearch:"Observe next measurement window without modifying listing",requiresApproval:false};
}
export function buildPerformanceReportCard(data: SalesVelocityData, limit=25): PerformanceReportCard {
  if (!Number.isInteger(limit) || limit < 0 || limit > 500) throw new Error("Invalid investigation limit");
  const hypotheses=data.rows.map(classify).sort((a,b)=>b.priority-a.priority || a.ebayItemId.localeCompare(b.ebayItemId)).slice(0,limit);
  return {version:CHIEF_PERFORMANCE_AGENT_VERSION,generatedAt:data.generatedAt,listings:data.rows.length,sales30:data.rows.reduce((s,r)=>s+r.units30,0),sales90:data.rows.reduce((s,r)=>s+r.units90,0),listingsWithTraffic:data.rows.filter(r=>r.traffic!=null).length,listingsMissingTraffic:data.rows.filter(r=>r.traffic==null).length,completeEvidence:data.completeEvidenceCount,providerFailures:data.probes.filter(p=>p.status!=="succeeded").map(p=>p.provider+": "+p.status),hypotheses,readOnly:true};
}
