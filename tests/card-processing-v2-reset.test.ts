import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { prepareV2LocalReset, commitV2LocalReset, readV2ResetTransfers } from "../lib/card-processing-v2-reset.ts";
import { withV2State, readV2State, v2Dir } from "../lib/card-processing-v2-store.ts";
import { withQueue, readQueue } from "../lib/card-orchestrator-store.ts";
import { upsertCard, fingerprint, type CardInput, type QueueState } from "../lib/card-orchestrator.ts";
import { runV2 } from "../lib/card-processing-v2-worker.ts";

const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const instructionId = "card-processing-v2-reset-approved-20261103";
async function setup(root: string) {
  const folder = path.join(root, "scans"), legacy = path.join(root, "artifacts/card-orchestrator");
  await fs.mkdir(folder, { recursive: true }); await fs.mkdir(v2Dir(root), { recursive: true });
  await fs.writeFile(path.join(v2Dir(root), "config.json"), JSON.stringify({ folder }));
  await fs.mkdir(path.join(root, "artifacts/engineering-mission"), { recursive: true });
  const authority = { instructions: [{ id: instructionId, text: "Reset local records and matching eBay drafts", source: "Synthetic unit-test instruction", capturedAt: new Date().toISOString(), taskIds: ["card-processing-v2-reset-20261103"], policyRefs: ["scoped-local-reset-and-matching-ebay-draft-removal"] }] };
  await fs.writeFile(path.join(root, "artifacts/engineering-mission/work-queue.json"), JSON.stringify(authority));
  const cards: CardInput[] = [];
  for (let index = 1; index <= 3; index++) {
    const photos: CardInput["photos"] = [];
    for (const side of ["front", "back"] as const) { const bytes = Buffer.from(`original-${index}-${side}`), filename = path.join(folder, `card-${index}-${side}.jpg`); await fs.writeFile(filename, bytes); const stable = new Date(Date.now() - 5000); await fs.utimes(filename, stable, stable); photos.push({ path: filename, sha256: sha(bytes), side }); }
    cards.push({ id: `LEGACY-${index}`, sku: `legacy-sku-${index}`, source: "synthetic-reset-test", photos, candidates: [], identity: {
      player: `Player ${index}`, season: "2025", set: "Topps Chrome", manufacturer: "Topps", cardNumber: String(index), sport: "Baseball", team: "", parallel: "Base", serial: "", printRun: null, condition: "Near mint or better", autograph: false, patch: false, language: "English", artwork: "Base portrait", conditionType: "Raw",
    } });
  }
  await withQueue(legacy, s => {
    for (const card of cards) upsertCard(s, card);
    s.cards[cards[0].id].input.knownDraft = "5431234567890";
    s.cards[cards[0].id].draftLifecycle = { binding: "old-binding", state: "saved", draftId: "5431234567890", observedAt: new Date(Date.now() - 86400000).toISOString(), evidence: "Synthetic retained old draft observation" };
    s.draftWriter = { owner: "old-writer", scope: cards.map(card => card.id), configuredAt: new Date().toISOString(), evidence: "Synthetic old writer", lease: { token: "expired-test-lease", expiresAt: new Date(Date.now() - 1000).toISOString() }, creationAuthority: { evidence: "old test authority", bindings: Object.fromEntries(cards.map(card => [card.id, `binding-${card.id}`])) } };
  });
  const selected = cards.slice(0, 2), photos = selected.flatMap(card => card.photos);
  await withV2State(s => { s.baseline = { initializedAt: new Date().toISOString(), paths: photos.map(photo => photo.path), hashes: photos.map(photo => photo.sha256), fileCount: photos.length }; }, root);
  const observation = { observedAt: new Date().toISOString(), kind: "read-only-browser-seller-observation", seller: "imaydit58", source: "https://www.ebay.com/sh/lst/drafts", method: "Synthetic authenticated empty-page observation", draftCount: 0, searchEmpty: true, authenticatedBrowserRead: true, apiConnectionVerified: false, scopesObserved: ["drafts"], inventoryClearanceComplete: false, externalWrites: 0 };
  const relative = "artifacts/card-processing-v2/drafts-empty.json", bytes = JSON.stringify(observation); await fs.writeFile(path.join(root, relative), bytes);
  const request = { resetId: "synthetic-scope-reset", instructionId, pairs: selected.map(card => ({ legacyCardId: card.id, photos: card.photos.map(({ path, sha256 }) => ({ path, sha256 })) })), draftObservation: { path: relative, sha256: sha(bytes) } };
  return { root, folder, legacy, cards, selected, request, authority, observation };
}
async function fixture(run: (data: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "v2-reset-"));
  try { await run(await setup(root)); } finally { await fs.rm(root, { recursive: true, force: true }); }
}

test("reset preparation is concrete and reviewable without changing photos, queues or protected intake", () => fixture(async f => {
  const before = await fs.readFile(path.join(f.legacy, "state.json"), "utf8"), v2Before = await fs.readFile(path.join(v2Dir(f.root), "state.json"), "utf8");
  const reference = await prepareV2LocalReset(f.root, f.request), plan = JSON.parse(await fs.readFile(path.join(f.root, reference.path), "utf8"));
  assert.equal(plan.kind, "v2-scoped-local-reset-plan"); assert.equal(Object.keys(plan.scopedSnapshot.cards).length, 2);
  assert.equal(await fs.readFile(path.join(f.legacy, "state.json"), "utf8"), before);
  assert.equal(await fs.readFile(path.join(v2Dir(f.root), "state.json"), "utf8"), v2Before);
  for (const card of f.cards) for (const photo of card.photos) assert.equal(sha(await fs.readFile(photo.path)), photo.sha256);
}));

test("scoped reset retires selected active jobs only, preserves every original and fences old imports", () => fixture(async f => {
  const before = await readQueue(f.legacy), unrelated = fingerprint(before.cards[f.cards[2].id]);
  const reference = await prepareV2LocalReset(f.root, f.request), receipt = await commitV2LocalReset(f.root, reference), after = await readQueue(f.legacy);
  assert.equal(receipt.released, true); assert.equal(receipt.photosPreserved, true); assert.equal(receipt.sourceFilesDeleted, 0); assert.equal(receipt.ebayDraftsDeleted, 0); assert.equal(receipt.ebayDraftOutcome, "already-empty-observed");
  assert.equal(receipt.freshFourScopeClearanceRequiredBeforeDraftCreation, true);
  assert.equal(after.cards[f.cards[0].id], undefined); assert.equal(after.cards[f.cards[1].id], undefined); assert.equal(fingerprint(after.cards[f.cards[2].id]), unrelated);
  assert.deepEqual(after.draftWriter!.scope, [f.cards[2].id]); assert.deepEqual(Object.keys(after.draftWriter!.creationAuthority!.bindings), [f.cards[2].id]);
  assert.equal(Object.keys(after.v2OwnershipTransfers!).length, 2);
  assert.throws(() => upsertCard(after, f.cards[0]), /ownership transferred/);
  assert.throws(() => upsertCard(after, { ...f.cards[0], id: "REIMPORTED-WITH-NEW-ID" }), /ownership transferred/);
  for (const card of f.cards) for (const photo of card.photos) assert.equal(sha(await fs.readFile(photo.path)), photo.sha256);
  const release = await readV2ResetTransfers(f.root); assert.equal(release.releasedHashes.length, 4); assert.equal(release.inventoryClearanceComplete, false);
  assert.equal(release.transfers[f.cards[0].id].resetId, f.request.resetId); assert.match(release.transfers[f.cards[0].id].receipt, /receipt\.json#sha256=[a-f0-9]{64}$/);
  assert.deepEqual(receipt.pairs[0].guards.knownDraftIds, ["5431234567890"]);
  assert.equal(Object.keys((await readV2State(f.root)).cards).length, 0, "retirement does not invent V2 identification or auto-create inventory");
}));

test("seller/source/condition and positive inventory facts survive draft-history reset", () => fixture(async f => {
  await withQueue(f.legacy, s => {
    const card = s.cards[f.cards[0].id]; card.input.sourceHold = "Seller: retain original until source issue resolved";
    card.input.identity.condition = "Excellent"; card.input.knownLive = { itemId: "123456789012", url: "https://www.ebay.com/itm/123456789012", observedAt: new Date().toISOString(), source: "Synthetic retained live fact" };
    card.jobs.pricing.state = "held"; card.jobs.pricing.reason = "Old pricing review only";
  });
  const receipt = await commitV2LocalReset(f.root, await prepareV2LocalReset(f.root, f.request)), guards = receipt.pairs[0].guards;
  assert.ok(guards.hardHolds.some(hold => /Seller:/.test(hold))); assert.ok(guards.hardHolds.some(hold => /Excellent/.test(hold)));
  assert.deepEqual(guards.positiveDispositions, ["live"]); assert.ok(!guards.hardHolds.some(hold => /Old pricing/.test(hold)));
  const handoff = await readV2ResetTransfers(f.root); assert.deepEqual(handoff.receipts[0].pairs[0].guards.positiveDispositions, ["live"]);
}));

test("reset cannot expand beyond the exact baseline or substitute hashes and legacy owners", () => fixture(async f => {
  const outside = structuredClone(f.request); outside.pairs.push({ legacyCardId: f.cards[2].id, photos: f.cards[2].photos.map(({ path, sha256 }) => ({ path, sha256 })) });
  await assert.rejects(prepareV2LocalReset(f.root, outside), /exact complete protected baseline/);
  const wrongOwner = structuredClone(f.request); wrongOwner.pairs[0].legacyCardId = f.cards[2].id;
  await assert.rejects(prepareV2LocalReset(f.root, wrongOwner), /exact legacy original pair/);
  const missing = structuredClone(f.request); missing.pairs.pop(); await assert.rejects(prepareV2LocalReset(f.root, missing), /exact complete protected baseline/);
}));

test("changed originals or selected active history stop commit without deleting active jobs", () => fixture(async f => {
  const reference = await prepareV2LocalReset(f.root, f.request);
  await fs.writeFile(f.selected[0].photos[0].path, "changed bytes");
  await assert.rejects(commitV2LocalReset(f.root, reference), /protected original changed/);
  assert.equal(Object.keys((await readQueue(f.legacy)).cards).length, 3);
}));

test("a selected job edit invalidates the prepared scope without deleting current work", () => fixture(async f => {
  const reference = await prepareV2LocalReset(f.root, f.request);
  await withQueue(f.legacy, s => { s.cards[f.cards[0].id].jobs.listing.reason = "New independent checkpoint"; });
  await assert.rejects(commitV2LocalReset(f.root, reference), /Selected active history changed/);
  assert.equal(Object.keys((await readQueue(f.legacy)).cards).length, 3);
}));

test("unrelated queue edits made after preparation survive the scoped commit", () => fixture(async f => {
  const reference = await prepareV2LocalReset(f.root, f.request);
  await withQueue(f.legacy, s => { s.cards[f.cards[2].id].jobs.listing.reason = "Unrelated work created after reset planning"; });
  await commitV2LocalReset(f.root, reference);
  const state = await readQueue(f.legacy);
  assert.equal(state.cards[f.cards[2].id].jobs.listing.reason, "Unrelated work created after reset planning");
  assert.equal(Object.keys(state.cards).length, 1);
}));

test("active worker leases and mixed selected/unrelated group operations cannot be retired", () => fixture(async f => {
  await withQueue(f.legacy, s => { const job = s.cards[f.cards[0].id].jobs.photos; job.state = "leased"; job.lease = { owner: "another-worker", token: "test-lease", startedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() }; });
  await assert.rejects(prepareV2LocalReset(f.root, f.request), /active worker lease/);
  await withQueue(f.legacy, s => { delete s.cards[f.cards[0].id].jobs.photos.lease; s.cards[f.cards[0].id].jobs.photos.state = "todo"; s.draftCreationGroups = { mixed: { id: "mixed", members: [f.cards[0].id, f.cards[2].id], sku: "shared", bindings: {}, price: null, evidence: "Synthetic mixed group", createdAt: new Date().toISOString() } }; });
  await assert.rejects(prepareV2LocalReset(f.root, f.request), /unrelated active draftCreationGroups/);
}));

test("captured exact reset authority and fresh real-seller empty-draft observation are mandatory", () => fixture(async f => {
  const original = structuredClone(f.authority); f.authority.instructions[0].text = "Prepare a reset plan";
  await fs.writeFile(path.join(f.root, "artifacts/engineering-mission/work-queue.json"), JSON.stringify(f.authority));
  await assert.rejects(prepareV2LocalReset(f.root, f.request), /captured exact scoped reset/);
  await fs.writeFile(path.join(f.root, "artifacts/engineering-mission/work-queue.json"), JSON.stringify(original));
  const stale = { ...f.observation, observedAt: new Date(Date.now() - 3601000).toISOString() }, bytes = JSON.stringify(stale); await fs.writeFile(path.join(f.root, f.request.draftObservation.path), bytes); f.request.draftObservation.sha256 = sha(bytes);
  await assert.rejects(prepareV2LocalReset(f.root, f.request), /fresh seller draft observation/);
}));

test("committed reset retries are idempotent and recover a final-receipt rename interruption", () => fixture(async f => {
  const reference = await prepareV2LocalReset(f.root, f.request), first = await commitV2LocalReset(f.root, reference), before = await readQueue(f.legacy);
  const final = path.join(v2Dir(f.root), "resets", f.request.resetId, "receipt.json"), pending = path.join(path.dirname(final), "receipt-pending-test-crash.json");
  await fs.rename(final, pending);
  const recovered = await commitV2LocalReset(f.root, reference), after = await readQueue(f.legacy);
  assert.deepEqual(recovered, first); assert.equal(after.revision, before.revision); assert.ok((await fs.stat(final)).isFile());
  const again = await commitV2LocalReset(f.root, reference); assert.deepEqual(again, first); assert.equal((await readQueue(f.legacy)).revision, before.revision);
}));

test("reset plan and committed receipt bytes cannot be substituted or escaped", () => fixture(async f => {
  const reference = await prepareV2LocalReset(f.root, f.request);
  await assert.rejects(commitV2LocalReset(f.root, { ...reference, path: "../outside.json" }), /under artifacts/);
  await assert.rejects(commitV2LocalReset(f.root, { ...reference, sha256: "f".repeat(64) }), /evidence changed/);
  await commitV2LocalReset(f.root, reference);
  const final = path.join(v2Dir(f.root), "resets", f.request.resetId, "receipt.json"); await fs.appendFile(final, " ");
  await assert.rejects(readV2ResetTransfers(f.root), /evidence changed/);
}));

test("a fresh isolated V2 root has no reset transfers and reading does not create a legacy queue", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "v2-reset-empty-"));
  try {
    assert.deepEqual(await readV2ResetTransfers(root), { receipts: [], transfers: {}, releasedHashes: [], releasedLegacyIds: [], inventoryClearanceComplete: false });
    await assert.rejects(fs.stat(path.join(root, "artifacts/card-orchestrator")), { code: "ENOENT" });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("the worker admits only committed exact transferred baseline pairs and retains the receipt binding", () => fixture(async f => {
  await commitV2LocalReset(f.root, await prepareV2LocalReset(f.root, f.request));
  let calls = 0;
  const deps = { legacyHashes: async () => f.cards.flatMap(card => card.photos.map(photo => photo.sha256)), identify: async () => { calls++; throw Error("No identification setup was authorized by this admission-only test"); } };
  const first = await runV2(f.root, "transferred-admission", deps), again = await runV2(f.root, "transferred-admission-retry", deps);
  assert.equal(calls, 0); assert.equal(Object.keys(first.cards).length, 2); assert.equal(Object.keys(again.cards).length, 2);
  assert.deepEqual(Object.values(first.cards).map(card => card.resetTransfer!.legacyCardId).sort(), f.selected.map(card => card.id).sort());
  assert.ok(Object.values(first.cards).every(card => card.resetTransfer!.resetId === f.request.resetId && /receipt\.json#sha256=[a-f0-9]{64}$/.test(card.resetTransfer!.receipt)));
  assert.equal(first.baseline!.fileCount, 4); assert.equal(Object.values(first.cards).filter(card => card.identity).length, 0, "ownership transfer is not identification evidence");
}));

test("committed transfers with retained live facts or source holds cannot bypass protected baseline intake", () => fixture(async f => {
  await withQueue(f.legacy, s => {
    s.cards[f.selected[0].id].input.knownLive = { itemId: "123456789012", url: "https://www.ebay.com/itm/123456789012", observedAt: new Date().toISOString(), source: "Synthetic retained live evidence" };
    s.cards[f.selected[1].id].input.sourceHold = "Seller source hold: preserve until exact reconciliation";
  });
  await commitV2LocalReset(f.root, await prepareV2LocalReset(f.root, f.request));
  const state = await runV2(f.root, "transferred-guards-retained", { legacyHashes: async () => f.cards.flatMap(card => card.photos.map(photo => photo.sha256)) });
  assert.equal(Object.keys(state.cards).length, 0);
  const transfer = await readV2ResetTransfers(f.root);
  assert.deepEqual(transfer.receipts[0].pairs[0].guards.positiveDispositions, ["live"]);
  assert.ok(transfer.receipts[0].pairs[1].guards.hardHolds.some(hold => hold.includes("Seller source hold")));
}));
