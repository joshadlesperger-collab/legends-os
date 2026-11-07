import test from "node:test";
import { factualV2Description } from "../lib/card-processing-v2-description.ts";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { createDraftFeedClient, decodeV2DraftFeedResult, parseV2FeedCsv, assertV2DraftOnlyCsv, parseDraftFeedResults, uploadV2DraftIntents, V2_FEED_BASE, type DraftFeedBinding } from "../lib/card-processing-v2-uploader.ts";
import { readV2State, v2Dir, withV2State } from "../lib/card-processing-v2-store.ts";
import { consolidationKey, digest, preparePayload, searchableTitle, type V2Card, type V2Category } from "../lib/card-processing-v2.ts";
import { reconcileV2RejectedFeedForBrowser } from "../lib/card-processing-v2-uploader.ts";
import { beginV2Draft } from "../lib/card-processing-v2-draft-lifecycle.ts";

const csv = 'Action,Custom label (SKU),Title\r\nDraft,V2-one,Exact card\r\n';
const binding = (index: number): DraftFeedBinding => ({ key: digest(`key-${index}`), sku: `V2-${index}`, captureIds: [digest(`capture-${index}`)], lineNumber: index + 1 });
const report = (rows: string[]) => "Action,Status,DraftID,Line Number,CustomLabel,ErrorCode,WarningCode,ItemID\r\n" + rows.join("\r\n") + "\r\n";
const task = (taskId = "task-123", status = "COMPLETED") => ({ taskId, status, feedType: "FX_LISTING", schemaVersion: "1.0" });
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
type Request = { url: string; init: RequestInit };

test("the official feed client creates only FX_LISTING, uploads only Draft rows and polls the same task", async () => {
  const requests: Request[] = [];
  const fetcher = (async (url, init = {}) => {
    requests.push({ url: String(url), init });
    if (String(url).endsWith("/task")) return new Response(null, { status: 202, headers: { Location: `${V2_FEED_BASE}/task/task-123` } });
    if (String(url).endsWith("/upload_file")) return new Response(null, { status: 202 });
    if (String(url).endsWith("/download_result_file")) return new Response(report(["Draft,Success,5430000000001,2,V2-1,,," ]));
    return json(task());
  }) as typeof fetch;
  const client = createDraftFeedClient("synthetic-unit-test-token", fetcher), id = await client.createTask();
  assert.equal(id, "task-123"); await client.uploadFile(id, csv); assert.equal((await client.getTask(id)).taskId, id); await client.downloadResult(id);
  assert.deepEqual(requests.map(r => r.url), [`${V2_FEED_BASE}/task`, `${V2_FEED_BASE}/task/task-123/upload_file`, `${V2_FEED_BASE}/task/task-123`, `${V2_FEED_BASE}/task/task-123/download_result_file`]);
  assert.deepEqual(JSON.parse(String(requests[0].init.body)), { feedType: "FX_LISTING", schemaVersion: "1.0" });
  assert.deepEqual(requests.map(r => r.init.method ?? "GET"), ["POST", "POST", "GET", "GET"]);
  for (const request of requests) { assert.equal(request.init.redirect, "error"); assert.ok(request.init.signal); assert.equal(new Headers(request.init.headers).get("X-EBAY-C-MARKETPLACE-ID"), "EBAY_US"); }
  assert.ok(requests[1].init.body instanceof FormData);
  const file = (requests[1].init.body as FormData).get("file"); assert.ok(file instanceof Blob); assert.equal(await file.text(), csv);
});

test("feed requests never automatically retry HTTP or uncertain network mutations", async () => {
  for (const status of [401, 403, 429, 500]) {
    let calls = 0; const client = createDraftFeedClient("synthetic-token", (async () => { calls++; return new Response("untrusted external response", { status }); }) as typeof fetch);
    await assert.rejects(client.createTask(), new RegExp(`HTTP ${status}`)); assert.equal(calls, 1);
  }
  let calls = 0; const client = createDraftFeedClient("synthetic-token", (async () => { calls++; throw Error("untrusted exception details"); }) as typeof fetch);
  await assert.rejects(client.createTask(), error => error instanceof Error && /No automatic retry/.test(error.message) && !error.message.includes("untrusted exception"));
  assert.equal(calls, 1);
});

test("untrusted task locations, foreign task IDs and non-Draft actions stop before unsafe requests", async () => {
  for (const location of ["https://evil.example/task/123", `${V2_FEED_BASE}/task/123?redirect=1`, `${V2_FEED_BASE}/task/123#fragment`, "https://api.ebay.com/sell/inventory/v1/offer/123"]) {
    const client = createDraftFeedClient("synthetic-token", (async () => new Response(null, { status: 202, headers: { Location: location } })) as typeof fetch);
    await assert.rejects(client.createTask(), /Unexpected eBay task Location/);
  }
  let calls = 0; const client = createDraftFeedClient("synthetic-token", (async () => { calls++; return json(task("foreign-task")); }) as typeof fetch);
  await assert.rejects(client.getTask("task-123"), /foreign feed task/);
  for (const action of ["Add", "Revise", "Relist", "End"]) await assert.rejects(client.uploadFile("task-123", csv.replace("Draft,", `${action},`)), /Draft rows/);
  await assert.rejects(client.getTask("../escape")); assert.equal(calls, 1);
});

test("feed CSV parsing preserves quoted commas, quotes and exact physical line numbers", () => {
  const input = '\uFEFF#INFO,Template=test\r\nAction,CustomLabel,Description\r\nDraft,V2-one,"First line, comma\r\nSecond ""quoted"" line"\r\nDraft,V2-two,Plain text\r\n';
  const parsed = parseV2FeedCsv(input);
  assert.deepEqual(parsed.map(row => row.lineNumber), [1, 2, 3, 5]);
  assert.equal(parsed[2].cells[2], 'First line, comma\r\nSecond "quoted" line');
  const draft = assertV2DraftOnlyCsv(input); assert.deepEqual(draft.rows.map(row => row.lineNumber), [3, 5]);
  assert.throws(() => parseV2FeedCsv('Action,Title\nDraft,"unterminated'), /Unterminated/);
  assert.throws(() => parseV2FeedCsv('Action,Title\nDraft,"quoted"not-valid'), /Unexpected content/);
});

test("official csv.gz results decode within bounds without executing or extracting files", async () => {
  const result = report(["Draft,Success,5430000000001,2,V2-1,,,"]), compressed = gzipSync(result);
  assert.equal(decodeV2DraftFeedResult(compressed), result);
  assert.equal(decodeV2DraftFeedResult(Buffer.from(result)), result);
  assert.throws(() => decodeV2DraftFeedResult(Buffer.from([0x1f, 0x8b, 0, 1])), /Compressed feed result is invalid/);
  const client = createDraftFeedClient("synthetic-token", (async () => new Response(compressed, { headers: { "Content-Type": "application/octet-stream", "Content-Disposition": 'attachment; filename="result.csv.gz"' } })) as typeof fetch);
  assert.equal(await client.downloadResult("task-123"), result);
});

test("result mapping accepts observed blank CustomLabel with exact input lines and retains warnings", () => {
  const first = binding(1), second = binding(2); first.lineNumber = 5; second.lineNumber = 6;
  const rows = parseDraftFeedResults(report(["Draft,Success,5430000000001,5,,,21916626,", "Draft,Success,5430000000002,6,,,,"]), [first, second]);
  assert.equal(rows[0].key, first.key); assert.equal(rows[0].sku, first.sku); assert.equal(rows[0].draftId, "5430000000001"); assert.equal(rows[0].status, "success"); assert.equal(rows[0].warningCode, "21916626");
  assert.equal(rows[1].key, second.key);
});

test("mixed feed outcomes remain per-row; counts or missing IDs cannot prove creation", () => {
  const expected = [binding(1), binding(2), binding(3), binding(4)];
  const parsed = parseDraftFeedResults(report(["Draft,Success,5430000000001,2,V2-1,,,", "Draft,Failure,,3,V2-2,21900001,,", "Draft,Success,,4,V2-3,,,"]), expected);
  assert.deepEqual(parsed.map(row => row.status), ["success", "failed", "uncertain", "uncertain"]);
  assert.equal(parsed[3].errorCode, "MISSING_RESULT_ROW");
});

const sellerHubReport = (rows: string[]) => "LineNumber,DraftID,Title,Status,Link to complete draft,ErrorCode,ErrorMessage\r\n" + rows.join("\r\n") + "\r\n";
test("actual Seller Hub schema binds data ordinals to frozen input order despite metadata and empty error continuations", async () => {
  const expected = [binding(1), binding(2)].map((b, n) => ({ ...b, lineNumber: n + 3 }));
  const fixture = await fs.readFile(new URL("./fixtures/card-processing-v2-seller-hub-draft-result.csv", import.meta.url), "utf8");
  const result = parseDraftFeedResults(fixture, expected);
  assert.throws(() => parseDraftFeedResults(fixture, [...expected].reverse()), /ambiguous/);
  assert.deepEqual(result.map(r => [r.key, r.sku, r.lineNumber, r.status, r.draftId]), expected.map((b, n) => [b.key, b.sku, b.lineNumber, "success", `529000000000${n + 1}`]));
  assert.deepEqual(parseDraftFeedResults(sellerHubReport(["2,5290000000002,,SUCCESS,https://www.ebay.com/sl/list?mode=AddItem&draft_id=5290000000002,,", "1,5290000000001,,SUCCESS,https://www.ebay.com/sl/list?mode=AddItem&draft_id=5290000000001,,"]), expected).map(r => r.draftId), ["5290000000001", "5290000000002"]);
});
test("Seller Hub success needs exact Draft-only link, unique ordinal and unique DraftID", () => {
  const expected = [{ ...binding(1), lineNumber: 3 }, { ...binding(2), lineNumber: 4 }], row = "1,5290000000001,,SUCCESS,https://www.ebay.com/sl/list?mode=AddItem&draft_id=5290000000001,,";
  for (const bad of [
    row.replace("https:", "http:"), row.replace("www.ebay.com", "evil.example"), row.replace("mode=AddItem", "mode=ReviseItem"),
    row.replace("draft_id=5290000000001", "draft_id=5290000000002"), row.replace("draft_id=5290000000001", "draft_id=5290000000001&draft_id=5290000000001"),
    row.replace("draft_id=5290000000001", "draft_id=5290000000001&itemId=123"), row.replace("draft_id=5290000000001", "draft_id=5290000000001#fragment"),
  ]) assert.throws(() => parseDraftFeedResults(sellerHubReport([bad]), expected), /same draft ID/);
  assert.throws(() => parseDraftFeedResults(sellerHubReport([row, row]), expected), /duplicate/);
  assert.throws(() => parseDraftFeedResults(sellerHubReport([row, row.replace(/^1,/, "2,")]), expected), /same draft ID/);
  for (const ordinal of ["0", "01", "3", "1.0", "1e0"]) assert.throws(() => parseDraftFeedResults(sellerHubReport([row.replace(/^1,/, `${ordinal},`)]), expected), /row/);
  assert.throws(() => parseDraftFeedResults(sellerHubReport([row.slice(0, -1), "        ,not-empty"]), expected), /malformed/);
  assert.throws(() => parseDraftFeedResults(sellerHubReport([row, "        ,"]), expected), /malformed/);
});
test("Seller Hub missing IDs, non-success or error text never prove draft creation", () => {
  const expected = [{ ...binding(1), lineNumber: 3 }, { ...binding(2), lineNumber: 4 }];
  for (const row of ["1,,,SUCCESS,,,", "1,5290000000001,,SUCCESS,,,", "1,5290000000001,,SUCCESS,https://www.ebay.com/sl/list?mode=AddItem&draft_id=5290000000001,,Actual error", "1,5290000000001,,UNKNOWN,https://www.ebay.com/sl/list?mode=AddItem&draft_id=5290000000001,,"]) {
    const result = parseDraftFeedResults(sellerHubReport([row]), expected); assert.equal(result[0].status, "uncertain"); assert.equal(result[1].errorCode, "MISSING_RESULT_ROW");
  }
  const failed = parseDraftFeedResults(sellerHubReport(['1,,,FAILED,,21900001,"First error\r\nSecond error"']), expected);
  assert.equal(failed[0].status, "failed"); assert.equal(failed[0].errorCode, "21900001");
});

test("unknown/duplicate rows, conflicting SKUs, live item IDs and duplicate draft IDs cannot be mapped", () => {
  const expected = [binding(1), binding(2)];
  for (const rows of [
    ["Draft,Success,5430000000001,20,V2-1,,,"],
    ["Draft,Success,5430000000001,2,another-sku,,,"],
    ["Add,Success,5430000000001,2,V2-1,,,"],
    ["Draft,Success,5430000000001,2,V2-1,,,123456789"],
    ["Draft,Success,5430000000001,2,V2-1,,,", "Draft,Success,5430000000002,2,V2-1,,,"],
    ["Draft,Success,5430000000001,2,V2-1,,,", "Draft,Success,5430000000001,3,V2-2,,,"],
  ]) assert.throws(() => parseDraftFeedResults(report(rows), expected), /unknown|duplicate|non-Draft|same draft ID/);
  assert.throws(() => parseDraftFeedResults("Action,Status\r\nDraft,Success\r\n", expected), /required Draft/);
});

async function fixture<T>(run: (root: string, keys: string[]) => Promise<T>, count = 1) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "v2-uploader-"));
  try {
    const keys: string[] = []; await fs.mkdir(v2Dir(root), { recursive: true });
    const folder = path.join(root, "scans"); await fs.mkdir(folder);
    const category: V2Category = { categoryId: "261328", source: "synthetic category fixture", observedAt: new Date().toISOString(), requiredAspects: ["Sport", "Player/Athlete", "Card Number"], allowedValues: {}, conditionId: "4000", conditionDescriptorName: "Card Condition", conditionDescriptorValue: "400010", conditionLabel: "Near mint or better" };
    await fs.writeFile(path.join(v2Dir(root), "config.json"), JSON.stringify({ folder, categories: [category] }));
    await fs.mkdir(path.join(root, "artifacts/engineering-mission"), { recursive: true });
    await fs.writeFile(path.join(root, "artifacts/engineering-mission/work-queue.json"), JSON.stringify({ instructions: [{ id: "synthetic-v2-pilot", capturedAt: new Date(Date.now() - 1000).toISOString(), taskIds: ["card-processing-v2-live-validation-20261103"], policyRefs: ["card-processing-v2-draft-pilot"] }] }));
    await withV2State(s => { s.baseline = { initializedAt: new Date(Date.now() - 2000).toISOString(), paths: [], hashes: [], fileCount: 0 }; }, root);
    for (let n = 1; n <= count; n++) {
        const identity = { name: `Player ${n}`, year: "2025", manufacturer: "Topps", product: "Chrome", number: String(n), categoryId: "261328" as const, language: "English", variant: "Base", artwork: "Base portrait", sportOrGame: "Baseball", team: "", serial: "", graded: false, damage: false, specifics: {} };
        const photos: V2Card["photos"] = [];
        for (const side of ["front", "back"] as const) { const bytes = Buffer.from(`synthetic original ${n} ${side}`), filename = path.join(folder, `${n}-${side}.jpg`); await fs.writeFile(filename, bytes); photos.push({ path: filename, hash: createHash("sha256").update(bytes).digest("hex"), side }); }
        const at = new Date().toISOString(), card: V2Card = { id: `V2-${n}`, sku: `V2-${n}`, captureId: digest(`uploader-capture-${n}`), photos,
          stage: "prepared", identity, identification: { pairMatches: true, frontImageIndex: "0", upright: true, identity, warnings: [] }, condition: "Near mint or better", title: searchableTitle(identity), description: factualV2Description(identity), descriptionSource: "factual", issues: [], nextAction: "Upload bound intent once", createdAt: at, updatedAt: at };
        card.groupId = consolidationKey(card);
        const hosted = card.photos.map(photo => ({ hash: photo.hash, url: `https://i.ebayimg.com/${photo.hash}.jpg`, expiresAt: new Date(Date.now() + 3 * 86400000).toISOString(), upright: true as const }));
        const payload = preparePayload(card, [card], category, hosted);
        await withV2State(s => { s.cards[card.id] = card; for (const photo of hosted) s.media[photo.hash] = photo; }, root);
        const body = { seller: "imaydit58", observedAt: new Date().toISOString(), source: "live-seller-read", scopes: { drafts: true, active: true, sold: true, scheduled: true }, captures: [{ captureId: card.captureId, sku: card.sku, disposition: "absent" }],
          expectedPolicies: { payment: "Synthetic established payment policy", returns: "No Return Accepted", shipping: null, location: "Synthetic established location", pricingShippingUnresolved: true } };
        const relative = `artifacts/card-processing-v2/reconciliation-${n}.json`, bytes = JSON.stringify(body); await fs.writeFile(path.join(root, relative), bytes);
        const reconciliation = { ...body, evidence: { path: relative, sha256: createHash("sha256").update(bytes).digest("hex") } };
        keys.push(await beginV2Draft(root, card.groupId!, payload, reconciliation, { pilot: { instructionId: "synthetic-v2-pilot", captureIds: payload.captureIds, expiresAt: new Date(Date.now() + 1800000).toISOString() } }));
    }
    return await run(root, keys);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
async function journal(root: string) {
  const folder = path.join(v2Dir(root), "uploads"), names = (await fs.readdir(folder)).filter(name => /^[a-f0-9]{64}\.json$/.test(name));
  assert.equal(names.length, 1); return JSON.parse(await fs.readFile(path.join(folder, names[0]), "utf8"));
}

test("the coordinator persists intent stages before network mutations and never calls import success verified", async () => fixture(async (root, keys) => {
  const requests: Request[] = [];
  const fetcher = (async (url, init = {}) => {
    const endpoint = String(url); requests.push({ url: endpoint, init }); const checkpoint = await journal(root);
    if (endpoint.endsWith("/task")) { assert.equal(checkpoint.status, "create-requested"); return new Response(null, { status: 202, headers: { Location: `${V2_FEED_BASE}/task/task-123` } }); }
    if (endpoint.endsWith("/upload_file")) { assert.equal(checkpoint.status, "upload-requested"); assert.equal(checkpoint.taskId, "task-123"); return new Response(null, { status: 202 }); }
    if (endpoint.endsWith("/download_result_file")) return new Response(report(["Draft,Success,5430000000001,2,V2-1,,,"]));
    return json(task());
  }) as typeof fetch;
  const result = await uploadV2DraftIntents(root, keys, { getAccessToken: async () => "synthetic-token", fetcher, maxPolls: 1, pollDelayMs: 0 });
  assert.equal(result.verified, false); assert.equal(result.canPublish, false); assert.equal(result.rows[0].draftId, "5430000000001");
  const state = await readV2State(root); assert.equal(state.submissions[keys[0]].status, "submitted"); assert.equal(state.cards["V2-1"].draftId, "5430000000001"); assert.notEqual(state.cards["V2-1"].stage, "verified");
  assert.equal(requests.filter(request => request.init.method === "POST").length, 2);
}));

test("an uncertain task creation is retained and cannot repeat POST on restart", async () => fixture(async (root, keys) => {
  let calls = 0; const deps = { getAccessToken: async () => "synthetic-token", fetcher: (async () => { calls++; throw Error("synthetic network uncertainty"); }) as typeof fetch, maxPolls: 1, pollDelayMs: 0 };
  await assert.rejects(uploadV2DraftIntents(root, keys, deps), /confirmed result/);
  assert.equal((await journal(root)).status, "uncertain");
  await assert.rejects(uploadV2DraftIntents(root, keys, deps), /Task creation outcome is uncertain/);
  assert.equal(calls, 1);
}));

test("an uncertain upload resumes the retained same task using GET only", async () => fixture(async (root, keys) => {
  let createCalls = 0, uploadCalls = 0, reads = 0;
  const fetcher = (async (url, init = {}) => {
    if (String(url).endsWith("/task")) { createCalls++; return new Response(null, { status: 202, headers: { Location: `${V2_FEED_BASE}/task/task-123` } }); }
    if (String(url).endsWith("/upload_file")) { uploadCalls++; throw Error("synthetic uncertain file upload"); }
    assert.equal(init.method ?? "GET", "GET"); reads++;
    if (String(url).endsWith("/download_result_file")) return new Response(report(["Draft,Success,5430000000001,2,V2-1,,,"]));
    return json(task());
  }) as typeof fetch;
  const deps = { getAccessToken: async () => "synthetic-token", fetcher, maxPolls: 1, pollDelayMs: 0 };
  await assert.rejects(uploadV2DraftIntents(root, keys, deps), /confirmed result/);
  const result = await uploadV2DraftIntents(root, keys, deps);
  assert.equal(createCalls, 1); assert.equal(uploadCalls, 1); assert.equal(reads, 2); assert.equal(result.rows[0].status, "success");
  await uploadV2DraftIntents(root, keys, deps); assert.equal(createCalls, 1); assert.equal(uploadCalls, 1); assert.equal(reads, 2, "completed retained results replay locally instead of requesting another upload");
}));

test("missing seller OAuth access records no network request and leaves prepared upload evidence", async () => fixture(async (root, keys) => {
  let calls = 0;
  await assert.rejects(uploadV2DraftIntents(root, keys, { getAccessToken: async () => { throw Error("synthetic missing connection"); }, fetcher: (async () => { calls++; throw Error("must not run"); }) as typeof fetch }), /OAuth connection is unavailable/);
  assert.equal(calls, 0); assert.equal((await journal(root)).status, "prepared");
}));

test("reordered or subset requests cannot create another batch after an uncertain upload", async () => fixture(async (root, keys) => {
  let creates = 0, uploads = 0, reads = 0;
  const fetcher = (async (url, init = {}) => {
    if (String(url).endsWith("/task")) { creates++; return new Response(null, { status: 202, headers: { Location: `${V2_FEED_BASE}/task/task-pending` } }); }
    if (String(url).endsWith("/upload_file")) { uploads++; throw Error("synthetic uncertain upload"); }
    assert.equal(init.method ?? "GET", "GET"); reads++; return json(task("task-pending", "QUEUED"));
  }) as typeof fetch;
  const deps = { getAccessToken: async () => "synthetic-token", fetcher, maxPolls: 1, pollDelayMs: 0 };
  await assert.rejects(uploadV2DraftIntents(root, keys, deps), /confirmed result/);
  await uploadV2DraftIntents(root, [...keys].reverse(), deps);
  await assert.rejects(uploadV2DraftIntents(root, [keys[0]], deps), /overlapping captures|another upload batch/);
  assert.equal(creates, 1); assert.equal(uploads, 1); assert.equal(reads, 1); assert.equal((await journal(root)).taskId, "task-pending");
}, 2));

test("partial success retains each exact ID and replay never reuploads failed or missing rows", async () => fixture(async (root, keys) => {
  let creates = 0, uploads = 0;
  const fetcher = (async url => {
    if (String(url).endsWith("/task")) { creates++; return new Response(null, { status: 202, headers: { Location: `${V2_FEED_BASE}/task/task-mixed` } }); }
    if (String(url).endsWith("/upload_file")) { uploads++; return new Response(null, { status: 202 }); }
    if (String(url).endsWith("/download_result_file")) {
      const checkpoint = await journal(root);
      return new Response(report(checkpoint.bindings.map((b: DraftFeedBinding, index: number) => `Draft,${index ? "Failure" : "Success"},${index ? "" : "5430000000001"},${b.lineNumber},${b.sku},${index ? "21900001" : ""},,`)));
    }
    return json(task("task-mixed"));
  }) as typeof fetch;
  const deps = { getAccessToken: async () => "synthetic-token", fetcher, maxPolls: 1, pollDelayMs: 0 };
  const result = await uploadV2DraftIntents(root, keys, deps); assert.deepEqual(result.rows.map(r => r.status), ["success", "failed"]);
  const state = await readV2State(root); assert.equal(state.submissions[result.rows[0].key].draftId, "5430000000001"); assert.equal(state.submissions[result.rows[1].key].status, "uncertain");
  await uploadV2DraftIntents(root, keys, deps); assert.equal(creates, 1); assert.equal(uploads, 1);
  assert.ok(Object.values((await readV2State(root)).cards).every(c => c.stage !== "verified"));
}, 2));

test("a post-begin seller hold prevents any new external create or upload", async () => fixture(async (root, keys) => {
  await withV2State(s => { const c = s.cards["V2-1"]; c.issues.push({ code: "SELLER_HOLD", detail: "Retain seller hold", owner: "Seller" }); c.stage = "exception"; }, root);
  let calls = 0;
  await assert.rejects(uploadV2DraftIntents(root, keys, { getAccessToken: async () => "synthetic-token", fetcher: (async () => { calls++; throw Error("must not run"); }) as typeof fetch }), /unheld prepared/);
  assert.equal(calls, 0); assert.equal((await journal(root)).status, "prepared");
  assert.ok((await readV2State(root)).cards["V2-1"].issues.some(i => i.code === "SELLER_HOLD"));
}));

test("changed original bytes stop a new upload before any external mutation", async () => fixture(async (root, keys) => {
  const photo = (await readV2State(root)).cards["V2-1"].photos[0]; await fs.appendFile(photo.path, "changed after begin");
  let calls = 0;
  await assert.rejects(uploadV2DraftIntents(root, keys, { getAccessToken: async () => "synthetic-token", fetcher: (async () => { calls++; throw Error("must not run"); }) as typeof fetch }), /photo changed/);
  assert.equal(calls, 0); assert.equal((await journal(root)).status, "prepared");
}));

test("old retained intent clearance cannot become fresh merely by creating a new journal", async () => fixture(async (root, keys) => {
  const state = await readV2State(root), intent = state.events.find(e => e.stage === "draft-intent")!;
  const filename = path.join(root, intent.detail.split("#sha256=")[0]), begin = JSON.parse(await fs.readFile(filename, "utf8"));
  begin.at = new Date(Date.now() - 61 * 60000).toISOString(); begin.reconciliation.observedAt = begin.at;
  const bytes = JSON.stringify(begin); await fs.writeFile(filename, bytes);
  const updatedReference = intent.detail.split("#sha256=")[0] + "#sha256=" + createHash("sha256").update(bytes).digest("hex");
  await withV2State(s => { s.events.find(e => e.stage === "draft-intent")!.detail = updatedReference; s.submissions[keys[0]].evidence = updatedReference; }, root);
  let calls = 0;
  await assert.rejects(uploadV2DraftIntents(root, keys, { getAccessToken: async () => "synthetic-token", fetcher: (async () => { calls++; throw Error("must not run"); }) as typeof fetch }), /Fresh exact seller observation/);
  assert.equal(calls, 0); assert.equal((await journal(root)).status, "prepared");
}));

test("a hold arriving after empty task creation still prevents the file upload", async () => fixture(async (root, keys) => {
  let creates = 0, uploads = 0;
  const fetcher = (async url => {
    if (String(url).endsWith("/task")) {
      creates++; await withV2State(s => { s.cards["V2-1"].issues.push({ code: "SELLER_HOLD", detail: "Preserve late seller hold", owner: "Seller" }); }, root);
      return new Response(null, { status: 202, headers: { Location: `${V2_FEED_BASE}/task/task-held` } });
    }
    uploads++; throw Error("must not upload");
  }) as typeof fetch;
  await assert.rejects(uploadV2DraftIntents(root, keys, { getAccessToken: async () => "synthetic-token", fetcher }), /unheld prepared/);
  assert.equal(creates, 1); assert.equal(uploads, 0); assert.equal((await journal(root)).status, "task-created"); assert.equal((await journal(root)).taskId, "task-held");
}));


test("actual failure-only Feed shape needs no DraftID but unknown/success rows never prove rejection", () => {
 const expected=[binding(1)];
 const result="Line Number,Action,Status,ErrorCode,ErrorMessage,ItemID,ReferenceID,CustomLabel\n2,Draft,Failure,BAF.Error.5,Unable to find Task Action Id for task Draft,,,V2-1\n";
 assert.equal(parseDraftFeedResults(result,expected)[0].status,"failed");
 assert.equal(parseDraftFeedResults(result.replace(',Failure,',',Unknown,'),expected)[0].status,"uncertain");
 assert.equal(parseDraftFeedResults(result.replace(',Failure,',',Success,'),expected)[0].status,"uncertain");
 assert.throws(()=>parseDraftFeedResults(result.replace(',,,V2-1',',,123,V2-1'),expected),/non-Draft/);
});

test("raw malformed result is retained before parsing and cannot trigger POST replay", async()=>fixture(async(root,keys)=>{
 let posts=0;
 const fetcher=(async(url,init={})=>{if(init.method==='POST'){posts++;return new Response(null,{status:202,headers:String(url).endsWith('/task')?{Location:`${V2_FEED_BASE}/task/task-123`}:{}});}return String(url).endsWith('/download_result_file')?new Response('unsupported result header'):json(task());}) as typeof fetch;
 await assert.rejects(uploadV2DraftIntents(root,keys,{getAccessToken:async()=> 'synthetic-token',fetcher,maxPolls:1,pollDelayMs:0}),/required Draft/);
 const checkpoint=await journal(root);assert.equal(await fs.readFile(path.join(root,checkpoint.resultPath),'utf8'),'unsupported result header');assert.ok(checkpoint.resultHash);assert.equal(posts,2);
}));

test("proven exact rejection yields same-intent browser handoff and permanently fences API retry", async()=>fixture(async(root,keys)=>{
 const rejected="Line Number,Action,Status,ErrorCode,ErrorMessage,ItemID,ReferenceID,CustomLabel\n2,Draft,Failure,BAF.Error.5,Unable to find Task Action Id for task Draft,,,V2-1\n";
 const terminal={...task('task-123','COMPLETED_WITH_ERROR'),uploadSummary:{successCount:0,failureCount:1}};
 const fetcher=(async(url,init={})=>{if(init.method==='POST')return new Response(null,{status:202,headers:String(url).endsWith('/task')?{Location:`${V2_FEED_BASE}/task/task-123`}:{}});return String(url).endsWith('/download_result_file')?new Response(rejected):json(terminal);}) as typeof fetch;
 const uploaded=await uploadV2DraftIntents(root,keys,{getAccessToken:async()=> 'synthetic-token',fetcher,maxPolls:1,pollDelayMs:0});assert.equal(uploaded.rows[0].status,'failed');
 async function evidence(name:string,value:unknown){const relative=`artifacts/${name}.json`,bytes=JSON.stringify(value);await fs.writeFile(path.join(root,relative),bytes);return{path:relative,sha256:createHash('sha256').update(bytes).digest('hex')};}
 const checkpoint=await journal(root), result={path:checkpoint.resultPath,sha256:checkpoint.resultHash}, taskRef=await evidence('task-result',terminal),drafts=await evidence('drafts-empty',{kind:'live-seller-drafts-empty',seller:'imaydit58',source:'live-seller-read',observedAt:new Date().toISOString(),draftCount:0});
 await assert.rejects(reconcileV2RejectedFeedForBrowser(root,uploaded.journalPath,{result:{...result,sha256:'0'.repeat(64)},task:taskRef,drafts}),/hash mismatch/);
 const wrongTask=await evidence('wrong-task',{...terminal,taskId:'foreign'});await assert.rejects(reconcileV2RejectedFeedForBrowser(root,uploaded.journalPath,{result,task:wrongTask,drafts}),/Same-task/);
 const stale=await evidence('stale-drafts',{kind:'live-seller-drafts-empty',seller:'imaydit58',source:'live-seller-read',observedAt:new Date(Date.now()-61*60000).toISOString(),draftCount:0});await assert.rejects(reconcileV2RejectedFeedForBrowser(root,uploaded.journalPath,{result,task:taskRef,drafts:stale}),/Fresh/);
 const before=await readV2State(root),handoff=await reconcileV2RejectedFeedForBrowser(root,uploaded.journalPath,{result,task:taskRef,drafts});assert.deepEqual(handoff.keys,keys);assert.equal(handoff.newIntents,0);assert.equal(handoff.canPublish,false);assert.deepEqual(await readV2State(root),before);
 let network=0;await assert.rejects(uploadV2DraftIntents(root,keys,{getAccessToken:async()=>{network++;return 'synthetic';},fetcher}),/browser handoff/);assert.equal(network,0);
}));


test("production default capability gate stops before OAuth or any new API mutation", async()=>fixture(async(root,keys)=>{
 let tokens=0;await assert.rejects(uploadV2DraftIntents(root,keys,{getAccessToken:async()=>{tokens++;throw Error('must not load OAuth');}}),/capability is unvalidated/);
 assert.equal(tokens,0);assert.equal((await journal(root)).status,'prepared');assert.equal((await readV2State(root)).submissions[keys[0]].status,'intent');
}));
