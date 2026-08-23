export const LISTING_REFRESH_RULE_VERSION = "listing-refresh-v1.0.0";
export type ListingRefreshClassification = "HIGH-CONFIDENCE REFRESH" | "REVIEW" | "LEAVE ALONE" | "DO NOT TOUCH";
export type ListingRefreshInput = {
  listingId:string; ebayItemId:string; title:string; currentPrice:number; listingStatus:string; listingFormat:string|null; startTime:Date|null;
  authoritativeObservedAt:Date|null; authoritativeSource:string|null; categoryId:string|null; quantity:number;
  units30:number; units90:number; views30:number|null; trafficObservedAt:Date|null; watchers:number|null;
  promotionStatus:string|null; currentAdRate:number|null; negotiationEligible:boolean|null;
  lastPriceChangeAt:Date|null; lastTitleChangeAt:Date|null; lastRefreshAt:Date|null; activeIntervention:boolean; now?:Date;
};
export type ListingRefreshScore = {
  listingId:string; ebayItemId:string; title:string; currentPrice:number; startTime:string|null; ageDays:number|null;
  classification:ListingRefreshClassification; score:number; proposedAction:"END → SELL SIMILAR"|null; confidence:number;
  views30:number|null; impressions:number|null; trafficQuality:"authoritative"|"supported"|"unavailable";
  watchers:number|null; watcherQuality:"authoritative"|"stale"|"unavailable"; units30:number; units90:number;
  promotedStatus:string|null; currentAdRate:number|null; lastMaterialChange:string|null; reason:string; evidenceGaps:string[]; blockers:string[];
  ruleVersion:string; assessedAt:string;
};
const DAY=86_400_000;
const age=(now:Date,value:Date|null)=>value?Math.max(0,Math.floor((now.getTime()-value.getTime())/DAY)):null;
const recent=(now:Date,value:Date|null,days:number)=>Boolean(value&&now.getTime()-value.getTime()<days*DAY);
const fixed=(value:string|null)=>Boolean(value&&/fixed/i.test(value));
export function scoreListingRefresh(input:ListingRefreshInput):ListingRefreshScore{
  const now=input.now??new Date(),ageDays=age(now,input.startTime),fresh=Boolean(input.authoritativeObservedAt&&now.getTime()-input.authoritativeObservedAt.getTime()<=7*DAY),watcherQuality:ListingRefreshScore["watcherQuality"]=fresh?"authoritative":input.watchers==null?"unavailable":"stale";
  const trafficQuality:ListingRefreshScore["trafficQuality"]=input.views30!=null&&input.trafficObservedAt&&now.getTime()-input.trafficObservedAt.getTime()<=31*DAY?"supported":"unavailable";
  const blockers:string[]=[],gaps:string[]=[];let score=0;
  if(input.listingStatus!=="active")blockers.push("Listing is not active");
  if(ageDays==null)blockers.push("Authoritative listing start date is unavailable");else if(ageDays<60)blockers.push("Listing is younger than 60 days");else score+=ageDays>=180?70:ageDays>=120?58:ageDays>=90?45:30;
  if(!fixed(input.listingFormat))blockers.push("Listing is not a verified fixed-price listing");
  if(!fresh)blockers.push("Live eBay listing state is stale or unavailable");
  if(!input.categoryId)blockers.push("Authoritative category identity is unavailable");
  if(input.quantity<=0)blockers.push("No active inventory quantity remains");
  if(input.units30>0)blockers.push("Listing has an authoritative sale within 30 days");else score+=15;
  if(input.units90===0)score+=5;
  if(recent(now,input.lastTitleChangeAt,30))blockers.push("Recent title optimization requires a 30-day observation window");
  if(recent(now,input.lastRefreshAt,60))blockers.push("Listing was refreshed within 60 days");
  if(input.activeIntervention)blockers.push("Listing is already part of an active governed intervention");
  if(input.negotiationEligible===true)blockers.push("eBay currently reports buyer interest eligible for a seller offer");
  if(input.negotiationEligible==null)gaps.push("eBay does not expose an authoritative active seller-offer ledger; outstanding-offer absence cannot be proven");
  if(trafficQuality==="supported"){if(input.views30!<=5)score+=10;else if(input.views30!>=25)blockers.push("Recent view activity is too strong for a blind refresh");}else gaps.push("Fresh Analytics impressions/CTR are unavailable; no exposure claim is made");
  if(watcherQuality==="authoritative"){if((input.watchers??0)===0)score+=5;else if((input.watchers??0)>=3)blockers.push("Authoritative watcher interest is strong");}else gaps.push("Fresh authoritative watcher evidence is unavailable");
  if(input.lastPriceChangeAt&&recent(now,input.lastPriceChangeAt,30))blockers.push("Recent price change requires an observation window");
  const material=[input.lastTitleChangeAt&&{label:"title optimized",at:input.lastTitleChangeAt},input.lastPriceChangeAt&&{label:"price changed",at:input.lastPriceChangeAt},input.lastRefreshAt&&{label:"previous refresh",at:input.lastRefreshAt}].filter((v):v is {label:string;at:Date}=>Boolean(v)).sort((a,b)=>b.at.getTime()-a.at.getTime())[0];
  const healthy=blockers.some(item=>/sale within|view activity|watcher interest|buyer interest/.test(item));const structural=blockers.some(item=>/not active|younger|not a verified|stale|category|quantity|observation|already part|refreshed/.test(item));
  let classification:ListingRefreshClassification,reason:string,confidence:number;
  if(healthy){classification="LEAVE ALONE";confidence=90;reason="Recent sales or buyer engagement make continued observation safer than resetting the listing.";}
  else if(structural){classification="DO NOT TOUCH";confidence=95;reason="A hard freshness, lifecycle, format, identity, or intervention guardrail blocks refresh.";}
  else if(score>=65&&gaps.length===0){classification="HIGH-CONFIDENCE REFRESH";confidence=Math.min(95,score);reason="The mature fixed-price listing is fresh, inactive in recent sales, weakly engaged, and has no competing intervention or offer state.";}
  else if(ageDays!=null&&ageDays>=60&&input.units30===0){classification="REVIEW";confidence=Math.min(85,Math.max(55,score));reason="Age and authoritative non-sale evidence support refresh review, but missing exposure or seller-offer evidence prevents high confidence.";}
  else{classification="DO NOT TOUCH";confidence=90;reason="The listing does not satisfy the minimum refresh evidence policy.";}
  return{listingId:input.listingId,ebayItemId:input.ebayItemId,title:input.title,currentPrice:input.currentPrice,startTime:input.startTime?.toISOString()??null,ageDays,classification,score,proposedAction:classification==="HIGH-CONFIDENCE REFRESH"||classification==="REVIEW"?"END → SELL SIMILAR":null,confidence,views30:trafficQuality==="supported"?input.views30:null,impressions:null,trafficQuality,watchers:watcherQuality==="authoritative"?input.watchers:null,watcherQuality,units30:input.units30,units90:input.units90,promotedStatus:fresh?input.promotionStatus:null,currentAdRate:input.currentAdRate,lastMaterialChange:material?`${material.label} ${material.at.toISOString()}`:null,reason,evidenceGaps:gaps,blockers,ruleVersion:LISTING_REFRESH_RULE_VERSION,assessedAt:now.toISOString()};
}
