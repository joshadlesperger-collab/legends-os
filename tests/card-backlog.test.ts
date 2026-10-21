import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { backlogCounts, reconcileBacklog, reconcileScans, type BacklogEvidence } from "../lib/card-backlog.ts";
import { loadCardBacklog } from "../lib/card-backlog-store.ts";
import { fingerprint, newQueue, upsertCard } from "../lib/card-orchestrator.ts";
import { importLegacyCard } from "../lib/card-orchestrator-import.ts";

const now = "2026-10-21T12:00:00Z", h = (n: number) => n.toString(16).padStart(64, "0");
const identity = { player: "Player", season: "2025", set: "Set", manufacturer: "Maker", cardNumber: "12", parallel: "Base", language: "English", condition: "Excellent", conditionType: "Ungraded" };
const base = (overrides: Partial<BacklogEvidence> = {}): BacklogEvidence => ({ source: "identity", kind: "identity", id: "one", sku: "sku", frontHash: h(1), backHash: h(2), identity, identityStatus: "identified", identityKey: "identity-key", title: "Exact title..", ...overrides });
const proposal = { item: 3.98, shipping: 0, source: "pricing", updatedAt: "2026-10-18T12:00:00Z", policy: "item-only", reviewRequired: true };
test("deduplicates reimports by front hash, preserving intentional title periods and conditions", () => {
  const c = reconcileBacklog([base(), base({ id: "alias", source: "copy", frontHash: h(1).toUpperCase() })], now);
  assert.equal(c.length, 1); assert.equal(c[0].physicalUnits, 1); assert.equal(c[0].title, "Exact title.."); assert.equal(c[0].identity.condition, "Excellent"); assert.equal(c[0].aliases.length, 2);
});
test("distinct originals are inventory; shared backs do not collapse them", () => {
  const c = reconcileBacklog([base(), base({ id: "two", sku: "sku2", frontHash: h(3) })], now);
  assert.equal(backlogCounts(c).physicalCaptures, 2); assert.equal(c[0].groupKey, c[1].groupKey);
});
test("different serials and parallels never form a quantity group", () => {
  const c = reconcileBacklog([base({ identity: { ...identity, serial: "01/99", printRun: "99" } }), base({ id: "two", sku: "sku2", frontHash: h(3), identity: { ...identity, parallel: "Blue", serial: "02/99", printRun: "99" } })], now);
  assert.ok(c.every(c => c.groupKey === null)); assert.equal(c.length, 2);
});
test("same serial on distinct originals retains both and surfaces a reading conflict", () => {
  const c = reconcileBacklog([base({ identity: { ...identity, serial: "01/99" } }), base({ id: "two", sku: "sku2", frontHash: h(3), identity: { ...identity, serial: "1/99" } })], now);
  assert.equal(c.length, 2); assert.ok(c.every(c => c.state === "unresolved"));
});
test("conflicting pair cannot promote a price or approval", () => {
  const c = reconcileBacklog([base(), base({ kind: "pricing", backHash: h(4), proposal })], now)[0];
  assert.equal(c.state, "unresolved"); assert.equal(c.proposal, null); assert.equal(c.prices.length, 1);
});
test("matching ID with different front bytes does not merge physical copies", () => {
  const c = reconcileBacklog([base(), base({ frontHash: h(3) })], now);
  assert.equal(c.length, 2); assert.ok(c.every(c => c.issues.some(i => i.includes("Stable ID"))));
});
test("hash-less receipt excludes Add while withholding identity and price authority", () => {
  const c = reconcileBacklog([base(), { kind: "manifest", source: "receipt", id: "one", proposal, receipts: [{ id: "123", disposition: "draft", source: "receipt" }] }], now)[0];
  assert.equal(c.excludedFromNewListing, true); assert.equal(c.proposal, null); assert.equal(c.state, "unresolved");
});
test("partial active snapshot cannot erase saved draft/live/sold receipts", () => {
  const input = [base({ receipts: [{ id: "123", disposition: "draft", source: "old" }, { id: "456", disposition: "live", source: "old" }] })];
  assert.equal(reconcileBacklog(input, now)[0].state, "live");
  const sold = reconcileBacklog([...input, { kind: "marketplace", source: "sold", receipts: [{ id: "456", disposition: "sold", source: "sold" }] }], now)[0];
  assert.equal(sold.state, "sold"); assert.equal(sold.receipts.length, 3);
});
test("receipt-ID join consolidates duplicate marketplace rows and never matches titles", () => {
  const c = reconcileBacklog([base({ receipts: [{ id: "456", disposition: "live", source: "manifest" }] }), { kind: "marketplace", source: "active", title: "Exact title..", receipts: [{ id: "456", disposition: "live", source: "active" }] }, { kind: "marketplace", source: "active", title: "Exact title..", receipts: [{ id: "789", disposition: "live", source: "active" }] }], now);
  assert.equal(c.length, 2); assert.equal(backlogCounts(c).physicalCaptures, 1); assert.equal(backlogCounts(c).distinctLiveReceipts, 2);
});
test("a reused receipt is unresolved unless an explicit compatible quantity group exists", () => {
  const receipt = { id: "123", disposition: "draft" as const, source: "manifest" };
  const input = [base({ receipts: [receipt] }), base({ id: "two", sku: "sku2", frontHash: h(3), receipts: [receipt] })];
  assert.ok(reconcileBacklog(input, now).every(c => c.state === "unresolved"));
  assert.ok(reconcileBacklog(input.map(e => ({ ...e, receipts: [{ ...receipt, groupId: "group" }] })), now).every(c => c.state === "draft"));
  for (const field of ["season", "manufacturer", "language", "condition"]) {
    const mixed = input.map((e, index) => ({ ...e, identity: index ? { ...identity, [field]: "Different" } : identity, receipts: [{ ...receipt, groupId: "group" }] }));
    assert.ok(reconcileBacklog(mixed, now).every(c => c.state === "unresolved"));
  }
});
test("approval binds exact price, shipping, policy, timestamp, identity and original pair", () => {
  const pricing = base({ kind: "pricing", source: "pricing", proposal, approval: { proposal: { ...proposal, approvedAt: now }, identityKey: "identity-key", photoHashes: [h(2), h(1)] } });
  assert.equal(reconcileBacklog([base(), pricing], now)[0].state, "locally-approved");
  for (const change of [{ item: 4.44 }, { shipping: 1.49 }, { policy: "changed" }, { updatedAt: now }]) assert.equal(reconcileBacklog([base(), { ...pricing, proposal: { ...proposal, ...change } }], now)[0].approvedPrice, null);
  assert.equal(reconcileBacklog([base({ identityKey: "changed" }), pricing], now)[0].approvedPrice, null);
  assert.equal(reconcileBacklog([base(), { ...pricing, approval: { ...pricing.approval!, photoHashes: [h(1), h(8)] } }], now)[0].approvedPrice, null);
});
test("stale approvals stay unapproved and explicit price override is never replaced by formula", () => {
  const c = reconcileBacklog([base(), base({ kind: "pricing", proposal: { ...proposal, stale: true }, override: { ...proposal, item: 3.95, reviewRequired: false }, overrides: { user_price_override: 3.95 } })], now)[0];
  assert.equal(c.override?.item, 3.95); assert.equal(c.approvedPrice?.item, 3.95); assert.equal(c.proposal?.item, 3.98);
});
test("missing, future, and stale approval dates cannot approve a saved price", () => {
  for (const approvedAt of ["invalid", "", "2026-11-01T00:00:00Z", "2026-10-01T00:00:00Z"]) {
    const c = reconcileBacklog([base(), base({kind:"pricing", proposal, approval:{proposal:{...proposal,approvedAt}, identityKey:"identity-key",photoHashes:[h(1),h(2)]}})],now)[0];
    assert.equal(c.approvedPrice,null);
  }
  const old = {...proposal,updatedAt:"2026-01-01T00:00:00Z"};
  assert.equal(reconcileBacklog([base(),base({kind:"pricing",proposal:old,approval:{proposal:{...old,approvedAt:now},identityKey:"identity-key",photoHashes:[h(1),h(2)]}})],now)[0].approvedPrice,null);
});
test("conflicting saved identity withholds pricing but retains source evidence", () => {
  const c = reconcileBacklog([base(), base({ kind: "pricing", identity: { ...identity, parallel: "Blue" }, proposal })], now)[0];
  assert.equal(c.proposal, null); assert.equal(c.prices.length, 1); assert.equal(c.state, "unresolved");
});
test("counts are exclusive by state; milestones overlap without counting extra units", () => {
  const c = reconcileBacklog([base({ proposal, holds: ["needs inspection"], receipts: [{ id: "123", disposition: "draft", source: "saved", quantity: 5 }] }), base({ id: "two", sku: "two", frontHash: h(3), identityStatus: "not-identified", identity: {} })], now);
  const counts = backlogCounts(c); assert.equal(Object.values(counts.states).reduce((a,b) => a+b,0), 2); assert.equal(counts.physicalCaptures, 2); assert.equal(counts.held, 1); assert.equal(counts.withProposal, 1);
});
test("folder re-read matches hashes, never filename order, without increasing inventory", () => {
  const c = reconcileBacklog([base()], now), files = [{ path: "copy.jpg", hash: h(1) }, { path: "renamed.jpg", hash: h(1) }, { path: "back.jpg", hash: h(2) }, { path: "unknown.jpg", hash: h(9) }];
  const first = reconcileScans(c, files); assert.deepEqual(reconcileScans(c, files), first); assert.equal(first.duplicateFiles, 1); assert.equal(first.capturedCardsPresent, 1); assert.equal(first.unmatched.length, 1); assert.equal(c.length, 1);
});
test("ingestion recovers archived hashes, keeps dated manifests and reports corrupt sources", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "card-backlog-test-"));
  try {
    const write = async (p: string, data: unknown) => { await fs.mkdir(path.dirname(path.join(root,p)), { recursive: true }); await fs.writeFile(path.join(root,p), JSON.stringify(data)); };
    const inbox = path.join(root, "inbox"), original = path.join(inbox,"original.heic"), archive = path.join(inbox,"Listed","456","original.heic");
    await write("artifacts/identity-queue/cards.json", { cards: [{ card_id: "one", source_key: "sku", front_original_path: original, back_sha256: h(2), recorded_live_item_id: "456", status: "identity-ready", player: "Player" }] });
    await write("artifacts/pricing-queue/queue-state.json", { cards: [] });
    await write("artifacts/batch-202610191516/manifest.json", { cards: [{ cardId: "one", key: "sku", frontHash: h(1), backHash: h(2), liveItemId: "456", title: "Keep this title." }] });
    await write("artifacts/card-orchestrator/state.json", { malformed: true });
    const s = await loadCardBacklog({ root, inbox, now, scans: [{ path: archive, hash: h(1) }] });
    assert.equal(s.counts.physicalCaptures, 1); assert.equal(s.cards[0].title, "Keep this title."); assert.equal(s.counts.distinctLiveReceipts, 1); assert.equal(s.marketplace.complete, false); assert.ok(s.warnings.some(w => w.includes("schema")));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test("live inbox hashing ignores symlinks and preserves originals across repeat reads", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "card-backlog-scan-"));
  try {
    const inbox = path.join(root, "inbox"); await fs.mkdir(inbox); const bytes = Buffer.from("original photo bytes");
    await fs.writeFile(path.join(inbox,"card_front.jpg"),bytes); await fs.writeFile(path.join(inbox,"card_back.jpg"),Buffer.from("back"));
    const s = await loadCardBacklog({ root, inbox, now }); assert.equal(s.counts.physicalCaptures,1); assert.equal(s.cards[0].state,"unprocessed");
    assert.equal(s.cards[0].frontHash,createHash("sha256").update(bytes).digest("hex"));
    assert.deepEqual((await loadCardBacklog({ root,inbox,now })).counts,s.counts); assert.deepEqual(await fs.readFile(path.join(inbox,"card_front.jpg")),bytes);
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});

test("source approval survives filling unknown fields but not correcting known identity", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "card-backlog-approval-"));
  try {
    const write = async (p: string, data: unknown) => { await fs.mkdir(path.dirname(path.join(root,p)), { recursive: true }); await fs.writeFile(path.join(root,p), JSON.stringify(data)); };
    const legacy = { card_id:"one", source_key:"sku", quantity:1, player:"Player", season:"2025", set:"Set", manufacturer:"Maker", card_number:"12", sport_game:"Basketball", team:"Original team", parallel:"Base", condition_plan:"Excellent", front_sha256:h(1), back_sha256:h(2), front_original_path:"front.jpg", back_original_path:"back.jpg", status:"identity-ready" };
    const pricing = { ...legacy, proposed_item_price:proposal.item, buyer_shipping:proposal.shipping, updated_at:proposal.updatedAt, pricing_policy_version:proposal.policy };
    const input = importLegacyCard(legacy,pricing,[]), queue = newQueue(); upsertCard(queue,input,now);
    const job = queue.cards.one.jobs.identity; job.state="done"; job.result={identity:{...input.identity,autograph:false}};
    await write("artifacts/identity-queue/cards.json",{cards:[legacy]});
    await write("artifacts/pricing-queue/queue-state.json",{cards:[pricing]});
    await write("artifacts/card-orchestrator/asking-price-approvals.json",{approvals:[{cardId:"one",item:proposal.item,shipping:proposal.shipping,sourceUpdatedAt:proposal.updatedAt,policyVersion:proposal.policy,photoHashes:[h(1),h(2)],sourceIdentityKey:fingerprint(input.identity),approvedAt:now}]});
    await write("artifacts/card-orchestrator/state.json",queue);
    assert.equal((await loadCardBacklog({root,now,scans:[]})).cards[0].approvedPrice?.item,proposal.item);
    job.result={identity:{...input.identity,autograph:false,team:"Corrected team"}};
    await write("artifacts/card-orchestrator/state.json",queue);
    assert.equal((await loadCardBacklog({root,now,scans:[]})).cards[0].approvedPrice,null);
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});
