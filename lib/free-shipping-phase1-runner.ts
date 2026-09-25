import { prisma } from "@/lib/prisma";
import { getItem, getValidAccessToken } from "@/lib/ebay";
import { getAdvertisingContext } from "@/lib/ebay-marketing";
import {
  FREE_SHIPPING_PHASE1_ITEM_IDS,
  FREE_SHIPPING_PHASE1_VERSION,
  evaluateFreeShippingCandidate,
  freeShippingPolicies,
  getFulfillmentPolicies,
  type FreeShippingDryRunRow,
} from "@/lib/free-shipping-experiment";

export type FreeShippingPhase1DryRunResult = {
  experiment:string;
  mode:"DRY_RUN_ONLY";
  providerWrites:false;
  selected:number;
  persistedListingsFound:number;
  missing:string[];
  ready:number;
  completed:number;
  blocked:number;
  completedItemIds:string[];
  freePolicyCandidates:Array<{
    storeId:string;
    policies:Array<{fulfillmentPolicyId:string|null;name:string|null;handlingTime:unknown|null}>;
  }>;
  rows:FreeShippingDryRunRow[];
};

async function inBatches<T,R>(items:T[],size:number,fn:(item:T)=>Promise<R>):Promise<R[]>{
  const out:R[]=[];
  for(let i=0;i<items.length;i+=size){
    out.push(...await Promise.all(items.slice(i,i+size).map(fn)));
  }
  return out;
}

export async function runFreeShippingPhase1DryRun():Promise<FreeShippingPhase1DryRunResult>{
  const listings=await prisma.listing.findMany({
    where:{ebayItemId:{in:[...FREE_SHIPPING_PHASE1_ITEM_IDS]}},
    include:{store:true},
  });
  const byItemId=new Map(listings.map(listing=>[listing.ebayItemId,listing]));
  const missing=FREE_SHIPPING_PHASE1_ITEM_IDS.filter(itemId=>!byItemId.has(itemId));
  const storeIds=Array.from(new Set(listings.map(listing=>listing.storeId)));
  const verifiedExecutions=await prisma.ebayActionExecution.findMany({
    where:{
      action:"FREE_SHIPPING_PHASE1",
      doctrineVersion:FREE_SHIPPING_PHASE1_VERSION,
      status:"verified",
      oldEbayItemId:{in:[...FREE_SHIPPING_PHASE1_ITEM_IDS]},
    },
    select:{oldEbayItemId:true},
  });
  const completedItemIds=Array.from(new Set(verifiedExecutions.map(row=>row.oldEbayItemId))); 
  const completedSet=new Set(completedItemIds);

  const storeState=new Map<string,{
    accessToken:string;
    adContext:Awaited<ReturnType<typeof getAdvertisingContext>>;
    freePolicies:ReturnType<typeof freeShippingPolicies>;
  }>();

  for(const storeId of storeIds){
    const listing=listings.find(row=>row.storeId===storeId);
    if(!listing)continue;
    const {accessToken}=await getValidAccessToken(listing.store);
    const [adContext,policies]=await Promise.all([
      getAdvertisingContext(accessToken),
      getFulfillmentPolicies(accessToken),
    ]);
    storeState.set(storeId,{accessToken,adContext,freePolicies:freeShippingPolicies(policies)});
  }

  const rows=await inBatches([...FREE_SHIPPING_PHASE1_ITEM_IDS],8,async itemId=>{
    const listing=byItemId.get(itemId);
    if(!listing){
      return {
        itemId,title:null,currentPrice:null,currentShipping:null,proposedPrice:null,
        currentDelivered:null,proposedDelivered:null,shippingProfileId:null,adRate:null,
        ready:false,blockers:["Listing is missing from Legends OS"],
      } satisfies FreeShippingDryRunRow;
    }
    const state=storeState.get(listing.storeId);
    if(!state){
      return {
        itemId,title:listing.title,currentPrice:Number(listing.currentPrice),currentShipping:null,proposedPrice:null,
        currentDelivered:null,proposedDelivered:null,shippingProfileId:null,adRate:null,
        ready:false,blockers:["Store credentials could not be loaded"],
      } satisfies FreeShippingDryRunRow;
    }
    try{
      const live=await getItem(state.accessToken,itemId);
      const ad=state.adContext.contexts.get(itemId)??state.adContext.defaultContext;
      return evaluateFreeShippingCandidate({
        itemId,
        item:live,
        persistedTitle:listing.title,
        persistedPrice:Number(listing.currentPrice),
        adRate:ad.adRate,
      });
    }catch(error){
      return {
        itemId,title:listing.title,currentPrice:Number(listing.currentPrice),currentShipping:null,proposedPrice:null,
        currentDelivered:null,proposedDelivered:null,shippingProfileId:null,adRate:null,
        ready:false,blockers:[error instanceof Error?error.message:String(error)],
      } satisfies FreeShippingDryRunRow;
    }
  });

  return {
    experiment:FREE_SHIPPING_PHASE1_VERSION,
    mode:"DRY_RUN_ONLY",
    providerWrites:false,
    selected:FREE_SHIPPING_PHASE1_ITEM_IDS.length,
    persistedListingsFound:listings.length,
    missing:[...missing],
    ready:rows.filter(row=>row.ready&&!completedSet.has(row.itemId)).length,
    completed:completedItemIds.length,
    blocked:rows.filter(row=>!row.ready&&!completedSet.has(row.itemId)).length,
    completedItemIds,
    freePolicyCandidates:Array.from(storeState.entries()).map(([storeId,state])=>({
      storeId,
      policies:state.freePolicies.map(policy=>({
        fulfillmentPolicyId:policy.fulfillmentPolicyId??null,
        name:policy.name??null,
        handlingTime:policy.handlingTime??null,
      })),
    })),
    rows,
  };
}
