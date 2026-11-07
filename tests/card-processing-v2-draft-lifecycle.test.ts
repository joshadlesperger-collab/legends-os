import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { renewV2DraftAuthorization, beginV2Draft, recordV2Import, reviewV2DraftDescription, validateV2DraftForUpload, verifyV2Draft } from "../lib/card-processing-v2-draft-lifecycle.ts";
import { acquireV2Lock, readV2State, withV2State } from "../lib/card-processing-v2-store.ts";
import { consolidationKey, digest, preparePayload, searchableTitle, type V2Card, type V2Category, type V2Payload } from "../lib/card-processing-v2.ts";
import { V2_TRANSPORT_CONTRACT } from "../lib/card-processing-v2-transport.ts";
import { prepareV2LocalReset, commitV2LocalReset, readV2ResetTransfers } from "../lib/card-processing-v2-reset.ts";
import { withQueue } from "../lib/card-orchestrator-store.ts";
import { upsertCard, type CardInput } from "../lib/card-orchestrator.ts";

const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const policies = { payment: "Established payment policy", returns: "No Return Accepted" as const, shipping: null, location: "Established seller location", pricingShippingUnresolved: true };
async function reference(root: string, filename: string, value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value)); await fs.writeFile(path.join(root, filename), bytes);
  return { path: filename, sha256: sha(bytes) };
}
async function fixture(fn: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "v2-draft-lifecycle-"));
  try { await fn(await setup(root)); } finally { await fs.rm(root, { recursive: true, force: true }); }
}
async function setup(root: string) {
  const artifacts = "artifacts/card-processing-v2"; await fs.mkdir(path.join(root, artifacts), { recursive: true });
  const folder = path.join(root, "scans"); await fs.mkdir(folder);
  const photos = [];
  for (const side of ["front", "back"] as const) { const bytes = Buffer.from(`original-${side}`), filename = path.join(folder, `card-${side}.jpg`); await fs.writeFile(filename, bytes); photos.push({ path: filename, hash: sha(bytes), side }); }
  const at = new Date().toISOString(); const expiresAt = new Date(Date.now() + 72 * 3600000).toISOString();
  const identity = { name: "Aaron Judge", year: "2024", manufacturer: "Topps", product: "Topps Chrome", number: "1", categoryId: "261328" as const,
    language: "English", variant: "Base", artwork: "Base portrait", sportOrGame: "Baseball", team: "New York Yankees", serial: "", graded: false, damage: false, specifics: {} };
  const card: V2Card = { id: "V2-capture", sku: "V2-capture", captureId: sha("capture"), photos, stage: "prepared", identity,
    identification: { pairMatches: true, frontImageIndex: "0", upright: true, identity, warnings: [] }, condition: "Near mint or better",
    title: searchableTitle(identity), description: "2024 Topps Chrome Aaron Judge. New York Yankees. Near mint or better. Exact card shown in the front and back photos.", descriptionSource: "factual", issues: [], nextAction: "Draft handoff", createdAt: at, updatedAt: at };
  card.groupId = consolidationKey(card);
  const category: V2Category = { categoryId: "261328", source: "Retained live category snapshot regression fixture", observedAt: at, requiredAspects: ["Sport", "Player/Athlete", "Set", "Card Number"],
    allowedValues: {}, conditionId: "4000", conditionDescriptorName: "Card Condition - (ID: 40001)", conditionDescriptorValue: "Near mint or better - (ID: 400010)", conditionLabel: "Near mint or better" };
  await fs.writeFile(path.join(root, artifacts, "config.json"), JSON.stringify({ folder, categories: [category] }));
  const hosted = photos.map((p, n) => ({ hash: p.hash, url: `https://i.ebayimg.com/${n}.jpg`, expiresAt, upright: true as const }));
  const payload = preparePayload(card, [card], category, hosted);
  await withV2State(s => { s.cards[card.id] = card; for (const photo of hosted) s.media[photo.hash] = photo; }, root);
  const body = { seller: "imaydit58" as const, observedAt: new Date().toISOString(), source: "live-seller-read" as const,
    scopes: { drafts: true as const, active: true as const, sold: true as const, scheduled: true as const }, captures: [{ captureId: card.captureId, sku: card.sku, disposition: "absent" as const }], expectedPolicies: policies };
  const reconciliation = { ...body, evidence: await reference(root, `${artifacts}/reconciliation.json`, body) };
  const installMethod = async () => {
    // Synthetic contract fixture only: never copied into the application's live artifacts.
    const start = new Date(Date.now() - 10000).toISOString(), end = new Date().toISOString();
    const observations = [];
    for (const n of [1, 2]) {
      const p: V2Payload = { ...payload, sku: `PILOT-${n}`, captureIds: [sha(`pilot-${n}`)] };
      const actual = { kind: "saved-reopened-ebay-draft", seller: "imaydit58", draftId: `543000000000${n}`, url: `https://www.ebay.com/sl/sell?draft_id=543000000000${n}`,
        observedAt: end, payload: p, policies, editorErrors: [] };
      observations.push({ expected: p, expectedPolicies: policies, savedReadback: await reference(root, `${artifacts}/pilot-${n}.json`, actual) });
    }
    const importReport = await reference(root, `${artifacts}/pilot-import.json`, { kind: "live-ebay-import-result", action: "Draft", jobId: "12345678",
      rows: [1, 2].map(n => ({ sku: `PILOT-${n}`, draftId: `543000000000${n}`, result: "Success" })) });
    await fs.writeFile(path.join(root, artifacts, "method-proof.json"), JSON.stringify({ version: 1, contract: V2_TRANSPORT_CONTRACT, method: "seller-hub-draft-csv", kind: "live", importAction: "Draft", importJobId: "12345678",
      startedAt: start, finishedAt: end, published: false, duplicateInventory: false, ebayIdentityAIUsed: false, fieldRepairs: 0, observations, importReport }));
  };
  const importReceipt = async (draftId = "5431111111111", jobId = "12345679") => {
    const observedAt = new Date().toISOString();
    const row = { kind: "live-ebay-draft-import-row", seller: "imaydit58", action: "Draft", jobId, draftId, sku: payload.sku, result: "Success", observedAt };
    return { jobId, draftId, observedAt, evidence: await reference(root, `${artifacts}/import-${draftId}.json`, row) };
  };
  const savedReadback = async (p = payload, draftId = "5431111111111", savedPolicies = policies) => {
    const raw = { kind: "saved-reopened-ebay-draft" as const, seller: "imaydit58" as const, draftId, url: `https://www.ebay.com/sl/sell?draft_id=${draftId}`, observedAt: new Date().toISOString(),
      payload: p, policies: savedPolicies, savedItemPrice: null, savedShippingAmount: null, editorErrors: [] };
    return { ...raw, evidence: await reference(root, `${artifacts}/saved-${digest(raw)}.json`, raw) };
  };
  const reviewedDescription = async (key: string, overrides: Record<string, unknown> = {}) => {
    const expected = (await readV2State(root)).submissions[key].payload, at = new Date().toISOString();
    const body = { kind: "reviewed-ebay-ai-description", seller: "imaydit58", draftId: "5431111111111", url: "https://www.ebay.com/sl/sell?draft_id=5431111111111",
      generatedAt: at, observedAt: at, capability: "ebay-editor-description-ai", reviewer: "Regression fixture reviewer", reviewed: true, unsupportedClaims: false, contradictions: false,
      beforePayloadHash: digest(expected), title: expected.title, categoryId: expected.categoryId, specifics: expected.specifics,
      description: "2024 Topps Chrome Aaron Judge #1. New York Yankees. Near mint or better. The exact card is shown in the front and back photos.", ...overrides };
    return { ...body, evidence: await reference(root, `${artifacts}/description-${digest(body)}.json`, body) };
  };
  return { root, card, payload, reconciliation, installMethod, importReceipt, savedReadback, reviewedDescription };
}

async function pilot(f: Awaited<ReturnType<typeof setup>>, transfer = false, sourceHold?: string, positiveLive = false, legacyOrientationReversed = false) {
  const pilotInstruction = { id: "synthetic-v2-pilot", capturedAt: new Date(Date.now() - 2000).toISOString(), taskIds: ["card-processing-v2-live-validation-20261103"], policyRefs: ["card-processing-v2-draft-pilot"] };
  const resetInstruction = { id: "synthetic-reset-approved", text: "Reset local records and matching eBay drafts", capturedAt: new Date(Date.now() - 1000).toISOString(), source: "Synthetic reset instruction fixture",
    taskIds: ["card-processing-v2-reset-20261103"], policyRefs: ["scoped-local-reset-and-matching-ebay-draft-removal"] };
  await fs.mkdir(path.join(f.root, "artifacts/engineering-mission"), { recursive: true });
  await fs.writeFile(path.join(f.root, "artifacts/engineering-mission/work-queue.json"), JSON.stringify({ instructions: [pilotInstruction, resetInstruction] }));
  await withV2State(s => { s.baseline = { initializedAt: new Date(Date.now() - 3000).toISOString(), paths: f.card.photos.map(p => p.path), hashes: f.card.photos.map(p => p.hash), fileCount: 2 }; }, f.root);
  if (transfer) {
    const legacyCard: CardInput = { id: "LEGACY-RESET-ONE", sku: "LEGACY-RESET-SKU", source: "Synthetic reset fixture", photos: f.card.photos.map(p => ({ path: p.path, sha256: p.hash, side: legacyOrientationReversed ? (p.side === "front" ? "back" as const : "front" as const) : p.side })), candidates: [],
      identity: { player: "Aaron Judge", season: "2024", set: "Topps Chrome", manufacturer: "Topps", cardNumber: "1", sport: "Baseball", team: "New York Yankees", parallel: "Base", serial: "", printRun: null,
        condition: "Near mint or better", autograph: false, patch: false, language: "English", artwork: "Base portrait", conditionType: "Raw" }, ...(sourceHold ? { sourceHold } : {}),
      ...(positiveLive ? { knownLive: { itemId: "123456789012", url: "https://www.ebay.com/itm/123456789012", observedAt: new Date().toISOString(), source: "Synthetic positive live receipt" } } : {}) };
    await withQueue(path.join(f.root, "artifacts/card-orchestrator"), s => { upsertCard(s, legacyCard); });
    const observed = { observedAt: new Date().toISOString(), kind: "read-only-browser-seller-observation", seller: "imaydit58", source: "https://www.ebay.com/sh/lst/drafts", method: "Synthetic authenticated empty draft observation", draftCount: 0,
      searchEmpty: true, authenticatedBrowserRead: true, apiConnectionVerified: false, scopesObserved: ["drafts"], inventoryClearanceComplete: false, externalWrites: 0 };
    const observation = await reference(f.root, "artifacts/card-processing-v2/reset-drafts-observation.json", observed);
    const request = { resetId: "synthetic-lifecycle-transfer", instructionId: resetInstruction.id, pairs: [{ legacyCardId: legacyCard.id, photos: legacyCard.photos.map(p => ({ path: p.path, sha256: p.sha256 })) }], draftObservation: observation };
    const receipt = await commitV2LocalReset(f.root, await prepareV2LocalReset(f.root, request));
    const committed = await readV2ResetTransfers(f.root);
    await withV2State(s => { s.cards[f.card.id].resetTransfer = { resetId: receipt.resetId, legacyCardId: legacyCard.id, receipt: committed.transfers[legacyCard.id].receipt, instructionId: resetInstruction.id }; s.cards[f.card.id].createdAt = new Date().toISOString(); }, f.root);
  }
  return { pilot: { instructionId: pilotInstruction.id, captureIds: f.payload.captureIds, expiresAt: new Date(Date.now() + 30 * 60000).toISOString() } };
}

test("begin is gated on validated method and persists no intent on missing proof", () => fixture(async f => {
  await assert.rejects(beginV2Draft(f.root, f.card.groupId!, f.payload, f.reconciliation), /unvalidated/);
  assert.equal(Object.keys((await readV2State(f.root)).submissions).length, 0);
}));

test("begin binds exact prepared captures and saves intent before any external action", () => fixture(async f => {
  await f.installMethod();
  const key = await beginV2Draft(f.root, f.card.groupId!, f.payload, f.reconciliation);
  const state = await readV2State(f.root);
  assert.equal(state.submissions[key].status, "intent"); assert.equal(state.submissions[key].draftId, undefined);
  assert.match(state.submissions[key].evidence!, /operations\/begin-.*#sha256=/);
  await assert.rejects(beginV2Draft(f.root, f.card.groupId!, f.payload, f.reconciliation), /already owns/);
  assert.equal(Object.keys((await readV2State(f.root)).submissions).length, 1);
}));

test("fresh four-scope evidence and all current payload fields are required", () => fixture(async f => {
  await f.installMethod();
  await assert.rejects(beginV2Draft(f.root, f.card.groupId!, f.payload, { ...f.reconciliation, observedAt: new Date(Date.now() - 61 * 60000).toISOString() }), /Fresh/);
  await assert.rejects(beginV2Draft(f.root, f.card.groupId!, f.payload, { ...f.reconciliation, scopes: { ...f.reconciliation.scopes, sold: false } }));
  await assert.rejects(beginV2Draft(f.root, f.card.groupId!, { ...f.payload, title: "Other title" }, f.reconciliation), /current capture group|changed/);
  await fs.appendFile(f.card.photos[0].path, "changed");
  await assert.rejects(beginV2Draft(f.root, f.card.groupId!, f.payload, f.reconciliation), /photo changed/);
  assert.equal(Object.keys((await readV2State(f.root)).submissions).length, 0);
}));

test("existing seller disposition holds the capture instead of creating a new draft", () => fixture(async f => {
  await f.installMethod();
  const { evidence: _ignored, ...body } = f.reconciliation;
  const changed = { ...body, captures: [{ captureId: f.card.captureId, sku: f.card.sku, disposition: "live", id: "123000000000" }] };
  const packet = { ...changed, evidence: await reference(f.root, "artifacts/card-processing-v2/live-reconciliation.json", changed) };
  await assert.rejects(beginV2Draft(f.root, f.card.groupId!, f.payload, packet), /Existing inventory/);
  const state = await readV2State(f.root); assert.equal(state.cards[f.card.id].stage, "exception"); assert.equal(Object.keys(state.submissions).length, 0);
}));

test("import receipt maps same ID, fences conflicting IDs and recovers only by reconciliation", () => fixture(async f => {
  await f.installMethod(); const key = await beginV2Draft(f.root, f.card.groupId!, f.payload, f.reconciliation);
  const receipt = await f.importReceipt(); await recordV2Import(f.root, key, receipt);
  assert.equal((await readV2State(f.root)).cards[f.card.id].draftId, receipt.draftId);
  await assert.rejects(recordV2Import(f.root, key, await f.importReceipt("5432222222222")), /conflicts/);
  assert.equal((await readV2State(f.root)).submissions[key].status, "uncertain");
  await recordV2Import(f.root, key, receipt); assert.equal((await readV2State(f.root)).submissions[key].status, "submitted");
  assert.equal(Object.keys((await readV2State(f.root)).submissions).length, 1);
}));

test("full saved readback verifies captures and knowledge but retains explicit pending archive", () => fixture(async f => {
  await f.installMethod(); const key = await beginV2Draft(f.root, f.card.groupId!, f.payload, f.reconciliation);
  await recordV2Import(f.root, key, await f.importReceipt());
  const result = await verifyV2Draft(f.root, key, await f.savedReadback());
  assert.equal(result.status, "verified"); assert.equal(result.archive, "pending-supported-receipt-handoff"); assert.equal(result.canPublish, false);
  const state = await readV2State(f.root); assert.equal(state.cards[f.card.id].stage, "verified"); assert.match(state.cards[f.card.id].nextAction, /Archive pending/);
  assert.equal(Object.keys(state.knowledge).length, 1);
  for (const p of f.card.photos) assert.equal(sha(await fs.readFile(p.path)), p.hash);
}));

test("canonical Seller Hub camel-case draft URLs verify the same imported ID", () => fixture(async f => {
  await f.installMethod(); const key = await beginV2Draft(f.root, f.card.groupId!, f.payload, f.reconciliation);
  await recordV2Import(f.root, key, await f.importReceipt());
  const raw = await f.savedReadback(); raw.url = `https://www.ebay.com/lstng?draftId=${raw.draftId}`;
  const { evidence: _old, ...body } = raw; raw.evidence = await reference(f.root, "artifacts/card-processing-v2/canonical-readback.json", body);
  const verified = await verifyV2Draft(f.root, key, raw); assert.equal(verified.status, "verified");
  assert.equal((await readV2State(f.root)).cards[f.card.id].draftId, raw.draftId);
}));

test("saved field and policy mismatches retain same draft for repair and cannot certify knowledge", () => fixture(async f => {
  await f.installMethod(); const key = await beginV2Draft(f.root, f.card.groupId!, f.payload, f.reconciliation);
  await recordV2Import(f.root, key, await f.importReceipt());
  await assert.rejects(verifyV2Draft(f.root, key, await f.savedReadback({ ...f.payload, quantity: 2 })), /does not match/);
  assert.equal((await readV2State(f.root)).submissions[key].draftId, "5431111111111");
  await assert.rejects(verifyV2Draft(f.root, key, await f.savedReadback(f.payload, "5431111111111", { ...policies, payment: "Inherited wrong payment" })), /does not match/);
  assert.equal(Object.keys((await readV2State(f.root)).knowledge).length, 0);
  await verifyV2Draft(f.root, key, await f.savedReadback()); assert.equal((await readV2State(f.root)).cards[f.card.id].stage, "verified");
}));

test("unbound, tampered and nonblank-price readbacks cannot verify", () => fixture(async f => {
  await f.installMethod(); const key = await beginV2Draft(f.root, f.card.groupId!, f.payload, f.reconciliation);
  await recordV2Import(f.root, key, await f.importReceipt());
  const saved = await f.savedReadback();
  await assert.rejects(verifyV2Draft(f.root, key, { ...saved, savedItemPrice: 9.99 }));
  await fs.appendFile(path.join(f.root, saved.evidence.path), " ");
  await assert.rejects(verifyV2Draft(f.root, key, saved), /hash changed/);
  assert.equal((await readV2State(f.root)).cards[f.card.id].stage, "prepared");
}));

test("post-intent capture changes cannot seed verified knowledge", () => fixture(async f => {
  await f.installMethod(); const key = await beginV2Draft(f.root, f.card.groupId!, f.payload, f.reconciliation);
  await recordV2Import(f.root, key, await f.importReceipt());
  await withV2State(s => { s.cards[f.card.id].identity!.team = "Wrong inherited team"; }, f.root);
  await assert.rejects(verifyV2Draft(f.root, key, await f.savedReadback()), /does not match/);
  const state = await readV2State(f.root); assert.equal(Object.keys(state.knowledge).length, 0);
  assert.equal(state.submissions[key].draftId, "5431111111111"); assert.equal(state.submissions[key].status, "uncertain");
}));

test("original change after import retains an explicit photo exception and prevents archive handoff", () => fixture(async f => {
  await f.installMethod(); const key = await beginV2Draft(f.root, f.card.groupId!, f.payload, f.reconciliation);
  await recordV2Import(f.root, key, await f.importReceipt());
  await fs.appendFile(f.card.photos[1].path, "changed after upload");
  await assert.rejects(verifyV2Draft(f.root, key, await f.savedReadback()), /Original photo changed/);
  const state = await readV2State(f.root); assert.equal(state.cards[f.card.id].stage, "exception");
  assert.ok(state.cards[f.card.id].issues.some(i => i.code === "ORIGINAL_CHANGED")); assert.equal(Object.keys(state.knowledge).length, 0);
}));

test("new seller holds survive import reconciliation and prevent verification", () => fixture(async f => {
  await f.installMethod(); const key = await beginV2Draft(f.root, f.card.groupId!, f.payload, f.reconciliation);
  await withV2State(s => { const c = s.cards[f.card.id]; c.issues.push({ code: "SELLER_HOLD", detail: "Seller requires condition inspection", owner: "Seller" }); c.stage = "exception"; c.nextAction = "Seller requires condition inspection"; }, f.root);
  await recordV2Import(f.root, key, await f.importReceipt());
  await assert.rejects(verifyV2Draft(f.root, key, await f.savedReadback()), /hold/);
  const c = (await readV2State(f.root)).cards[f.card.id]; assert.equal(c.stage, "exception"); assert.equal(c.nextAction, "Seller requires condition inspection");
  assert.ok(c.issues.some(i => i.code === "SELLER_HOLD"));
}));

test("actual reviewed eBay AI description amends only text on the same draft and preserves original intent bytes", () => fixture(async f => {
  await f.installMethod(); const key = await beginV2Draft(f.root, f.card.groupId!, f.payload, f.reconciliation);
  const initial = (await readV2State(f.root)).submissions[key];
  const initialFile = path.join(f.root, initial.evidence!.split("#sha256=")[0]); const initialBytes = await fs.readFile(initialFile);
  await recordV2Import(f.root, key, await f.importReceipt());
  const packet = await f.reviewedDescription(key); const result = await reviewV2DraftDescription(f.root, key, packet);
  assert.equal(result.status, "description-reviewed-awaiting-save-reopen");
  const state = await readV2State(f.root), amended = state.submissions[key];
  assert.equal(amended.key, key); assert.equal(amended.draftId, initial.draftId ?? "5431111111111");
  assert.equal(amended.payload.description, packet.description); assert.equal(amended.payload.descriptionSource, "ebay-ai-reviewed");
  assert.deepEqual({ ...amended.payload, description: f.payload.description, descriptionSource: f.payload.descriptionSource }, f.payload);
  assert.deepEqual(await fs.readFile(initialFile), initialBytes);
  await verifyV2Draft(f.root, key, await f.savedReadback(amended.payload));
  assert.equal((await readV2State(f.root)).cards[f.card.id].stage, "verified");
}));

test("description review rejects identity, title, category, specifics and pricing substitutions", () => fixture(async f => {
  await f.installMethod(); const key = await beginV2Draft(f.root, f.card.groupId!, f.payload, f.reconciliation); await recordV2Import(f.root, key, await f.importReceipt());
  for (const patch of [{ title: "Different player title" }, { categoryId: "183454" }, { specifics: { Sport: ["Football"] } }, { price: 9.99 }, { identity: { name: "Different player" } }, { unsupportedClaims: true }, { contradictions: true }]) {
    await assert.rejects(reviewV2DraftDescription(f.root, key, await f.reviewedDescription(key, patch)));
  }
  assert.deepEqual((await readV2State(f.root)).submissions[key].payload, f.payload);
  assert.equal((await readV2State(f.root)).events.filter(e => e.stage === "draft-description-reviewed").length, 0);
}));

test("description review requires actual same-draft fresh capability evidence and exact bound bytes", () => fixture(async f => {
  await f.installMethod(); const key = await beginV2Draft(f.root, f.card.groupId!, f.payload, f.reconciliation); await recordV2Import(f.root, key, await f.importReceipt());
  for (const patch of [{ draftId: "5432222222222" }, { url: "https://www.ebay.com/sl/sell?draft_id=5432222222222" }, { capability: "synthetic-description" }, { generatedAt: new Date(Date.now() - 61 * 60000).toISOString() }, { description: "<script>bad</script>" }]) {
    await assert.rejects(reviewV2DraftDescription(f.root, key, await f.reviewedDescription(key, patch)));
  }
  const packet = await f.reviewedDescription(key);
  await assert.rejects(reviewV2DraftDescription(f.root, key, { ...packet, description: "Changed without matching observation bytes" }), /evidence does not match/);
  await fs.appendFile(path.join(f.root, packet.evidence.path), " ");
  await assert.rejects(reviewV2DraftDescription(f.root, key, packet), /hash changed/);
}));

test("unreviewed changed saved text fails; an immutable chain of reviewed descriptions can then verify", () => fixture(async f => {
  await f.installMethod(); const key = await beginV2Draft(f.root, f.card.groupId!, f.payload, f.reconciliation); await recordV2Import(f.root, key, await f.importReceipt());
  const unreviewed: V2Payload = { ...f.payload, description: "Changed in the editor without review", descriptionSource: "ebay-ai-reviewed" };
  await assert.rejects(verifyV2Draft(f.root, key, await f.savedReadback(unreviewed)), /does not match/);
  await reviewV2DraftDescription(f.root, key, await f.reviewedDescription(key));
  await reviewV2DraftDescription(f.root, key, await f.reviewedDescription(key, { description: "Aaron Judge 2024 Topps Chrome #1. New York Yankees. Near mint or better; exact front and back shown." }));
  const state = await readV2State(f.root); assert.equal(state.events.filter(e => e.stage === "draft-description-reviewed").length, 2);
  await verifyV2Draft(f.root, key, await f.savedReadback(state.submissions[key].payload));
  assert.equal((await readV2State(f.root)).submissions[key].status, "verified");
  await assert.rejects(reviewV2DraftDescription(f.root, key, await f.reviewedDescription(key)), /before verification/);
}));

test("a modified amendment artifact cannot replace original proof or certify verification", () => fixture(async f => {
  await f.installMethod(); const key = await beginV2Draft(f.root, f.card.groupId!, f.payload, f.reconciliation); await recordV2Import(f.root, key, await f.importReceipt());
  await reviewV2DraftDescription(f.root, key, await f.reviewedDescription(key));
  const state = await readV2State(f.root), amendment = state.events.find(e => e.stage === "draft-description-reviewed")!;
  await fs.appendFile(path.join(f.root, amendment.detail.split("#sha256=")[0]), " ");
  await assert.rejects(verifyV2Draft(f.root, key, await f.savedReadback(state.submissions[key].payload)), /does not match/);
  assert.equal((await readV2State(f.root)).submissions[key].status, "uncertain");
  assert.equal(Object.keys((await readV2State(f.root)).knowledge).length, 0);
}));

test("pilot still excludes baseline originals without a committed authorized reset transfer", () => fixture(async f => {
  const options = await pilot(f);
  await assert.rejects(beginV2Draft(f.root, f.card.groupId!, f.payload, f.reconciliation, options), /activation originals/);
  await assert.rejects(fs.stat(path.join(f.root, "artifacts/card-orchestrator")), error => (error as NodeJS.ErrnoException).code === "ENOENT");
  assert.equal(Object.keys((await readV2State(f.root)).submissions).length, 0);
}));

test("exact committed reset transfer permits a baseline pilot while retaining fresh four-scope requirements", () => fixture(async f => {
  const options = await pilot(f, true);
  await assert.rejects(beginV2Draft(f.root, f.card.groupId!, f.payload, { ...f.reconciliation, scopes: { ...f.reconciliation.scopes, sold: false } }, options));
  const key = await beginV2Draft(f.root, f.card.groupId!, f.payload, f.reconciliation, options);
  assert.equal((await readV2State(f.root)).submissions[key].status, "intent");
  await validateV2DraftForUpload(f.root, key);
  for (const photo of f.card.photos) assert.equal(sha(await fs.readFile(photo.path)), photo.hash);
}));

test("forged reset metadata without a committed registry cannot release baseline protection", () => fixture(async f => {
  const options = await pilot(f);
  await withV2State(s => { s.cards[f.card.id].resetTransfer = { resetId: "invented", legacyCardId: "LEGACY-NOT-COMMITTED", receipt: "artifacts/missing-receipt.json#sha256=" + "a".repeat(64), instructionId: "synthetic-reset-approved" }; }, f.root);
  await assert.rejects(beginV2Draft(f.root, f.card.groupId!, f.payload, f.reconciliation, options), /committed unheld exact/);
  await assert.rejects(fs.stat(path.join(f.root, "artifacts/card-orchestrator")), error => (error as NodeJS.ErrnoException).code === "ENOENT");
}));

test("reset receipt tampering or capture pointer substitution cannot authorize a baseline draft", () => fixture(async f => {
  const options = await pilot(f, true), state = await readV2State(f.root), transfer = state.cards[f.card.id].resetTransfer!;
  await withV2State(s => { s.cards[f.card.id].resetTransfer!.receipt = transfer.receipt.replace(/.$/, transfer.receipt.endsWith("a") ? "b" : "a"); }, f.root);
  await assert.rejects(beginV2Draft(f.root, f.card.groupId!, f.payload, f.reconciliation, options), /committed unheld exact/);
  await withV2State(s => { s.cards[f.card.id].resetTransfer = transfer; }, f.root);
  await fs.appendFile(path.join(f.root, transfer.receipt.split("#sha256=")[0]), " ");
  await assert.rejects(beginV2Draft(f.root, f.card.groupId!, f.payload, f.reconciliation, options), /Reset evidence changed/);
  assert.equal(Object.keys((await readV2State(f.root)).submissions).length, 0);
}));

test("retired seller/source guards remain draft blockers after reset", () => fixture(async f => {
  const options = await pilot(f, true, "Seller hold: inspect source");
  await assert.rejects(beginV2Draft(f.root, f.card.groupId!, f.payload, f.reconciliation, options), /committed unheld exact/);
}));

test("retired positive live/sold/scheduled facts cannot be erased by a draft-history reset", () => fixture(async f => {
  const options = await pilot(f, true, undefined, true);
  await assert.rejects(beginV2Draft(f.root, f.card.groupId!, f.payload, f.reconciliation, options), /committed unheld exact/);
}));

test("changed captured reset authority invalidates the transferred baseline exception", () => fixture(async f => {
  const options = await pilot(f, true), filename = path.join(f.root, "artifacts/engineering-mission/work-queue.json"), queue = JSON.parse(await fs.readFile(filename, "utf8"));
  queue.instructions.find((i: { id: string }) => i.id === "synthetic-reset-approved").policyRefs = [];
  await fs.writeFile(filename, JSON.stringify(queue));
  await assert.rejects(beginV2Draft(f.root, f.card.groupId!, f.payload, f.reconciliation, options), /captured reset authority/);
  assert.equal(Object.keys((await readV2State(f.root)).submissions).length, 0);
}));

test("new committed-registry guards after begin prevent external upload of transferred originals", () => fixture(async f => {
  const options = await pilot(f, true), key = await beginV2Draft(f.root, f.card.groupId!, f.payload, f.reconciliation, options);
  await withQueue(path.join(f.root, "artifacts/card-orchestrator"), s => { s.v2OwnershipTransfers!["LEGACY-RESET-ONE"].positiveDispositions.push("sold"); });
  await assert.rejects(validateV2DraftForUpload(f.root, key), /committed unheld exact/);
  assert.equal((await readV2State(f.root)).submissions[key].draftId, undefined);
}));

test("legacy reset orientation is not identity evidence: the new reviewed side correction may proceed", () => fixture(async f => {
  const options = await pilot(f, true, undefined, false, true);
  const key = await beginV2Draft(f.root, f.card.groupId!, f.payload, f.reconciliation, options);
  assert.equal((await readV2State(f.root)).submissions[key].status, "intent"); await validateV2DraftForUpload(f.root, key);
  await withV2State(s => { const card = s.cards[f.card.id]; card.photos = [card.photos[1], card.photos[0]]; }, f.root);
  await assert.rejects(validateV2DraftForUpload(f.root, key), /capture fields changed/);
}));

async function admissionPilot(f:Awaited<ReturnType<typeof setup>>){
 const now=Date.now(),request={id:'synthetic-new-batch-request',capturedAt:new Date(now-10000).toISOString(),taskIds:['synthetic-new-batch'],policyRefs:['draft-only-no-publication','internal-browser-only','preserve-all-photo-bytes']},authority={id:'synthetic-current-start',capturedAt:new Date(now-1000).toISOString(),taskIds:['synthetic-new-batch','card-processing-v2-live-validation-20261103'],policyRefs:['card-processing-v2-draft-pilot',...request.policyRefs]};
 await fs.mkdir(path.join(f.root,'artifacts/engineering-mission'),{recursive:true});await fs.writeFile(path.join(f.root,'artifacts/engineering-mission/work-queue.json'),JSON.stringify({instructions:[request,authority],tasks:[{id:'synthetic-new-batch',status:'in-progress'}]}));
 await withV2State(s=>{s.baseline={initializedAt:new Date(now-20000).toISOString(),hashes:[],paths:[],fileCount:0};s.cards[f.card.id].createdAt=new Date(now-5000).toISOString();},f.root);
 return{pilot:{instructionId:authority.id,admissionInstructionId:request.id,captureIds:f.payload.captureIds,expiresAt:new Date(now+30*60000).toISOString()}};
}
test('fresh execution authority links earlier same-task request without backdating admission or changing payload',()=>fixture(async f=>{
 const options=await admissionPilot(f),before=await readV2State(f.root);await assert.rejects(beginV2Draft(f.root,f.card.groupId!,f.payload,f.reconciliation,{pilot:{...options.pilot,admissionInstructionId:undefined}}),/newly admitted/);
 const key=await beginV2Draft(f.root,f.card.groupId!,f.payload,f.reconciliation,options),after=await readV2State(f.root);assert.deepEqual(after.submissions[key].payload,f.payload);assert.equal(after.cards[f.card.id].createdAt,before.cards[f.card.id].createdAt);assert.deepEqual(after.cards[f.card.id].photos,before.cards[f.card.id].photos);
}));
test('linked admission does not authorize prior inventory or baseline originals',()=>fixture(async f=>{
 const options=await admissionPilot(f);await withV2State(s=>{s.cards[f.card.id].createdAt=new Date(Date.now()-60000).toISOString();},f.root);await assert.rejects(beginV2Draft(f.root,f.card.groupId!,f.payload,f.reconciliation,options),/newly admitted/);
 await withV2State(s=>{s.cards[f.card.id].createdAt=new Date().toISOString();s.baseline!.hashes=f.card.photos.map(p=>p.hash);},f.root);await assert.rejects(beginV2Draft(f.root,f.card.groupId!,f.payload,f.reconciliation,options),/activation originals/);assert.equal(Object.keys((await readV2State(f.root)).submissions).length,0);
}));
test('unrelated, superseded, finished-task or old execution authority cannot shift admission boundary',()=>fixture(async f=>{
 const options=await admissionPilot(f),file=path.join(f.root,'artifacts/engineering-mission/work-queue.json'),original=JSON.parse(await fs.readFile(file,'utf8'));
 for(const kind of ['unrelated','superseded','finished','stale']){const queue=structuredClone(original);if(kind==='unrelated')queue.instructions[0].taskIds=['some-other-batch'];if(kind==='superseded')queue.instructions.push({id:'replacement',capturedAt:new Date().toISOString(),taskIds:[],policyRefs:[],supersedes:[options.pilot.admissionInstructionId]});if(kind==='finished')queue.tasks[0].status='done';if(kind==='stale')queue.instructions[1].capturedAt=new Date(Date.now()-61*60000).toISOString();await fs.writeFile(file,JSON.stringify(queue));await assert.rejects(beginV2Draft(f.root,f.card.groupId!,f.payload,f.reconciliation,options),/Admission boundary|Fresh exact/);}
}));


test('pilot instruction reader preserves valid ISO UTC and nonzero offsets without changing immutable queue source',()=>fixture(async f=>{
 const options=await admissionPilot(f),file=path.join(f.root,'artifacts/engineering-mission/work-queue.json'),q=JSON.parse(await fs.readFile(file,'utf8'));
 q.instructions[0].capturedAt=q.instructions[0].capturedAt.replace('Z','+00:00');const instant=Date.parse(q.instructions[1].capturedAt);q.instructions[1].capturedAt=new Date(instant+330*60000).toISOString().replace('Z','+05:30');
 q.instructions.push({id:'unrelated-captured-reply',capturedAt:new Date().toISOString().replace('Z','+00:00'),taskIds:[],policyRefs:[]});await fs.writeFile(file,JSON.stringify(q));const source=await fs.readFile(file,'utf8');const key=await beginV2Draft(f.root,f.card.groupId!,f.payload,f.reconciliation,options);assert.equal((await readV2State(f.root)).submissions[key].status,'intent');assert.equal(await fs.readFile(file,'utf8'),source);assert.equal(Date.parse(q.instructions[1].capturedAt),instant);
}));

test('pilot instruction reader rejects invalid offset datetime before any intent is written',()=>fixture(async f=>{
 const options=await admissionPilot(f),file=path.join(f.root,'artifacts/engineering-mission/work-queue.json'),q=JSON.parse(await fs.readFile(file,'utf8'));q.instructions.push({id:'invalid-offset-date',capturedAt:'2026-13-05T03:22:00+00:00',taskIds:[],policyRefs:[]});await fs.writeFile(file,JSON.stringify(q));const source=await fs.readFile(file,'utf8');await assert.rejects(beginV2Draft(f.root,f.card.groupId!,f.payload,f.reconciliation,options),/ISO datetime/);assert.equal(Object.keys((await readV2State(f.root)).submissions).length,0);assert.equal(await fs.readFile(file,'utf8'),source);
}));

async function freshRenewal(f:Awaited<ReturnType<typeof setup>>){const {evidence:_old,...body}=f.reconciliation;body.observedAt=new Date().toISOString();return {...body,evidence:await reference(f.root,`artifacts/card-processing-v2/renew-${Date.now()}.json`,body)};}
test('authorization renewal preserves expired intent key, payload and original history',t=>fixture(async f=>{
 await f.installMethod();const key=await beginV2Draft(f.root,f.card.groupId!,f.payload,f.reconciliation),before=await readV2State(f.root),original=await fs.readFile(path.join(f.root,before.submissions[key].evidence!.split('#')[0]));
 t.mock.timers.enable({apis:['Date'],now:Date.now()});t.mock.timers.tick(61*60000);try{
 // Method proof freshness is intentionally renewed by actual fixture evidence.
 await f.installMethod();await assert.rejects(validateV2DraftForUpload(f.root,key),/Fresh exact/);
 const r=await renewV2DraftAuthorization(f.root,key,{reconciliation:await freshRenewal(f)});assert.equal(r.key,key);assert.deepEqual(await validateV2DraftForUpload(f.root,key),f.payload);
 const after=await readV2State(f.root);assert.deepEqual(after.submissions,before.submissions);assert.deepEqual(after.cards,before.cards);assert.deepEqual(after.events.slice(0,before.events.length),before.events);assert.deepEqual(await fs.readFile(path.join(f.root,before.submissions[key].evidence!.split('#')[0])),original);
 const file=path.join(f.root,r.checkpoint.split('#')[0]);await fs.appendFile(file,' ');await assert.rejects(validateV2DraftForUpload(f.root,key),/hash changed/);
 }finally{t.mock.timers.reset();}
}));
for(const kind of ['uncertain','uploaded','payload','capture','positive','policies','uploader'] as const)test(`authorization renewal refuses ${kind}`,()=>fixture(async f=>{
 await f.installMethod();const key=await beginV2Draft(f.root,f.card.groupId!,f.payload,f.reconciliation);let recon=await freshRenewal(f);
 if(kind==='positive'||kind==='policies'){const {evidence,...b}=recon;if(kind==='positive')(b.captures[0] as {disposition:string}).disposition='live';else b.expectedPolicies={...b.expectedPolicies,location:'Changed location'};recon={...b,evidence:await reference(f.root,'artifacts/card-processing-v2/changed-renewal.json',b)};}
 else if(kind==='uploader'){await fs.mkdir(path.join(f.root,'artifacts/card-processing-v2/uploads'));await fs.writeFile(path.join(f.root,'artifacts/card-processing-v2/uploads/test.json'),JSON.stringify({bindings:[{key}],status:'uncertain'}));}
 else await withV2State(s=>{if(kind==='uncertain')s.submissions[key].status='uncertain';if(kind==='uploaded'){s.submissions[key].status='submitted';s.submissions[key].draftId='123456789012';}if(kind==='payload')s.submissions[key].payload.title+=' changed';if(kind==='capture')s.cards[f.card.id].photos.reverse();},f.root);
 await assert.rejects(renewV2DraftAuthorization(f.root,key,{reconciliation:recon}));assert.equal((await readV2State(f.root)).events.filter(e=>e.stage==='draft-authorization-renewed').length,0);
}));
test('pilot renewal keeps original authority and rejects supersession',()=>fixture(async f=>{
 await fs.mkdir(path.join(f.root,'artifacts/engineering-mission'),{recursive:true});const instruction={id:'renewable-pilot',capturedAt:new Date(Date.now()-2000).toISOString(),taskIds:['card-processing-v2-live-validation-20261103'],policyRefs:['card-processing-v2-draft-pilot']};const qfile=path.join(f.root,'artifacts/engineering-mission/work-queue.json');await fs.writeFile(qfile,JSON.stringify({instructions:[instruction]}));await withV2State(s=>{s.baseline={initializedAt:instruction.capturedAt,paths:[],hashes:[],fileCount:0};},f.root);
 const pilot={instructionId:instruction.id,expiresAt:new Date(Date.now()+10000).toISOString(),captureIds:f.payload.captureIds};const key=await beginV2Draft(f.root,f.card.groupId!,f.payload,f.reconciliation,{pilot});const realNow=Date.now;Date.now=()=>realNow()+61000;try{await assert.rejects(validateV2DraftForUpload(f.root,key),/expired/);const renewed={...pilot,expiresAt:new Date(Date.now()+1800000).toISOString()};await renewV2DraftAuthorization(f.root,key,{reconciliation:await freshRenewal(f),pilot:renewed});await validateV2DraftForUpload(f.root,key);await fs.writeFile(qfile,JSON.stringify({instructions:[instruction,{id:'replacement',supersedes:[instruction.id]}]}));await assert.rejects(validateV2DraftForUpload(f.root,key),/superseded/);}finally{Date.now=realNow;}
}));

for(const defect of ['none','foreign-lease','csv','requested'] as const)test(`authorization renewal ready-upload ownership ${defect}`,()=>fixture(async f=>{
 await f.installMethod();const key=await beginV2Draft(f.root,f.card.groupId!,f.payload,f.reconciliation),groups=[{groupId:f.card.groupId!,cardIds:[f.card.id],payload:f.payload}],jobId=digest(groups),dir=path.join(f.root,'artifacts/card-processing-v2/browser-jobs');await fs.mkdir(dir,{recursive:true});const csvPath=`artifacts/card-processing-v2/browser-jobs/${jobId}.csv`,csv='immutable fixture CSV';await fs.writeFile(path.join(f.root,csvPath),defect==='csv'?csv+'changed':csv);
 const lease={owner:'fixture-browser',token:'a'.repeat(64)},at=new Date().toISOString();await fs.writeFile(path.join(dir,jobId+'.json'),JSON.stringify({version:1,id:jobId,stage:defect==='requested'?'upload-requested':'ready-upload',groups:[{...groups[0],key}],lease,at,updatedAt:at,canPublish:false,pricing:'deferred-preserved',csvPath,csvSha256:sha(csv)}));
 const packet={reconciliation:await freshRenewal(f),browserLease:{jobId,...lease,owner:defect==='foreign-lease'?'foreign':lease.owner}};
 if(defect==='none'){await renewV2DraftAuthorization(f.root,key,packet);assert.deepEqual(await validateV2DraftForUpload(f.root,key),f.payload);assert.equal(await fs.readFile(path.join(f.root,csvPath),'utf8'),csv);}else await assert.rejects(renewV2DraftAuthorization(f.root,key,packet));
}));

test('authorization renewal fails closed against active browser or preparation owner',()=>fixture(async f=>{
 await f.installMethod();const key=await beginV2Draft(f.root,f.card.groupId!,f.payload,f.reconciliation),packet={reconciliation:await freshRenewal(f)};
 const {acquireV2BrowserBridgeLock}=await import('../lib/card-processing-v2-browser-upload-workflow.ts');const bridge=await acquireV2BrowserBridgeLock(f.root);try{await assert.rejects(renewV2DraftAuthorization(f.root,key,packet),/bridge already owned/);}finally{await bridge();}
 const worker=await acquireV2Lock('worker',f.root);try{await assert.rejects(renewV2DraftAuthorization(f.root,key,packet));await assert.rejects(fs.stat(path.join(f.root,'artifacts/card-processing-v2/browser-jobs/bridge.lock')),/ENOENT/);}finally{await worker();}
 assert.equal((await readV2State(f.root)).events.filter(e=>e.stage==='draft-authorization-renewed').length,0);
}));
import {randomUUID} from 'node:crypto';
import {writeV2ProcessingBatch} from '../lib/card-processing-v2-processing-batches.ts';
async function background(f:Awaited<ReturnType<typeof setup>>){
 const instruction={id:'dedicated-authority',text:'Use the dedicated background browser for selected drafts and photo archival.',capturedAt:new Date(Date.now()-1000).toISOString(),taskIds:['v2-background-runner-20261105'],policyRefs:['dedicated-background-browser-authorized','leave-pricing-alone','draft-only-no-publication','preserve-all-photo-bytes']};
 const file=path.join(f.root,'artifacts/engineering-mission/work-queue.json');await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,JSON.stringify({instructions:[instruction],tasks:[{id:'v2-background-runner-20261105',status:'in-progress'}]}));
 const batchId=randomUUID(),at=new Date().toISOString();await writeV2ProcessingBatch(f.root,{jobId:batchId,clickedAt:at,acceptedAt:at,status:'stopped',captures:[{candidateId:digest('candidate'),cardId:f.card.id,photos:f.card.photos.map(p=>({hash:p.hash,side:p.side}))}],baselineCallIds:[]});
 return{instruction,file,authority:{instructionId:instruction.id,batchId,expiresAt:new Date(Date.now()+3500000).toISOString(),captureIds:[f.card.captureId]}};
}
test('dedicated background begin persists separate real authority and renews exact never-sent intent without legacy pilot claims',()=>fixture(async f=>{
 const b=await background(f),key=await beginV2Draft(f.root,f.card.groupId!,f.payload,f.reconciliation,{background:b.authority});
 assert.deepEqual(await validateV2DraftForUpload(f.root,key),f.payload);
 const s=await readV2State(f.root),checkpoint=s.events.find(e=>e.stage==='draft-intent')!.detail,begin=JSON.parse(await fs.readFile(path.join(f.root,checkpoint.split('#sha256=')[0]),'utf8'));
 assert.equal(begin.methodStatus,'background-authorized-unvalidated');assert.equal(begin.pilot,undefined);assert.deepEqual(begin.background,b.authority);
 const renewed={...b.authority,expiresAt:new Date(Date.now()+3550000).toISOString()};await renewV2DraftAuthorization(f.root,key,{reconciliation:await freshRenewal(f),background:renewed});
 assert.deepEqual(await validateV2DraftForUpload(f.root,key),f.payload);assert.equal(Object.keys((await readV2State(f.root)).submissions).length,1);
 await assert.rejects(renewV2DraftAuthorization(f.root,key,{reconciliation:await freshRenewal(f),background:{...renewed,batchId:randomUUID()}}),/preserve exact background/);
}));
test('dedicated route cannot draft captures outside accepted hashes or a batch predating authorization',()=>fixture(async f=>{
 const b=await background(f);await assert.rejects(beginV2Draft(f.root,f.card.groupId!,f.payload,f.reconciliation,{background:{...b.authority,captureIds:[digest('foreign')]}}),/exact current captures/);
 const batchFile=path.join(f.root,'artifacts/card-processing-v2/processing-batches',b.authority.batchId+'.json'),batch=JSON.parse(await fs.readFile(batchFile,'utf8'));batch.captures[0].photos[0].hash=digest('foreign-photo');await fs.writeFile(batchFile,JSON.stringify(batch));await assert.rejects(beginV2Draft(f.root,f.card.groupId!,f.payload,f.reconciliation,{background:b.authority}),/exact newly accepted/);
 batch.captures[0].photos=f.card.photos.map(p=>({hash:p.hash,side:p.side}));batch.clickedAt=new Date(Date.now()-5000).toISOString();await fs.writeFile(batchFile,JSON.stringify(batch));await assert.rejects(beginV2Draft(f.root,f.card.groupId!,f.payload,f.reconciliation,{background:b.authority}),/exact newly accepted/);assert.equal(Object.keys((await readV2State(f.root)).submissions).length,0);
}));
test('background route preserves four-scope positive inventory guard and expiry',()=>fixture(async f=>{
 const b=await background(f);await assert.rejects(beginV2Draft(f.root,f.card.groupId!,f.payload,f.reconciliation,{background:{...b.authority,expiresAt:new Date(Date.now()-1).toISOString()}}),/expiry/);
 const {evidence,...body}=f.reconciliation;body.captures[0].disposition='live' as any;const recon={...body,evidence:await reference(f.root,'artifacts/card-processing-v2/background-positive.json',body)};
 await assert.rejects(beginV2Draft(f.root,f.card.groupId!,f.payload,recon,{background:b.authority}),/Existing inventory/);assert.equal(Object.keys((await readV2State(f.root)).submissions).length,0);
}));
test('dedicated authority revocation stops new upload but preserves existing immutable intent',()=>fixture(async f=>{
 const b=await background(f),key=await beginV2Draft(f.root,f.card.groupId!,f.payload,f.reconciliation,{background:b.authority}),before=(await readV2State(f.root)).submissions;
 const q=JSON.parse(await fs.readFile(b.file,'utf8'));q.instructions.push({id:'revoke',supersedes:[b.instruction.id]});await fs.writeFile(b.file,JSON.stringify(q));await assert.rejects(validateV2DraftForUpload(f.root,key),/authority required/);assert.deepEqual((await readV2State(f.root)).submissions,before);
}));
test('background authority binds the same original bytes after front/back correction',()=>fixture(async f=>{const b=await background(f),file=path.join(f.root,'artifacts/card-processing-v2/processing-batches',b.authority.batchId+'.json'),batch=JSON.parse(await fs.readFile(file,'utf8'));batch.captures[0].photos.forEach((p:any)=>p.side=p.side==='front'?'back':'front');await fs.writeFile(file,JSON.stringify(batch));const key=await beginV2Draft(f.root,f.card.groupId!,f.payload,f.reconciliation,{background:b.authority});assert.deepEqual(await validateV2DraftForUpload(f.root,key),f.payload);}));

async function duplicateRisk(f:Awaited<ReturnType<typeof setup>>){
 const b=await background(f),queue=JSON.parse(await fs.readFile(b.file,'utf8')),instruction={id:'seller-duplicates-authority',text:'Prioritize speed; I accept another listing instead of account-wide inventory duplicate scans.',capturedAt:new Date().toISOString(),taskIds:['v2-background-runner-20261105'],policyRefs:['seller-accepts-existing-inventory-duplicates']};
 queue.instructions.push(instruction);await fs.writeFile(b.file,JSON.stringify(queue));
 const body={seller:'imaydit58' as const,observedAt:new Date().toISOString(),source:'seller-accepted-duplicate-risk' as const,instructionId:instruction.id,captures:[{captureId:f.card.captureId,sku:f.card.sku,disposition:'duplicate-risk-accepted' as const}],expectedPolicies:policies};
 return{...b,instruction,reconciliation:{...body,evidence:await reference(f.root,'artifacts/card-processing-v2/duplicate-risk.json',body)}};
}
test('seller duplicate-risk route records honest acceptance without inventory absence and retains one-intent ownership',()=>fixture(async f=>{
 const r=await duplicateRisk(f),key=await beginV2Draft(f.root,f.card.groupId!,f.payload,r.reconciliation,{background:r.authority});assert.deepEqual(await validateV2DraftForUpload(f.root,key),f.payload);
 const state=await readV2State(f.root),ref=state.submissions[key].evidence!,operation=JSON.parse(await fs.readFile(path.join(f.root,ref.split('#sha256=')[0]),'utf8'));
 assert.equal(operation.reconciliation.source,'seller-accepted-duplicate-risk');assert.equal(operation.reconciliation.scopes,undefined);assert.equal(operation.reconciliation.captures[0].disposition,'duplicate-risk-accepted');
 await assert.rejects(beginV2Draft(f.root,f.card.groupId!,f.payload,r.reconciliation,{background:r.authority}),/already owns/);assert.equal(Object.keys((await readV2State(f.root)).submissions).length,1);
}));
test('duplicate-risk route requires captured seller policy and exact dedicated background execution',()=>fixture(async f=>{
 const r=await duplicateRisk(f);await f.installMethod();await assert.rejects(beginV2Draft(f.root,f.card.groupId!,f.payload,r.reconciliation),/requires the dedicated background route/);
 const queue=JSON.parse(await fs.readFile(r.file,'utf8'));queue.instructions.find((i:any)=>i.id===r.instruction.id).policyRefs=[];await fs.writeFile(r.file,JSON.stringify(queue));await assert.rejects(beginV2Draft(f.root,f.card.groupId!,f.payload,r.reconciliation,{background:r.authority}),/captured seller acceptance/);assert.equal(Object.keys((await readV2State(f.root)).submissions).length,0);
}));
test('duplicate-risk evidence cannot invent scanned scopes, foreign captures, remote IDs or backdate seller permission',()=>fixture(async f=>{
 const r=await duplicateRisk(f);await assert.rejects(beginV2Draft(f.root,f.card.groupId!,f.payload,{...r.reconciliation,scopes:{active:true,sold:true,drafts:true,scheduled:true}},{background:r.authority}));
 await assert.rejects(beginV2Draft(f.root,f.card.groupId!,f.payload,{...r.reconciliation,captures:[{...r.reconciliation.captures[0],id:'123'}]},{background:r.authority}));
 const {evidence,...body}=r.reconciliation;body.captures[0].captureId=digest('foreign');const foreign={...body,evidence:await reference(f.root,'artifacts/card-processing-v2/risk-foreign.json',body)};await assert.rejects(beginV2Draft(f.root,f.card.groupId!,f.payload,foreign,{background:r.authority}),/every exact capture/);
 body.captures[0].captureId=f.card.captureId;body.observedAt=new Date(Date.parse(r.instruction.capturedAt)-100).toISOString();await assert.rejects(beginV2Draft(f.root,f.card.groupId!,f.payload,{...body,evidence:await reference(f.root,'artifacts/card-processing-v2/risk-backdate.json',body)},{background:r.authority}),/predates seller authorization/);assert.equal(Object.keys((await readV2State(f.root)).submissions).length,0);
}));
test('revoked duplicate-risk authority stops upload without erasing the exact original intent',()=>fixture(async f=>{
 const r=await duplicateRisk(f),key=await beginV2Draft(f.root,f.card.groupId!,f.payload,r.reconciliation,{background:r.authority}),before=(await readV2State(f.root)).submissions;
 const queue=JSON.parse(await fs.readFile(r.file,'utf8'));queue.instructions.push({id:'later-decision',supersedes:[r.instruction.id]});await fs.writeFile(r.file,JSON.stringify(queue));await assert.rejects(validateV2DraftForUpload(f.root,key),/captured seller acceptance/);assert.deepEqual((await readV2State(f.root)).submissions,before);
}));
test('duplicate-risk authorization renews only its same policy route and frozen captures',()=>fixture(async f=>{
 const r=await duplicateRisk(f),key=await beginV2Draft(f.root,f.card.groupId!,f.payload,r.reconciliation,{background:r.authority}),{evidence,...body}=r.reconciliation;body.observedAt=new Date().toISOString();const reconciliation={...body,evidence:await reference(f.root,'artifacts/card-processing-v2/risk-renewal.json',body)};
 await renewV2DraftAuthorization(f.root,key,{reconciliation,background:r.authority});assert.deepEqual(await validateV2DraftForUpload(f.root,key),f.payload);
 await assert.rejects(renewV2DraftAuthorization(f.root,key,{reconciliation:await freshRenewal(f),background:r.authority}),/unchanged policies/);assert.equal(Object.keys((await readV2State(f.root)).submissions).length,1);
}));
