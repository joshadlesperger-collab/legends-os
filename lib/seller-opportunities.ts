import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { enumerateSellerAuctionsEndingBefore, getEbayApplicationAccessToken, type EbayBrowseItemSummary, type SellerAuctionEnumeration } from "@/lib/ebay-browse";
import { classifySellerListing } from "@/lib/seller-opportunity-domain";
export { MONITORED_SELLERS } from "@/lib/seller-registry";
import { MONITORED_SELLERS } from "@/lib/seller-registry";

export type SellerCompletenessAudit = { status:"Complete"|"Incomplete"; reportedTotal:number; retrievedTotal:number; uniqueItemIds:number; duplicateCount:number; earliestEndTime:string|null; latestEndTime:string|null; outsideBoundaryCount:number; singleCount:number; lotCount:number; reconciles:boolean; immediatelyBefore:Array<{itemId:string;endTime:string}>; immediatelyAfter:Array<{itemId:string;endTime:string}> };
export class IncompleteSellerRunError extends Error { constructor(public audit:SellerCompletenessAudit){super(`Incomplete eBay response: reported ${audit.reportedTotal}, retrieved ${audit.retrievedTotal}, unique ${audit.uniqueItemIds}, duplicates ${audit.duplicateCount}, outside CT date ${audit.outsideBoundaryCount}`);this.name="IncompleteSellerRunError";} }

function centralDate(value:Date){return new Intl.DateTimeFormat("en-CA",{timeZone:"America/Chicago",year:"numeric",month:"2-digit",day:"2-digit"}).format(value);}
function centralDayWindow(value:Date){const date=centralDate(value);const noon=new Date(`${date}T12:00:00Z`);const zone=String(new Intl.DateTimeFormat("en-US",{timeZone:"America/Chicago",timeZoneName:"longOffset"}).formatToParts(noon).find(part=>part.type==="timeZoneName")?.value??"GMT-05:00");const match=zone.match(/GMT([+-])(\d{2}):(\d{2})/);if(!match)throw new Error("Could not resolve Central Time offset");const offset=(Number(match[2])*60+Number(match[3]))*(match[1]==="+"?1:-1);const start=new Date(`${date}T00:00:00Z`);start.setUTCMinutes(start.getUTCMinutes()-offset);const nextProbe=new Date(start.getTime()+30*60*60*1000);const nextDate=centralDate(nextProbe);const nextNoon=new Date(`${nextDate}T12:00:00Z`);const nextZone=String(new Intl.DateTimeFormat("en-US",{timeZone:"America/Chicago",timeZoneName:"longOffset"}).formatToParts(nextNoon).find(part=>part.type==="timeZoneName")?.value??zone);const nextMatch=nextZone.match(/GMT([+-])(\d{2}):(\d{2})/)!;const nextOffset=(Number(nextMatch[2])*60+Number(nextMatch[3]))*(nextMatch[1]==="+"?1:-1);const end=new Date(`${nextDate}T00:00:00Z`);end.setUTCMinutes(end.getUTCMinutes()-nextOffset);return{start,end};}

const legacyId=(item:EbayBrowseItemSummary)=>String(item.legacyItemId??item.itemId.split("|")[1]??item.itemId);

export async function auditSellerOpportunities(slug:string,reviewDate=new Date()){
  const seller=MONITORED_SELLERS.find(entry=>entry.slug===slug);if(!seller)throw new Error("Unsupported monitored seller");
  const {start,end}=centralDayWindow(reviewDate),pad=2*60*60*1000,token=await getEbayApplicationAccessToken();
  const signature=(result:SellerAuctionEnumeration)=>result.items.map(legacyId).sort().join("|");
  let exact=await enumerateSellerAuctionsEndingBefore(token,seller.ebayUserId,seller.browseCategoryIds,end),stable=false;
  for(let attempt=0;attempt<3;attempt+=1){const check=await enumerateSellerAuctionsEndingBefore(token,seller.ebayUserId,seller.browseCategoryIds,end);if(check.reportedTotal===exact.reportedTotal&&signature(check)===signature(exact)){exact=check;stable=true;break;}exact=check;}
  if(!stable)throw new Error("Incomplete eBay response: active inventory did not stabilize across repeated pagination passes");
  const beforeCutoff=start.getTime()>Date.now()?await enumerateSellerAuctionsEndingBefore(token,seller.ebayUserId,seller.browseCategoryIds,start):{reportedTotal:0,items:[]};
  const throughWideEnd=await enumerateSellerAuctionsEndingBefore(token,seller.ebayUserId,seller.browseCategoryIds,new Date(end.getTime()+pad));
  const ids=exact.items.map(legacyId),unique=new Set(ids),duplicateCount=ids.length-unique.size;
  const qualifying=exact.items.filter(item=>{const time=new Date(String(item.itemEndDate)).getTime();return time>=start.getTime()&&time<end.getTime();});
  const outsideBoundaryCount=exact.items.length-qualifying.length,sorted=[...qualifying].sort((a,b)=>String(a.itemEndDate).localeCompare(String(b.itemEndDate))),singleCount=qualifying.filter(item=>classifySellerListing(item.title).kind==="single").length,lotCount=qualifying.length-singleCount;
  const nearby=(side:"before"|"after")=>(side==="before"?beforeCutoff.items:throughWideEnd.items).filter(item=>{const time=new Date(String(item.itemEndDate)).getTime();return side==="before"?time>=start.getTime()-pad&&time<start.getTime():time>=end.getTime()&&time<end.getTime()+pad;}).sort((a,b)=>String(a.itemEndDate).localeCompare(String(b.itemEndDate))).slice(side==="before"?-10:0,side==="before"?undefined:10).map(item=>({itemId:legacyId(item),endTime:String(item.itemEndDate)}));
  const reconciles=singleCount+lotCount===qualifying.length,status=exact.reportedTotal===unique.size&&duplicateCount===0&&outsideBoundaryCount===0&&reconciles?"Complete":"Incomplete";
  return{audit:{status,reportedTotal:exact.reportedTotal,retrievedTotal:exact.items.length,uniqueItemIds:unique.size,duplicateCount,earliestEndTime:sorted[0]?.itemEndDate??null,latestEndTime:sorted.at(-1)?.itemEndDate??null,outsideBoundaryCount,singleCount,lotCount,reconciles,immediatelyBefore:nearby("before"),immediatelyAfter:nearby("after")} satisfies SellerCompletenessAudit,qualifying,windowStart:start,windowEnd:end,seller};
}

function numeric(value: unknown, fallback = 0) {
  if (value && typeof value === "object" && "#text" in value) return numeric((value as { "#text"?: unknown })["#text"], fallback);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function itemSpecifics(item: EbayBrowseItemSummary): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  const entries = item.localizedAspects ?? [];
  const result: Record<string, string | string[]> = {};
  for (const entry of entries) if (entry.name && entry.value != null) result[entry.name] = entry.value;
  return Object.keys(result).length ? result : Prisma.JsonNull;
}

function normalizeAuction(item: EbayBrowseItemSummary, seller: string, windowStart: Date, windowEnd: Date) {
  const endTime = item.itemEndDate ? new Date(item.itemEndDate) : null;
  if (!endTime || !Number.isFinite(endTime.getTime()) || endTime < windowStart || endTime > windowEnd) return null;
  if (!item.buyingOptions?.includes("AUCTION")) return null;
  if (item.seller?.username?.toLowerCase() !== seller.toLowerCase()) throw new Error(`Browse returned an item for unexpected seller ${item.seller?.username ?? "unknown"}`);
  const classification = classifySellerListing(String(item.title ?? ""));
  const price = item.currentBidPrice ?? item.price;
  const legacyItemId = item.legacyItemId ?? item.itemId.split("|")[1] ?? item.itemId;
  return {
    seller,
    ebayItemId: String(legacyItemId),
    kind: classification.kind,
    title: String(item.title ?? "Untitled eBay listing"),
    listingUrl: item.itemWebUrl ?? `https://www.ebay.com/itm/${String(legacyItemId)}`,
    currentBid: new Prisma.Decimal(numeric(price?.value).toFixed(2)),
    currency: price?.currency ?? "USD",
    bidCount: Math.max(0, Math.trunc(numeric(item.bidCount))),
    endTime,
    estimatedCards: classification.estimatedCards,
    imageUrl: item.image?.imageUrl ?? null,
    categoryName: item.categories?.at(-1)?.categoryName ?? null,
    itemSpecifics: itemSpecifics(item),
    classificationReason: classification.reason,
  };
}

export async function collectSellerOpportunities(slug: string, now = new Date()) {
  const {seller,audit,qualifying,windowStart,windowEnd}=await auditSellerOpportunities(slug,now);
  if(audit.status!=="Complete")throw new IncompleteSellerRunError(audit);
  const byItemId = new Map<string, ReturnType<typeof normalizeAuction>>();
  for (const item of qualifying) {
      const auction = normalizeAuction(item, seller.ebayUserId, windowStart, windowEnd);
      if (auction) byItemId.set(auction.ebayItemId, auction);
  }
  const auctions = Array.from(byItemId.values()).filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
  for(const auction of auctions){const existing=auction.itemSpecifics&&typeof auction.itemSpecifics==="object"&&!Array.isArray(auction.itemSpecifics)?auction.itemSpecifics as Record<string,Prisma.JsonValue>:{};auction.itemSpecifics={...existing,completenessAudit:audit} as Prisma.InputJsonValue;}
  const singleCount = auctions.filter((entry) => entry.kind === "single").length;
  const lotCount = auctions.length - singleCount;
  return prisma.sellerOpportunityRun.create({ data: {
    seller: seller.ebayUserId, windowStart, windowEnd, itemCount: auctions.length, singleCount, lotCount,
    auctions: { create: auctions },
  } });
}
