import { evaluateCompAgainstIdentity } from "./comp-validation/engine.ts";
import { parseCardIdentity } from "./comp-validation/identity.ts";
import type { CompSale } from "./comp-validation/types.ts";
import { getEbayApplicationAccessToken, searchActiveMarket, type EbayBrowseItemSummary } from "./ebay-browse.ts";

export type ActiveMarketContext = {
  observedAt: string; query: string; exactActiveCount: number; nearActiveCount: number;
  exactAuctionCount: number; exactFixedPriceCount: number; auctionCurrentPrices: number[];
  fixedPriceAskLow: number | null; fixedPriceAskMedian: number | null; fixedPriceAskHigh: number | null;
  useful: boolean;
};

function numberValue(item: EbayBrowseItemSummary) { const value = Number((item.currentBidPrice ?? item.price)?.value); return Number.isFinite(value) && value > 0 ? value : null; }
function median(values: number[]) { const sorted=[...values].sort((a,b)=>a-b); if(!sorted.length)return null; const middle=Math.floor(sorted.length/2); return sorted.length%2?sorted[middle]:(sorted[middle-1]+sorted[middle])/2; }
function activeAsComp(item: EbayBrowseItemSummary): CompSale | null {
  const price=numberValue(item); if(price==null)return null; const parsed=parseCardIdentity(item.title);
  return {compKey:`active-${item.itemId}`,providerId:"ebay-browse-active",providerName:"eBay active market",sourceItemId:item.itemId,sourceUrl:item.itemWebUrl??null,soldTitle:item.title,soldDate:new Date().toISOString(),soldPrice:price,shipping:null,buyerPremium:null,totalBuyerCost:null,isAuction:item.buyingOptions?.includes("AUCTION")??false,priceConfirmed:true,currency:"USD",attributes:{player:parsed.player,year:parsed.year,manufacturer:parsed.manufacturer,setName:parsed.setName,cardNumber:parsed.cardNumber,rawOrGraded:parsed.rawOrGraded,gradeCompany:parsed.gradeCompany,gradeValue:parsed.gradeValue,rookie:parsed.rookie,autograph:parsed.autograph,patch:parsed.patch,parallel:parsed.parallel,variation:parsed.variation,serialNumbered:parsed.serialNumbered,printRun:parsed.printRun}};
}
export function buildActiveSearchQuery(title:string){const identity=parseCardIdentity(title);return [identity.year,identity.player,identity.setName??identity.manufacturer,identity.cardNumber?`#${identity.cardNumber}`:null,identity.variation?.replace(/^subset:/,""),identity.parallel&&identity.parallel!=="chrome"?identity.parallel:null,identity.printRun?`/${identity.printRun}`:null,"-lot","-lots","-reprint"].filter(Boolean).join(" ").slice(0,100);}
export async function loadActiveMarketContext(input:{title:string;targetEbayItemId:string;categoryIds:readonly string[]}):Promise<ActiveMarketContext>{
  const query=buildActiveSearchQuery(input.title); const token=await getEbayApplicationAccessToken(); const target=parseCardIdentity(input.title); const items=(await searchActiveMarket(token,query,input.categoryIds,50)).filter(item=>(item.legacyItemId??item.itemId.split("|")[1]??item.itemId)!==input.targetEbayItemId);
  const matched=items.flatMap(item=>{const comp=activeAsComp(item);if(!comp)return[];const evaluation=evaluateCompAgainstIdentity(comp,target);return evaluation.tier?[{item,price:comp.soldPrice,tier:evaluation.tier}]:[];});
  const exact=matched.filter(row=>row.tier==="exact"),near=matched.filter(row=>row.tier==="near-exact"); const auctions=exact.filter(row=>row.item.buyingOptions?.includes("AUCTION")); const fixed=exact.filter(row=>row.item.buyingOptions?.includes("FIXED_PRICE")); const asks=fixed.map(row=>row.price).sort((a,b)=>a-b);
  return {observedAt:new Date().toISOString(),query,exactActiveCount:exact.length,nearActiveCount:near.length,exactAuctionCount:auctions.length,exactFixedPriceCount:fixed.length,auctionCurrentPrices:auctions.map(row=>row.price).sort((a,b)=>a-b).slice(0,10),fixedPriceAskLow:asks[0]??null,fixedPriceAskMedian:median(asks),fixedPriceAskHigh:asks.at(-1)??null,useful:exact.length>0||near.length>=3};
}
