import {ebayGetJson} from "./ebay-readonly.ts";
export type TrafficMetrics={impressions:number|null;views:number|null;clickThroughRate:number|null;transactions:number|null;conversionRate:number|null;observedAt:string;windowStart:string;windowEnd:string};
type TrafficRecord={dimensionValues?:Array<{value?:string}>;metricValues?:Array<{metricName?:string;value?:string|number}>};
const number=(value:unknown)=>{const parsed=Number(value);return Number.isFinite(parsed)?parsed:null};
export async function getTrafficReport(input:{accessToken:string;listingIds:string[];start:Date;end:Date;fetcher?:typeof fetch}){
  if(!input.listingIds.length)return new Map<string,TrafficMetrics>();
  const dimensions="LISTING";const metrics="LISTING_IMPRESSION_TOTAL,LISTING_VIEWS_TOTAL,CLICK_THROUGH_RATE,TRANSACTION,SALES_CONVERSION_RATE";
  const filter=`date_range:[${input.start.toISOString()}..${input.end.toISOString()}],listing_ids:{${input.listingIds.join("|")}}`;
  const query=new URLSearchParams({dimension:dimensions,metric:metrics,filter});
  const data=await ebayGetJson<{records?:TrafficRecord[]}>("analytics-traffic",`/sell/analytics/v1/traffic_report?${query}`,input.accessToken,input.fetcher);
  const observedAt=new Date().toISOString(),result=new Map<string,TrafficMetrics>();
  for(const record of data.records??[]){const itemId=record.dimensionValues?.[0]?.value;if(!itemId)continue;const values=new Map((record.metricValues??[]).map(value=>[String(value.metricName).toUpperCase(),number(value.value)]));result.set(itemId,{impressions:values.get("LISTING_IMPRESSION_TOTAL")??null,views:values.get("LISTING_VIEWS_TOTAL")??null,clickThroughRate:values.get("CLICK_THROUGH_RATE")??null,transactions:values.get("TRANSACTION")??null,conversionRate:values.get("SALES_CONVERSION_RATE")??null,observedAt,windowStart:input.start.toISOString(),windowEnd:input.end.toISOString()});}
  return result;
}
