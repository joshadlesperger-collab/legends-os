/** Deterministic veto, never an eBay write or a claim that scarcity guarantees value. */
export const SCARCITY_GUARD_VERSION = "scarcity-sanity-2026-10-22-v2";
export const MIN_STRONG_EXACT_SALES = 5;
export const MIN_RELATED_SALES = 3;
export type ScarcityAnchor = { saleId: string; sourceUrl: string; soldDate: string; buyerTotal: number; sourcePrintRun: number };
export function scarcityGuard(input: {
  targetPrintRun: number | null; proposedBuyerTotal: number; exactSoldCount: number;
  anchors: ScarcityAnchor[]; searchEvidence?: string; existingBuyerTotal?: number; exactSupportedBuyerTotal?: number;
}) {
  const reasons: string[] = [];
  const strongExact = input.exactSoldCount >= MIN_STRONG_EXACT_SALES;
  if (!Number.isFinite(input.proposedBuyerTotal) || input.proposedBuyerTotal <= 0) reasons.push("Invalid proposed buyer total");
  const numbered = input.targetPrintRun !== null;
  if (numbered && (!Number.isSafeInteger(input.targetPrintRun) || input.targetPrintRun! < 1)) reasons.push("Invalid target print run");
  if (numbered && !strongExact && !input.anchors.length && !input.searchEvidence?.trim()) reasons.push("Numbered card needs related-parallel sold evidence or a documented scarcity search before pricing");
  if (input.existingBuyerTotal !== undefined && input.proposedBuyerTotal < input.existingBuyerTotal * 0.75 && !strongExact) reasons.push("Price reduction exceeds 25%; preserve existing asking price pending strong exact evidence and review");
  if (input.exactSupportedBuyerTotal !== undefined && strongExact && input.proposedBuyerTotal + 0.005 < input.exactSupportedBuyerTotal) reasons.push("Proposed override undercuts its own exact sold evidence");
  const ordered = [...input.anchors].sort((a,b)=>a.sourcePrintRun-b.sourcePrintRun || b.soldDate.localeCompare(a.soldDate));
  // Consume complete lowest-print-run groups until the sample requirement is met.
  // /299 cannot dilute adequate /50 or /99 evidence simply because it is plentiful.
  const selected: ScarcityAnchor[] = [];
  for(const run of Array.from(new Set(ordered.map(a=>a.sourcePrintRun)))) {
    if(selected.length >= MIN_RELATED_SALES) break;
    selected.push(...ordered.filter(a=>a.sourcePrintRun===run));
  }
  const seen=new Set<string>();
  for(const a of input.anchors) {
    if(seen.has(a.saleId)||seen.has(a.sourceUrl)) reasons.push("Duplicate scarcity sale");
    seen.add(a.saleId);seen.add(a.sourceUrl);
    if(!Number.isFinite(a.buyerTotal)||a.buyerTotal<=0||!Number.isSafeInteger(a.sourcePrintRun)||a.sourcePrintRun<1) reasons.push("Invalid scarcity anchor");
  }
  if(numbered && !strongExact && input.anchors.length>0 && selected.length<MIN_RELATED_SALES) reasons.push("Related-parallel math needs at least three verified sold observations; retain as a review estimate");
  const calculations = selected.map(a => ({ ...a, targetPrintRun: input.targetPrintRun, estimatedBuyerTotal: numbered ? a.buyerTotal * a.sourcePrintRun / input.targetPrintRun! : null }));
  const validEstimates = calculations.map(a=>a.estimatedBuyerTotal).filter((v):v is number=>v!==null&&Number.isFinite(v)&&v>0);
  const estimate = validEstimates.length ? validEstimates.reduce((a,b)=>a+b,0)/validEstimates.length : null;
  if (numbered && !strongExact && estimate !== null && input.proposedBuyerTotal + 0.005 < estimate) reasons.push("Proposed price undercuts numbered-parallel math without five verified exact sales");
  return { version: SCARCITY_GUARD_VERSION, passed: reasons.length===0, reasons, calculations, estimatedBuyerTotal:estimate,
    excludedAnchors:ordered.filter(a=>!selected.includes(a)).map(a=>({...a,reason:"Lower-print-run evidence already meets sample requirement"})),
    method:strongExact?"exact-sold":estimate!==null?"related-print-run":"review", exactSoldCount:input.exactSoldCount,
    minimumExactSales:MIN_STRONG_EXACT_SALES,minimumRelatedSales:MIN_RELATED_SALES };
}
