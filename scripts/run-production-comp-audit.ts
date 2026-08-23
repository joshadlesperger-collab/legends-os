import { Prisma } from "@prisma/client";
import { buildValuation, createTelemetry, mergeCompState } from "../lib/comp-validation/engine.ts";
import { prisma } from "../lib/prisma.ts";
import { buildRecommendation, type ListingRecord, type MarketEvidence } from "../lib/recommendations.ts";
import { isActionablePricingRecommendation } from "../lib/recommendation-queue.ts";

const apply = process.argv.includes("--apply");
const LIMIT = 60;
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

async function main(){
  const select={id:true,storeId:true,title:true,currentPrice:true,quantity:true,quantitySold:true,views:true,watchers:true,listingFormat:true,categoryId:true,condition:true,startTime:true,createdAt:true,listingQuality:true,store:{select:{accountId:true}},snapshots:{orderBy:{capturedAt:"desc" as const},take:2}};
  const [valuable,repeat]=await Promise.all([
    prisma.listing.findMany({where:{listingStatus:"active",currentPrice:{gte:20}},orderBy:[{currentPrice:"desc"},{views:"desc"}],take:30,select}),
    prisma.listing.findMany({where:{listingStatus:"active",saleEvents:{some:{provider:"ebay-fulfillment",status:{not:"cancelled"}}}},orderBy:{saleEvents:{_count:"desc"}},take:40,select}),
  ]);
  const listings=Array.from(new Map([...valuable,...repeat].map(row=>[row.id,row])).values()).slice(0,LIMIT);
  const results=[];
  for(const listing of listings){
    const {result,compState}=await buildValuation({listing:{...listing,currentPrice:Number(listing.currentPrice)},telemetry:createTelemetry(),identityResultCache:new Map(),allowLiveProvider:true});
    const evidence:MarketEvidence|null=result.provider.providerId==="the-card-api"&&result.acceptedCompCount>=3&&result.confidenceScore>=60&&["moderate","high","very-high"].includes(result.confidenceBand)&&result.weightedRecentMarketValue!=null?{marketValue:result.weightedRecentMarketValue,acceptedCompCount:result.acceptedCompCount,confidenceScore:result.confidenceScore,confidenceBand:result.confidenceBand,source:"The Card API confirmed sold transactions",observedAt:new Date()}:null;
    const recommendation=buildRecommendation(listing as ListingRecord,evidence);
    results.push({listing,result,recommendation,compState});
  }
  const summary={mode:apply?"apply":"dry-run",analyzed:results.length,sufficient:results.filter(x=>x.result.acceptedCompCount>=3&&["moderate","high","very-high"].includes(x.result.confidenceBand)).length,insufficient:results.filter(x=>x.result.recommendationType==="insufficient-data").length,raise:results.filter(x=>x.recommendation.type==="raise-price").length,lower:results.filter(x=>x.recommendation.type==="lower-price").length,hold:results.filter(x=>x.recommendation.type==="hold").length,medianCompCount:[...results].map(x=>x.result.acceptedCompCount).sort((a,b)=>a-b)[Math.floor(results.length/2)]??0,confidence:{veryHigh:results.filter(x=>x.result.confidenceBand==="very-high").length,high:results.filter(x=>x.result.confidenceBand==="high").length,moderate:results.filter(x=>x.result.confidenceBand==="moderate").length,low:results.filter(x=>x.result.confidenceBand==="low").length,insufficient:results.filter(x=>x.result.confidenceBand==="insufficient").length},providerCalls:results.length};
  if(apply){for(const {listing,result,recommendation,compState} of results){
    const nextState={...compState,cache:{...(compState.cache??{}),[result.parsedIdentity.identityHash]:{stateHash:result.stateHash,updatedAt:new Date().toISOString(),result:{recommendedPrice:result.recommendedPrice,weightedRecentMarketValue:result.weightedRecentMarketValue,lowMarketRange:result.lowMarketRange,highMarketRange:result.highMarketRange,confidenceScore:result.confidenceScore,confidenceBand:result.confidenceBand,trendDirection:result.trendDirection,trendPct:result.trendPct,recommendationType:result.recommendationType,acceptedCompCount:result.acceptedCompCount,excludedCompCount:result.excludedCompCount,newestCompDate:result.newestCompDate,oldestCompDate:result.oldestCompDate,evidenceSources:result.evidenceSources,evidenceWindowDays:result.evidenceWindowDays,medianSoldPrice:result.medianSoldPrice,meanSoldPrice:result.meanSoldPrice,priceDispersionPct:result.priceDispersionPct,exactMatchCount:result.exactMatchCount,nearExactMatchCount:result.nearExactMatchCount,confidenceComponents:result.confidenceComponents,evidenceObservedAt:result.evidenceObservedAt,providerId:result.provider.providerId}}}};
    await prisma.$transaction(async tx=>{
      await tx.listing.update({where:{id:listing.id},data:{listingQuality:json(mergeCompState(listing.listingQuality,nextState))}});
      const existing=await tx.recommendation.findFirst({where:{listingId:listing.id,status:"pending",type:{in:["raise-price","lower-price","hold","insufficient-data"]}},orderBy:{generatedAt:"desc"}});
      const data={type:recommendation.type,suggestedPrice:recommendation.suggestedPrice==null?null:new Prisma.Decimal(recommendation.suggestedPrice),reason:recommendation.reason,expectedProfitImpact:new Prisma.Decimal(recommendation.expectedProfitImpact),confidence:recommendation.confidence,status:"pending"};
      const rec=existing?await tx.recommendation.update({where:{id:existing.id},data}):await tx.recommendation.create({data:{...data,listingId:listing.id,storeId:listing.storeId}});
      const actionable=isActionablePricingRecommendation(recommendation);
      if(actionable){const queued=await tx.actionQueue.findFirst({where:{recommendationId:rec.id,status:"pending"}});if(!queued)await tx.actionQueue.create({data:{recommendationId:rec.id,accountId:listing.store.accountId,storeId:listing.storeId,rank:1,status:"pending"}});}else await tx.actionQueue.updateMany({where:{recommendationId:rec.id,status:"pending"},data:{status:"invalidated"}});
    });
  }}
  console.log(JSON.stringify({summary,examples:results.slice(0,20).map(x=>({title:x.listing.title,currentPrice:Number(x.listing.currentPrice),marketValue:x.result.weightedRecentMarketValue,suggestedPrice:x.recommendation.suggestedPrice,type:x.recommendation.type,accepted:x.result.acceptedCompCount,range:[x.result.lowMarketRange,x.result.highMarketRange],confidence:x.result.confidenceScore,band:x.result.confidenceBand,dates:[x.result.oldestCompDate,x.result.newestCompDate],sources:x.result.evidenceSources}))},null,2));
}
main().catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1}).finally(async()=>prisma.$disconnect());
