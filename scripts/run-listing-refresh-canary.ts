import {loadEnvConfig} from "@next/env";
loadEnvConfig(process.cwd(),true);
import {Prisma} from "@prisma/client";
import {prisma} from "../lib/prisma.ts";
import {getItem,getValidAccessToken} from "../lib/ebay.ts";
import {getAdvertisingEligibility,getCampaignAdvertisingContext} from "../lib/ebay-marketing.ts";
import {findEligibleItems} from "../lib/ebay-negotiation.ts";
import {loadListingRefreshCandidates} from "../lib/listing-refresh-data.ts";
import {createGovernedRefreshExecution,ebayWriteProvider,executeGovernedAction,preservedRelistState,remainingProviderQuantity} from "../lib/governed-ebay-actions.ts";

const EXECUTE="--execute-approved-10-refresh-canary",DAY=86_400_000;
const active=(item:Awaited<ReturnType<typeof getItem>>)=>String(item.SellingStatus?.ListingStatus??"").toLowerCase()==="active";
const price=(item:Awaited<ReturnType<typeof getItem>>)=>{const value=item.SellingStatus?.CurrentPrice;return Number(value&&typeof value==="object"?value["#text"]:value);};

async function main(){
  const execute=process.argv.includes(EXECUTE);if(!execute&&!process.argv.includes("--preflight-only"))throw new Error(`Use --preflight-only or ${EXECUTE}`);
  const benchmark=await loadListingRefreshCandidates(),candidates=benchmark.rows.filter(row=>row.classification==="REVIEW"&&(row.ageDays??0)>=90&&row.currentPrice<100&&row.units30===0&&row.views30===0&&(row.watchers??0)===0&&row.blockers.length===0);
  const store=await prisma.store.findFirst({where:{isActive:true,connectionStatus:"connected"}});if(!store)throw new Error("No active connected eBay store");const {accessToken}=await getValidAccessToken(store);
  const eligibility=await getAdvertisingEligibility(accessToken),marketing=await getCampaignAdvertisingContext(accessToken,eligibility),negotiation=await findEligibleItems(accessToken);
  const selected:Array<{listingId:string;ebayItemId:string;title:string;ageDays:number;currentPrice:number;quantity:number;providerState:unknown;promotion:unknown;startTime:string|null}>=[],skips:Array<{ebayItemId:string;reason:string}>=[];
  for(const row of candidates){if(selected.length===10)break;if(negotiation.has(row.ebayItemId)){skips.push({ebayItemId:row.ebayItemId,reason:"Negotiation eligible"});continue;}
    const listing=await prisma.listing.findUnique({where:{id:row.listingId},include:{priceChanges:{orderBy:{changedAt:"desc"},take:1},ebayActionExecutions:{where:{createdAt:{gte:new Date(Date.now()-60*DAY)}}}}});if(!listing||listing.storeId!==store.id||listing.listingStatus!=="active"||listing.ebayActionExecutions.some(x=>["approved","executing","partial_failure"].includes(x.status))){skips.push({ebayItemId:row.ebayItemId,reason:"Persisted lifecycle/intervention state is no longer eligible"});continue;}
    const recentSales=await prisma.saleEvent.count({where:{listingId:listing.id,provider:"ebay-fulfillment",status:{not:"cancelled"},soldAt:{gte:new Date(Date.now()-30*DAY)}}});if(recentSales){skips.push({ebayItemId:row.ebayItemId,reason:"Authoritative sale in last 30 days"});continue;}
    const live=await getItem(accessToken,row.ebayItemId),quantity=remainingProviderQuantity(live);if(!active(live)||live.ItemID!==row.ebayItemId||live.Title!==listing.title||!live.ListingType?.toLowerCase().includes("fixed")||quantity==null||Math.abs(price(live)-row.currentPrice)>.005){skips.push({ebayItemId:row.ebayItemId,reason:"Live provider identity/state failed preflight"});continue;}
    const start=live.ListingDetails?.StartTime?new Date(live.ListingDetails.StartTime):null;if(!start||Date.now()-start.getTime()<90*DAY){skips.push({ebayItemId:row.ebayItemId,reason:"Live provider age is below 90 days or unavailable"});continue;}
    selected.push({listingId:listing.id,ebayItemId:row.ebayItemId,title:live.Title,ageDays:Math.floor((Date.now()-start.getTime())/DAY),currentPrice:price(live),quantity,providerState:preservedRelistState(live,quantity),promotion:marketing.contexts.get(row.ebayItemId)??marketing.defaultContext,startTime:start.toISOString()});
  }
  const reportable=selected.map(({providerState:_providerState,...row})=>row);if(selected.length!==10){console.log(JSON.stringify({selected:reportable,skips},null,2));throw new Error(`Fail closed: only ${selected.length} candidates passed the 10-item preflight`);}if(!execute){console.log(JSON.stringify({selected:reportable,skips,marketingObservedAt:marketing.defaultContext.observedAt,negotiationEligibleCount:negotiation.size},null,2));return;}
  const operatorId="operator-approved-listing-refresh-canary-2026-08-22",results:unknown[]=[];
  for(const candidate of selected){let executionId:string|null=null;try{
    const liveEligible=await findEligibleItems(accessToken);if(liveEligible.has(candidate.ebayItemId)){results.push({...candidate,status:"skipped",reason:"Negotiation eligibility appeared at execution"});continue;}
    const live=await getItem(accessToken,candidate.ebayItemId);if(!active(live)||remainingProviderQuantity(live)!==candidate.quantity||JSON.stringify(preservedRelistState(live,candidate.quantity))!==JSON.stringify(candidate.providerState))throw new Error("Live state changed after canary selection");
    const evidence={selection:{ageDays:candidate.ageDays,views30:0,watchers:0,sales30:0,priceBelow100:true},promotion:candidate.promotion,negotiation:{eligible:false,observedAt:new Date().toISOString(),activeOfferLedger:"not exposed by Negotiation API; operator authorization accepts this documented limitation"},providerPreflight:{itemId:candidate.ebayItemId,startTime:candidate.startTime,remainingQuantity:candidate.quantity,observedAt:new Date().toISOString()}};
    const execution=await createGovernedRefreshExecution({listingId:candidate.listingId,operatorId,beforeProviderState:candidate.providerState,remainingQuantity:candidate.quantity,evidence});executionId=execution.id;const completed=await executeGovernedAction(execution.id,operatorId,ebayWriteProvider,{writesEnabled:true});const events=await prisma.ebayActionExecutionEvent.findMany({where:{executionId:execution.id},orderBy:{sequence:"asc"}});results.push({oldItemId:candidate.ebayItemId,newItemId:completed.newEbayItemId,title:candidate.title,price:candidate.currentPrice,ageDays:candidate.ageDays,remainingQuantity:candidate.quantity,status:completed.status,executionId:execution.id,decisionId:execution.decisionId,events:events.map(e=>({id:e.id,type:e.type,createdAt:e.createdAt,snapshot:e.snapshot}))});
  }catch(error){results.push({oldItemId:candidate.ebayItemId,executionId,status:"failed",error:error instanceof Error?error.message:String(error)});break;}}
  console.log(JSON.stringify({selected:10,results},null,2));
}
main().finally(()=>prisma.$disconnect()).catch(error=>{console.error(error instanceof Error?error.stack??error.message:error);process.exitCode=1;});
