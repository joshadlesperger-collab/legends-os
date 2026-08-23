import assert from "node:assert/strict";
import test from "node:test";
import { enumerateSellerAuctionsEndingBefore, getEbayApplicationAccessToken, searchSellerAuctionsEnding } from "../lib/ebay-browse.ts";
import { classifySellerListing } from "../lib/seller-opportunity-domain.ts";

test("lot classification uses explicit context and preserves lot-number singles", () => {
  assert.deepEqual(classifySellerListing("25 Card Prizm Rookie Lot"), { kind: "lot", reason: "Explicit multi-card quantity", estimatedCards: 25 });
  assert.deepEqual(classifySellerListing("Alex Sarr X-Fractor 20 Cards Lots"), { kind: "lot", reason: "Explicit multi-card quantity", estimatedCards: 20 });
  assert.equal(classifySellerListing("LOT OF 10 Shohei Ohtani Inserts").kind, "lot");
  assert.equal(classifySellerListing("2024 Topps Chrome Lot #17 Elly De La Cruz RC").kind, "single");
  assert.equal(classifySellerListing("NOT A LOT 2023 Bowman Auto").kind, "single");
  assert.equal(classifySellerListing("2023 Prizm Victor Wembanyama Rookie Card").kind, "single");
});

test("active calendar-day enumeration uses the accepted upper-bound-only end filter", async (t) => {
  const originalFetch=globalThis.fetch;
  t.after(()=>{globalThis.fetch=originalFetch;});
  globalThis.fetch=async(input)=>{const url=new URL(String(input));assert.equal(url.searchParams.get("filter"),"sellers:{Letsgocardcn},buyingOptions:{AUCTION},itemEndDate:[..2026-08-22T05:00:00.000Z]");return new Response(JSON.stringify({total:1,offset:0,limit:200,itemSummaries:[{itemId:"v1|1|0",legacyItemId:"1",title:"Card",itemEndDate:"2026-08-22T01:00:00.000Z"}]}),{status:200});};
  const result=await enumerateSellerAuctionsEndingBefore("application-token","Letsgocardcn",["212"],new Date("2026-08-22T05:00:00.000Z"));
  assert.equal(result.reportedTotal,1);assert.equal(result.items.length,1);
});

test("Browse enumeration authenticates once and retrieves every seller auction page", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalId = process.env.EBAY_CLIENT_ID;
  const originalSecret = process.env.EBAY_CLIENT_SECRET;
  process.env.EBAY_CLIENT_ID = "test-client";
  process.env.EBAY_CLIENT_SECRET = "test-secret";
  const from = new Date("2026-08-21T12:00:00.000Z");
  const to = new Date("2026-08-22T12:00:00.000Z");
  const pages: number[] = [];
  t.after(() => { globalThis.fetch = originalFetch; if (originalId === undefined) delete process.env.EBAY_CLIENT_ID; else process.env.EBAY_CLIENT_ID = originalId; if (originalSecret === undefined) delete process.env.EBAY_CLIENT_SECRET; else process.env.EBAY_CLIENT_SECRET = originalSecret; });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/oauth2/token")) {
      assert.match(String(init?.body), /grant_type=client_credentials/);
      return new Response(JSON.stringify({ access_token: "application-token", expires_in: 7200 }), { status: 200 });
    }
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer application-token");
    assert.equal(new Headers(init?.headers).get("X-EBAY-C-MARKETPLACE-ID"), "EBAY_US");
    assert.equal(url.searchParams.get("category_ids"), "212");
    assert.equal(url.searchParams.has("q"), false);
    assert.match(url.searchParams.get("filter") ?? "", /sellers:\{Letsgocardcn\}/);
    assert.match(url.searchParams.get("filter") ?? "", /buyingOptions:\{AUCTION\}/);
    assert.match(url.searchParams.get("filter") ?? "", /itemEndDate:\[2026-08-21T12:00:00\.000Z\.\.2026-08-22T12:00:00\.000Z\]/);
    const offset = Number(url.searchParams.get("offset"));
    pages.push(offset);
    const item = { itemId: `v1|${offset + 1}|0`, legacyItemId: String(offset + 1), title: "Card", seller: { username: "Letsgocardcn" }, buyingOptions: ["AUCTION"], itemEndDate: "2026-08-21T18:00:00.000Z" };
    return new Response(JSON.stringify({ total: 2, offset, limit: 200, next: offset === 0 ? "next" : undefined, itemSummaries: [item] }), { status: 200 });
  };
  const ids: string[] = [];
  const token = await getEbayApplicationAccessToken();
  for await (const page of searchSellerAuctionsEnding(token, "Letsgocardcn", ["212"], from, to)) ids.push(...page.map((item) => String(item.legacyItemId)));
  assert.deepEqual(pages, [0, 1]);
  assert.deepEqual(ids, ["1", "2"]);
});
