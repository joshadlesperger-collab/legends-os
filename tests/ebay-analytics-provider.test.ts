import test from "node:test";
import assert from "node:assert/strict";
import { getTrafficReport } from "../lib/ebay-analytics.ts";

const start = new Date("2026-10-01T00:00:00Z"), end = new Date("2026-10-24T00:00:00Z");
function fixtureFetcher(body: unknown, inspect?: (url: URL, init?: RequestInit) => void): typeof fetch {
  return async (url, init) => {
    inspect?.(new URL(String(url)), init);
    return new Response(JSON.stringify(body), { status: 200 });
  };
}
test("provider header order controls metrics and returned coverage is preserved", async () => {
  const result = await getTrafficReport({ accessToken: "test", listingIds: ["123"], start, end, fetcher: fixtureFetcher({
    header: { dimensionKeys: [{ key: "LISTING" }], metrics: [
      { key: "TRANSACTION" }, { key: "LISTING_VIEWS_TOTAL" }, { key: "LISTING_IMPRESSION_TOTAL" },
      { key: "SALES_CONVERSION_RATE" }, { key: "CLICK_THROUGH_RATE" },
    ] },
    records: [{ dimensionValues: [{ value: "123", applicable: true }], metricValues: [
      { value: 2, applicable: true }, { value: 40 }, { value: 1000 }, { value: 5 }, { value: 1.2 },
    ] }],
    startDate: "2026-10-01T00:00:00.000Z", endDate: "2026-10-22T23:59:59.000Z", lastUpdatedDate: "2026-10-23T00:00:00.000Z",
  }, (url, init) => {
    assert.equal(init?.method, "GET");
    assert.equal(url.searchParams.get("dimension"), "LISTING");
    assert.equal(url.searchParams.get("filter"), "date_range:[2026-10-01T00:00:00.000+00:00..2026-10-24T00:00:00.000+00:00],listing_ids:{123}");
  }) });
  const row = result.get("123")!;
  assert.deepEqual([row.impressions, row.views, row.transactions, row.conversionRate, row.clickThroughRate], [1000, 40, 2, 5, 1.2]);
  assert.equal(row.windowEnd, "2026-10-22T23:59:59.000Z");
  assert.equal(row.lastUpdatedAt, "2026-10-23T00:00:00.000Z");
});
test("non-applicable, null, blank and malformed metrics stay unavailable; real zero survives", async () => {
  const result = await getTrafficReport({ accessToken: "test", listingIds: ["123"], start, end, fetcher: fixtureFetcher({
    header: { metrics: ["LISTING_IMPRESSION_TOTAL", "LISTING_VIEWS_TOTAL", "CLICK_THROUGH_RATE", "TRANSACTION", "SALES_CONVERSION_RATE"].map(key => ({ key })) },
    records: [{ dimensionValues: [{ value: "123" }], metricValues: [
      { value: 99, applicable: false }, { value: null }, { value: " " }, { value: "0", applicable: true }, { value: "unavailable" },
    ] }, { dimensionValues: [{ value: "456", applicable: false }], metricValues: [] }],
  }) });
  const row = result.get("123")!;
  assert.deepEqual([row.impressions, row.views, row.clickThroughRate, row.transactions, row.conversionRate], [null, null, null, 0, null]);
  assert.equal(row.lastUpdatedAt, null);
  assert.equal(result.has("456"), false);
});
test("unnamed values without a header are not guessed from request ordering", async () => {
  const result = await getTrafficReport({ accessToken: "test", listingIds: ["123"], start, end, fetcher: fixtureFetcher({ records: [{ dimensionValues: [{ value: "123" }], metricValues: [{ value: 50 }] }] }) });
  assert.equal(result.get("123")?.impressions, null);
});
