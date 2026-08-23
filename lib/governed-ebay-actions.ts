import { Prisma, type EbayActionExecution } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { loadInventoryHealth } from "@/lib/inventory-health-data";
import { endFixedPriceListing, getItem, getValidAccessToken, relistFixedPriceListing, reviseFixedPrice, reviseFixedPriceTitle, verifyRelistFixedPriceListing, type EbayListingItem } from "@/lib/ebay";
import { importItems } from "@/lib/ebay-sync-service";
import { INVENTORY_DECISION_DOCTRINE_VERSION } from "@/lib/inventory-decision-doctrine";
import { hasLegacyDuplicateDiscriminator, hasUnresolvedDuplicateFamily, inspectListingTitle, legacyDuplicateTitleKey, passesProvenTitleExecutionPolicy, TITLE_INSPECTION_RULE_VERSION, type TitleInspection } from "@/lib/title-inspection-agent";

export type GovernedAction = "LOWER_PRICE" | "RAISE_PRICE" | "OPTIMIZE_TITLE" | "END_SELL_SIMILAR" | "ENDED_BIN_CLEANUP";
export type GovernedProposal = { action:GovernedAction; listingId:string; ebayItemId:string; doctrineVersion:string; before:Record<string,unknown>; after:Record<string,unknown>; why:string; ready:boolean; blockers:string[] };
export type EbayWriteProvider = {
  getItem(accessToken:string,itemId:string):Promise<EbayListingItem>;
  revisePrice(accessToken:string,itemId:string,price:number,messageId:string):Promise<{itemId:string}>;
  reviseTitle(accessToken:string,itemId:string,title:string,messageId:string):Promise<{itemId:string;ack?:string;warningCodes?:string[]}>;
  endListing(accessToken:string,itemId:string,messageId:string):Promise<{itemId:string}>;
  verifyRelist(accessToken:string,itemId:string,quantity:number,messageId:string):Promise<{itemId:string;ack?:string;warnings?:Array<{code:string|null;severity:string|null;message:string}>}>;
  relist(accessToken:string,itemId:string,quantity:number,messageId:string):Promise<{oldItemId:string;newItemId:string;ack?:string;warnings?:Array<{code:string|null;severity:string|null;message:string}>}>;
};

export const ebayWriteProvider:EbayWriteProvider={getItem,revisePrice:reviseFixedPrice,reviseTitle:reviseFixedPriceTitle,endListing:endFixedPriceListing,verifyRelist:verifyRelistFixedPriceListing,relist:relistFixedPriceListing};
const asJson=(value:unknown)=>JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==="object"?Object.fromEntries(Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)])):value;
const sameJson=(left:unknown,right:unknown)=>JSON.stringify(canonical(left))===JSON.stringify(canonical(right));
const providerPrice=(item:EbayListingItem)=>{const value=item.SellingStatus?.CurrentPrice;if(typeof value==="number")return value;if(typeof value==="string")return Number(value);if(value&&typeof value==="object")return Number(value["#text"]);return NaN;};
export function unrelatedProviderState(item:EbayListingItem){return canonical({itemId:String(item.ItemID),description:item.Description??null,price:providerPrice(item),quantity:item.Quantity,quantityAvailable:item.QuantityAvailable,quantitySold:item.SellingStatus?.QuantitySold??null,listingStatus:item.SellingStatus?.ListingStatus??null,listingType:item.ListingType??null,condition:item.ConditionDisplayName??null,category:item.PrimaryCategory??null,startTime:item.ListingDetails?.StartTime??null,endTime:item.ListingDetails?.EndTime??null,pictures:item.PictureDetails?.PictureURL??null,itemSpecifics:item.ItemSpecifics??null});}
export function remainingProviderQuantity(item:EbayListingItem){const explicit=Number(item.QuantityAvailable);if(Number.isInteger(explicit)&&explicit>0)return explicit;const total=Number(item.Quantity),sold=Number(item.SellingStatus?.QuantitySold??0),remaining=total-sold;return Number.isInteger(remaining)&&remaining>0?remaining:null;}
export function preservedRelistState(item:EbayListingItem,remainingQuantity:number){
  const fields=["Title","SubTitle","Description","SKU","StartPrice","BuyItNowPrice","Currency","Country","Site","Location","PostalCode","ListingType","ListingDuration","PrimaryCategory","SecondaryCategory","Storefront","ItemSpecifics","ConditionID","ConditionDisplayName","ConditionDescriptors","PictureDetails","SellerProfiles","ShippingDetails","ShippingPackageDetails","ReturnPolicy","PaymentMethods","AutoPay","BestOfferDetails","BuyerRequirementDetails","DispatchTimeMax","ShipToLocations","ProductListingDetails","Variations","VariationSpecificsSet","ItemCompatibilityList","ExtendedProducerResponsibility","Regulatory","ProductSafety","QuantityRestrictionPerBuyer","PrivateListing"];
  const state:Record<string,unknown>={Quantity:remainingQuantity};for(const field of fields)state[field]=item[field]??null;
  if(state.BestOfferDetails&&typeof state.BestOfferDetails==="object"){const details={...(state.BestOfferDetails as Record<string,unknown>)};delete details.BestOfferCount;delete details.NewBestOffer;state.BestOfferDetails=details;}
  return canonical(state);
}
function materialWarnings(result:{warnings?:Array<{code:string|null;severity:string|null;message:string}>}){return (result.warnings??[]).filter(w=>w.severity?.toLowerCase()!=="warning"||w.code!=="21919456");}

export async function buildGovernedTitleProposal(listingId:string):Promise<{proposal:GovernedProposal;inspection:TitleInspection}|null>{
  const listing=await prisma.listing.findUnique({where:{id:listingId},select:{id:true,ebayItemId:true,title:true,currentPrice:true,quantity:true,listingStatus:true,itemSpecifics:true,authoritativeObservedAt:true,lastSyncedAt:true}});if(!listing||listing.listingStatus!=="active")return null;
  const titleBase=listing.title.replace(/\.{1,3}\s*$/,"").trim(),siblings=await prisma.listing.findMany({where:{title:{startsWith:titleBase}},select:{title:true}}),siblingTitles=siblings.map(row=>row.title).filter(title=>legacyDuplicateTitleKey(title)===legacyDuplicateTitleKey(listing.title)),legacyDuplicateDiscriminator=hasLegacyDuplicateDiscriminator(listing.title,siblingTitles),duplicateAmbiguity=hasUnresolvedDuplicateFamily(listing.title,siblingTitles);
  const inspection=inspectListingTitle({listingId:listing.id,ebayItemId:listing.ebayItemId,title:listing.title,itemSpecifics:listing.itemSpecifics,evidenceObservedAt:listing.authoritativeObservedAt??listing.lastSyncedAt,legacyDuplicateDiscriminator,excludeReason:duplicateAmbiguity?"Active or historical normalized-title duplicate family requires operator review":null});
  const blockers:string[]=[];if(!passesProvenTitleExecutionPolicy(inspection))blockers.push("Title inspection no longer satisfies the proven execution policy");if(!/^\d+$/.test(listing.ebayItemId))blockers.push("Numeric provider ItemID is unavailable");
  const proposal:GovernedProposal={action:"OPTIMIZE_TITLE",listingId:listing.id,ebayItemId:listing.ebayItemId,doctrineVersion:TITLE_INSPECTION_RULE_VERSION,before:{title:listing.title,price:Number(listing.currentPrice),quantity:listing.quantity,listingStatus:listing.listingStatus,ebayItemId:listing.ebayItemId},after:{title:inspection.proposedTitle},why:inspection.reason,ready:blockers.length===0,blockers};return{proposal,inspection};
}

export async function createGovernedTitleExecution(listingId:string,operatorId:string){
  const built=await buildGovernedTitleProposal(listingId);if(!built||!built.proposal.ready)throw new Error("Title proposal is not execution-ready");const {proposal,inspection}=built;
  const decision=await prisma.operatorDecision.create({data:{listingId,operatorId,recommendedAction:"OPTIMIZE_TITLE",doctrineVersion:TITLE_INSPECTION_RULE_VERSION,decision:"follow_recommendation",beforeState:asJson(proposal.before),evidenceSnapshot:asJson({source:"title-inspection-agent",inspection,governedProposal:proposal,capturedAt:new Date().toISOString()}),observationWindowDays:0}});
  const execution=await prisma.ebayActionExecution.create({data:{listingId,storeId:(await prisma.listing.findUniqueOrThrow({where:{id:listingId},select:{storeId:true}})).storeId,decisionId:decision.id,operatorId,action:"OPTIMIZE_TITLE",doctrineVersion:TITLE_INSPECTION_RULE_VERSION,idempotencyKey:`${decision.id}:${TITLE_INSPECTION_RULE_VERSION}:OPTIMIZE_TITLE`,oldEbayItemId:proposal.ebayItemId,beforeState:asJson(proposal.before),proposedState:asJson(proposal.after),evidenceSnapshot:asJson({source:"title-inspection-agent",inspection})}});await appendEvent(execution.id,"approved",{operatorId,proposal,inspection});return execution;
}

export async function createGovernedRefreshExecution(input:{listingId:string;operatorId:string;beforeProviderState:unknown;remainingQuantity:number;evidence:unknown}){
  const listing=await prisma.listing.findUniqueOrThrow({where:{id:input.listingId},select:{id:true,storeId:true,ebayItemId:true,title:true,currentPrice:true,listingStatus:true,listingFormat:true}});
  if(listing.listingStatus!=="active"||!listing.listingFormat?.toLowerCase().includes("fixed")||!/^\d+$/.test(listing.ebayItemId)||!Number.isInteger(input.remainingQuantity)||input.remainingQuantity<=0)throw new Error("Refresh execution input is not eligible");
  const before={title:listing.title,price:Number(listing.currentPrice),listingStatus:listing.listingStatus,listingFormat:listing.listingFormat,ebayItemId:listing.ebayItemId,remainingQuantity:input.remainingQuantity,providerState:input.beforeProviderState};
  const after={listingStatus:"active",ebayItemId:"provider-assigned-after-relist",remainingQuantity:input.remainingQuantity};
  const decision=await prisma.operatorDecision.create({data:{listingId:listing.id,operatorId:input.operatorId,recommendedAction:"END_SELL_SIMILAR",doctrineVersion:"listing-refresh-canary-v1.0.0",decision:"follow_recommendation",beforeState:asJson(before),evidenceSnapshot:asJson({source:"listing-refresh-canary",evidence:input.evidence,capturedAt:new Date().toISOString()}),observationWindowDays:30}});
  const execution=await prisma.ebayActionExecution.create({data:{listingId:listing.id,storeId:listing.storeId,decisionId:decision.id,operatorId:input.operatorId,action:"END_SELL_SIMILAR",doctrineVersion:"listing-refresh-canary-v1.0.0",idempotencyKey:`${decision.id}:listing-refresh-canary-v1.0.0:END_SELL_SIMILAR`,oldEbayItemId:listing.ebayItemId,beforeState:asJson(before),proposedState:asJson(after),evidenceSnapshot:asJson({source:"listing-refresh-canary",evidence:input.evidence})}});
  await appendEvent(execution.id,"approved",{operatorId:input.operatorId,before,after,evidence:input.evidence});return execution;
}

export async function buildGovernedProposal(listingId:string):Promise<GovernedProposal|null>{
  const data=await loadInventoryHealth(new Date(),listingId);const row=data.rows[0];if(!row){const ended=await prisma.listing.findFirst({where:{id:listingId,listingStatus:"ended",listingFormat:{contains:"Fixed",mode:"insensitive"},relistedToEbayItemId:null},select:{id:true,ebayItemId:true,title:true,currentPrice:true,endTime:true}});if(!ended)return null;const blockers=ended.endTime&&ended.endTime.getTime()<=Date.now()-30*86_400_000?[]:["Ended listing has not completed the 30-day cleanup retention period"];return{action:"ENDED_BIN_CLEANUP",listingId:ended.id,ebayItemId:ended.ebayItemId,doctrineVersion:INVENTORY_DECISION_DOCTRINE_VERSION,before:{listingStatus:"ended",cleanupDisposition:null,ebayItemId:ended.ebayItemId,title:ended.title,price:Number(ended.currentPrice)},after:{listingStatus:"ended",cleanupDisposition:"reviewed_archived",ebayItemId:ended.ebayItemId},why:"The fixed-price listing is already ended, has completed its retention period, and has no recorded replacement ItemID. Internal cleanup removes it from the operator queue while preserving all Legends history.",ready:blockers.length===0,blockers};}const action=row.doctrine.interventionSelected;
  if(!["LOWER_PRICE","RAISE_PRICE","OPTIMIZE_TITLE","END_SELL_SIMILAR"].includes(action))return null;
  const blockers:string[]=[];let after:Record<string,unknown>={};const ebayItemId=row.ebayItemId??"";if(!/^\d+$/.test(ebayItemId))blockers.push("Numeric provider ItemID is unavailable");
  if(action==="LOWER_PRICE"||action==="RAISE_PRICE"){
    if(row.suggestedPrice==null||row.compConfidence==null)blockers.push("Supported price target is unavailable");
    if((row.compConfidence??0)<60)blockers.push("Comp confidence is below policy threshold");
    after={price:row.suggestedPrice};
  }else if(action==="OPTIMIZE_TITLE"){
    if(!row.doctrine.proposedTitle)blockers.push("Exact non-destructive title proposal is unavailable");
    after={title:row.doctrine.proposedTitle};
  }else{
    if(row.doctrine.diagnosticFunnelStage!=="refresh")blockers.push("Doctrine does not classify this listing as refresh-ready");
    after={listingStatus:"active",ebayItemId:"provider-assigned-after-relist"};
  }
  return{action:action as GovernedAction,listingId:row.id,ebayItemId,doctrineVersion:row.doctrine.doctrineVersion,before:{title:row.title,price:row.currentPrice,quantity:row.quantity,listingStatus:"active",ebayItemId},after,why:row.doctrine.whyThisActionOutranksAlternatives,ready:blockers.length===0,blockers};
}

async function appendEvent(executionId:string,type:string,snapshot:unknown){const latest=await prisma.ebayActionExecutionEvent.findFirst({where:{executionId},orderBy:{sequence:"desc"},select:{sequence:true}});return prisma.ebayActionExecutionEvent.create({data:{executionId,sequence:(latest?.sequence??0)+1,type,snapshot:asJson(snapshot)}});}
function productionWritesEnabled(){return process.env.VERCEL_ENV!=="production"||process.env.EBAY_PRODUCTION_WRITES_ENABLED==="explicitly-approved";}

async function revalidate(execution:EbayActionExecution,provider:EbayWriteProvider,accessToken:string){
  const evidence=execution.evidenceSnapshot as Record<string,unknown>;const refreshCanary=execution.action==="END_SELL_SIMILAR"&&evidence.source==="listing-refresh-canary";const titleInspection=execution.action==="OPTIMIZE_TITLE"&&evidence.source==="title-inspection-agent";const proposal=refreshCanary?null:titleInspection?(await buildGovernedTitleProposal(execution.listingId))?.proposal:await buildGovernedProposal(execution.listingId);if(!refreshCanary&&(!proposal||!proposal.ready))throw new Error("Doctrine no longer supports an executable action");
  if(!refreshCanary&&proposal&&(proposal.action!==execution.action||proposal.doctrineVersion!==execution.doctrineVersion||!sameJson(proposal.after,execution.proposedState)))throw new Error("Proposal changed after approval; a new authenticated approval is required");
  const live=await provider.getItem(accessToken,execution.oldEbayItemId);if(live.Title!==String((execution.beforeState as Record<string,unknown>).title))throw new Error("Provider title changed after approval");
  const expectedPrice=Number((execution.beforeState as Record<string,unknown>).price);if(Math.abs(providerPrice(live)-expectedPrice)>0.005)throw new Error("Provider price changed after approval");
  if(refreshCanary){const quantity=remainingProviderQuantity(live),expectedQuantity=Number((execution.beforeState as Record<string,unknown>).remainingQuantity);if(quantity!==expectedQuantity)throw new Error("Provider remaining quantity changed after approval");if(!sameJson(preservedRelistState(live,expectedQuantity),(execution.beforeState as Record<string,unknown>).providerState))throw new Error("Provider listing state changed after approval");}
  return live;
}

export async function createGovernedExecution(decisionId:string,operatorId:string){
  const decision=await prisma.operatorDecision.findUnique({where:{id:decisionId},include:{listing:true}});if(!decision||decision.operatorId!==operatorId||decision.decision!=="follow_recommendation")throw new Error("A matching authenticated approval is required");
  const proposal=await buildGovernedProposal(decision.listingId);if(!proposal||!proposal.ready||proposal.action!==decision.recommendedAction||proposal.doctrineVersion!==decision.doctrineVersion)throw new Error("Approved decision is stale or not executable");
  const execution=await prisma.ebayActionExecution.upsert({where:{decisionId},update:{},create:{listingId:decision.listingId,storeId:decision.listing.storeId,decisionId,operatorId,action:proposal.action,doctrineVersion:proposal.doctrineVersion,idempotencyKey:`${decisionId}:${proposal.doctrineVersion}:${proposal.action}`,oldEbayItemId:proposal.ebayItemId,beforeState:asJson(proposal.before),proposedState:asJson(proposal.after),evidenceSnapshot:asJson(decision.evidenceSnapshot??{})}});
  if(await prisma.ebayActionExecutionEvent.count({where:{executionId:execution.id}})===0)await appendEvent(execution.id,"approved",{operatorId,proposal});
  return execution;
}

export async function executeGovernedAction(executionId:string,operatorId:string,provider:EbayWriteProvider=ebayWriteProvider,options:{writesEnabled?:boolean}={}){
  let execution=await prisma.ebayActionExecution.findUniqueOrThrow({where:{id:executionId},include:{store:true}});if(execution.operatorId!==operatorId)throw new Error("Execution belongs to another operator approval");
  if(execution.status==="verified")return execution;
  if(execution.action==="ENDED_BIN_CLEANUP"){
    const proposal=await buildGovernedProposal(execution.listingId);if(!proposal||!proposal.ready||!sameJson(proposal.after,execution.proposedState))throw new Error("Ended-listing cleanup proposal changed after approval");
    await appendEvent(execution.id,"server_revalidated",{listingStatus:"ended",providerWrite:false});await appendEvent(execution.id,"internal_cleanup_verified",{historyPreserved:true,providerWrite:false});
    return prisma.ebayActionExecution.update({where:{id:execution.id},data:{status:"verified",providerVerifiedAt:new Date()}});
  }
  const {accessToken}=await getValidAccessToken(execution.store);const live=await revalidate(execution,provider,accessToken);await appendEvent(execution.id,"server_revalidated",{itemId:live.ItemID,title:live.Title,price:providerPrice(live)});
  if(!(options.writesEnabled??productionWritesEnabled())){await appendEvent(execution.id,"production_write_blocked",{reason:"Controlled production write approval is not enabled"});throw new Error("Production eBay writes are disabled pending controlled approval");}
  execution=await prisma.ebayActionExecution.update({where:{id:execution.id},data:{status:"executing"},include:{store:true}});await appendEvent(execution.id,"execution_started",{action:execution.action});
  try{
    if(execution.action==="LOWER_PRICE"||execution.action==="RAISE_PRICE")await provider.revisePrice(accessToken,execution.oldEbayItemId,Number((execution.proposedState as Record<string,unknown>).price),execution.idempotencyKey);
    else if(execution.action==="OPTIMIZE_TITLE"){const providerResult=await provider.reviseTitle(accessToken,execution.oldEbayItemId,String((execution.proposedState as Record<string,unknown>).title),execution.idempotencyKey);await appendEvent(execution.id,"provider_accepted",providerResult);}
    else if(execution.action==="END_SELL_SIMILAR"){
      const old=await provider.getItem(accessToken,execution.oldEbayItemId);const existingRelist=old.RelistedItemID==null?null:String(old.RelistedItemID);
      if(!existingRelist){const quantity=remainingProviderQuantity(old);if(quantity==null)throw new Error("Actual remaining provider quantity is unavailable");const alreadyEnded=await prisma.ebayActionExecutionEvent.count({where:{executionId:execution.id,type:"provider_listing_ended"}})>0;const alreadyVerified=await prisma.ebayActionExecutionEvent.count({where:{executionId:execution.id,type:"provider_relist_preflight_verified"}})>0;
        if(!alreadyEnded&&!alreadyVerified){const verification=await provider.verifyRelist(accessToken,execution.oldEbayItemId,quantity,`${execution.idempotencyKey}:verify`);await appendEvent(execution.id,"provider_relist_preflight_verified",{quantity,result:verification,preservedState:preservedRelistState(old,quantity)});if(materialWarnings(verification).length)throw new Error(`Relist verification returned material warnings: ${materialWarnings(verification).map(w=>w.code??w.message).join(", ")}`);}
        if(!alreadyEnded){await provider.endListing(accessToken,execution.oldEbayItemId,`${execution.idempotencyKey}:end`);const ended=await provider.getItem(accessToken,execution.oldEbayItemId);if(String(ended.SellingStatus?.ListingStatus??"").toLowerCase()==="active")throw new Error("Provider did not confirm the old listing ended");await appendEvent(execution.id,"provider_listing_ended",{oldItemId:execution.oldEbayItemId,quantity,providerStatus:ended.SellingStatus?.ListingStatus??null});}
        const relisted=await provider.relist(accessToken,execution.oldEbayItemId,quantity,`${execution.idempotencyKey}:relist`);await appendEvent(execution.id,"provider_relist_accepted",{quantity,result:relisted});execution=await prisma.ebayActionExecution.update({where:{id:execution.id},data:{newEbayItemId:relisted.newItemId},include:{store:true}});}else execution=await prisma.ebayActionExecution.update({where:{id:execution.id},data:{newEbayItemId:existingRelist},include:{store:true}});
    }else throw new Error("Unsupported provider action");
    const verifyItemId=execution.newEbayItemId??execution.oldEbayItemId;const verified=await provider.getItem(accessToken,verifyItemId);
    if((execution.action==="LOWER_PRICE"||execution.action==="RAISE_PRICE")&&Math.abs(providerPrice(verified)-Number((execution.proposedState as Record<string,unknown>).price))>0.005)throw new Error("Provider price verification failed");
    if(execution.action==="OPTIMIZE_TITLE"&&verified.Title!==String((execution.proposedState as Record<string,unknown>).title))throw new Error("Provider title verification failed");
    if(execution.action==="OPTIMIZE_TITLE"&&!sameJson(unrelatedProviderState(live),unrelatedProviderState(verified))){await appendEvent(execution.id,"unintended_change_detected",{before:unrelatedProviderState(live),after:unrelatedProviderState(verified)});throw new Error("Provider title revision changed unrelated listing state");}
    if(execution.action==="END_SELL_SIMILAR"){
      const quantity=remainingProviderQuantity(live);if(quantity==null||!sameJson(preservedRelistState(live,quantity),preservedRelistState(verified,quantity))){await appendEvent(execution.id,"unintended_change_detected",{before:quantity==null?null:preservedRelistState(live,quantity),after:quantity==null?null:preservedRelistState(verified,quantity)});throw new Error("Relisted listing did not preserve unrelated provider state exactly");}
      await importItems({storeId:execution.storeId,items:[verified],source:"governed-relist-verification",status:"active",observedAt:new Date()});
      await prisma.listing.update({where:{id:execution.listingId},data:{listingStatus:"ended",relistedToEbayItemId:verifyItemId}});
      const activeCopies=await prisma.listing.count({where:{storeId:execution.storeId,ebayItemId:{in:[execution.oldEbayItemId,verifyItemId]},listingStatus:"active"}});if(activeCopies!==1){await appendEvent(execution.id,"duplicate_reconciliation_failed",{activeCopies,oldItemId:execution.oldEbayItemId,newItemId:verifyItemId});throw new Error("Old/new listing active-population reconciliation failed");}
    }else if(execution.action==="OPTIMIZE_TITLE")await prisma.listing.update({where:{id:execution.listingId},data:{title:verified.Title,lastSyncedAt:new Date(),authoritativeObservedAt:new Date(),authoritativeSource:"governed-title-verification"}});
    else await importItems({storeId:execution.storeId,items:[verified],source:"governed-revision-verification",status:"active",observedAt:new Date()});
    await appendEvent(execution.id,"provider_verified",{itemId:verifyItemId,title:verified.Title,price:providerPrice(verified),unrelatedStateUnchanged:execution.action==="OPTIMIZE_TITLE"?true:undefined});
    return prisma.ebayActionExecution.update({where:{id:execution.id},data:{status:"verified",providerVerifiedAt:new Date()}});
  }catch(error){const partial=execution.action==="END_SELL_SIMILAR"&&await prisma.ebayActionExecutionEvent.count({where:{executionId:execution.id,type:"provider_listing_ended"}})>0;await appendEvent(execution.id,partial?"partial_failure":"execution_failed",{message:error instanceof Error?error.message:"Provider action failed"});await prisma.ebayActionExecution.update({where:{id:execution.id},data:{status:partial?"partial_failure":"failed"}});throw error;}
}
