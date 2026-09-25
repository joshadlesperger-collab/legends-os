import {prisma} from "./prisma.ts";
import {buildVelocityAutopilotPlan,executeVelocityAutopilot,VELOCITY_APPROVAL_TEXT} from "./sales-velocity-autopilot.ts";
import {loadTitleInspection} from "./title-inspection-data.ts";
import {loadListingCompleteness} from "./listing-completeness-data.ts";
import {loadListingImageQuality} from "./listing-image-quality-data.ts";

const ACTIVE_JOB_STATUSES=["pending","running","retryable","paused"];
export const SCHEDULER_VERSION="legends-scheduler-v1.0.0";

export function schedulerState(){
  const paused=process.env.LEGENDS_AUTOPILOT_PAUSED==="true";
  const writesEnabled=process.env.LEGENDS_AUTOPILOT_WRITES_ENABLED==="explicitly-approved";
  return{paused,writesEnabled,version:SCHEDULER_VERSION};
}

async function ensureJob(storeId:string,type:"listing_incremental"|"orders_incremental"){
  const existing=await prisma.syncJob.findFirst({where:{storeId,type,status:{in:ACTIVE_JOB_STATUSES}},select:{id:true,status:true}});
  if(existing)return{type,created:false,id:existing.id,status:existing.status};
  const job=await prisma.syncJob.create({data:{storeId,type,status:"pending"}});
  return{type,created:true,id:job.id,status:job.status};
}

export async function runSchedulerSense(){
  const state=schedulerState();
  if(state.paused)return{...state,skipped:true,reason:"LEGENDS_AUTOPILOT_PAUSED=true"};
  const stores=await prisma.store.findMany({where:{isActive:true,connectionStatus:"connected"},select:{id:true,ebaySellerUsername:true,orderAccessStatus:true}});
  const jobs=[] as Array<{storeId:string;type:string;created:boolean;id:string;status:string}>;
  for(const store of stores){
    const listing=await ensureJob(store.id,"listing_incremental");
    jobs.push({storeId:store.id,...listing});
    if(store.orderAccessStatus==="ready"){
      const orders=await ensureJob(store.id,"orders_incremental");
      jobs.push({storeId:store.id,...orders});
    }
  }
  return{...state,skipped:false,stores:stores.length,jobs};
}

export async function runSchedulerVelocityPlan(){
  const state=schedulerState();
  if(state.paused)return{...state,skipped:true,reason:"LEGENDS_AUTOPILOT_PAUSED=true"};
  const plan=await buildVelocityAutopilotPlan();
  const result={...state,skipped:false,generatedAt:plan.generatedAt,counts:plan.counts,offerPreview:plan.offerCandidates.filter(x=>x.ready).slice(0,10).map(x=>({itemId:x.itemId,price:x.currentPrice,offer:x.offerPrice,unknownCostException:x.unknownCostException})),refreshPreview:plan.refreshCandidates.filter(x=>x.ready).slice(0,10).map(x=>({itemId:x.itemId,ageDays:x.ageDays,views30:x.views30}))};
  console.log("Legends Scheduler velocity plan",JSON.stringify(result));
  return result;
}

export async function runSchedulerDiagnostics(){
  const state=schedulerState();
  if(state.paused)return{...state,skipped:true,reason:"LEGENDS_AUTOPILOT_PAUSED=true"};
  const [titles,completeness,images]=await Promise.all([loadTitleInspection(),loadListingCompleteness(),loadListingImageQuality()]);
  const result={...state,skipped:false,titles:{inspected:titles.inspected,recommendations:titles.recommendations.length,review:titles.statusCounts.REVIEW},completeness:{assessed:completeness.assessments.length,safelyCorrectable:completeness.safelyCorrectable,review:completeness.counts.REVIEW},images:{scanned:images.scanned,review:images.counts.review,operatorAction:images.counts.operator}};
  console.log("Legends Scheduler diagnostics",JSON.stringify(result));
  return result;
}

async function runScheduledWrite(mode:"offers"|"refresh"){
  const state=schedulerState();
  if(state.paused)return{...state,mode,skipped:true,reason:"LEGENDS_AUTOPILOT_PAUSED=true"};
  if(!state.writesEnabled)return{...state,mode,skipped:true,reason:"Scheduled eBay writes remain disabled until first controlled batch is verified and LEGENDS_AUTOPILOT_WRITES_ENABLED=explicitly-approved"};
  const operatorId=process.env.OPERATOR_ID||"owner";
  const result=await executeVelocityAutopilot({operatorId,approvalText:VELOCITY_APPROVAL_TEXT,mode});
  const failures=[...result.offerResults,...result.refreshResults].filter((row:any)=>row?.status==="failed");
  if(failures.length)console.error("Legends Scheduler write batch stopped",JSON.stringify({mode,failures}));
  else console.log("Legends Scheduler write batch complete",JSON.stringify({mode,offers:result.offerResults.length,refreshes:result.refreshResults.length}));
  return{...state,mode,skipped:false,offerResults:result.offerResults,refreshResults:result.refreshResults,refreshStopped:result.refreshStopped};
}

export const runSchedulerOffers=()=>runScheduledWrite("offers");
export const runSchedulerRefresh=()=>runScheduledWrite("refresh");
