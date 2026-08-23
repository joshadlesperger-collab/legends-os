import {ebayGetJson} from "./ebay-readonly.ts";
export type NegotiationEligibility={listingId:string;eligible:true;observedAt:string};
export async function findEligibleItems(accessToken:string,fetcher?:typeof fetch){
  const result=new Map<string,NegotiationEligibility>();let offset=0;
  for(let page=0;page<50;page++){const query=new URLSearchParams({limit:"200",offset:String(offset)});const data=await ebayGetJson<{eligibleItems?:Array<{listingId?:string}>;total?:number;next?:string}>("negotiation-eligibility",`/sell/negotiation/v1/find_eligible_items?${query}`,accessToken,fetcher);const rows=data.eligibleItems??[];const observedAt=new Date().toISOString();for(const row of rows)if(row.listingId)result.set(row.listingId,{listingId:row.listingId,eligible:true,observedAt});offset+=rows.length;if(!rows.length||!data.next||(data.total!=null&&offset>=data.total))break;}
  return result;
}

export type SellerOfferResponse={offers?:Array<{offerId?:string;revision?:string;creationDate?:string;lastModifiedDate?:string;offerStatus?:string;offeredItems?:Array<{listingId?:string;quantity?:number;discountPercentage?:string;price?:{value?:string;currency?:string}}>}>};
export async function sendOfferToInterestedBuyers(accessToken:string,input:{listingId:string;price:number;currency?:string;message?:string},fetcher:typeof fetch=fetch):Promise<SellerOfferResponse>{
  if(!/^\d+$/.test(input.listingId)||!Number.isFinite(input.price)||input.price<=0)throw new Error("Invalid governed seller-offer input");
  const response=await fetcher("https://api.ebay.com/sell/negotiation/v1/send_offer_to_interested_buyers",{method:"POST",headers:{Authorization:`Bearer ${accessToken}`,Accept:"application/json","Content-Type":"application/json","X-EBAY-C-MARKETPLACE-ID":"EBAY_US"},body:JSON.stringify({allowCounterOffer:false,message:input.message??"A special offer from Legends Card Co.",offeredItems:[{listingId:input.listingId,quantity:1,price:{value:input.price.toFixed(2),currency:input.currency??"USD"}}]})});
  const body=await response.text();if(!response.ok)throw new Error(`eBay Negotiation send offer failed with HTTP ${response.status}: ${body.slice(0,500)}`);if(!body.trim())throw new Error("eBay accepted the offer request without returning auditable offer data");return JSON.parse(body) as SellerOfferResponse;
}
