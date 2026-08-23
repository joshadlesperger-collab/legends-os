import { parseCardIdentity } from "./comp-validation/identity.ts";
import type { CompProviderAdapter } from "./comp-validation/provider.ts";
import type { CardIdentity, CompSale } from "./comp-validation/types.ts";

export type EvidenceSourceKind="internal-sales"|"cached-external"|"ebay-authoritative"|"external-adapter";
export type PricingPriorityInput={listingId:string;title:string;currentPrice:number;quantity:number;ageDays:number|null;views:number|null;watchers:number|null;units90:number;cachedEvidenceConfidence:number|null;internalComparableCount:number;authoritativeDetails:boolean};
export type PricingPriority={listingId:string;title:string;score:number;cohort:"watchers-no-sale"|"high-value-stale"|"high-traffic-no-conversion"|"likely-pricing-mismatch"|"old-stale"|"everything-else";expectedSource:EvidenceSourceKind;estimatedRequests:number;drivers:string[]};

const clamp=(value:number,min:number,max:number)=>Math.max(min,Math.min(max,value));
export function providerRequestBudget(env:NodeJS.ProcessEnv=process.env){const parsed=Number(env.PRICING_EVIDENCE_EXTERNAL_REQUEST_CAP??"0");return Number.isInteger(parsed)?clamp(parsed,0,1000):0;}
export function scorePricingEvidencePriority(input:PricingPriorityInput):PricingPriority{
  const exposure=input.currentPrice*Math.max(1,input.quantity);const stale=(input.ageDays??0)>=90&&input.units90===0;const noSale=input.units90===0;
  const cohort=input.watchers!=null&&input.watchers>=3&&noSale?"watchers-no-sale":exposure>=50&&stale?"high-value-stale":(input.views??0)>=30&&noSale?"high-traffic-no-conversion":input.cachedEvidenceConfidence!=null&&input.cachedEvidenceConfidence<60?"likely-pricing-mismatch":stale?"old-stale":"everything-else";
  const exposureScore=exposure>=100?30:exposure>=50?24:exposure>=20?16:exposure>=10?8:3;
  const ageScore=(input.ageDays??0)>=365?15:(input.ageDays??0)>=180?12:(input.ageDays??0)>=90?9:(input.ageDays??0)>=30?4:0;
  const watcherScore=clamp((input.watchers??0)*4,0,20);const trafficScore=(input.views??0)>=100?15:(input.views??0)>=30?12:(input.views??0)>=10?7:0;
  const actionValue=noSale?10:2;const source=input.cachedEvidenceConfidence!=null&&input.cachedEvidenceConfidence>=60?"cached-external":input.internalComparableCount>=3?"internal-sales":input.authoritativeDetails?"ebay-authoritative":"external-adapter";
  const acquisitionPenalty={"cached-external":0,"internal-sales":2,"ebay-authoritative":5,"external-adapter":12}[source];
  const cohortBonus={"watchers-no-sale":30,"high-value-stale":22,"high-traffic-no-conversion":18,"likely-pricing-mismatch":16,"old-stale":8,"everything-else":0}[cohort];
  const score=clamp(exposureScore+ageScore+watcherScore+trafficScore+actionValue+cohortBonus-acquisitionPenalty,0,100);
  return{listingId:input.listingId,title:input.title,score,cohort,expectedSource:source,estimatedRequests:source==="external-adapter"?1:0,drivers:[`$${exposure.toFixed(2)} listed exposure`,`${input.ageDays??"unknown"} days old`,`${input.watchers??0} watchers`,`${input.views??0} observed views`,`${input.internalComparableCount} internal comparables`,`${input.cachedEvidenceConfidence??"no"} cached confidence`]};
}
export function buildExternalResearchDryRun(priorities:PricingPriority[],configuredCap=providerRequestBudget()){
  const reusable=priorities.filter(row=>row.expectedSource!=="external-adapter");const external=priorities.filter(row=>row.expectedSource==="external-adapter").sort((a,b)=>b.score-a.score||a.listingId.localeCompare(b.listingId));
  const proposed=external.slice(0,configuredCap);return{totalCandidates:priorities.length,existingEvidenceReused:reusable.length,externalEligible:external.length,configuredRequestCap:configuredCap,estimatedProviderRequests:proposed.reduce((sum,row)=>sum+row.estimatedRequests,0),priorityPreview:external.slice(0,25),proposed,stoppedAtCap:external.length>proposed.length};
}

export type InternalSaleEvidence={id:string;title:string;soldAt:Date;unitPrice:number;currency:string;status:string};
const norm=(value:string|null)=>String(value??"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
export function auditInternalComparableIdentity(target:CardIdentity,sale:CardIdentity){
  const reasons:string[]=[];
  for(const field of ["player","year","manufacturer","setName","cardNumber"] as const){
    if(target[field]==null||sale[field]==null)reasons.push(`missing-${field}`);
    else if(norm(String(target[field]))!==norm(String(sale[field])))reasons.push(`different-${field}`);
  }
  for(const field of ["parallel","variation","gradeCompany","gradeValue","printRun"] as const){if(norm(String(target[field]??""))!==norm(String(sale[field]??"")))reasons.push(`different-${field}`);}
  for(const field of ["rawOrGraded","rookie","autograph","patch","serialNumbered"] as const){if(target[field]!==sale[field])reasons.push(`different-${field}`);}
  return{comparable:reasons.length===0,reasons};
}
function comparable(target:CardIdentity,sale:CardIdentity){return auditInternalComparableIdentity(target,sale).comparable;}
export function countInternalComparables(title:string,sales:InternalSaleEvidence[]){const target=parseCardIdentity(title);return sales.filter(row=>row.status!=="cancelled"&&row.currency==="USD"&&row.unitPrice>0&&comparable(target,parseCardIdentity(row.title))).length;}
export function buildInternalComparableIndex(sales:InternalSaleEvidence[]){const exact=new Map<string,number>();for(const row of sales){if(row.status==="cancelled"||row.currency!=="USD"||row.unitPrice<=0)continue;const identity=parseCardIdentity(row.title);if(identity.identityCompleteness<100)continue;exact.set(identity.identityHash,(exact.get(identity.identityHash)??0)+1);}return{count(title:string){const identity=parseCardIdentity(title);return identity.identityCompleteness===100?exact.get(identity.identityHash)??0:0;}};}
export function createInternalSalesAdapter(sales:InternalSaleEvidence[]):CompProviderAdapter{return{providerId:"legends-internal-sales",providerName:"Legends authoritative sales history",async searchSoldComps({identity,maxResults}){return sales.filter(row=>{if(row.status==="cancelled"||row.currency!=="USD"||row.unitPrice<=0)return false;const candidate=parseCardIdentity(row.title);const samePlayer=Boolean(identity.player&&candidate.player&&norm(identity.player)===norm(candidate.player));const sameYear=identity.year!=null&&candidate.year===identity.year;const relatedProduct=Boolean(identity.setName&&candidate.setName&&norm(identity.setName)===norm(candidate.setName))||Boolean(identity.manufacturer&&candidate.manufacturer&&norm(identity.manufacturer)===norm(candidate.manufacturer));return samePlayer&&sameYear&&relatedProduct;}).sort((a,b)=>b.soldAt.getTime()-a.soldAt.getTime()).slice(0,maxResults).map((row):CompSale=>{const parsed=parseCardIdentity(row.title);return{compKey:`legends-sale-${row.id}`,providerId:"legends-internal-sales",providerName:"Legends authoritative sales history",sourceItemId:row.id,sourceUrl:null,soldTitle:row.title,soldDate:row.soldAt.toISOString(),soldPrice:row.unitPrice,shipping:null,buyerPremium:null,totalBuyerCost:null,isAuction:false,priceConfirmed:true,currency:"USD",retrievalTier:"exact",attributes:{player:parsed.player,year:parsed.year,manufacturer:parsed.manufacturer,setName:parsed.setName,cardNumber:parsed.cardNumber,rawOrGraded:parsed.rawOrGraded,gradeCompany:parsed.gradeCompany,gradeValue:parsed.gradeValue,rookie:parsed.rookie,autograph:parsed.autograph,patch:parsed.patch,parallel:parsed.parallel,variation:parsed.variation,serialNumbered:parsed.serialNumbered,printRun:parsed.printRun}};});}};}
