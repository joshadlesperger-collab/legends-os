import {Prisma} from "@prisma/client";
import {prisma} from "@/lib/prisma";
import {loadSalesVelocity} from "@/lib/sales-velocity";
import {loadListingRefreshCandidates} from "@/lib/listing-refresh-data";
import {findEligibleItems,sendOfferToInterestedBuyers} from "@/lib/ebay-negotiation";
import {getItem,getValidAccessToken} from "@/lib/ebay";
import {createGovernedRefreshExecution,ebayWriteProvider,executeGovernedAction,preservedRelistState,remainingProviderQuantity} from "@/lib/governed-ebay-actions";

export const VELOCITY_AUTOPILOT_VERSION="sales-velocity-autopilot-v1.0.0";
export const VELOCITY_OFFER_DISCOUNT_PCT=8;
export const VELOCITY_OFFER_MAX_PER_RUN=25;
export const VELOCITY_REFRESH_MAX_PER_RUN=10;
export const VELOCITY_REFRESH_CANARY=3;
export const VELOCITY_APPROVAL_TEXT="I APPROVE SALES VELOCITY AUTOPILOT V1";
const DAY=86_400_000;
const ACTIVE=["approved","executing","partial_failure","manual_reconciliation_required"];
const json=(value:unknown)=>JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const cents=(value:number)=>Math.round((value+Number.EPSILON)*100)/100;
const offerPrice=(price:number)=>Math.ceil(price*(1-VELOCITY_OFFER_DISCOUNT_PCT/100)*100-1e-9)/100;
const livePrice=(item:Awaited<ReturnType<typeof getItem>>)=>{const value=item.SellingStatus?.CurrentPrice;return Number(value&&typeof value==="object"?value["#text"]:value);};
const active=(item:Awaited<ReturnType<typeof getItem>>)=>String(item.SellingStatus?.ListingStatus??"").toLowerCase()==="active";

export type VelocityOfferPlan={
  listingId:string;itemId:string;title:string;currentPrice:number;offerPrice:number;discountPct:number;
  watchers:number|null;ageDays:number|null;units30:number;knownUnitCost:number|null;estimatedGrossMarginPct:number|null;
  ready:boolean;blockers:string[];
};
export type VelocityRefreshPlan={
  listingId:string;itemId:string;title:string;currentPrice:number;ageDays:number|null;views30:number|null;watchers:number|null;
  units30:number;score:number;confidence:number;ready:boolean;blockers:string[];
};
export type VelocityAutopilotPlan={
  generatedAt:string;version:string;offerCandidates:VelocityOfferPlan[];refreshCandidates:VelocityRefreshPlan[];
  counts:{offersReady:number;offersReview:number;refreshReady:number};
};

async function getConnectedStores(){
  return prisma.store.findMany({where:{isActive:true,connectionStatus:"connected"}});
}

export async function buildVelocityAutopilotPlan(now=new Date()):Promise<VelocityAutopilotPlan>{
  const [velocity,refresh,stores]=await Promise.all([loadSalesVelocity(now),loadListingRefreshCandidates(now),getConnectedStores()]);
  const storeById=new Map(stores.map(store=>[store.id,store]));
  const listings=await prisma.listing.findMany({
    where:{listingStatus:"active"},
    select:{id:true,storeId:true,ebayItemId:true,title:true,currentPrice:true,quantity:true,
      costBasis:true,ebayActionExecutions:{where:{OR:[{status:{in:ACTIVE}},{action:{in:["VELOCITY_OFFER_8","SEND_OFFER"]},providerVerifiedAt:{gte:new Date(now.getTime()-7*DAY)}}]},select:{action:true,status:true,providerVerifiedAt:true}}}
  });
  const listingById=new Map(listings.map(row=>[row.id,row]));
  const eligByStore=new Map<string,Map<string,{listingId:string;eligible:true;observedAt:string}>>();
  for(const store of stores){
    try{
      const {accessToken}=await getValidAccessToken(store);
      eligByStore.set(store.id,await findEligibleItems(accessToken));
    }catch{
      eligByStore.set(store.id,new Map());
    }
  }

  const offerCandidates:VelocityOfferPlan[]=[];
  for(const row of velocity.rows){
    const listing=listingById.get(row.listingId);if(!listing)continue;
    const blockers:string[]=[];
    const eligible=eligByStore.get(listing.storeId)?.has(row.ebayItemId)??false;
    if(!eligible)continue;
    if(row.units30>0)blockers.push("Authoritative sale exists within 30 days");
    if(listing.ebayActionExecutions.some(x=>ACTIVE.includes(x.status)))blockers.push("Another governed action is active");
    if(listing.ebayActionExecutions.some(x=>(x.action==="VELOCITY_OFFER_8"||x.action==="SEND_OFFER")&&x.providerVerifiedAt&&now.getTime()-x.providerVerifiedAt.getTime()<7*DAY))blockers.push("A seller offer was already sent within 7 days");
    if(!row.costComplete||row.knownUnitCost==null)blockers.push("Known cost basis is incomplete; autopilot will not guess margin");
    const proposed=offerPrice(row.currentPrice);
    const margin=row.knownUnitCost!=null&&proposed>0?cents((proposed-row.knownUnitCost)/proposed*100):null;
    if(row.knownUnitCost!=null&&proposed<row.knownUnitCost*1.2)blockers.push("8% offer would violate the 20% known-cost margin guardrail");
    offerCandidates.push({listingId:row.listingId,itemId:row.ebayItemId,title:row.title,currentPrice:row.currentPrice,offerPrice:proposed,discountPct:cents((row.currentPrice-proposed)/row.currentPrice*100),watchers:row.watchers.value,ageDays:row.ageDays,units30:row.units30,knownUnitCost:row.knownUnitCost,estimatedGrossMarginPct:margin,ready:blockers.length===0,blockers});
  }
  offerCandidates.sort((a,b)=>Number(b.ready)-Number(a.ready)||(b.watchers??0)-(a.watchers??0)||(b.ageDays??0)-(a.ageDays??0)||a.itemId.localeCompare(b.itemId));

  const refreshCandidates:VelocityRefreshPlan[]=[];
  for(const row of refresh.rows.filter(row=>row.classification==="HIGH-CONFIDENCE REFRESH")){
    const listing=listingById.get(row.listingId);if(!listing)continue;
    const blockers=[...row.blockers];
    if((row.ageDays??0)<90)blockers.push("Autopilot requires at least 90 days age");
    if((row.views30??999)>5)blockers.push("Autopilot requires at most 5 views in 30 days");
    if((row.watchers??999)>0)blockers.push("Autopilot requires zero authoritative watchers");
    if(row.units30>0)blockers.push("Authoritative sale exists within 30 days");
    if(row.currentPrice>=100)blockers.push("Autopilot refresh is capped below $100");
    if(eligByStore.get(listing.storeId)?.has(row.ebayItemId))blockers.push("Negotiation eligible; buyer-intent action outranks refresh");
    if(listing.ebayActionExecutions.some(x=>ACTIVE.includes(x.status)))blockers.push("Another governed action is active");
    refreshCandidates.push({listingId:row.listingId,itemId:row.ebayItemId,title:row.title,currentPrice:row.currentPrice,ageDays:row.ageDays,views30:row.views30,watchers:row.watchers,units30:row.units30,score:row.score,confidence:row.confidence,ready:blockers.length===0,blockers});
  }
  refreshCandidates.sort((a,b)=>Number(b.ready)-Number(a.ready)||b.score-a.score||(b.ageDays??0)-(a.ageDays??0)||a.itemId.localeCompare(b.itemId));

  return{generatedAt:now.toISOString(),version:VELOCITY_AUTOPILOT_VERSION,offerCandidates,refreshCandidates,
    counts:{offersReady:offerCandidates.filter(x=>x.ready).length,offersReview:offerCandidates.filter(x=>!x.ready).length,refreshReady:refreshCandidates.filter(x=>x.ready).length}};
}

async function appendEvent(executionId:string,type:string,snapshot:unknown){
  const latest=await prisma.ebayActionExecutionEvent.findFirst({where:{executionId},orderBy:{sequence:"desc"},select:{sequence:true}});
  await prisma.ebayActionExecutionEvent.create({data:{executionId,sequence:(latest?.sequence??0)+1,type,snapshot:json(snapshot)}});
}

async function executeOffer(candidate:VelocityOfferPlan,operatorId:string){
  const listing=await prisma.listing.findUniqueOrThrow({where:{id:candidate.listingId},include:{store:true,costBasis:true}});
  const {accessToken}=await getValidAccessToken(listing.store);
  const [eligible,live]=await Promise.all([findEligibleItems(accessToken),getItem(accessToken,candidate.itemId)]);
  if(!eligible.has(candidate.itemId))throw new Error("Listing is no longer Negotiation eligible");
  if(!active(live)||live.Title!==listing.title||Math.abs(livePrice(live)-candidate.currentPrice)>.005)throw new Error("Live listing state changed before offer");
  const cost=listing.costBasis;
  if(!cost||[cost.unitAcquisitionCost,cost.unitGradingCost,cost.unitSuppliesCost,cost.unitOutboundPostageCost,cost.unitOtherCost].some(v=>v==null))throw new Error("Cost basis is no longer complete");
  const knownCost=[cost.unitAcquisitionCost,cost.unitGradingCost,cost.unitSuppliesCost,cost.unitOutboundPostageCost,cost.unitOtherCost].reduce((sum,v)=>sum+Number(v??0),0);
  const proposed=offerPrice(candidate.currentPrice);
  if(proposed<knownCost*1.2)throw new Error("Current economics fail 20% known-cost margin guardrail");
  const dayKey=new Date().toISOString().slice(0,10),idempotencyKey=`velocity-offer-8:${candidate.itemId}:${dayKey}`;
  const existing=await prisma.ebayActionExecution.findUnique({where:{idempotencyKey}});
  if(existing?.status==="verified")return{itemId:candidate.itemId,status:"already_verified",executionId:existing.id};
  if(existing)throw new Error(`Existing execution ${existing.id} requires reconciliation`);
  const decision=await prisma.operatorDecision.create({data:{listingId:listing.id,operatorId,recommendedAction:"VELOCITY_OFFER_8",doctrineVersion:VELOCITY_AUTOPILOT_VERSION,decision:"follow_recommendation",operatorAdjustedValue:proposed,beforeState:json({title:listing.title,price:candidate.currentPrice,itemId:candidate.itemId}),evidenceSnapshot:json({source:"velocity-autopilot",candidate,capturedAt:new Date().toISOString()}),observationWindowDays:7}});
  const execution=await prisma.ebayActionExecution.create({data:{listingId:listing.id,storeId:listing.storeId,decisionId:decision.id,operatorId,action:"VELOCITY_OFFER_8",doctrineVersion:VELOCITY_AUTOPILOT_VERSION,idempotencyKey,oldEbayItemId:candidate.itemId,beforeState:json({title:listing.title,price:candidate.currentPrice,itemId:candidate.itemId}),proposedState:json({offerPrice:proposed,discountPct:VELOCITY_OFFER_DISCOUNT_PCT}),evidenceSnapshot:json({candidate})}});
  await appendEvent(execution.id,"approved_and_server_revalidated",{candidate,knownCost});
  await prisma.ebayActionExecution.update({where:{id:execution.id},data:{status:"executing"}});
  const response=await sendOfferToInterestedBuyers(accessToken,{listingId:candidate.itemId,price:proposed,message:"A special offer from Legends Card Co."});
  const offers=response.offers??[];
  if(!offers.length||offers.some(o=>!o.offerId||o.offerStatus!=="PENDING"||!o.offeredItems?.some(i=>i.listingId===candidate.itemId))){
    await appendEvent(execution.id,"manual_reconciliation_required",{response,automaticRetry:false});
    await prisma.ebayActionExecution.update({where:{id:execution.id},data:{status:"manual_reconciliation_required"}});
    throw new Error("Provider offer response could not be verified");
  }
  await appendEvent(execution.id,"provider_verified",{offerPrice:proposed,offers:offers.map(o=>({offerId:o.offerId,status:o.offerStatus}))});
  await prisma.ebayActionExecution.update({where:{id:execution.id},data:{status:"verified",providerVerifiedAt:new Date()}});
  return{itemId:candidate.itemId,status:"verified",executionId:execution.id,offerPrice:proposed};
}

async function executeRefresh(candidate:VelocityRefreshPlan,operatorId:string){
  const listing=await prisma.listing.findUniqueOrThrow({where:{id:candidate.listingId},include:{store:true}});
  const {accessToken}=await getValidAccessToken(listing.store);
  const eligible=await findEligibleItems(accessToken);if(eligible.has(candidate.itemId))throw new Error("Buyer interest appeared; refresh stopped");
  const live=await getItem(accessToken,candidate.itemId),quantity=remainingProviderQuantity(live);
  if(!active(live)||live.Title!==listing.title||quantity==null||Math.abs(livePrice(live)-candidate.currentPrice)>.005)throw new Error("Live listing state changed before refresh");
  const providerState=preservedRelistState(live,quantity);
  const evidence={source:"velocity-autopilot",selection:candidate,negotiationEligible:false,observedAt:new Date().toISOString()};
  const execution=await createGovernedRefreshExecution({listingId:listing.id,operatorId,beforeProviderState:providerState,remainingQuantity:quantity,evidence});
  const completed=await executeGovernedAction(execution.id,operatorId,ebayWriteProvider,{writesEnabled:true});
  return{oldItemId:candidate.itemId,newItemId:completed.newEbayItemId,status:completed.status,executionId:execution.id};
}

export async function executeVelocityAutopilot(input:{operatorId:string;approvalText:string}){
  if(input.approvalText!==VELOCITY_APPROVAL_TEXT)throw new Error("Exact Velocity Autopilot approval is required");
  const plan=await buildVelocityAutopilotPlan();
  const offers=plan.offerCandidates.filter(x=>x.ready).slice(0,VELOCITY_OFFER_MAX_PER_RUN);
  const refreshes=plan.refreshCandidates.filter(x=>x.ready).slice(0,VELOCITY_REFRESH_MAX_PER_RUN);
  const offerResults:unknown[]=[];
  for(let i=0;i<offers.length;i++){
    try{offerResults.push(await executeOffer(offers[i],input.operatorId));}
    catch(error){offerResults.push({itemId:offers[i].itemId,status:"failed",error:error instanceof Error?error.message:String(error)});break;}
  }
  const refreshResults:unknown[]=[];
  const canary=refreshes.slice(0,VELOCITY_REFRESH_CANARY);
  for(const candidate of canary){
    try{refreshResults.push(await executeRefresh(candidate,input.operatorId));}
    catch(error){refreshResults.push({itemId:candidate.itemId,status:"failed",error:error instanceof Error?error.message:String(error)});return{plan,offerResults,refreshResults,refreshStopped:true};}
  }
  if(canary.length===VELOCITY_REFRESH_CANARY&&refreshResults.every((r:any)=>r.status==="verified")){
    for(const candidate of refreshes.slice(VELOCITY_REFRESH_CANARY)){
      try{refreshResults.push(await executeRefresh(candidate,input.operatorId));}
      catch(error){refreshResults.push({itemId:candidate.itemId,status:"failed",error:error instanceof Error?error.message:String(error)});break;}
    }
  }
  return{plan,offerResults,refreshResults,refreshStopped:false};
}
