import {prisma} from "./prisma.ts";
import {loadTitleInspection} from "./title-inspection-data.ts";
import {passesProvenTitleExecutionPolicy} from "./title-inspection-agent.ts";
import {createGovernedTitleExecution,ebayWriteProvider,executeGovernedAction} from "./governed-ebay-actions.ts";

export const TITLE_AUTOPILOT_VERSION="title-autopilot-v1.0.0";
export const TITLE_AUTOPILOT_MAX_PER_DAY=10;
export const TITLE_AUTOPILOT_CANARY=3;
const ACTIVE=["approved","executing","partial_failure","manual_reconciliation_required"];

export async function buildTitleAutopilotPlan(now=new Date()){
  const data=await loadTitleInspection(now);
  const candidates=data.recommendations.filter(passesProvenTitleExecutionPolicy);
  const active=await prisma.ebayActionExecution.findMany({
    where:{listingId:{in:candidates.map(x=>x.listingId)},status:{in:ACTIVE}},
    select:{listingId:true}
  });
  const blocked=new Set(active.map(x=>x.listingId));
  const rows=candidates.map(row=>({
    listingId:row.listingId,itemId:row.ebayItemId,currentTitle:row.currentTitle,proposedTitle:row.proposedTitle,
    confidence:row.confidence,qualityImprovement:row.qualityImprovement,
    ready:!blocked.has(row.listingId),blockers:blocked.has(row.listingId)?["Another governed action is active"]:[]
  })).sort((a,b)=>Number(b.ready)-Number(a.ready)||b.confidence-a.confidence||b.qualityImprovement-a.qualityImprovement||a.itemId.localeCompare(b.itemId));
  return{version:TITLE_AUTOPILOT_VERSION,generatedAt:now.toISOString(),ready:rows.filter(x=>x.ready).length,rows};
}

export async function executeTitleAutopilot(input:{operatorId:string;writesEnabled:boolean;maxPerRun?:number}){
  if(!input.writesEnabled)return{skipped:true,reason:"Scheduled title writes are disabled",results:[]};
  const plan=await buildTitleAutopilotPlan();
  const selected=plan.rows.filter(x=>x.ready).slice(0,Math.max(1,Math.min(input.maxPerRun??TITLE_AUTOPILOT_MAX_PER_DAY,20)));
  const results:any[]=[];
  const executeOne=async(row:(typeof selected)[number])=>{
    const execution=await createGovernedTitleExecution(row.listingId,input.operatorId);
    const completed=await executeGovernedAction(execution.id,input.operatorId,ebayWriteProvider,{writesEnabled:true});
    return{itemId:row.itemId,status:completed.status,executionId:execution.id,before:row.currentTitle,after:row.proposedTitle};
  };
  for(const row of selected.slice(0,TITLE_AUTOPILOT_CANARY)){
    try{results.push(await executeOne(row));}catch(error){results.push({itemId:row.itemId,status:"failed",error:error instanceof Error?error.message:String(error)});return{skipped:false,plan,results,stopped:true};}
  }
  if(selected.length>TITLE_AUTOPILOT_CANARY&&results.every(x=>x.status==="verified")){
    for(const row of selected.slice(TITLE_AUTOPILOT_CANARY)){
      try{results.push(await executeOne(row));}catch(error){results.push({itemId:row.itemId,status:"failed",error:error instanceof Error?error.message:String(error)});break;}
    }
  }
  return{skipped:false,plan,results,stopped:results.some(x=>x.status==="failed")};
}
