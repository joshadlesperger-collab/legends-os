import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getItem, getValidAccessToken, reviseFixedPricePriceAndShippingProfile, type EbayListingItem } from "@/lib/ebay";
import { getAdvertisingContext } from "@/lib/ebay-marketing";
import { importItems } from "@/lib/ebay-sync-service";
import {
  FREE_SHIPPING_PHASE1_ITEM_IDS,
  FREE_SHIPPING_PHASE1_VERSION,
  evaluateFreeShippingCandidate,
  freeShippingPolicies,
  getFulfillmentPolicies,
  providerShippingCharge,
  providerShippingProfileId,
} from "@/lib/free-shipping-experiment";

export const FREE_SHIPPING_PHASE1_ACTION = "FREE_SHIPPING_PHASE1";
export const FREE_SHIPPING_PHASE1_CANARY_SIZE = 5;
export const FREE_SHIPPING_PHASE1_APPROVAL_TEXT = "I APPROVE FREE SHIPPING PHASE 1";

const json=(value:unknown)=>JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==="object"
  ?Object.fromEntries(Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)]))
  :value;
const same=(a:unknown,b:unknown)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));

function value(value:unknown):string|null{
  if(value==null)return null;
  if(typeof value==="string"||typeof value==="number")return String(value);
  if(typeof value==="object"){
    const record=value as Record<string,unknown>;
    if(record["#text"]!=null)return String(record["#text"]);
  }
  return null;
}

function sellerProfile(item:EbayListingItem,key:"SellerPaymentProfile"|"SellerReturnProfile"){
  const profiles=item.SellerProfiles as Record<string,unknown>|undefined;
  return (profiles?.[key]??null) as Record<string,unknown>|null;
}

function unchangedState(item:EbayListingItem){
  const payment=sellerProfile(item,"SellerPaymentProfile");
  const returns=sellerProfile(item,"SellerReturnProfile");
  return canonical({
    itemId:String(item.ItemID),
    title:item.Title,
    quantity:item.Quantity,
    quantityAvailable:item.QuantityAvailable,
    quantitySold:item.SellingStatus?.QuantitySold??null,
    listingStatus:item.SellingStatus?.ListingStatus??null,
    listingType:item.ListingType??null,
    condition:item.ConditionDisplayName??null,
    category:item.PrimaryCategory??null,
    pictures:item.PictureDetails?.PictureURL??null,
    itemSpecifics:item.ItemSpecifics??null,
    paymentProfileId:value(payment?.PaymentProfileID),
    returnProfileId:value(returns?.ReturnProfileID),
  });
}

async function appendEvent(executionId:string,type:string,snapshot:unknown){
  const latest=await prisma.ebayActionExecutionEvent.findFirst({where:{executionId},orderBy:{sequence:"desc"},select:{sequence:true}});
  await prisma.ebayActionExecutionEvent.create({data:{executionId,sequence:(latest?.sequence??0)+1,type,snapshot:json(snapshot)}});
}

type Phase="canary"|"remaining";
export type FreeShippingExecutionRow={
  itemId:string;
  status:"verified"|"already_verified"|"failed";
  executionId?:string;
  beforePrice?:number;
  afterPrice?:number;
  beforeShipping?:number|null;
  afterShipping?:number|null;
  beforeShippingProfileId?:string|null;
  afterShippingProfileId?:string|null;
  error?:string;
};

export async function runFreeShippingPhase1Execution(input:{phase:Phase;operatorId:string;approvalText:string}){
  if(input.approvalText!==FREE_SHIPPING_PHASE1_APPROVAL_TEXT)throw new Error("Exact production approval text is required");
  // Phase 1 is separately and explicitly authorized for this exact fixed cohort.
  // The exact approval text plus the fixed cohort/version are the production gate.

  const targetIds=input.phase==="canary"
    ?[...FREE_SHIPPING_PHASE1_ITEM_IDS].slice(0,FREE_SHIPPING_PHASE1_CANARY_SIZE)
    :[...FREE_SHIPPING_PHASE1_ITEM_IDS].slice(FREE_SHIPPING_PHASE1_CANARY_SIZE);

  const listings=await prisma.listing.findMany({where:{ebayItemId:{in:targetIds}},include:{store:true}});
  const byItem=new Map(listings.map(row=>[row.ebayItemId,row]));
  if(listings.length!==targetIds.length)throw new Error("One or more approved treatment listings are missing from Legends OS");

  const storeIds=Array.from(new Set(listings.map(row=>row.storeId)));
  const storeState=new Map<string,{accessToken:string;adContext:Awaited<ReturnType<typeof getAdvertisingContext>>;freePolicyId:string;freePolicyName:string|null}>();
  for(const storeId of storeIds){
    const listing=listings.find(row=>row.storeId===storeId)!;
    const {accessToken}=await getValidAccessToken(listing.store);
    const [adContext,policies]=await Promise.all([getAdvertisingContext(accessToken),getFulfillmentPolicies(accessToken)]);
    const free=freeShippingPolicies(policies);
    if(free.length!==1||!free[0]?.fulfillmentPolicyId)throw new Error(`Expected exactly one free-shipping fulfillment policy for store ${storeId}; found ${free.length}`);
    storeState.set(storeId,{accessToken,adContext,freePolicyId:free[0].fulfillmentPolicyId,freePolicyName:free[0].name??null});
  }

  const results:FreeShippingExecutionRow[]=[];
  for(const itemId of targetIds){
    const existing=await prisma.ebayActionExecution.findFirst({where:{idempotencyKey:`free-shipping-phase1:${FREE_SHIPPING_PHASE1_VERSION}:${itemId}`}});
    if(existing?.status==="verified"){results.push({itemId,status:"already_verified",executionId:existing.id});continue;}
    if(existing)throw new Error(`Existing non-terminal free-shipping execution ${existing.id} requires reconciliation before continuing`);

    const listing=byItem.get(itemId)!;
    const state=storeState.get(listing.storeId)!;
    let executionId:string|undefined;
    try{
      const before=await getItem(state.accessToken,itemId);
      const ad=state.adContext.contexts.get(itemId)??state.adContext.defaultContext;
      const candidate=evaluateFreeShippingCandidate({
        itemId,
        item:before,
        persistedTitle:listing.title,
        persistedPrice:Number(listing.currentPrice),
        adRate:ad.adRate,
      });
      if(!candidate.ready||candidate.proposedPrice==null)throw new Error(`Live preflight blocked: ${candidate.blockers.join("; ")||"unknown blocker"}`);
      const beforeShippingProfileId=providerShippingProfileId(before);
      if(!beforeShippingProfileId)throw new Error("Current shipping profile ID is unavailable");
      if(beforeShippingProfileId===state.freePolicyId)throw new Error("Listing already uses the target free-shipping policy");

      const beforeUnchanged=unchangedState(before);
      const beforeShipping=providerShippingCharge(before);
      const decision=await prisma.operatorDecision.create({data:{
        listingId:listing.id,
        operatorId:input.operatorId,
        recommendedAction:FREE_SHIPPING_PHASE1_ACTION,
        doctrineVersion:FREE_SHIPPING_PHASE1_VERSION,
        decision:"follow_recommendation",
        beforeState:json({itemId,title:before.Title,price:candidate.currentPrice,shipping:beforeShipping,shippingProfileId:beforeShippingProfileId,adRate:candidate.adRate}),
        evidenceSnapshot:json({source:"free-shipping-phase1",phase:input.phase,freePolicyId:state.freePolicyId,freePolicyName:state.freePolicyName,candidate,capturedAt:new Date().toISOString()}),
        observationWindowDays:21,
      }});
      const execution=await prisma.ebayActionExecution.create({data:{
        listingId:listing.id,
        storeId:listing.storeId,
        decisionId:decision.id,
        operatorId:input.operatorId,
        action:FREE_SHIPPING_PHASE1_ACTION,
        doctrineVersion:FREE_SHIPPING_PHASE1_VERSION,
        idempotencyKey:`free-shipping-phase1:${FREE_SHIPPING_PHASE1_VERSION}:${itemId}`,
        oldEbayItemId:itemId,
        beforeState:json({title:before.Title,price:candidate.currentPrice,shipping:beforeShipping,shippingProfileId:beforeShippingProfileId,adRate:candidate.adRate,unchanged:beforeUnchanged}),
        proposedState:json({price:candidate.proposedPrice,shipping:0,shippingProfileId:state.freePolicyId,adRate:5}),
        evidenceSnapshot:json({source:"free-shipping-phase1",phase:input.phase,freePolicyName:state.freePolicyName,candidate}),
      }});
      executionId=execution.id;
      await appendEvent(execution.id,"approved_and_server_revalidated",{phase:input.phase,itemId,candidate,targetShippingProfileId:state.freePolicyId});

      await prisma.ebayActionExecution.update({where:{id:execution.id},data:{status:"executing"}});
      await appendEvent(execution.id,"execution_started",{itemId,price:candidate.proposedPrice,shippingProfileId:state.freePolicyId});
      const providerResult=await reviseFixedPricePriceAndShippingProfile(state.accessToken,itemId,candidate.proposedPrice,state.freePolicyId,execution.id);
      await appendEvent(execution.id,"provider_accepted",providerResult);

      const after=await getItem(state.accessToken,itemId);
      const afterPrice=Number(typeof after.SellingStatus?.CurrentPrice==="object"?(after.SellingStatus.CurrentPrice as Record<string,unknown>)["#text"]:after.SellingStatus?.CurrentPrice);
      const afterShippingProfileId=providerShippingProfileId(after);
      const afterShipping=providerShippingCharge(after);
      if(Math.abs(afterPrice-candidate.proposedPrice)>0.005)throw new Error("Provider verification failed: price does not equal approved target");
      if(afterShippingProfileId!==state.freePolicyId)throw new Error("Provider verification failed: shipping policy does not equal approved free-shipping policy");
      if(!same(beforeUnchanged,unchangedState(after)))throw new Error("Provider verification failed: an unrelated listing field changed");

      const afterMarketing=await getAdvertisingContext(state.accessToken);
      const afterAd=afterMarketing.contexts.get(itemId)??afterMarketing.defaultContext;
      if(afterAd.adRate==null||Math.abs(afterAd.adRate-5)>0.001)throw new Error("Provider verification failed: promoted-listing rate is no longer 5.0%");

      await importItems({storeId:listing.storeId,items:[after],source:"free-shipping-phase1-verification",status:"active",observedAt:new Date()});
      await appendEvent(execution.id,"provider_verified",{
        itemId,
        before:{price:candidate.currentPrice,shipping:beforeShipping,shippingProfileId:beforeShippingProfileId,adRate:candidate.adRate},
        after:{price:afterPrice,shipping:afterShipping,shippingProfileId:afterShippingProfileId,adRate:afterAd.adRate},
        unintendedChanges:[],
      });
      await prisma.ebayActionExecution.update({where:{id:execution.id},data:{status:"verified",providerVerifiedAt:new Date()}});
      results.push({itemId,status:"verified",executionId:execution.id,beforePrice:candidate.currentPrice??undefined,afterPrice,beforeShipping,afterShipping,beforeShippingProfileId,afterShippingProfileId});
    }catch(error){
      const message=error instanceof Error?error.message:String(error);
      if(executionId){
        await appendEvent(executionId,"manual_reconciliation_required",{message,automaticRetry:false});
        await prisma.ebayActionExecution.update({where:{id:executionId},data:{status:"manual_reconciliation_required"}});
      }
      results.push({itemId,status:"failed",executionId,error:message});
      break;
    }
  }

  return {
    phase:input.phase,
    requested:targetIds.length,
    verified:results.filter(row=>row.status==="verified"||row.status==="already_verified").length,
    failed:results.filter(row=>row.status==="failed").length,
    results,
  };
}
