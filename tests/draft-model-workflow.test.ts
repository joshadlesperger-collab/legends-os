import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { newQueue, upsertCard, claimJob, completeJob, type Identity, type QueueState } from "../lib/card-orchestrator.ts";
import { draftBinding, configureDraftWriter, claimDraftWriter, observeDraft, verifyDraft } from "../lib/card-draft-lifecycle.ts";
import { withQueue, readQueue } from "../lib/card-orchestrator-store.ts";
import { flowPacket } from "../lib/card-orchestrator-flow.ts";
import { admitDraftModelWorkflow, claimDraftModelStage, completeDraftModelStage, authorizeDraftModelPrice, draftModelStatus, beginDraftModelSave, finishDraftModelSave, type ModelFinding } from "../lib/draft-model-workflow.ts";
import { runDraftModelStage } from "../lib/draft-model-runner.ts";

const now = "2026-10-30T23:00:00.000Z";
const identity: Identity = { player: "Player", season: "2025", set: "Prizm", manufacturer: "Panini", cardNumber: "1", sport: "Basketball", team: "Team", parallel: "Base", serial: "", printRun: null, condition: "Near mint or better", autograph: false, patch: false };
const price = (item: number) => ({ item, shipping: 0, buyerTotal: item });
function fixture() {
  const s = newQueue();
  upsertCard(s, { id: "one", sku: "capture-one", identity, photos: [{ side: "front", path: "front.jpg", sha256: "a".repeat(64) }, { side: "back", path: "back.jpg", sha256: "b".repeat(64) }], source: "scanner-intake:test", candidates: [] }, now);
  for (const kind of ["photos", "identity"] as const) {
    const c = claimJob(s, "reviewer", kind, "one", now)!;
    completeJob(s, "one", kind, c.job.lease!.token, { outcome: "done", data: kind === "photos" ? { hashes: s.cards.one.input.photos.map(({ side, sha256 }) => ({ side, sha256 })), evidence: "originals read" } : { identity, pairMatches: true, frontFirst: true, serialInspected: true, evidence: "reviewed original pair" } }, now);
  }
  configureDraftWriter(s, "writer", ["one"], "Existing competing schedules paused", now);
  observeDraft(s, { observationId: "00000000-0000-4000-8000-000000000001", seller: "imaydit58", cardId: "one", sku: "capture-one", binding: draftBinding(s.cards.one), draftId: "123456789012", state: "saved", url: "https://www.ebay.com/sl/list?draft_id=123456789012", observedAt: now, evidence: "Exact draft observed" }, now);
  s.cards.one.draftLifecycle!.unpricedVerification = { binding: draftBinding(s.cards.one), draftId: "123456789012", at: now, evidence: "fixture saved blank draft and pair verified", canPublish: false };
  const token = claimDraftWriter(s, "writer", undefined, now).lease!.token;
  const comp = { saleId: "sale1", sourceUrl: "https://www.ebay.com/itm/111111111111", soldDate: "2026-10-25", itemPrice: 1.49, shipping: 0, currency: "USD", identity, serialObserved: false, priceDisclosed: true, ownAcquisition: false, graded: false, lot: false, condition: "Near mint or better", evidenceMode: "original-sale", evidence: "Verified exact sold item" };
  const input = { basis: "exact", comps: [comp], evidence: "Retained exact sale evidence", sourceChecks: { active: { status: "no-match", evidence: "Saved active report checked" }, sold: { status: "match", evidence: "Seller sold history checked" }, knowledge: { status: "no-match", evidence: "Local validated knowledge checked" } }, shipping: 0, shippingEvidence: "Verified free eligible shipping", shippingVerifiedAt: now, currentPrice: null, priceObservedAt: now, priceEvidence: "Saved draft blank price field" };
  return { s, input, token };
}
function admit(f = fixture()) { admitDraftModelWorkflow(f.s, "one", f.input, null, null, now); return f; }
function result(s: QueueState, role: "proposal" | "muse" | "baxter", finding: ModelFinding = { decision: "accept", price: price(1.49), rationale: "Evidence supports current price" }) {
  const c = claimDraftModelStage(s, "one", role, role, null, null, now);
  if (role === "baxter") s.baxterReviewConnection = { identity: "Baxter fixture", resultSource: "verified-dot-session-fixture", verifiedAt: now, evidence: "offline fixture only" };
  return completeDraftModelStage(s, "one", role, c.claim.token, finding, { provider: role === "proposal" ? "xai" : role === "muse" ? "meta" : "external-dot", model: role === "baxter" ? "Baxter fixture" : "fixture", source: role === "baxter" ? "verified-dot-session-fixture" : "fixture", workflowKey: c.key, proposalKey: s.draftModelWorkflows!.one.results.proposal?.key }, null, null, now);
}
function reviewed() { const f = admit(); for (const r of ["proposal", "muse", "baxter"] as const) result(f.s, r); return f; }
test("existing unpriced draft admission and replay retain one bound workflow", () => {
  const f = admit(), first = f.s.draftModelWorkflows!.one;
  assert.equal(admitDraftModelWorkflow(f.s, "one", f.input, null, null, now), first);
  assert.equal(draftModelStatus(f.s, "one", null, null, now).stage, "grok_pricing_pending");
  assert.equal(first.draftId, "123456789012");
});
test("both independent reviews required; OpenAI cannot impersonate Baxter", () => {
  const { s } = admit(); result(s, "proposal"); result(s, "muse");
  assert.equal(draftModelStatus(s, "one", null, null, now).stage, "waiting_for_baxter");
  assert.throws(() => authorizeDraftModelPrice(s, "one", null, null, now), /Both independent/);
  const c = claimDraftModelStage(s, "one", "baxter", "worker", null, null, now);
  assert.throws(() => completeDraftModelStage(s, "one", "baxter", c.claim.token, { decision: "accept", price: price(1.49), rationale: "Looks fair" }, { provider: "openai", model: "gpt", source: "api", workflowKey: c.key, proposalKey: s.draftModelWorkflows!.one.results.proposal!.key }, null, null, now), /Distinct routed/);
  assert.throws(() => completeDraftModelStage(s, "one", "baxter", c.claim.token, { decision: "accept", price: price(1.49), rationale: "Looks fair" }, { provider: "external-dot", model: "Baxter", source: "unverified", workflowKey: c.key, proposalKey: s.draftModelWorkflows!.one.results.proposal!.key }, null, null, now), /return path unavailable/);
});
test("stale review, duplicate claim and altered identity are fenced", () => {
  const { s } = admit(); result(s, "proposal");
  const c = claimDraftModelStage(s, "one", "muse", "muse", null, null, now);
  assert.throws(() => claimDraftModelStage(s, "one", "muse", "other", null, null, now), /Prior claim/);
  assert.throws(() => completeDraftModelStage(s, "one", "muse", c.claim.token, { decision: "accept", price: price(1.49), rationale: "Fair" }, { provider: "meta", model: "muse", source: "fixture", workflowKey: c.key, proposalKey: "old" }, null, null, now), /Stale\/mismatched/);
  s.cards.one.input.photos[0].sha256 = "d".repeat(64);
  assert.equal(draftModelStatus(s, "one", null, null, now).stage, "held");
});
test("evidence-backed increase is authorized after both reviews without seller approval", () => {
  const f = fixture(); f.input.comps[0].itemPrice = 2.49; admit(f);
  result(f.s, "proposal"); result(f.s, "muse", { decision: "increase", price: price(2.49), rationale: "Exact comparable supports 2.49" }); result(f.s, "baxter");
  const a = authorizeDraftModelPrice(f.s, "one", null, null, now);
  assert.equal(a.price.item, 2.49); assert.equal(authorizeDraftModelPrice(f.s, "one", null, null, now), a);
  const packet = flowPacket(f.s, ["one"], now).cards[0];
  assert.equal(packet.pricing.draftProposal?.item, 2.49); assert.equal(packet.pricing.approved, false);
});
test("unsupported agreement, conflict, explicit hold, stale evidence and downward changes fail closed", () => {
  const f = reviewed(); f.s.draftModelWorkflows!.one.input.comps = [{ ...f.input.comps[0], itemPrice: 10 }];
  assert.throws(() => authorizeDraftModelPrice(f.s, "one", null, null, now), /validated comparable/);
  const conflict = admit(); result(conflict.s, "proposal"); result(conflict.s, "muse", { decision: "increase", price: price(2.49), rationale: "Higher" }); result(conflict.s, "baxter", { decision: "increase", price: price(3.49), rationale: "Different" });
  assert.throws(() => authorizeDraftModelPrice(conflict.s, "one", null, null, now), /Conflicting/);
  const held = admit(); result(held.s, "proposal"); result(held.s, "muse", { decision: "hold", price: null, rationale: "Insufficient evidence" }); result(held.s, "baxter");
  assert.throws(() => authorizeDraftModelPrice(held.s, "one", null, null, now), /Reviewer hold/);
  assert.equal(draftModelStatus(held.s, "one", "seller hold", null, now).stage, "held");
  assert.equal(draftModelStatus(held.s, "one", null, null, "2027-02-01T00:00:00.000Z").stage, "held");
  const lower = reviewed(); lower.s.draftModelWorkflows!.one.input.currentPrice = price(3.49);
  assert.throws(() => authorizeDraftModelPrice(lower.s, "one", null, null, now), /downward/);
});
test("unknown shipping and shared draft groups require reconciliation", () => {
  const f = fixture(); const unknown = { ...f.input, comps: [{ ...f.input.comps[0], shipping: null }] };
  assert.throws(() => admitDraftModelWorkflow(f.s, "one", unknown, null, null, now), /shipping/);
  f.s.cards.two = structuredClone(f.s.cards.one); f.s.cards.two.input.id = "two";
  assert.throws(() => admitDraftModelWorkflow(f.s, "one", f.input, null, null, now), /Shared draft|conflict/i);
});
test("writer intent survives restart; retries reconcile instead of applying twice", async () => {
  const f = reviewed(); authorizeDraftModelPrice(f.s, "one", null, null, now);
  assert.throws(() => beginDraftModelSave(f.s, "one", "other", f.token, null, null, now), /writer|lease/i);
  const first = beginDraftModelSave(f.s, "one", "writer", f.token, null, null, now);
  assert.equal(first.action, "edit-same-draft");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "model-draft-"));
  try {
    await withQueue(dir, s => Object.assign(s, f.s));
    const restored = await readQueue(dir), retry = beginDraftModelSave(restored, "one", "writer", f.token, null, null, now);
    assert.equal(retry.operationId, first.operationId); assert.equal(retry.action, "reconcile-same-draft");
    assert.throws(() => finishDraftModelSave(restored, "one", "writer", f.token, null, null, now), /incomplete/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test("missing budget sends no calls; OpenAI and Baxter API stage requests are rejected", async () => {
  const { s } = admit(); let calls = 0;
  const transaction = async <T>(fn: (state: QueueState, ctx: {}) => T) => fn(s, {});
  const generate = async () => { calls++; return { finding: {}, inputTokens: 1, outputTokens: 1 }; };
  await assert.rejects(runDraftModelStage("one", "proposal", "worker", transaction, generate), /spending authorization/);
  await assert.rejects(runDraftModelStage("one", "baxter" as "muse", "worker", transaction, generate), /external Dot/);
  assert.equal(calls, 0); assert.equal(s.draftModelWorkflows!.one.claims.proposal, undefined);
});


test("full saved/reopened checker closes only the authorized same-draft write", () => {
  const f = reviewed(); authorizeDraftModelPrice(f.s, "one", null, null, now);
  beginDraftModelSave(f.s, "one", "writer", f.token, null, null, now);
  const expected = { draftId: "123456789012", sku: "capture-one", title: "Card", quantity: 1, item: 1.49, shipping: 0, offersEnabled: false, condition: "Near mint or better", specifics: {}, policies: { shipping: "111111111111", payment: "222222222222", returns: "333333333333" }, originalHashes: ["a".repeat(64), "b".repeat(64)], general: false, priority: false };
  const url = "https://www.ebay.com/lstng?draftId=123456789012";
  const ax = `Browser tab: 1, URL: "${url}".
1 text field (settable) Item title, Value: Card, ID: title
2 text field (settable) Custom label (SKU), Value: capture-one, ID: sku
3 text field (settable) Item price, Value: 1.49, ID: item
4 text field (settable) Quantity, Value: 1, ID: qty
5 switch (settable) Description: Allow offers, Value: 0
6 switch (settable) Description: Toggle General, Value: 0
7 switch (settable) Description: Toggle Priority, Value: 0
8 combo box (settable) Shipping policy, Value: Free (111111111111)
9 combo box (settable) Payment policy, Value: Managed (222222222222)
10 text Return policy : No returns (333333333333)
11 pop up button Format Buy It Now,
12 pop up button Condition type Ungraded: Not graded
13 pop up button Card Condition Near mint or better: Pack fresh
14 text 2 out of 25 photos or videos uploaded`;
  const at = (seconds: number) => new Date(Date.parse(now) + seconds * 1000).toISOString();
  const capture = { url, ax, savedAt: at(1), reopenedAt: at(10), capturedAt: at(15), shipping: { amount: 0, policyId: expected.policies.shipping, evidence: "Policy inspected" }, issues: { inspected: true as const, errors: [], evidence: "Issue summary inspected" }, visual: { draftId: expected.draftId, originalHashes: expected.originalHashes, screenshotSha256: "c".repeat(64), frontMain: true as const, backSecond: true as const, upright: true as const, identityMatches: true as const, reviewedAt: at(16), evidence: "Saved photos compared with originals" } };
  const checked = verifyDraft(f.s, "one", expected, capture, { approved: false, draftAuthorized: true, price: { item: 1.49, shipping: 0 } }, "fixture saved/reopened evidence", at(20));
  assert.equal(checked.allChecksPassed, true);
  const saved = finishDraftModelSave(f.s, "one", "writer", f.token, null, null, at(20));
  assert.equal(draftModelStatus(f.s, "one", null, null, at(20)).stage, "draft_price_saved_verified");
  assert.equal(finishDraftModelSave(f.s, "one", "writer", f.token, null, null, at(20)), saved);
  assert.throws(() => beginDraftModelSave(f.s, "one", "writer", f.token, null, null, at(20)), /unfinished/);
});

test("bounded runner reserves before generation, settles once, and refuses replay", async () => {
  // Use today's timestamps because the spending guard intentionally uses wall clock.
  const f = fixture(), current = new Date().toISOString();
  f.input.priceObservedAt = current; f.input.shippingVerifiedAt = current; f.input.comps[0].soldDate = current.slice(0, 10);
  admitDraftModelWorkflow(f.s, "one", f.input, null, null, current);
  const bound = (provider: "xai" | "meta") => ({ provider, model: "offline-fixture", inputTokens: 10000, outputTokens: 1200, maxRequestBytes: 50000, inputUsdPerMillion: 5, outputUsdPerMillion: 10, source: "https://example.com/fixture", justification: "Offline fixture upper bound only; not a production pricing authority", expiresAt: new Date(Date.now() + 3600000).toISOString(), allBillableTokensBounded: true as const });
  f.s.draftModelBudget = { authority: "offline test authorization", accountingEvidence: "offline test accounting", expiresAt: new Date(Date.now() + 3600000).toISOString(), perCardMicros: 200000, runMicros: 300000, priorMicros: 0, bounds: { xai: bound("xai"), meta: bound("meta") }, entries: [] };
  let s = f.s, calls = 0;
  const transaction = async <T>(fn: (state: QueueState, ctx: {}) => T) => { const copy = structuredClone(s); const value = fn(copy, {}); s = copy; return value; };
  const generate = async (args: { provider: string }) => { calls++; assert.equal(args.provider, "xai"); assert.equal(s.draftModelBudget!.entries[0].status, "pending"); return { finding: { decision: "accept", price: price(1.49), rationale: "Evidence supports price" }, inputTokens: 100, outputTokens: 100 }; };
  await runDraftModelStage("one", "proposal", "worker", transaction, generate);
  assert.equal(s.draftModelBudget!.entries[0].status, "settled");
  await assert.rejects(runDraftModelStage("one", "proposal", "worker", transaction, generate), /complete|recorded/);
  assert.equal(calls, 1);
  const bad = async () => ({ finding: {}, inputTokens: NaN, outputTokens: 100 });
  await assert.rejects(runDraftModelStage("one", "muse", "worker", transaction, bad), /uncertain/);
  assert.equal(s.draftModelBudget!.entries[1].status, "uncertain");
  await assert.rejects(runDraftModelStage("one", "muse", "worker", transaction, bad), /billing/);
});

test("per-card and run caps stop before creating a role claim", async () => {
  const f = fixture(), current = new Date().toISOString();
  f.input.priceObservedAt = current; f.input.shippingVerifiedAt = current; f.input.comps[0].soldDate = current.slice(0, 10);
  admitDraftModelWorkflow(f.s, "one", f.input, null, null, current);
  const bound = { provider: "xai" as const, model: "offline-fixture", inputTokens: 10000, outputTokens: 1200, maxRequestBytes: 50000, inputUsdPerMillion: 5, outputUsdPerMillion: 10, source: "https://example.com/fixture", justification: "Offline fixture upper bound only; not a production pricing authority", expiresAt: new Date(Date.now() + 3600000).toISOString(), allBillableTokensBounded: true as const };
  f.s.draftModelBudget = { authority: "fixture", accountingEvidence: "fixture", expiresAt: bound.expiresAt, perCardMicros: 1, runMicros: 1, priorMicros: 0, bounds: { xai: bound, meta: { ...bound, provider: "meta" } }, entries: [] };
  const transaction = async <T>(fn: (s: QueueState, ctx: {}) => T) => fn(f.s, {});
  await assert.rejects(runDraftModelStage("one", "proposal", "worker", transaction, async () => { throw Error("must not call"); }), /cap reached/);
  assert.equal(f.s.draftModelWorkflows!.one.claims.proposal, undefined);
});




test("Elite track-only mode has no financial cap but rejects other captures and replay", async () => {
  const f = fixture(), current = new Date().toISOString();
  f.s.cards.one.input.source = "scanner-intake:elite-red-20261031-160115";
  f.input.priceObservedAt = current; f.input.shippingVerifiedAt = current; f.input.comps[0].soldDate = current.slice(0, 10);
  admitDraftModelWorkflow(f.s, "one", f.input, null, null, current);
  const bound = { provider: "xai" as const, model: "offline-fixture", inputTokens: 10000, outputTokens: 1200, maxRequestBytes: 50000, inputUsdPerMillion: 5, outputUsdPerMillion: 10, source: "https://example.com/fixture", justification: "Offline fixture rates only, never production price evidence", expiresAt: new Date(Date.now() + 3600000).toISOString(), allBillableTokensBounded: true as const };
  f.s.draftModelBudget = { authority: "elite-run-cost-tracking-no-cap-20261031", mode: "track-only", scope: {runId: "elite-red-20261031", cardIds: ["one"]}, accountingEvidence: "fixture", expiresAt: bound.expiresAt, perCardMicros: null, runMicros: null, priorMicros: 900000000, bounds: {xai: bound, meta: {...bound, provider: "meta"}}, entries: [] };
  let calls=0;
  const transaction = async <T>(fn: (s: QueueState, ctx: {}) => T) => fn(f.s, {});
  const generate=async()=>{calls++;return {finding:{decision:"accept",price:price(1.49),rationale:"Fixture evidence"},inputTokens:100,outputTokens:100};};
  await assert.rejects(runDraftModelStage("outside", "proposal", "worker", transaction, generate), /outside authorized/);
  await runDraftModelStage("one", "proposal", "worker", transaction, generate);
  assert.equal(calls,1); assert.equal(f.s.draftModelBudget.entries[0].actualMicros,1500);
  await assert.rejects(runDraftModelStage("one", "proposal", "worker", transaction, generate), /complete|recorded/);
  assert.equal(calls,1);
});
