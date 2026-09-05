import { prisma } from "./prisma";
import { assessSoldInventory } from "./sold-inventory-integrity";

export async function loadSoldInventoryIntegrity(){
  const store=await prisma.store.findFirst({where:{connectionStatus:"connected",ebaySellerUsername:{not:null}},orderBy:{listings:{_count:"desc"}},select:{id:true,ebaySellerUsername:true,lastSyncAt:true}});
  if(!store)return {store:null,generatedAt:new Date(),results:[],metrics:{activeSingleQuantity:0,highConfidence:0,review:0,safe:0,sameItemIdReappearances:0,newItemIdIdentityMatches:0,migratedExclusions:0,legacyDuplicateFamilyExclusions:0}};
  const [active,sales,historical]=await Promise.all([
    prisma.listing.findMany({where:{storeId:store.id,listingStatus:"active"},select:{id:true,ebayItemId:true,title:true,currentPrice:true,quantity:true,startTime:true,sku:true,itemSpecifics:true,quantitySold:true,authoritativeObservedAt:true,snapshots:{select:{quantity:true},orderBy:{quantity:"desc"},take:1}}}),
    prisma.ebayOrderLine.findMany({where:{storeId:store.id,order:{cancelStatus:{notIn:["CANCELLED","CANCEL_PENDING"]}}},select:{id:true,ebayItemId:true,title:true,quantity:true,lineItemCost:true,order:{select:{creationDate:true,cancelStatus:true}}}}),
    prisma.listing.findMany({where:{storeId:store.id},select:{title:true}}),
  ]);
  const assessment=assessSoldInventory({active:active.map(row=>({...row,price:Number(row.currentPrice),maxObservedQuantity:row.snapshots[0]?.quantity??row.quantity})),sales:sales.map(row=>({id:row.id,ebayItemId:row.ebayItemId,title:row.title,quantity:row.quantity,soldAt:row.order.creationDate,price:Number(row.lineItemCost),cancelled:/cancel/i.test(row.order.cancelStatus)})),historicalTitles:historical.map(row=>row.title)});
  return {store,generatedAt:new Date(),...assessment};
}
