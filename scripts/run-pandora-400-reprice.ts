import { prisma } from "../lib/prisma.ts";
import { callTradingApi, getItem, getValidAccessToken, reviseFixedPrice, type EbayListingItem } from "../lib/ebay.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const EXECUTE_FLAG = "--execute-approved-pandora-400-reprice";
const DOCTRINE_VERSION = "pandora-400-saved-evidence-2026-10-20-v1";
const PWE_149_POLICY_ID = "248164772010";

type Candidate = { itemId: string; expectedPrice: number; price: number; shipping: number };
const CANDIDATES: Candidate[] = [
  ["128143072767",1.98,2.98,0],["128143072773",1.98,2.98,0],["128143119946",1.98,4.44,0],["128143119965",1.98,4.44,0],["128143141365",1.98,2.98,0],["128143141366",1.98,2.98,0],["128143141370",1.98,2.98,0],["128143141371",1.98,3.98,0],["128143141372",1.98,2.98,0],["128143141379",1.98,3.98,0],["128143141386",1.98,2.98,0],
  ["128143072763",2.44,3.44,0],["128143072765",2.44,3.98,0],["128143072766",2.44,4.44,0],["128143072768",2.44,4.44,0],["128143072769",2.44,3.98,0],["128143072771",2.44,4.44,0],["128143072772",2.44,3.44,0],["128143119945",2.44,2.98,0],["128143119949",2.44,3.49,1.49],["128143119951",2.44,2.98,0],["128143119952",2.44,2.98,0],["128143119953",2.44,3.44,0],["128143119954",2.44,3.44,0],["128143119957",2.44,2.98,0],["128143119959",2.44,2.98,0],["128143119960",2.44,3.98,0],["128143119961",2.44,3.49,1.49],["128143119962",2.44,3.98,0],["128143119963",2.44,2.98,0],["128143119964",2.44,3.44,0],["128143119967",2.44,2.98,0],["128143119968",2.44,3.98,0],["128143119971",2.44,2.98,0],["128143119972",2.44,2.98,0],["128143119974",2.44,3.49,1.49],["128143119975",2.44,2.98,0],["128143119977",2.44,3.44,0],["128143119978",2.44,2.98,0],["128143119980",2.44,2.98,0],["128143119981",2.44,2.98,0],["128143119982",2.44,2.98,0],["128143119983",2.44,2.98,0],["128143119986",2.44,2.98,0],["128143119988",2.44,3.49,1.49],["128143119990",2.44,2.98,0],["128143141362",2.44,2.98,0],["128143141374",2.44,3.44,0],["128143141375",2.44,2.98,0],["128143141376",2.44,2.98,0],["128143141377",2.44,2.98,0],["128143141378",2.44,2.98,0],["128143141383",2.44,3.44,0],
  ["128143050590",2.98,3.44,0],["128143050594",2.98,3.44,0],["128143050596",2.98,3.44,0],
  ["128143119970",3.44,2.98,0],["128143119973",3.44,2.98,0],["128143119979",3.44,2.98,0],
  ["128143119938",4.44,3.44,0],["128143119947",4.44,3.44,0],["128143119955",4.44,3.44,0],
  ["128143050589",4.49,3.98,0],["128143050593",4.49,3.98,0],["128143119935",4.49,3.95,1.49],["128143119940",4.49,3.95,1.49],["128143119942",4.49,3.95,1.49],
].map(([itemId, expectedPrice, price, shipping]) => ({ itemId: String(itemId), expectedPrice: Number(expectedPrice), price: Number(price), shipping: Number(shipping) }));

const money = (value: unknown): number => {
  const raw = value && typeof value === "object" ? ((value as Record<string, unknown>)["#text"] ?? (value as Record<string, unknown>).value) : value;
  return Number(raw);
};
const price = (item: EbayListingItem) => money(item.SellingStatus?.CurrentPrice);
const shipping = (item: EbayListingItem) => {
  const details = item.ShippingDetails as Record<string, unknown> | undefined;
  const raw = details?.ShippingServiceOptions;
  const options = Array.isArray(raw) ? raw : raw ? [raw] : [];
  for (const option of options as Array<Record<string, unknown>>) {
    const amount = money(option.ShippingServiceCost);
    if (Number.isFinite(amount)) return amount;
  }
  return null;
};
const stable = (item: EbayListingItem) => JSON.stringify({
  itemId:String(item.ItemID),title:item.Title,description:item.Description??null,quantity:item.Quantity,
  quantityAvailable:item.QuantityAvailable,quantitySold:item.SellingStatus?.QuantitySold??null,
  listingStatus:item.SellingStatus?.ListingStatus??null,listingType:item.ListingType??null,
  condition:item.ConditionDisplayName??null,category:item.PrimaryCategory??null,pictures:item.PictureDetails?.PictureURL??null,
  itemSpecifics:item.ItemSpecifics??null,sellerProfiles:item.SellerProfiles??null,shippingDetails:item.ShippingDetails??null,
});
const stableWithoutShipping = (item:EbayListingItem) => JSON.stringify({
  itemId:String(item.ItemID),title:item.Title,description:item.Description??null,quantity:item.Quantity,
  quantityAvailable:item.QuantityAvailable,quantitySold:item.SellingStatus?.QuantitySold??null,
  listingStatus:item.SellingStatus?.ListingStatus??null,listingType:item.ListingType??null,
  condition:item.ConditionDisplayName??null,category:item.PrimaryCategory??null,pictures:item.PictureDetails?.PictureURL??null,
  itemSpecifics:item.ItemSpecifics??null,
});
async function revisePriceAndShipping(accessToken:string,itemId:string,newPrice:number,messageId:string){
  const xml=`<ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><MessageID>${messageId}</MessageID><Item><ItemID>${itemId}</ItemID><StartPrice>${newPrice.toFixed(2)}</StartPrice><SellerProfiles><SellerShippingProfile><ShippingProfileID>${PWE_149_POLICY_ID}</ShippingProfileID></SellerShippingProfile></SellerProfiles></Item></ReviseFixedPriceItemRequest>`;
  await callTradingApi({callName:"ReviseFixedPriceItem",siteId:0,accessToken,xmlBody:xml,retryMode:"single-attempt"});
}
async function main(){
  const execute=process.argv.includes(EXECUTE_FLAG);
  const offsetArg=process.argv.find(arg=>arg.startsWith("--offset="));
  const limitArg=process.argv.find(arg=>arg.startsWith("--limit="));
  const offset=offsetArg?Number(offsetArg.split("=")[1]):0;
  const limit=limitArg?Number(limitArg.split("=")[1]):CANDIDATES.length;
  if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1)throw new Error("Invalid tranche offset or limit");
  const tranche=CANDIDATES.slice(offset,offset+limit);
  const store=await prisma.store.findFirstOrThrow({where:{isActive:true,connectionStatus:"connected",ebaySellerUsername:"imaydit58"}});
  const {accessToken}=await getValidAccessToken(store);
  const results:Array<Record<string,unknown>>=[];
  for(const candidate of tranche){
    try{
      const before=await getItem(accessToken,candidate.itemId);
      const beforePrice=price(before), beforeShipping=shipping(before);
      if(String(before.SellingStatus?.ListingStatus??"").toLowerCase()!=="active")throw new Error("Provider listing is not active");
      if(!/2025(?!-26).*prizm/i.test(before.Title)||!/pandora/i.test(before.Title)||!/(?:\/|#\/)400/i.test(before.Title))throw new Error("Provider title is outside the approved 2025 Pandora /400 scope");
      if(Math.abs(beforePrice-candidate.expectedPrice)>.005)throw new Error(`Provider price changed: ${beforePrice}`);
      const changeShipping=beforeShipping!=null&&Math.abs(beforeShipping-candidate.shipping)>.005;
      if(beforeShipping==null)throw new Error("Provider shipping is unavailable");
      if(changeShipping&&!(Math.abs(beforeShipping)<.005&&Math.abs(candidate.shipping-1.49)<.005))throw new Error(`Provider shipping cannot use the approved $1.49 correction: ${beforeShipping}`);
      if(!execute){results.push({itemId:candidate.itemId,status:"ready",beforePrice,beforeShipping,afterPrice:candidate.price,afterShipping:candidate.shipping,changeShipping,title:before.Title});continue;}
      const idempotencyKey=`${DOCTRINE_VERSION}:${candidate.itemId}:${candidate.price.toFixed(2)}`;
      if(changeShipping)await revisePriceAndShipping(accessToken,candidate.itemId,candidate.price,idempotencyKey);
      else await reviseFixedPrice(accessToken,candidate.itemId,candidate.price,idempotencyKey);
      const after=await getItem(accessToken,candidate.itemId);
      if(Math.abs(price(after)-candidate.price)>.005)throw new Error("Provider price readback failed");
      if(shipping(after)==null||Math.abs(Number(shipping(after))-candidate.shipping)>.005)throw new Error("Provider shipping changed unexpectedly");
      if(changeShipping?stableWithoutShipping(before)!==stableWithoutShipping(after):stable(before)!==stable(after))throw new Error("Provider changed unrelated listing state");
      results.push({itemId:candidate.itemId,status:"verified",beforePrice,afterPrice:candidate.price,shipping:candidate.shipping,title:after.Title,unrelatedStateUnchanged:true});
    }catch(error){
      results.push({itemId:candidate.itemId,status:"failed",error:error instanceof Error?error.message:String(error)});
    }
  }
  const receipt={mode:execute?"execute":"preflight",observedAt:new Date().toISOString(),offset,selected:tranche.length,ready:results.filter(x=>x.status==="ready").length,verified:results.filter(x=>x.status==="verified").length,failed:results.filter(x=>x.status==="failed").length,results};
  const directory=resolve("artifacts","pandora-400-reprice-20261020");mkdirSync(directory,{recursive:true});
  writeFileSync(resolve(directory,`${receipt.mode}-receipt-${offset}-${tranche.length}.json`),`${JSON.stringify(receipt,null,2)}\n`);
  console.log(JSON.stringify(receipt,null,2));
}

main().finally(()=>prisma.$disconnect()).catch(error=>{console.error(error instanceof Error?error.message:error);process.exitCode=1;});
