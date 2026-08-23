import { prisma } from "../lib/prisma";
import { buildValuation, createTelemetry } from "../lib/comp-validation/engine";
import { parseCardIdentity } from "../lib/comp-validation/identity";
import { auditInternalComparableIdentity, buildInternalComparableIndex, createInternalSalesAdapter, type InternalSaleEvidence } from "../lib/pricing-evidence-acquisition";
import type { ListingForComp, ProviderStatus } from "../lib/comp-validation/types";

const identityView=(title:string)=>{const x=parseCardIdentity(title);return{player:x.player,year:x.year,product:x.setName,cardNumber:x.cardNumber,parallel:x.parallel,variation:x.variation,printRun:x.printRun,rookie:x.rookie,autograph:x.autograph,memorabilia:x.patch,format:x.rawOrGraded,grader:x.gradeCompany,grade:x.gradeValue,completeness:x.identityCompleteness};};

async function main(){
  const[listings,rows]=await Promise.all([
    prisma.listing.findMany({where:{listingStatus:"active",recommendations:{none:{status:"pending",type:{in:["raise-price","lower-price"]},confidence:{gte:60}}}},select:{id:true,storeId:true,title:true,currentPrice:true,quantity:true,quantitySold:true,views:true,watchers:true,condition:true,listingFormat:true,listingQuality:true}}),
    prisma.saleEvent.findMany({where:{listingId:{not:null},status:{not:"cancelled"},currency:"USD"},select:{id:true,price:true,currency:true,status:true,soldAt:true,orderLine:{select:{title:true}}}}),
  ]);
  const sales:InternalSaleEvidence[]=rows.filter(row=>row.orderLine).map(row=>({id:row.id,title:row.orderLine!.title,soldAt:row.soldAt,unitPrice:Number(row.price),currency:row.currency??"",status:row.status}));
  const index=buildInternalComparableIndex(sales),adapter=createInternalSalesAdapter(sales),status:ProviderStatus={mode:"live",providerId:adapter.providerId,providerName:adapter.providerName,liveReady:true,requirements:["Authoritative linked Legends sale history"],notes:["No external request"]},cache=new Map(),results=[];
  for(const row of listings.filter(row=>index.count(row.title)>=3)){
    const listing:ListingForComp={...row,currentPrice:Number(row.currentPrice)},telemetry=createTelemetry();
    const{result}=await buildValuation({listing,telemetry,identityResultCache:cache,evidenceAdapter:adapter,providerStatusOverride:status,countsAgainstExternalBudget:false});
    const accepted=result.comps.filter(comp=>comp.inclusionStatus==="accepted").map(comp=>{const target=parseCardIdentity(row.title),sold=parseCardIdentity(comp.soldTitle);return{title:comp.soldTitle,soldPrice:comp.soldPrice,soldAt:comp.soldDate,matchTier:comp.matchTier,matchScore:comp.matchScore,identity:identityView(comp.soldTitle),whyComparable:auditInternalComparableIdentity(target,sold)};});
    results.push({listingId:row.id,title:row.title,currentPrice:Number(row.currentPrice),recommendedPrice:result.recommendedPrice,confidence:result.confidenceScore,type:result.recommendationType,accepted:result.acceptedCompCount,externalRequests:telemetry.externalProviderCalls,identity:identityView(row.title),acceptedEvidence:accepted});
  }
  const actions=results.filter(row=>["raise-price","lower-price"].includes(row.type)&&row.confidence>=60);
  console.log(JSON.stringify({evaluated:results.length,actionable:actions.length,holds:results.filter(row=>row.type==="hold").length,insufficient:results.filter(row=>row.type==="insufficient-data").length,externalRequests:results.reduce((sum,row)=>sum+row.externalRequests,0),actions},null,2));
}
main().finally(()=>prisma.$disconnect());
