import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { buildObservedOutcome, outcomeDueAt, type DecisionEvidence } from "@/lib/action-outcome-domain";

const DAY=86_400_000;
export async function observeDueOperatorOutcomes(now=new Date()){
  const candidates=await prisma.operatorDecision.findMany({where:{decidedAt:{lte:new Date(now.getTime()-30*DAY)}},orderBy:{decidedAt:"asc"},take:100,include:{listing:{select:{views:true,watchers:true}},outcomes:{select:{windowDays:true}}}});const due=candidates.filter(item=>outcomeDueAt(item.decidedAt,item.observationWindowDays)<=now&&!item.outcomes.some(outcome=>outcome.windowDays===item.observationWindowDays));if(!due.length)return{observed:0};
  const sales=await prisma.saleEvent.findMany({where:{listingId:{in:Array.from(new Set(due.map(item=>item.listingId)))},provider:"ebay-fulfillment",status:{not:"cancelled"},soldAt:{gte:due.reduce((earliest,item)=>item.decidedAt<earliest?item.decidedAt:earliest,due[0].decidedAt)}},select:{listingId:true,soldAt:true,price:true,quantity:true}});let observed=0;
  for(const item of due){const evidence=item.evidenceSnapshot as DecisionEvidence;const payload=buildObservedOutcome({decidedAt:item.decidedAt,windowDays:item.observationWindowDays,evidence,currentViews:item.listing.views,currentWatchers:item.listing.watchers,sales:sales.filter(sale=>sale.listingId===item.listingId),observedAt:now});try{await prisma.outcomeObservation.create({data:{decisionId:item.id,...payload,salePrice:payload.salePrice==null?null:new Prisma.Decimal(payload.salePrice.toFixed(2))}});observed++;}catch(error){if(!(error instanceof Prisma.PrismaClientKnownRequestError&&error.code==="P2002"))throw error;}}
  return{observed};
}
