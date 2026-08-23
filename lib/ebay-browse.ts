import { EbayApiError, isTransientEbayStatus } from "./ebay.ts";

const BROWSE_SCOPE = "https://api.ebay.com/oauth/api_scope";
const BROWSE_PAGE_SIZE = 200;
const BROWSE_RESULT_LIMIT = 10_000;
const REQUEST_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 15_000;

let applicationToken: { value: string; expiresAt: number } | null = null;

export type EbayBrowseItemSummary = {
  itemId: string;
  legacyItemId?: string;
  title: string;
  itemWebUrl?: string;
  itemEndDate?: string;
  currentBidPrice?: { value?: string; currency?: string };
  price?: { value?: string; currency?: string };
  bidCount?: number;
  buyingOptions?: string[];
  seller?: { username?: string };
  image?: { imageUrl?: string };
  categories?: Array<{ categoryId?: string; categoryName?: string }>;
  localizedAspects?: Array<{ name?: string; value?: string }>;
};

export type EbayBrowseItem = EbayBrowseItemSummary & {
  categoryId?: string;
  condition?: string;
  conditionId?: string;
  conditionDescriptors?: Array<{ name?: string; values?: Array<{ value?: string; content?: string; additionalInfo?: string | string[] }> }>;
  additionalImages?: Array<{ imageUrl?: string }>;
  shortDescription?: string;
  itemCreationDate?: string;
  estimatedAvailabilities?: Array<{ estimatedAvailabilityStatus?: string; estimatedAvailableQuantity?: number; estimatedSoldQuantity?: number; estimatedRemainingQuantity?: number }>;
};

type BrowseSearchResponse = {
  total?: number;
  limit?: number;
  offset?: number;
  next?: string;
  itemSummaries?: EbayBrowseItemSummary[];
  warnings?: Array<{ errorId?: number; message?: string }>;
  errors?: Array<{ errorId?: number; message?: string; longMessage?: string }>;
};

function credentials() {
  const clientId = process.env.EBAY_CLIENT_ID;
  const clientSecret = process.env.EBAY_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("eBay application credentials are not configured");
  return Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
}

export async function getEbayApplicationAccessToken() {
  if (applicationToken && applicationToken.expiresAt > Date.now() + 60_000) return applicationToken.value;
  const response = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${credentials()}` },
    body: new URLSearchParams({ grant_type: "client_credentials", scope: BROWSE_SCOPE }).toString(),
    cache: "no-store",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new EbayApiError("BrowseOAuth", `eBay application token request failed with HTTP ${response.status}`, String(response.status));
  const data = await response.json() as { access_token?: string; expires_in?: number };
  if (!data.access_token || !Number.isFinite(data.expires_in)) throw new EbayApiError("BrowseOAuth", "eBay application token response was incomplete");
  applicationToken = { value: data.access_token, expiresAt: Date.now() + Number(data.expires_in) * 1000 };
  return data.access_token;
}

function filter(seller: string, start: Date, end: Date) {
  return `sellers:{${seller}},buyingOptions:{AUCTION},itemEndDate:[${start.toISOString()}..${end.toISOString()}]`;
}

function endingBeforeFilter(seller: string, end: Date) {
  return `sellers:{${seller}},buyingOptions:{AUCTION},itemEndDate:[..${end.toISOString()}]`;
}

async function searchPage(token: string, seller: string, categoryIds: readonly string[], start: Date, end: Date, offset: number): Promise<BrowseSearchResponse> {
  const url = new URL("https://api.ebay.com/buy/browse/v1/item_summary/search");
  if (!categoryIds.length) throw new Error("Browse seller search requires at least one category");
  url.searchParams.set("category_ids", categoryIds.join(","));
  url.searchParams.set("filter", filter(seller, start, end));
  url.searchParams.set("sort", "endingSoonest");
  url.searchParams.set("limit", String(BROWSE_PAGE_SIZE));
  url.searchParams.set("offset", String(offset));
  let response: Response | null = null;
  for (let attempt = 1; attempt <= REQUEST_ATTEMPTS; attempt += 1) {
    response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, "X-EBAY-C-MARKETPLACE-ID": "EBAY_US" }, cache: "no-store", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!isTransientEbayStatus(response.status) || attempt === REQUEST_ATTEMPTS) break;
    await response.body?.cancel().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** (attempt - 1)));
  }
  if (!response) throw new EbayApiError("BrowseSearch", "eBay Browse search returned no response");
  const data = await response.json().catch(() => ({})) as BrowseSearchResponse;
  if (!response.ok) {
    const detail = data.errors?.map((error) => error.longMessage ?? error.message).filter(Boolean).join("; ");
    throw new EbayApiError("BrowseSearch", `eBay Browse search failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`, String(response.status));
  }
  return data;
}

async function searchPageEndingBefore(token: string, seller: string, categoryIds: readonly string[], end: Date, offset: number): Promise<BrowseSearchResponse> {
  const url = new URL("https://api.ebay.com/buy/browse/v1/item_summary/search");
  if (!categoryIds.length) throw new Error("Browse seller search requires at least one category");
  url.searchParams.set("category_ids", categoryIds.join(","));
  url.searchParams.set("filter", endingBeforeFilter(seller, end));
  url.searchParams.set("sort", "endingSoonest");
  url.searchParams.set("limit", String(BROWSE_PAGE_SIZE));
  url.searchParams.set("offset", String(offset));
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, "X-EBAY-C-MARKETPLACE-ID": "EBAY_US" }, cache: "no-store", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const data = await response.json().catch(() => ({})) as BrowseSearchResponse;
  if (!response.ok) throw new EbayApiError("BrowseSearch", `eBay Browse search failed with HTTP ${response.status}`, String(response.status));
  if (data.warnings?.length) throw new EbayApiError("BrowseSearch", `eBay Browse rejected or modified the ending-date query: ${data.warnings.map(warning=>`${warning.errorId??"warning"}: ${warning.message??"Unknown warning"}`).join("; ")}`);
  return data;
}

export async function searchActiveMarket(token: string, query: string, categoryIds: readonly string[], limit = 50): Promise<EbayBrowseItemSummary[]> {
  if (!query.trim() || !categoryIds.length) return [];
  const url = new URL("https://api.ebay.com/buy/browse/v1/item_summary/search");
  url.searchParams.set("q", query.slice(0, 100));
  url.searchParams.set("category_ids", categoryIds.join(","));
  url.searchParams.set("filter", "buyingOptions:{AUCTION|FIXED_PRICE},priceCurrency:USD");
  url.searchParams.set("limit", String(Math.max(1, Math.min(limit, 100))));
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, "X-EBAY-C-MARKETPLACE-ID": "EBAY_US" }, cache: "no-store", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const data = await response.json().catch(() => ({})) as BrowseSearchResponse;
  if (!response.ok) throw new EbayApiError("BrowseActiveMarket", `eBay active-market search failed with HTTP ${response.status}`, String(response.status));
  return data.itemSummaries ?? [];
}

export async function getBrowseItemByLegacyId(token: string, legacyItemId: string): Promise<EbayBrowseItem> {
  if (!/^\d+$/.test(legacyItemId)) throw new EbayApiError("BrowseGetItem", "A numeric legacy ItemID is required", "INVALID_ITEM_ID");
  const url = new URL("https://api.ebay.com/buy/browse/v1/item/get_item_by_legacy_id");
  url.searchParams.set("legacy_item_id", legacyItemId);
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, "X-EBAY-C-MARKETPLACE-ID": "EBAY_US" }, cache: "no-store", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const data = await response.json().catch(() => ({})) as EbayBrowseItem & { errors?: Array<{ message?: string; longMessage?: string }> };
  if (!response.ok) {
    const detail = data.errors?.map(error => error.longMessage ?? error.message).filter(Boolean).join("; ");
    throw new EbayApiError("BrowseGetItem", `eBay Browse item lookup failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`, String(response.status));
  }
  if (!data.itemId || !data.title) throw new EbayApiError("BrowseGetItem", "eBay Browse item lookup returned incomplete identity", "MISSING_ITEM");
  return data;
}

export async function* searchSellerAuctionsEnding(token: string, seller: string, categoryIds: readonly string[], start: Date, end: Date): AsyncGenerator<EbayBrowseItemSummary[]> {
  if (!seller.trim() || !Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) throw new Error("Invalid Browse seller or ending window");
  let offset = 0;
  let expectedTotal: number | null = null;
  for (;;) {
    const page = await searchPage(token, seller, categoryIds, start, end, offset);
    const total = Number(page.total ?? 0);
    if (!Number.isSafeInteger(total) || total < 0 || total > BROWSE_RESULT_LIMIT) throw new EbayApiError("BrowseSearch", `Browse result count ${String(page.total)} is outside the supported complete-enumeration range`);
    if (expectedTotal === null) expectedTotal = total;
    else if (total !== expectedTotal) throw new EbayApiError("BrowseSearch", "Browse result count changed during pagination; run was not persisted");
    const items = page.itemSummaries ?? [];
    yield items;
    offset += items.length;
    if (offset >= total) break;
    if (!items.length || !page.next) throw new EbayApiError("BrowseSearch", "Browse pagination ended before every qualifying item was retrieved");
  }
}

export type SellerAuctionEnumeration = { reportedTotal: number; items: EbayBrowseItemSummary[] };

export async function enumerateSellerAuctionsEnding(token: string, seller: string, categoryIds: readonly string[], start: Date, end: Date): Promise<SellerAuctionEnumeration> {
  if (!seller.trim() || !Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) throw new Error("Invalid Browse seller or ending window");
  let offset = 0;
  let reportedTotal: number | null = null;
  const items: EbayBrowseItemSummary[] = [];
  for (;;) {
    const page = await searchPage(token, seller, categoryIds, start, end, offset);
    const total = Number(page.total ?? 0);
    if (!Number.isSafeInteger(total) || total < 0 || total > BROWSE_RESULT_LIMIT) throw new EbayApiError("BrowseSearch", `Browse result count ${String(page.total)} is outside the supported complete-enumeration range`);
    if (reportedTotal === null) reportedTotal = total;
    else if (total !== reportedTotal) throw new EbayApiError("BrowseSearch", "Browse result count changed during completeness audit");
    const pageItems = page.itemSummaries ?? [];
    items.push(...pageItems);
    offset += pageItems.length;
    if (offset >= total) break;
    if (!pageItems.length || !page.next) throw new EbayApiError("BrowseSearch", `Browse pagination ended at ${offset} of ${total}`);
  }
  return { reportedTotal: reportedTotal ?? 0, items };
}

export async function enumerateSellerAuctionsEndingBefore(token: string, seller: string, categoryIds: readonly string[], end: Date): Promise<SellerAuctionEnumeration> {
  if (!seller.trim() || !Number.isFinite(end.getTime())) throw new Error("Invalid Browse seller or ending boundary");
  let offset=0,reportedTotal:number|null=null;const items:EbayBrowseItemSummary[]=[];
  for(;;){const page=await searchPageEndingBefore(token,seller,categoryIds,end,offset),total=Number(page.total??0);if(!Number.isSafeInteger(total)||total<0)throw new EbayApiError("BrowseSearch",`Browse result count ${String(page.total)} is invalid`);if(reportedTotal===null)reportedTotal=total;else if(total!==reportedTotal)throw new EbayApiError("BrowseSearch","Browse result count changed during pagination");const pageItems=page.itemSummaries??[];items.push(...pageItems);offset+=pageItems.length;if(!page.next)break;if(!pageItems.length||offset>=BROWSE_RESULT_LIMIT)throw new EbayApiError("BrowseSearch",`Browse pagination could not safely continue after ${offset} items`);}
  return{reportedTotal:reportedTotal??0,items};
}

export async function getSellerActiveListingTotal(token:string,seller:string){
  const url=new URL("https://api.ebay.com/buy/browse/v1/item_summary/search");url.searchParams.set("category_ids","0");url.searchParams.set("filter",`sellers:{${seller}}`);url.searchParams.set("limit","1");
  const response=await fetch(url,{headers:{Authorization:`Bearer ${token}`,"X-EBAY-C-MARKETPLACE-ID":"EBAY_US"},cache:"no-store",signal:AbortSignal.timeout(REQUEST_TIMEOUT_MS)});const data=await response.json().catch(()=>({})) as BrowseSearchResponse;if(!response.ok)throw new EbayApiError("BrowseSellerTotal",`eBay seller-total query failed with HTTP ${response.status}`,String(response.status));if(data.warnings?.length)throw new EbayApiError("BrowseSellerTotal",`eBay modified the seller-total query: ${data.warnings.map(warning=>warning.message).filter(Boolean).join("; ")}`);const total=Number(data.total??0);if(!Number.isSafeInteger(total)||total<0)throw new EbayApiError("BrowseSellerTotal","eBay returned an invalid seller active-listing total");return total;
}
