import {ebayGetJson} from "./ebay-readonly.ts";
export type AdvertisingContext={eligible:boolean|null;programStatus:string|null;campaignId:string|null;campaignName:string|null;campaignStatus:string|null;adId:string|null;adStatus:string|null;adRate:number|null;observedAt:string};
export async function getAdvertisingEligibility(accessToken:string,fetcher?:typeof fetch){
  const observedAt=new Date().toISOString();
  const eligibility=await ebayGetJson<{advertisingEligibility?:Array<{programType?:string;status?:string}>}>("advertising-eligibility","/sell/account/v1/advertising_eligibility",accessToken,fetcher);
  const programs=eligibility.advertisingEligibility??[];const promoted=programs.find(row=>/PROMOTED/i.test(row.programType??""))??programs[0];
  return{eligible:promoted?promoted.status==="ELIGIBLE":null,programStatus:promoted?.status??null,observedAt};
}
export async function getCampaignAdvertisingContext(accessToken:string,eligibility:{eligible:boolean|null;programStatus:string|null;observedAt:string},fetcher?:typeof fetch){
  const observedAt=new Date().toISOString();
  const contexts=new Map<string,AdvertisingContext>(),listingAdCounts=new Map<string,number>();let offset=0;
  for(let page=0;page<20;page++){const q=new URLSearchParams({limit:"200",offset:String(offset)});const data=await ebayGetJson<{campaigns?:Array<{campaignId?:string;campaignName?:string;campaignStatus?:string}>;total?:number;next?:string}>("marketing-campaigns",`/sell/marketing/v1/ad_campaign?${q}`,accessToken,fetcher);const campaigns=data.campaigns??[];
    for(const campaign of campaigns){if(!campaign.campaignId)continue;let adOffset=0;for(let adPage=0;adPage<50;adPage++){const aq=new URLSearchParams({limit:"200",offset:String(adOffset)});const ads=await ebayGetJson<{ads?:Array<{adId?:string;listingId?:string;adStatus?:string;bidPercentage?:string|number}>;total?:number;next?:string}>("marketing-ads",`/sell/marketing/v1/ad_campaign/${encodeURIComponent(campaign.campaignId)}/ad?${aq}`,accessToken,fetcher);const rows=ads.ads??[];for(const ad of rows)if(ad.listingId){listingAdCounts.set(ad.listingId,(listingAdCounts.get(ad.listingId)??0)+1);contexts.set(ad.listingId,{eligible:eligibility.eligible,programStatus:eligibility.programStatus,campaignId:campaign.campaignId,campaignName:campaign.campaignName??null,campaignStatus:campaign.campaignStatus??null,adId:ad.adId??null,adStatus:ad.adStatus??null,adRate:Number.isFinite(Number(ad.bidPercentage))?Number(ad.bidPercentage):null,observedAt});}adOffset+=rows.length;if(!rows.length||!ads.next||(ads.total!=null&&adOffset>=ads.total))break;}
    }offset+=campaigns.length;if(!campaigns.length||!data.next||(data.total!=null&&offset>=data.total))break;
  }
  return{contexts,listingAdCounts,defaultContext:{eligible:eligibility.eligible,programStatus:eligibility.programStatus,campaignId:null,campaignName:null,campaignStatus:null,adId:null,adStatus:null,adRate:null,observedAt}};
}
export async function getAdvertisingContext(accessToken:string,fetcher?:typeof fetch){const eligibility=await getAdvertisingEligibility(accessToken,fetcher);return getCampaignAdvertisingContext(accessToken,eligibility,fetcher)}

export type BulkCreateAdResult={listingId:string;statusCode:number;adId:string|null;href:string|null;errors:Array<{errorId:number|null;category:string|null;message:string}>};
export async function bulkCreateAdsByListingId(accessToken:string,campaignId:string,listingIds:string[],bidPercentage="5.0",fetcher:typeof fetch=fetch){
  if(!/^\d+$/.test(campaignId)||!listingIds.length||listingIds.length>500||new Set(listingIds).size!==listingIds.length)throw new Error("Invalid governed Promoted Listings batch");
  if(bidPercentage!=="5.0"||listingIds.some(id=>!/^\d+$/.test(id)))throw new Error("Governed Promoted Listings writes require exact listing IDs and a 5.0% rate");
  const response=await fetcher(`https://api.ebay.com/sell/marketing/v1/ad_campaign/${encodeURIComponent(campaignId)}/bulk_create_ads_by_listing_id`,{method:"POST",headers:{Authorization:`Bearer ${accessToken}`,Accept:"application/json","Content-Type":"application/json","X-EBAY-C-MARKETPLACE-ID":"EBAY_US"},body:JSON.stringify({requests:listingIds.map(listingId=>({listingId,bidPercentage}))})});
  const text=await response.text();let data:unknown={};try{data=text.trim()?JSON.parse(text):{};}catch{throw new Error(`Marketing bulk create returned non-JSON HTTP ${response.status}`);}
  if(!response.ok&&response.status!==207)throw new Error(`Marketing bulk create failed with HTTP ${response.status}`);
  const rows=((data as {responses?:unknown[]}).responses??[]) as Array<{listingId?:string;statusCode?:number;adId?:string;href?:string;errors?:Array<{errorId?:number;category?:string;message?:string;longMessage?:string}>}>;
  return rows.map(row=>({listingId:String(row.listingId??""),statusCode:Number(row.statusCode??0),adId:row.adId??null,href:row.href??null,errors:(row.errors??[]).map(error=>({errorId:Number.isFinite(Number(error.errorId))?Number(error.errorId):null,category:error.category??null,message:error.longMessage??error.message??"eBay Marketing error"}))})) satisfies BulkCreateAdResult[];
}
