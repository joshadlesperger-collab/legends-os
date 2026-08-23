export type HealthState = "learning" | "healthy" | "opportunity" | "interest_no_conversion" | "slow" | "stale" | "critical" | "insufficient_data";
export type SaleLikelihood = "high" | "moderate" | "low" | "unknown";
export type RootCause = "learning" | "discoverability" | "demand" | "conversion" | "pricing" | "capital" | "low_stock" | "insufficient_data" | "none";

export type InventoryHealthInput = {
  id: string; title: string; ebayItemId?: string | null; ageDays: number | null; daysSinceSale: number | null;
  views: number | null; views30: number | null; trafficObservationDays: number | null; watchers: number | null; quantity: number; currentPrice: number;
  units7: number; units30: number; units90: number; salesDollars30: number;
  knownUnitCost: number | null; knownCapital: number | null; costComplete: boolean | null;
  supportedPriceAction: "raise-price" | "lower-price" | null; suggestedPrice: number | null;
  marketValue: number | null; compConfidence: number | null;
};

export type InventoryHealth = InventoryHealthInput & {
  listedExposure: number; healthScore: number; state: HealthState; stateLabel: string;
  positives: string[]; negatives: string[]; velocityTrend: "accelerating" | "healthy" | "flat" | "slowing" | "no_recent_sales" | "insufficient_history";
  saleLikelihood: SaleLikelihood; assessmentConfidence: "high" | "moderate" | "low";
  rootCause: RootCause; rootCauseLabel: string; recommendedAction: string; recommendationWhy: string;
  priorityScore: number; priorityDrivers: string[]; issue: string; trafficEvidence: "recent-window" | "lifetime-total" | "unavailable"; viewsForDecision: number | null;
};

const clamp = (value: number) => Math.max(0, Math.min(100, Math.round(value)));
const labels: Record<HealthState, string> = { learning:"Learning / New", healthy:"Healthy", opportunity:"Opportunity", interest_no_conversion:"Interest / No Conversion", slow:"Slow", stale:"Stale", critical:"Critical / Dead Capital", insufficient_data:"Insufficient Data" };
const rootLabels: Record<RootCause, string> = { learning:"Too early to intervene", discoverability:"Discoverability", demand:"Demand", conversion:"Conversion", pricing:"Pricing", capital:"Capital efficiency", low_stock:"Low stock", insufficient_data:"Insufficient data", none:"No immediate problem" };

export function calculateInventoryHealth(input: InventoryHealthInput): InventoryHealth {
  const age = input.ageDays; const watchers = input.watchers; const hasRecentWindow=input.views30!=null&&(input.trafficObservationDays??0)>=7;const views=hasRecentWindow?input.views30:input.views;const trafficEvidence=hasRecentWindow?"recent-window":input.views!=null?"lifetime-total":"unavailable";const trafficLabel=hasRecentWindow?`${input.views30} views in the observed ${input.trafficObservationDays}-day window`:`${input.views??0} observed lifetime views`;
  const listedExposure = Math.max(0,input.currentPrice)*Math.max(0,input.quantity);
  const learning = age != null && age < 14; const noRecentSale = input.units90 === 0;
  const pricingSupported = input.supportedPriceAction != null && input.suggestedPrice != null && input.compConfidence != null && input.compConfidence >= 60;
  const priceGap = pricingSupported && input.marketValue && input.marketValue > 0 ? (input.currentPrice-input.marketValue)/input.marketValue*100 : null;
  const positives:string[]=[]; const negatives:string[]=[]; let score=70;
  if (input.units30>=2){score+=18;positives.push(`${input.units30} units sold in 30 days`);} else if(input.units90>0){score+=9;positives.push(`${input.units90} unit${input.units90===1?"":"s"} sold in 90 days`);}
  if ((watchers??0)>=3){score+=5;positives.push(`${watchers} watchers show interest`);} if ((views??0)>=25){score+=4;positives.push(trafficLabel);}
  if (age!=null&&age>90&&noRecentSale){score-=20;negatives.push(`${age} days listed with no sale in 90 days`);} if(age!=null&&age>180&&noRecentSale){score-=12;negatives.push("More than 180 days in inventory");}
  if(age!=null&&age>=30&&views!=null&&views<5){score-=16;negatives.push(`${trafficLabel} indicate weak discoverability`);} else if(age!=null&&age>=60&&views!=null&&views<20){score-=8;negatives.push("Observed traffic is weak for the available window");}
  if(age!=null&&age>=30&&(watchers??0)>=3&&noRecentSale){score-=12;negatives.push(`${watchers} watchers but no sale in 90 days`);}
  if(priceGap!=null&&priceGap>10){score-=Math.min(20,10+priceGap/5);negatives.push(`Price is ${Math.round(priceGap)}% above supported market evidence`);} else if(priceGap!=null&&Math.abs(priceGap)<=10){score+=5;positives.push("Price is near supported market evidence");}
  if(input.units30>0&&input.quantity<=2){positives.push("Recent sales with low remaining quantity");}
  let healthScore=clamp(score); let state:HealthState;
  if(age==null) state="insufficient_data"; else if(learning) state="learning"; else if(input.units30>0&&input.quantity<=2) state="opportunity"; else if((watchers??0)>=3&&noRecentSale) state="interest_no_conversion"; else if(healthScore<35&&(listedExposure>=100||(input.knownCapital??0)>=50)) state="critical"; else if(age>90&&noRecentSale) state="stale"; else if(healthScore<65) state="slow"; else state="healthy";
  if(state==="learning") healthScore=Math.max(healthScore,70);
  const velocityTrend = age==null||age<30 ? "insufficient_history" : input.units7>=2&&input.units7*4>input.units30*1.4 ? "accelerating" : input.units30>=2 ? "healthy" : input.units90>input.units30&&input.units30===0 ? "slowing" : input.units90===0 ? "no_recent_sales" : "flat";
  let saleLikelihood:SaleLikelihood="unknown"; if(!learning&&age!=null){if(input.units30>=2) saleLikelihood="high"; else if(input.units90>0||(watchers??0)>=3) saleLikelihood="moderate"; else if(age>=45&&input.units90===0) saleLikelihood="low";}
  const assessmentConfidence = age!=null&&views!=null&&watchers!=null&&(age>=30||input.units90>0) ? (pricingSupported||input.units90>0?"high":"moderate") : "low";
  let rootCause:RootCause="none";
  if(age==null) rootCause="insufficient_data"; else if(learning) rootCause="learning"; else if(input.units30>0&&input.quantity<=2) rootCause="low_stock"; else if(pricingSupported&&priceGap!=null&&Math.abs(priceGap)>10) rootCause="pricing"; else if((watchers??0)>=3&&noRecentSale) rootCause="conversion"; else if(age>=30&&views!=null&&views<5) rootCause="discoverability"; else if((input.knownCapital??0)>=100&&input.units90===0) rootCause="capital"; else if(age>=60&&input.units90===0) rootCause="demand";
  let recommendedAction="LEAVE ALONE", recommendationWhy="No supported intervention is stronger than continued observation.";
  if(rootCause==="learning"){recommendedAction="MONITOR";recommendationWhy="The listing needs more observation time before intervention.";}
  else if(rootCause==="low_stock"){recommendedAction="CONSIDER SOURCING MORE";recommendationWhy="Recent authoritative sales and low remaining quantity suggest replenishment deserves review.";}
  else if(rootCause==="pricing"&&pricingSupported){recommendedAction=input.supportedPriceAction==="lower-price"?"REVIEW SUPPORTED PRICE DROP":"REVIEW SUPPORTED PRICE INCREASE";recommendationWhy=`Trusted comp evidence supports ${input.suggestedPrice!.toFixed(2)} at ${input.compConfidence}% confidence.`;}
  else if(rootCause==="conversion"){recommendedAction="CONSIDER OFFER / REVIEW PRICE";recommendationWhy="Observed interest is not converting into authoritative sales.";}
  else if(rootCause==="discoverability"){recommendedAction="REVIEW TITLE / DISCOVERABILITY";recommendationWhy="The listing is old enough to evaluate but has very little observed traffic.";}
  else if(rootCause==="capital"){recommendedAction="REVIEW STALE CAPITAL";recommendationWhy="Known investment is tied up without recent authoritative sales.";}
  else if(rootCause==="demand"){recommendedAction="REVIEW STALE INVENTORY";recommendationWhy="The listing has aged without recent authoritative demand evidence.";}
  else if(input.knownUnitCost==null){recommendedAction="ENTER COST";recommendationWhy=input.units30>0?"Recent sales exist, but missing cost prevents margin and ROI decisions.":"Missing cost prevents known-capital, margin, and ROI decisions.";}
  const severity=100-healthScore; const economic=Math.min(30,Math.log10(1+Math.max(listedExposure,input.knownCapital??0))*12); const actionability=rootCause==="pricing"?20:rootCause==="conversion"||rootCause==="discoverability"?14:rootCause==="low_stock"?16:8; const priorityScore=clamp(severity*.5+economic+actionability+(assessmentConfidence==="high"?8:assessmentConfidence==="moderate"?4:0));
  const priorityDrivers=[`${severity} health-severity points`,`${Math.round(listedExposure)} dollars listed exposure`,`${assessmentConfidence} assessment confidence`];
  const issue = rootCause==="pricing"?(input.supportedPriceAction==="lower-price"?"likely-overpriced":"potentially-underpriced"):rootCause==="conversion"?"watchers-no-sale":rootCause==="low_stock"?"fast-seller-low-stock":input.units90===0&&(age??0)>90&&listedExposure>=50?"high-value-stale":input.units90===0&&(age??0)>90?"stale":rootCause==="capital"?"high-capital-low-velocity":rootCause==="discoverability"?"no-traffic":input.knownUnitCost==null?"missing-cost":"other";
  return {...input,listedExposure,healthScore,state,stateLabel:labels[state],positives,negatives,velocityTrend,saleLikelihood,assessmentConfidence,rootCause,rootCauseLabel:rootLabels[rootCause],recommendedAction,recommendationWhy,priorityScore,priorityDrivers,issue,trafficEvidence,viewsForDecision:views};
}

export type ParetoRow={issue:string;label:string;listingCount:number;listedExposure:number;knownCapital:number|null;healthImpact:number;cumulativeImpactPct:number};
const issueLabels:Record<string,string>={"no-traffic":"No traffic / discoverability","watchers-no-sale":"Watchers but no sale","likely-overpriced":"Likely overpriced","potentially-underpriced":"Potentially underpriced","high-capital-low-velocity":"High capital / low velocity","fast-seller-low-stock":"Fast seller / low stock","high-value-stale":"High-value stale","stale":"Stale inventory","missing-cost":"Missing cost basis","other":"Other"};
export function buildInventoryPortfolio(rows:InventoryHealth[]){
  const total=rows.length; const listingWeighted=total?rows.reduce((s,r)=>s+r.healthScore,0)/total:0; const listedTotal=rows.reduce((s,r)=>s+r.listedExposure,0); const listedWeighted=listedTotal?rows.reduce((s,r)=>s+r.healthScore*r.listedExposure,0)/listedTotal:listingWeighted;
  const states=Object.fromEntries(Object.keys(labels).map(key=>[key,{count:0,listedExposure:0,knownCapital:0,knownCapitalListings:0}])) as Record<HealthState,{count:number;listedExposure:number;knownCapital:number;knownCapitalListings:number}>;
  for(const row of rows){const bucket=states[row.state];bucket.count++;bucket.listedExposure+=row.listedExposure;if(row.knownCapital!=null){bucket.knownCapital+=row.knownCapital;bucket.knownCapitalListings++;}}
  const grouped=new Map<string,Omit<ParetoRow,"cumulativeImpactPct">>(); for(const row of rows){if(row.healthScore>=70&&row.issue==="other")continue;const current=grouped.get(row.issue)??{issue:row.issue,label:issueLabels[row.issue]??row.issue,listingCount:0,listedExposure:0,knownCapital:null,healthImpact:0};current.listingCount++;current.listedExposure+=row.listedExposure;if(row.knownCapital!=null)current.knownCapital=(current.knownCapital??0)+row.knownCapital;current.healthImpact+=Math.max(0,70-row.healthScore)*(1+Math.log10(1+row.listedExposure));grouped.set(row.issue,current);}
  const ranked=Array.from(grouped.values()).sort((a,b)=>b.healthImpact-a.healthImpact);const impactTotal=ranked.reduce((s,r)=>s+r.healthImpact,0);let cumulative=0;const pareto=ranked.map(row=>{cumulative+=row.healthImpact;return{...row,cumulativeImpactPct:impactTotal?cumulative*100/impactTotal:0};});
  const ageBands=Object.fromEntries(["0-30","31-60","61-90","91-180","180+","unknown"].map(band=>[band,{count:0,listedExposure:0,knownCapital:0,knownCapitalListings:0}])) as Record<string,{count:number;listedExposure:number;knownCapital:number;knownCapitalListings:number}>;
  for(const row of rows){const band=row.ageDays==null?"unknown":row.ageDays>180?"180+":row.ageDays>90?"91-180":row.ageDays>60?"61-90":row.ageDays>30?"31-60":"0-30";const bucket=ageBands[band];bucket.count++;bucket.listedExposure+=row.listedExposure;if(row.knownCapital!=null){bucket.knownCapital+=row.knownCapital;bucket.knownCapitalListings++;}}
  return{total,listingWeightedHealth:listingWeighted,economicallyWeightedHealth:listedWeighted,economicBasis:"listed-value exposure" as const,listedExposure:listedTotal,states,ageBands,pareto,criticalFew:pareto.findIndex(row=>row.cumulativeImpactPct>=80)+1||pareto.length};
}
