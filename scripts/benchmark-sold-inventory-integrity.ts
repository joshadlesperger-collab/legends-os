import { prisma } from "../lib/prisma.ts";
import { getActiveListings, getValidAccessToken } from "../lib/ebay.ts";
import { normalizeEbayItem } from "../lib/ebay-sync-domain.ts";
import { assessSoldInventory } from "../lib/sold-inventory-integrity.ts";

async function main(){
  const store=await prisma.store.findFirstOrThrow({where:{connectionStatus:"connected",ebaySellerUsername:{not:null}},orderBy:{listings:{_count:"desc"}}});
  const token=await getValidAccessToken(store);const items=[];for await(const page of getActiveListings(token.accessToken,0))items.push(...page);
  const ids=items.map(item=>String(item.ItemID));
  const [stored,sales,historical]=await Promise.all([
    prisma.listing.findMany({where:{storeId:store.id,ebayItemId:{in:ids}},select:{ebayItemId:true,itemSpecifics:true,snapshots:{select:{quantity:true},orderBy:{quantity:"desc"},take:1}}}),
    prisma.ebayOrderLine.findMany({where:{storeId:store.id,order:{cancelStatus:{notIn:["CANCELLED","CANCEL_PENDING"]}}},select:{id:true,ebayItemId:true,title:true,quantity:true,lineItemCost:true,order:{select:{creationDate:true,cancelStatus:true}}}}),
    prisma.listing.findMany({where:{storeId:store.id},select:{title:true}}),
  ]);
  const byId=new Map(stored.map(row=>[row.ebayItemId,row]));const observedAt=new Date();
  const active=items.map((item,index)=>{const row=normalizeEbayItem(item,"active"),old=byId.get(row.ebayItemId);return{id:`live-${index}`,ebayItemId:row.ebayItemId,title:row.title,price:Number(row.currentPrice),quantity:row.quantity,startTime:row.startTime,sku:row.sku,itemSpecifics:row.itemSpecifics??old?.itemSpecifics??null,quantitySold:row.quantitySold,maxObservedQuantity:Math.max(row.quantity,old?.snapshots[0]?.quantity??row.quantity),authoritativeObservedAt:observedAt};});
  const assessment=assessSoldInventory({active,sales:sales.map(row=>({id:row.id,ebayItemId:row.ebayItemId,title:row.title,quantity:row.quantity,soldAt:row.order.creationDate,price:Number(row.lineItemCost),cancelled:/cancel/i.test(row.order.cancelStatus)})),historicalTitles:historical.map(row=>row.title)});
  console.log(JSON.stringify({generatedAt:observedAt,store:store.ebaySellerUsername,liveRetrieved:items.length,uniqueItemIds:new Set(ids).size,metrics:assessment.metrics,suspicious:assessment.results.filter(row=>row.classification!=="SAFE / EXPLAINED").sort((a,b)=>b.confidence-a.confidence).slice(0,50).map(row=>({classification:row.classification,confidence:row.confidence,current:{itemId:row.listing.ebayItemId,title:row.listing.title,price:row.listing.price,quantity:row.listing.quantity,startTime:row.listing.startTime},priorSale:row.priorSale&&{itemId:row.priorSale.ebayItemId,title:row.priorSale.title,price:row.priorSale.price,soldAt:row.priorSale.soldAt},matchType:row.matchType,reason:row.reason,evidence:row.evidence}))},null,2));
}
main().finally(()=>prisma.$disconnect());
