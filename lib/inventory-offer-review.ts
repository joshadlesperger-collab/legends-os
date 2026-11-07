export type ReviewSource = {sku:string;title:string;price:string;quantity:string;photos:string[];condition:string;description:string;location:string;policies:string[];specifics:[string,string][]};
export function reviewSources(packet:{headers:string[];rows:string[][]}):ReviewSource[]{
 if(!Array.isArray(packet.headers)||!Array.isArray(packet.rows)||packet.rows.length>2)throw Error('Expected bounded two-card test packet');
 return packet.rows.map(row=>{
  const get=(key:string)=>String(row[packet.headers.indexOf(key)]??'');
  const sku=get('Custom Label (SKU)');
  if(!['TEST-CSV-cactus13-0001','TEST-CSV-cactus13-0010'].includes(sku))throw Error('Unexpected test SKU');
  return {sku,title:get('Title'),price:get('Start price'),quantity:get('Quantity'),photos:get('Item photo URL').split('|').filter(u=>{try{return new URL(u).protocol==='https:'}catch{return false}}),condition:get('CD:Card Condition - (ID: 40001)'),description:get('Description'),location:get('Location'),policies:['Shipping profile name','Payment profile name','Return profile name'].map(get),specifics:packet.headers.flatMap((h,i)=>h.startsWith('C:')&&row[i]?[[h.slice(2),String(row[i])] as [string,string]]:[])};
 });
}
export type RemoteReview = {sku:string;checkedAt:string;status:string;itemStatus?:number;offerStatus?:number;item?:{title?:string;photos?:string[];condition?:string;conditionDescriptors?:unknown;aspects?:unknown;quantity?:number};offers?:{id?:string;status?:string;price?:unknown;quantity?:number;policies?:unknown;location?:string;description?:string}[]};
export async function readOfferReview(token:string,skus:string[],fetcher:typeof fetch=fetch):Promise<RemoteReview[]>{
 if(!token||skus.length>2||!skus.length||new Set(skus).size!==skus.length)throw Error('Bounded authenticated review required');
 return Promise.all(skus.map(async sku=>{
  const checkedAt=new Date().toISOString();
  try{
   const headers={Authorization:`Bearer ${token}`,Accept:'application/json'};
   const [ir,or]=await Promise.all([
    fetcher(`https://api.ebay.com/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`,{method:'GET',headers,signal:AbortSignal.timeout(15000)}),
    fetcher(`https://api.ebay.com/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}`,{method:'GET',headers,signal:AbortSignal.timeout(15000)})]);
   const [i,o]=await Promise.all([ir.json(),or.json()]);
   return {sku,checkedAt,status:ir.ok&&or.ok&&!o.next?'API read completed; compare saved fields':'API read incomplete; no readiness claim',itemStatus:ir.status,offerStatus:or.status,
    item:ir.ok?{title:i.product?.title,photos:i.product?.imageUrls,condition:i.condition,conditionDescriptors:i.conditionDescriptors,aspects:i.product?.aspects,quantity:i.availability?.shipToLocationAvailability?.quantity}:undefined,
    offers:or.ok?(o.offers??[]).map((v:any)=>({id:v.offerId,status:v.status,price:v.pricingSummary?.price,quantity:v.availableQuantity,policies:v.listingPolicies,location:v.merchantLocationKey,description:v.listingDescription})):undefined};
  }catch{return {sku,checkedAt,status:'API unavailable; local evidence only'};}
 }));
}
