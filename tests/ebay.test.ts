import assert from "node:assert/strict";
import test from "node:test";
import { callTradingApi, EbayApiError, endFixedPriceListing, getActiveListings, getItem, getSellerList, getStoredToken, getValidAccessToken, isEbayQuotaError, isHardEbayAuthenticationError, isTransientEbayStatus, parseTotalPages, relistFixedPriceListing, reviseFixedPrice, reviseFixedPriceTitle, setStoredToken, verifyRelistFixedPriceListing } from "../lib/ebay.ts";
import { bulkCreateAdsByListingId } from "../lib/ebay-marketing.ts";

test("governed promoted-ad creation is fixed to a unique listing batch at exactly five percent", async () => {
  const calls: Array<{url:string;body:unknown}> = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({url:String(input),body:JSON.parse(String(init?.body))});
    return new Response(JSON.stringify({responses:[{listingId:"123",statusCode:201,adId:"ad-1",href:"/ad/ad-1"}]}),{status:200,headers:{"content-type":"application/json"}});
  };
  const result=await bulkCreateAdsByListingId("token","135950457010",["123"],"5.0",fetcher);
  assert.equal(result[0]?.adId,"ad-1");
  assert.deepEqual(calls[0]?.body,{requests:[{listingId:"123",bidPercentage:"5.0"}]});
  await assert.rejects(()=>bulkCreateAdsByListingId("token","135950457010",["123"],"6.0",fetcher),/5.0%/);
  await assert.rejects(()=>bulkCreateAdsByListingId("token","135950457010",["123","123"],"5.0",fetcher),/Invalid governed/);
});

test("pagination accepts bounded page counts and rejects malformed/runaway values", () => {
  assert.equal(parseTotalPages("3", "TestCall", 1), 3);
  assert.throws(() => parseTotalPages("not-a-number", "TestCall", 1), /malformed pagination/);
  assert.throws(() => parseTotalPages(501, "TestCall", 1), /safety limit/);
  assert.throws(() => parseTotalPages(1, "TestCall", 2), /moved backwards/);
});

test("provider quota failures latch across Trading and Browse error shapes", () => {
  assert.equal(isEbayQuotaError(new EbayApiError("BrowseGetItem", "limited", "429")), true);
  assert.equal(isEbayQuotaError(new Error("eBay Browse item lookup failed with HTTP 429: The request limit has been reached")), true);
  assert.equal(isEbayQuotaError(new Error("unrelated provider failure")), false);
});

test("retry policy is limited to transient HTTP statuses", () => {
  assert.equal(isTransientEbayStatus(429), true);
  assert.equal(isTransientEbayStatus(503), true);
  assert.equal(isTransientEbayStatus(400), false);
  assert.equal(isTransientEbayStatus(401), false);
});

test("hard Trading authentication failures latch the migration stop condition", () => {
  assert.equal(isHardEbayAuthenticationError(new EbayApiError("VerifyAddFixedPriceItem", "expired", "21917053")), true);
  assert.equal(isHardEbayAuthenticationError(new EbayApiError("GetMyeBaySelling", "hard expired", "932")), true);
  assert.equal(isHardEbayAuthenticationError(new Error("IAF token supplied is expired")), true);
  assert.equal(isHardEbayAuthenticationError(new EbayApiError("GetItem", "quota", "518")), false);
});

test("Trading API retries a transient response and then succeeds", async (t) => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls += 1;
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("X-EBAY-API-IAF-TOKEN"), "redacted-test-token");
    assert.equal(headers.has("X-EBAY-API-APP-NAME"), false);
    assert.equal(headers.has("X-EBAY-API-DEV-NAME"), false);
    assert.equal(headers.has("X-EBAY-API-CERT-NAME"), false);
    if (calls === 1) return new Response("temporary", { status: 503, headers: { "retry-after": "0" } });
    return new Response("<GetUserResponse><Ack>Success</Ack></GetUserResponse>", { status: 200 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  await callTradingApi({ callName: "GetUser", siteId: 0, accessToken: "redacted-test-token", xmlBody: "<GetUserRequest />" });
  assert.equal(calls, 2);
});

test("active listing pagination handles multiple pages exactly once", async (t) => {
  const originalFetch = globalThis.fetch;
  const requestedPages: number[] = [];
  globalThis.fetch = async (_url, init) => {
    const body = String(init?.body ?? "");
    const page = Number(body.match(/<PageNumber>(\d+)<\/PageNumber>/)?.[1] ?? 0);
    requestedPages.push(page);
    return new Response(`<GetMyeBaySellingResponse><Ack>Success</Ack><ActiveList><ItemArray><Item><ItemID>item-${page}</ItemID><Title>Card</Title><Quantity>1</Quantity><QuantityAvailable>1</QuantityAvailable><SellingStatus><CurrentPrice>10</CurrentPrice><QuantitySold>0</QuantitySold></SellingStatus></Item></ItemArray><PaginationResult><TotalNumberOfPages>2</TotalNumberOfPages></PaginationResult></ActiveList></GetMyeBaySellingResponse>`, { status: 200 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const ids: string[] = [];
  for await (const page of getActiveListings("redacted-test-token")) ids.push(...page.map((row) => String(row.ItemID)));
  assert.deepEqual(requestedPages, [1, 2]);
  assert.deepEqual(ids, ["item-1", "item-2"]);
});

test("seller-list enumeration returns authoritative category identifiers", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response(`<GetSellerListResponse><Ack>Success</Ack><ItemArray><Item><ItemID>123456789012</ItemID><Title>Card</Title><Quantity>1</Quantity><QuantityAvailable>1</QuantityAvailable><PrimaryCategory><CategoryID>261328</CategoryID></PrimaryCategory><SellingStatus><CurrentPrice>10</CurrentPrice><QuantitySold>0</QuantitySold></SellingStatus></Item></ItemArray><PaginationResult><TotalNumberOfPages>1</TotalNumberOfPages></PaginationResult></GetSellerListResponse>`);
  const pages = [];
  for await (const page of getSellerList("token", 0, { endFrom: new Date("2026-08-22T00:00:00Z"), endTo: new Date("2026-09-01T00:00:00Z") })) pages.push(...page);
  assert.equal(pages.length, 1);
  assert.equal(String(pages[0]?.PrimaryCategory?.CategoryID), "261328");
});

test("partial authoritative enumeration fails before reconciliation can proceed", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("<GetMyeBaySellingResponse><Ack>PartialSuccess</Ack><Errors><ErrorCode>1</ErrorCode><ShortMessage>partial</ShortMessage></Errors><ActiveList><PaginationResult><TotalNumberOfPages>1</TotalNumberOfPages></PaginationResult></ActiveList></GetMyeBaySellingResponse>", { status: 200 });
  t.after(() => { globalThis.fetch = originalFetch; });

  await assert.rejects(async () => {
    for await (const _page of getActiveListings("redacted-test-token")) {
      // A partial authoritative enumeration must never yield a reconcilable page.
    }
  }, /partial result/);
});

test("GetItem requires and preserves the exact numeric provider identity", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (_input, init) => {
    assert.match(String(init?.body), /<ItemID>1234567890<\/ItemID>/);
    return new Response("<GetItemResponse><Ack>Success</Ack><Item><ItemID>1234567890</ItemID><Title>Historical card</Title><Quantity>1</Quantity><QuantityAvailable>0</QuantityAvailable><SellingStatus><CurrentPrice>25</CurrentPrice><QuantitySold>1</QuantitySold></SellingStatus></Item></GetItemResponse>", { status: 200 });
  };
  assert.equal((await getItem("redacted-test-token", "1234567890")).ItemID, "1234567890");
  await assert.rejects(getItem("redacted-test-token", "not-an-item"), /numeric eBay ItemID/);
});

test("governed provider calls send only the explicitly approved field", async (t) => {
  const originalFetch=globalThis.fetch;const calls:Array<{name:string;body:string}>=[];t.after(()=>{globalThis.fetch=originalFetch;});
  globalThis.fetch=async(_input,init)=>{const headers=new Headers(init?.headers);const name=headers.get("X-EBAY-API-CALL-NAME")??"";const body=String(init?.body??"");calls.push({name,body});const response=name==="RelistFixedPriceItem"?"<RelistFixedPriceItemResponse><Ack>Success</Ack><ItemID>222222222222</ItemID></RelistFixedPriceItemResponse>":`<${name}Response><Ack>Success</Ack></${name}Response>`;return new Response(response,{status:200});};
  await reviseFixedPrice("redacted-test-token","111111111111",35,"price-key");
  await reviseFixedPriceTitle("redacted-test-token","111111111111","Ohtani & Trout","title-key");
  await endFixedPriceListing("redacted-test-token","111111111111","end-key");
  await verifyRelistFixedPriceListing("redacted-test-token","111111111111",3,"verify-key");
  assert.deepEqual(await relistFixedPriceListing("redacted-test-token","111111111111",3,"relist-key"),{oldItemId:"111111111111",newItemId:"222222222222",itemId:"111111111111",ack:"Success",warnings:[]});
  assert.match(calls[0].body,/<StartPrice>35\.00<\/StartPrice>/);assert.doesNotMatch(calls[0].body,/<Title>/);
  assert.match(calls[1].body,/<Title>Ohtani &amp; Trout<\/Title>/);assert.doesNotMatch(calls[1].body,/<StartPrice>/);
  assert.match(calls[2].body,/<EndingReason>NotAvailable<\/EndingReason>/);
  assert.match(calls[3].body,/<Quantity>3<\/Quantity>/);assert.match(calls[4].body,/<Quantity>3<\/Quantity>/);
  assert.deepEqual(calls.map(call=>call.name),["ReviseInventoryStatus","ReviseFixedPriceItem","EndFixedPriceItem","VerifyRelistItem","RelistFixedPriceItem"]);
});

test("token storage round-trips and malformed stored values fail closed", (t) => {
  const originalKey = process.env.TOKEN_ENCRYPTION_KEY;
  process.env.TOKEN_ENCRYPTION_KEY = "11".repeat(32);
  t.after(() => {
    if (originalKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = originalKey;
  });

  const stored = setStoredToken("redacted-test-token");
  assert.equal(getStoredToken(stored), "redacted-test-token");
  assert.equal(getStoredToken("malformed"), null);
  assert.throws(() => getStoredToken("00:bad-ciphertext"));
});

test("forced OAuth refresh replaces a provider-invalid token before its stored expiry",async(t)=>{const originalFetch=globalThis.fetch,originalKey=process.env.TOKEN_ENCRYPTION_KEY,originalId=process.env.EBAY_CLIENT_ID,originalSecret=process.env.EBAY_CLIENT_SECRET;process.env.TOKEN_ENCRYPTION_KEY="11".repeat(32);process.env.EBAY_CLIENT_ID="test-client";process.env.EBAY_CLIENT_SECRET="test-secret";t.after(()=>{globalThis.fetch=originalFetch;if(originalKey===undefined)delete process.env.TOKEN_ENCRYPTION_KEY;else process.env.TOKEN_ENCRYPTION_KEY=originalKey;if(originalId===undefined)delete process.env.EBAY_CLIENT_ID;else process.env.EBAY_CLIENT_ID=originalId;if(originalSecret===undefined)delete process.env.EBAY_CLIENT_SECRET;else process.env.EBAY_CLIENT_SECRET=originalSecret;});globalThis.fetch=async()=>new Response(JSON.stringify({access_token:"new-access",expires_in:7200,token_type:"Bearer"}),{status:200,headers:{"content-type":"application/json"}});const result=await getValidAccessToken({id:"store",oauthAccessToken:setStoredToken("old-access"),oauthRefreshToken:setStoredToken("refresh"),tokenExpiresAt:new Date(Date.now()+3600_000)},{forceRefresh:true});assert.equal(result.accessToken,"new-access");assert.equal(result.refreshToken,"refresh");});
