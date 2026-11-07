import type {V2Identity} from './card-processing-v2.ts';
export const PRICE_CHECK_POLICY={version:'price-check-preview-5pct-1usd-watchers8-v1',allowancePercent:5,allowanceCapCents:100,watcherPercent:8,minimumItemCents:149,mode:'preview' as const,canPublish:false as const};
export type PriceCheckEvidence={path:string;sha256:string};
export type PriceCheckCurrent={itemCents:number|null;shippingCents:number|null;observedAt:string;source:'retained-ebay-observation'|'manual-preview';evidence?:PriceCheckEvidence};
export type PriceCheckCandidate={draftId:string;title:string;cardIds:string[];identity:V2Identity;current:PriceCheckCurrent|null;identityConflict?:boolean};
export type PriceCheckComp={itemId:string;title:string;url:string;itemCents:number;shippingCents:number;totalCents:number;seller:string;observedAt:string;identityProof:string[];confidence?:'structured'|'title-supported';warnings?:string[]};
export type PriceCheckStatus='within-band'|'below-band'|'above-band'|'no-comp'|'unknown-price'|'comp-uncertain'|'provider-error'|'identity-conflict'|'below-item-floor'|'watcher-floor';
export type PriceCheckDecision={choice:'keep'|'match-low'|'custom'|'leave-draft';itemCents:number|null;totalCents:number|null;watcherItemCents:number|null;watcherTotalCents:number|null;status:PriceCheckStatus|'leave-draft';flags:string[];at:string};
export type PriceCheckRow={draftId:string;title:string;status:PriceCheckStatus;reason:string;flags:string[];current:PriceCheckCurrent|null;currentItemCents:number|null;shippingCents:number|null;ourTotalCents:number|null;watcherItemCents:number|null;watcherTotalCents:number|null;lowestComp:PriceCheckComp|null;allowanceCents:number|null;minQualifyingTotalCents:number|null;maxQualifyingTotalCents:number|null;gapCents:number|null;gapPercent:number|null;compCount:number;excludedCompCount:number;limitations:string[];decision?:PriceCheckDecision;canPublish:false};
export type PriceCheckRun={id:string;mode:'preview';canPublish:false;policyVersion:string;status:'running'|'complete'|'failed';startedAt:string;endedAt?:string;elapsedMs:number;draftIds:string[];rows:PriceCheckRow[];progress:{completed:number;total:number;phase:string};requestCount:number;cost:{amountUsd:null;source:string};scopeHash:string;failure?:string};
const cents=(n:number|null)=>n===null||Number.isSafeInteger(n)&&n>=0;
export function priceCheckMath(itemCents:number|null,shippingCents:number|null,lowCents:number|null){
 if(!cents(itemCents)||!cents(shippingCents)||!cents(lowCents))throw Error('Exact nonnegative USD cents required');
 const watcherItemCents=itemCents===null?null:Math.floor((itemCents*92+50)/100),allowanceCents=lowCents===null?null:Math.min(Math.floor(lowCents*5/100),100),ourTotalCents=itemCents===null||shippingCents===null?null:itemCents+shippingCents;
 return{currentItemCents:itemCents,shippingCents,ourTotalCents,watcherItemCents,watcherTotalCents:watcherItemCents===null||shippingCents===null?null:watcherItemCents+shippingCents,allowanceCents,minQualifyingTotalCents:lowCents===null?null:lowCents-allowanceCents!,maxQualifyingTotalCents:lowCents===null?null:lowCents+allowanceCents!,gapCents:lowCents===null||ourTotalCents===null?null:lowCents-ourTotalCents,gapPercent:lowCents===null||ourTotalCents===null||lowCents===0?null:(lowCents-ourTotalCents)*100/lowCents};
}
export function evaluatePriceCheck(candidate:PriceCheckCandidate,comps:PriceCheckComp[],options:{excludedCompCount?:number;limitations?:string[];providerError?:boolean;sourceUncertain?:boolean}={}):PriceCheckRow{
 const ordered=comps.slice().sort((a,b)=>a.totalCents-b.totalCents||a.itemId.localeCompare(b.itemId)),lowestComp=ordered[0]??null,m=priceCheckMath(candidate.current?.itemCents??null,candidate.current?.shippingCents??null,lowestComp?.totalCents??null),flags:string[]=[];
 if(candidate.identityConflict)flags.push('identity-conflict');
 if(m.currentItemCents===null||m.shippingCents===null)flags.push('unknown-price');
 if(m.currentItemCents!==null&&m.currentItemCents<149)flags.push('below-item-floor');
 if(m.watcherItemCents!==null&&m.watcherItemCents<149)flags.push('watcher-floor');
 if(options.providerError)flags.push('provider-error');
 if(!lowestComp)flags.push('no-comp');else{
  if(new Set(ordered.map(c=>c.seller.toLowerCase())).size<2||options.sourceUncertain||lowestComp.confidence==='title-supported')flags.push('comp-uncertain');
  if(m.ourTotalCents!==null&&m.ourTotalCents<m.minQualifyingTotalCents!)flags.push('below-band');
  if(m.ourTotalCents!==null&&m.ourTotalCents>m.maxQualifyingTotalCents!)flags.push('above-band');
 }
 const reasons:Record<string,string>={'identity-conflict':'Saved copies disagree on catalog identity.','unknown-price':'Current item price or shipping is unknown; enter both for a labeled manual preview.','below-item-floor':'Item price is below the existing $1.49 policy floor.','watcher-floor':'The projected 8% watcher offer falls below the $1.49 item-price floor.','provider-error':'The market source could not complete this bounded check.','no-comp':'No strictly comparable available listing was confirmed.','comp-uncertain':'Fewer than two independent sellers were confirmed, or eBay returned search warnings; comparison needs review.','below-band':'Our delivered price is below the lowest valid observed comp by more than the allowed 5%/$1 gap.','above-band':'Our delivered price is above the lowest valid observed comp by more than the preview allowance.'};
 return{draftId:candidate.draftId,title:candidate.title,status:(flags[0]??'within-band') as PriceCheckStatus,reason:flags.length?flags.map(f=>reasons[f]).join(' '):'Within the price band. This preview is not publication approval.',flags,current:candidate.current,...m,lowestComp,compCount:ordered.length,excludedCompCount:options.excludedCompCount??0,limitations:[...(options.limitations??[]),...(lowestComp?.warnings??[])],canPublish:false};
}
export function previewPriceDecision(row:PriceCheckRow,choice:PriceCheckDecision['choice'],itemCents?:number,at=new Date().toISOString()):PriceCheckDecision{
 if(choice==='leave-draft')return{choice,itemCents:null,totalCents:null,watcherItemCents:null,watcherTotalCents:null,status:'leave-draft',flags:[],at};
 const selected=choice==='keep'?row.currentItemCents:choice==='match-low'?(row.lowestComp&&row.shippingCents!==null?row.lowestComp.totalCents-row.shippingCents:null):itemCents??null;
 if(selected===null||!Number.isSafeInteger(selected)||selected<1||selected>100_000_000||row.shippingCents===null||choice==='match-low'&&selected<149)throw Error('A valid item price and known shipping are required; matching cannot breach the $1.49 item-price floor');
 const m=priceCheckMath(selected,row.shippingCents,row.lowestComp?.totalCents??null),flags=row.flags.filter(f=>!['unknown-price','below-item-floor','watcher-floor','below-band','above-band'].includes(f));
 if(selected<149)flags.push('below-item-floor');if(m.watcherItemCents!<149)flags.push('watcher-floor');if(m.ourTotalCents!==null&&m.minQualifyingTotalCents!==null&&m.ourTotalCents<m.minQualifyingTotalCents)flags.push('below-band');if(m.ourTotalCents!==null&&m.maxQualifyingTotalCents!==null&&m.ourTotalCents>m.maxQualifyingTotalCents)flags.push('above-band');
 return{choice,itemCents:selected,totalCents:m.ourTotalCents,watcherItemCents:m.watcherItemCents,watcherTotalCents:m.watcherTotalCents,status:(flags[0]??'within-band') as PriceCheckStatus,flags,at};
}
