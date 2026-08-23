import { EbayApiError, isTransientEbayStatus } from "@/lib/ebay";
export { getOrderWindowStart, ORDER_OVERLAP_MS } from "@/lib/ebay-order-domain";

export type EbayAmount = { value?: string; currency?: string };
export type EbayRefundPayload = { refundId?: string; refundReferenceId?: string; refundStatus?: string; refundDate?: string; amount?: EbayAmount };
export type EbayOrderLinePayload = {
  lineItemId?: string; legacyItemId?: string; sku?: string; title?: string; quantity?: number;
  lineItemCost?: EbayAmount; total?: EbayAmount; deliveryCost?: EbayAmount;
  lineItemFulfillmentStatus?: string; listingMarketplaceId?: string;
  refunds?: EbayRefundPayload[]; taxes?: Array<{ amount?: EbayAmount }>;
  appliedPromotions?: Array<{ discountAmount?: EbayAmount }>;
};
export type EbayOrderPayload = {
  orderId?: string; creationDate?: string; lastModifiedDate?: string;
  orderPaymentStatus?: string; orderFulfillmentStatus?: string;
  cancelStatus?: { cancelState?: string }; lineItems?: EbayOrderLinePayload[];
  pricingSummary?: { priceSubtotal?: EbayAmount; deliveryCost?: EbayAmount; priceDiscount?: EbayAmount; deliveryDiscount?: EbayAmount; tax?: EbayAmount; total?: EbayAmount };
  paymentSummary?: { totalDueSeller?: EbayAmount; refunds?: EbayRefundPayload[] };
  totalMarketplaceFee?: EbayAmount;
};

type OrdersResponse = { href?: string; next?: string; limit?: number; offset?: number; total?: number; orders?: EbayOrderPayload[]; warnings?: unknown[] };
export type EbayOrdersPage = { orders: EbayOrderPayload[]; total: number; nextOffset: number | null };
const ORDER_PAGE_LIMIT = 50;
const MAX_ORDER_PAGES = 200;
const MAX_ATTEMPTS = 3;
// Three worst-case provider attempts consume about 24 seconds, leaving ample
// room under Vercel's 60-second limit for page ingestion and lease release.
const REQUEST_TIMEOUT_MS = 8_000;
function wait(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function retryDelay(attempt: number) { return 250 * 2 ** (attempt - 1) + Math.floor(Math.random() * 100); }

async function fetchOrdersPage(accessToken: string, from: Date, to: Date, offset: number): Promise<OrdersResponse> {
  const filter = `lastmodifieddate:[${from.toISOString()}..${to.toISOString()}]`;
  const url = new URL("https://api.ebay.com/sell/fulfillment/v1/order");
  url.searchParams.set("filter", filter);
  url.searchParams.set("limit", String(ORDER_PAGE_LIMIT));
  url.searchParams.set("offset", String(offset));
  url.searchParams.set("fieldGroups", "TAX_BREAKDOWN");

  let response: Response | null = null;
  let networkError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (!isTransientEbayStatus(response.status) || attempt === MAX_ATTEMPTS) break;
      await response.body?.cancel().catch(() => undefined);
    } catch (error) {
      networkError = error;
      if (attempt === MAX_ATTEMPTS) break;
    }
    await wait(retryDelay(attempt));
  }
  if (!response) throw new EbayApiError("getOrders", `getOrders network request failed after ${MAX_ATTEMPTS} attempts: ${networkError instanceof Error ? networkError.message : "network error"}`);
  if (!response.ok) throw new EbayApiError("getOrders", `getOrders failed with HTTP ${response.status}`, String(response.status));

  let payload: OrdersResponse;
  try { payload = await response.json() as OrdersResponse; }
  catch { throw new EbayApiError("getOrders", "getOrders returned malformed JSON", "MALFORMED_RESPONSE"); }
  if (!Array.isArray(payload.orders)) payload.orders = [];
  if (payload.warnings?.length) throw new EbayApiError("getOrders", "getOrders returned a partial/warning response; checkpoint was not advanced", "PARTIAL_RESPONSE");
  if (payload.total != null && (!Number.isInteger(payload.total) || payload.total < 0)) throw new EbayApiError("getOrders", "getOrders returned malformed pagination", "MALFORMED_PAGINATION");
  return payload;
}

export async function getOrdersPage(accessToken: string, from: Date, to: Date, offset: number): Promise<EbayOrdersPage> {
  const payload = await fetchOrdersPage(accessToken, from, to, offset);
  const orders = payload.orders ?? [];
  const total = payload.total ?? offset + orders.length;
  const hasMore = Boolean(payload.next) || offset + orders.length < total;
  if (hasMore && orders.length === 0) throw new EbayApiError("getOrders", "getOrders pagination did not advance", "MALFORMED_PAGINATION");
  const nextOffset = hasMore ? offset + orders.length : null;
  if (nextOffset != null && nextOffset <= offset) throw new EbayApiError("getOrders", "getOrders pagination did not advance", "MALFORMED_PAGINATION");
  if (nextOffset != null && nextOffset / ORDER_PAGE_LIMIT >= MAX_ORDER_PAGES) {
    throw new EbayApiError("getOrders", `getOrders exceeded the ${MAX_ORDER_PAGES}-page safety limit`, "PAGINATION_LIMIT");
  }
  return { orders, total, nextOffset };
}

export async function* getOrders(accessToken: string, from: Date, to: Date): AsyncGenerator<EbayOrderPayload[]> {
  let offset = 0;
  for (let page = 1; page <= MAX_ORDER_PAGES; page += 1) {
    const current = await getOrdersPage(accessToken, from, to, offset);
    yield current.orders;
    if (current.nextOffset == null) return;
    offset = current.nextOffset;
  }
  throw new EbayApiError("getOrders", `getOrders exceeded the ${MAX_ORDER_PAGES}-page safety limit`, "PAGINATION_LIMIT");
}
