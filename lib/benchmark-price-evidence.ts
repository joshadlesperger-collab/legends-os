import {z} from 'zod';

/** Research quality gate, not a replacement for approved pricing/rounding rules.
 * Three observations are a minimum review sample, never statistical proof of value.
 * Model votes are deliberately absent: repeated interpretations cannot add sales.
 */
const packetSchema=z.object({asOf:z.string().date(),identityKey:z.string().min(1),variantVerified:z.literal(true),identityEvidence:z.string().min(1),comps:z.array(z.object({
 sourceUrl:z.string().url(),identityKey:z.string().min(1),soldDate:z.string().date(),item:z.number().positive(),shipping:z.number().nonnegative(),currency:z.literal('USD'),
 soldVerified:z.literal(true),photoMatchVerified:z.literal(true),singleRawCard:z.literal(true),priceDisclosed:z.literal(true),ownAcquisition:z.literal(false),evidence:z.string().min(1),
}))});
export type BenchmarkPriceEvidence=z.infer<typeof packetSchema>;
export function assessBenchmarkPriceEvidence(input:unknown){
 const parsed=packetSchema.safeParse(input);
 const reasons:string[]=[];
 if(!parsed.success)return {status:'evidence-hold' as const,marketPriceSupported:false,uniqueComps:0,reasons:['Missing verified variant, sale provenance, date, shipping or single-card evidence.'],range:null,mean:null,median:null};
 const p=parsed.data;const seen=new Set<string>();const totals:number[]=[];
 for(const c of p.comps){
  const url=new URL(c.sourceUrl);const id=url.pathname.match(/^\/itm\/(?:[^/]+\/)?(\d{9,15})\/?$/)?.[1];
  if(!id||!/(^|\.)ebay\.com$/.test(url.hostname)){reasons.push('Unsupported comparable source.');continue;}
  if(seen.has(id)){reasons.push('Duplicate sale listing cannot count as independent evidence.');continue;}seen.add(id);
  if(c.identityKey!==p.identityKey){reasons.push('Comparable variant/identity mismatch.');continue;}
  const age=(Date.parse(p.asOf)-Date.parse(c.soldDate))/86400000;
  if(age<0||age>90){reasons.push('Comparable outside the current 90-day valuation window; retain as history only.');continue;}
  totals.push(c.item+c.shipping);
 }
 totals.sort((a,b)=>a-b);
 if(totals.length<3)reasons.push('Fewer than three unique verified sold listings; arithmetic only.');
 const range=totals.length?{low:totals[0],high:totals.at(-1)!}:null;
 if(range&&range.high/range.low>2)reasons.push('Delivered-price spread exceeds 2x; review sale format, condition and outliers before selecting a price.');
 const median=totals.length?(totals[Math.floor((totals.length-1)/2)]+totals[Math.ceil((totals.length-1)/2)])/2:null;
 return {status:reasons.length?'evidence-hold' as const:'review-estimate' as const,marketPriceSupported:reasons.length===0,uniqueComps:totals.length,reasons,range,mean:totals.length?totals.reduce((a,b)=>a+b,0)/totals.length:null,median};
}
