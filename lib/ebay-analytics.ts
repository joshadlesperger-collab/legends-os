import { ebayGetJson } from "./ebay-readonly.ts";
export type TrafficMetrics = { impressions:number|null; views:number|null; clickThroughRate:number|null; transactions:number|null; conversionRate:number|null; observedAt:string; windowStart:string; windowEnd:string; lastUpdatedAt?:string|null };
type TrafficValue = { value?:unknown; applicable?:boolean; metricName?:string };
type TrafficReport = {
  header?: { dimensionKeys?:Array<{key?:string}>; metrics?:Array<{key?:string}> };
  records?:Array<{dimensionValues?:TrafficValue[]; metricValues?:TrafficValue[]}>;
  startDate?:string; endDate?:string; lastUpdatedDate?:string;
};
function metricNumber(metric:TrafficValue):number|null {
  if (metric.applicable === false || metric.value == null) return null;
  if (typeof metric.value !== "number" && typeof metric.value !== "string") return null;
  if (typeof metric.value === "string" && !metric.value.trim()) return null;
  const parsed = Number(metric.value);
  return Number.isFinite(parsed) ? parsed : null;
}
export async function getTrafficReport(input:{accessToken:string;listingIds:string[];start:Date;end:Date;fetcher?:typeof fetch}) {
  if (!input.listingIds.length) return new Map<string,TrafficMetrics>();
  const metrics = "LISTING_IMPRESSION_TOTAL,LISTING_VIEWS_TOTAL,CLICK_THROUGH_RATE,TRANSACTION,SALES_CONVERSION_RATE";
  // eBay accepts ISO 8601 dates with an explicit UTC offset and uses whole days.
  const date = (value:Date) => value.toISOString().replace(/Z$/, "+00:00");
  const filter = `date_range:[${date(input.start)}..${date(input.end)}],listing_ids:{${input.listingIds.join("|")}}`;
  const query = new URLSearchParams({dimension:"LISTING",metric:metrics,filter});
  const data = await ebayGetJson<TrafficReport>("analytics-traffic",`/sell/analytics/v1/traffic_report?${query}`,input.accessToken,input.fetcher);
  const observedAt = new Date().toISOString(), result = new Map<string,TrafficMetrics>();
  const listingIndex = data.header?.dimensionKeys?.findIndex(dimension => dimension.key?.toUpperCase() === "LISTING") ?? 0;
  for (const record of data.records ?? []) {
    const dimension = record.dimensionValues?.[listingIndex];
    if (dimension?.applicable === false || dimension?.value == null || !String(dimension.value)) continue;
    const values = new Map<string,number|null>();
    const metricValues = record.metricValues ?? [];
    for (let index = 0; index < metricValues.length; index++) {
      const metric = metricValues[index];
      // Live responses name metrics in the header, in the same order as values.
      // Retain named-value compatibility for previously saved fixtures/exports.
      const key = data.header?.metrics ? data.header.metrics[index]?.key : metric.metricName;
      if (key) values.set(key.toUpperCase(),metricNumber(metric));
    }
    result.set(String(dimension.value), {
      impressions:values.get("LISTING_IMPRESSION_TOTAL")??null, views:values.get("LISTING_VIEWS_TOTAL")??null,
      clickThroughRate:values.get("CLICK_THROUGH_RATE")??null, transactions:values.get("TRANSACTION")??null,
      conversionRate:values.get("SALES_CONVERSION_RATE")??null, observedAt,
      windowStart:data.startDate??input.start.toISOString(), windowEnd:data.endDate??input.end.toISOString(),
      // Provider freshness is distinct from retrieval time.
      lastUpdatedAt:data.lastUpdatedDate??null,
    });
  }
  return result;
}
