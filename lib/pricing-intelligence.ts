/** Pricing intelligence foundation: pure functions; no listing side effects. */
export type VerifiedSale = { id: string; variantKey: string; playerId: string; productId: string; parallelId: string; serialMax?: number | null; soldAt: string; itemPrice: number; shippingPrice: number; sourceUrl: string; verified: boolean; condition: string; excluded?: boolean };
export type TargetVariant = { variantKey: string; playerId: string; productId: string; parallelId: string; serialMax?: number | null; condition: string };
export type Estimate = { method: "verified-exact" | "inferred-parallel" | "review"; fairValue: number | null; evidenceIds: string[]; confidence: "high" | "medium" | "low"; reviewRequired: boolean; reasons: string[] };
const median = (values: number[]) => { const s = [...values].sort((a,b)=>a-b); return s.length % 2 ? s[(s.length-1)/2] : (s[s.length/2-1]+s[s.length/2])/2; };
const valid = (s: VerifiedSale, asOf: string) => s.verified && !s.excluded && s.soldAt <= asOf && Number.isFinite(s.itemPrice) && s.itemPrice > 0 && Number.isFinite(s.shippingPrice) && s.shippingPrice >= 0 && /^https:\/\//.test(s.sourceUrl);
export function estimateVariant(target: TargetVariant, sales: VerifiedSale[], asOf: string): Estimate {
  const eligible = sales.filter(s => valid(s, asOf) && s.condition === target.condition);
  const exact = eligible.filter(s => s.variantKey === target.variantKey);
  if (exact.length >= 3) return { method:"verified-exact", fairValue:median(exact.map(s=>s.itemPrice+s.shippingPrice)), evidenceIds:exact.map(s=>s.id), confidence:"high", reviewRequired:false, reasons:["Median landed price of verified exact completed sales"] };
  // Infer only from measured, matched-player parallel pairs; never invent a fixed multiplier.
  const anchor = eligible.filter(s => s.playerId === target.playerId && s.productId === target.productId && s.parallelId !== target.parallelId);
  const ratios: { ratio:number; ids:string[] }[] = [];
  for (const other of new Set(anchor.map(s=>s.parallelId))) {
    const source = anchor.filter(s=>s.parallelId===other);
    const targetPeers = eligible.filter(s=>s.productId===target.productId && s.parallelId===target.parallelId && s.playerId!==target.playerId);
    const otherPeers = eligible.filter(s=>s.productId===target.productId && s.parallelId===other && s.playerId!==target.playerId);
    const common = [...new Set(targetPeers.map(s=>s.playerId))].filter(p=>otherPeers.some(s=>s.playerId===p));
    const pairs = common.map(p=>({t:targetPeers.filter(s=>s.playerId===p),o:otherPeers.filter(s=>s.playerId===p)})).filter(p=>p.t.length>=2 && p.o.length>=2);
    if (source.length < 2 || pairs.length < 3) continue;
    const measured = pairs.map(p=>median(p.t.map(s=>s.itemPrice+s.shippingPrice))/median(p.o.map(s=>s.itemPrice+s.shippingPrice))).filter(n=>Number.isFinite(n)&&n>0);
    if (measured.length < 3) continue;
    ratios.push({ratio:median(measured),ids:[...source,...pairs.flatMap(p=>[...p.t,...p.o])].map(s=>s.id)});
  }
  if (ratios.length) {
    const best = ratios[0]; const source = eligible.filter(s=>best.ids.includes(s.id)&&s.playerId===target.playerId&&s.productId===target.productId&&s.parallelId!==target.parallelId);
    if (source.length>=2) return {method:"inferred-parallel",fairValue:Math.round(median(source.map(s=>s.itemPrice+s.shippingPrice))*best.ratio*100)/100,evidenceIds:[...new Set(best.ids)],confidence:"low",reviewRequired:true,reasons:["Inferred from observed matched-player parallel ratios; requires approval"]};
  }
  return {method:"review",fairValue:null,evidenceIds:exact.map(s=>s.id),confidence:"low",reviewRequired:true,reasons:[exact.length?"Insufficient exact verified sales":"No verified exact sales","Insufficient matched-player parallel evidence; do not fabricate a price"]};
}
