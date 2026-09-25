import {prisma} from "./prisma.ts";

export type LearningActionSummary={
  action:string;observations:number;salesObserved:number;saleRatePct:number;
  avgViewsChange:number|null;avgWatchersChange:number|null;
  posture:"INSUFFICIENT DATA"|"CONTINUE"|"SLOW DOWN"|"FAVOR";
};

const avg=(values:number[])=>values.length?Math.round(values.reduce((a,b)=>a+b,0)/values.length*10)/10:null;

export async function buildLearningSummary(now=new Date()){
  const since=new Date(now.getTime()-90*86_400_000);
  const observations=await prisma.outcomeObservation.findMany({
    where:{observedAt:{gte:since}},
    include:{decision:{select:{recommendedAction:true,doctrineVersion:true,decidedAt:true}}}
  });
  const grouped=new Map<string,typeof observations>();
  for(const row of observations){const action=row.decision.recommendedAction;const items=grouped.get(action)??[];items.push(row);grouped.set(action,items);}
  const summaries:LearningActionSummary[]=[];
  for(const [action,rows] of Array.from(grouped.entries())){
    const salesObserved=rows.filter((x:(typeof rows)[number])=>x.saleOccurred===true).length;
    const rate=rows.length?salesObserved/rows.length*100:0;
    const views=rows.flatMap((x:(typeof rows)[number])=>x.viewsChange==null?[]:[x.viewsChange]);
    const watchers=rows.flatMap((x:(typeof rows)[number])=>x.watchersChange==null?[]:[x.watchersChange]);
    let posture:LearningActionSummary["posture"]="INSUFFICIENT DATA";
    if(rows.length>=10){
      if(rate>=20)posture="FAVOR";
      else if(rate<5)posture="SLOW DOWN";
      else posture="CONTINUE";
    }
    summaries.push({action,observations:rows.length,salesObserved,saleRatePct:Math.round(rate*10)/10,avgViewsChange:avg(views),avgWatchersChange:avg(watchers),posture});
  }
  summaries.sort((a,b)=>b.observations-a.observations||b.saleRatePct-a.saleRatePct||a.action.localeCompare(b.action));
  return{generatedAt:now.toISOString(),windowDays:90,summaries};
}

export async function deriveAdaptiveExecutionPolicy(now=new Date()){
  const learning=await buildLearningSummary(now);
  const posture=(action:string)=>learning.summaries.find(x=>x.action===action)?.posture??"INSUFFICIENT DATA";
  const scale=(base:number,value:LearningActionSummary["posture"],min:number,max:number)=>{
    if(value==="FAVOR")return Math.min(max,Math.ceil(base*1.5));
    if(value==="SLOW DOWN")return Math.max(min,Math.floor(base*0.5));
    return base;
  };
  const offerPosture=posture("VELOCITY_OFFER_8"),refreshPosture=posture("END_SELL_SIMILAR"),titlePosture=posture("OPTIMIZE_TITLE");
  return{
    generatedAt:learning.generatedAt,
    sampleGate:10,
    sellerOffer:{posture:offerPosture,maxPerRun:scale(25,offerPosture,10,35),unknownCostMax24h:scale(10,offerPosture,5,15),discountPct:8},
    refresh:{posture:refreshPosture,maxPerRun:scale(10,refreshPosture,5,15),canary:3},
    title:{posture:titlePosture,maxPerRun:scale(10,titlePosture,5,15),canary:3,cooldownDays:30},
    immutableGuardrails:["Seller-offer discount remains 8%","Unknown-cost automatic offers remain under $25","Refresh eligibility thresholds do not loosen","Title execution policy remains non-destructive and provider-verified"]
  };
}
