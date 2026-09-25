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
  for(const [action,rows] of grouped){
    const salesObserved=rows.filter(x=>x.saleOccurred===true).length;
    const rate=rows.length?salesObserved/rows.length*100:0;
    const views=rows.flatMap(x=>x.viewsChange==null?[]:[x.viewsChange]);
    const watchers=rows.flatMap(x=>x.watchersChange==null?[]:[x.watchersChange]);
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
