import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { createHash, randomUUID } from "node:crypto";
import { listV2Candidates, resolveV2Selection, readV2CandidatePhoto } from "../lib/card-processing-v2-selection.ts";
import { initializeV2, runV2, scanV2Folder, pairV2Photos, type IdentificationResult } from "../lib/card-processing-v2-worker.ts";
import { readV2State, withV2State, v2Dir } from "../lib/card-processing-v2-store.ts";
import { digest } from "../lib/card-processing-v2.ts";
import { categoryFromMetadata, type V2CategoryAcquisition } from "../lib/card-processing-v2-category.ts";

async function image(folder: string, filename: string, seed: number) {
  const bytes = await sharp({ create: { width: 32, height: 48, channels: 3, background: { r: seed % 255, g: seed * 3 % 255, b: seed * 7 % 255 } } }).png().toBuffer();
  const full = path.join(folder, filename); await fs.writeFile(full, bytes); const stable = new Date(Date.now() - 5000); await fs.utimes(full, stable, stable);
  return { path: full, hash: createHash("sha256").update(bytes).digest("hex") };
}
async function pair(folder: string, number: number) {
  return [await image(folder, `${number}-front.png`, number * 10), await image(folder, `${number}-back.png`, number * 10 + 1)];
}
async function fixture(run: (root: string, folder: string) => Promise<void>, count = 3) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "v2-selection-")), folder = path.join(root, "scans");
  try {
    await fs.mkdir(folder); await fs.mkdir(v2Dir(root), { recursive: true });
    await fs.writeFile(path.join(v2Dir(root), "config.json"), JSON.stringify({ folder, pairing: "named", batchLimit: 10, categories: [], identification: {
      model: "test-identification-only", authority: "synthetic-selection-test", expiresAt: new Date(Date.now() + 86400000).toISOString(), pricingSource: "https://example.com/test-model-bounds", inputUsdPerMillion: 1, outputUsdPerMillion: 2,
      maxInputTokens: 10000, maxOutputTokens: 1000, maxRequestBytes: 1000000, capMicros: 1000000,
    } }));
    await initializeV2(root); for (let n = 1; n <= count; n++) await pair(folder, n);
    await run(root, folder);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
function result(name = "Pikachu"): IdentificationResult {
  return { inputTokens: 100, outputTokens: 50, finding: { pairMatches: true, frontImageIndex: "0", upright: true, warnings: [], identity: {
    name, year: "2025", manufacturer: "Pokemon", product: "Journey Together", number: "35", categoryId: "183454", language: "English", variant: "Base", artwork: "Base portrait", sportOrGame: "Pokemon TCG", team: "", serial: "", graded: false, damage: false, specifics: {},
  } } };
}
async function seedWaitingCards(root: string, folder: string) {
  const pairs = pairV2Photos(await scanV2Folder(folder), "named").pairs;
  await withV2State(s => {
    for (const [index, photos] of Array.from(pairs.entries())) {
      const id = `V2-existing-${index}`, at = new Date().toISOString();
      s.cards[id] = { id, sku: id, captureId: digest(["selected-seed", photos[0].hash]), photos: [{ ...photos[0], side: "front" }, { ...photos[1], side: "back" }],
        stage: "waiting", condition: "Near mint or better", title: "", description: "", descriptionSource: "factual", issues: [], nextAction: "OpenAI identification", createdAt: at, updatedAt: at };
    }
  }, root);
}

test("candidate listing represents complete immutable pairs with safe display IDs and real snapshot tokens", () => fixture(async (root, folder) => {
  const snapshot = await listV2Candidates(root);
  assert.match(snapshot.token, /^[a-f0-9]{64}$/); assert.equal(snapshot.activationRequired, false); assert.equal(snapshot.candidates.length, 3); assert.equal(snapshot.unmatchedPhotos, 0);
  assert.equal(new Set(snapshot.candidates.map(candidate => candidate.id)).size, 3);
  for (const candidate of snapshot.candidates) { assert.equal(candidate.photoCount, 2); assert.equal(candidate.eligible, true); assert.ok(candidate.label); assert.ok(candidate.frontUrl); assert.ok(candidate.backUrl); assert.ok(!candidate.id.includes(folder)); }
  const resolved = await resolveV2Selection(root, { mode: "selected", token: snapshot.token, candidateIds: [snapshot.candidates[0].id] });
  assert.equal(resolved.captures.length, 1); assert.equal(resolved.candidateIds.length, 1); assert.equal(resolved.captures[0].photos.length, 2);
}));

test("selection rejects unknown IDs, path injection, arbitrary folder overrides and malformed scope", () => fixture(async root => {
  const snapshot = await listV2Candidates(root), known = snapshot.candidates[0].id;
  for (const request of [
    { mode: "selected", token: snapshot.token, candidateIds: ["../../outside/private.png"] },
    { mode: "selected", token: snapshot.token, candidateIds: [digest("unknown-capture")] },
    { mode: "selected", token: snapshot.token, candidateIds: [] },
    { mode: "selected", token: snapshot.token, candidateIds: [known, known] },
    { mode: "selected", token: "invalid", candidateIds: [known] },
    { mode: "selected", token: snapshot.token, candidateIds: [known], folder: "C:/another-folder" },
  ]) await assert.rejects(resolveV2Selection(root, request));
}));

test("changed bytes, new candidates and folder/pairing changes invalidate old tokens", () => fixture(async (root, folder) => {
  const first = await listV2Candidates(root), firstRequest = { mode: "all", token: first.token };
  await pair(folder, 4); await assert.rejects(resolveV2Selection(root, firstRequest), /changed|stale|refresh/i);
  const second = await listV2Candidates(root); await image(folder, "1-front.png", 200);
  await assert.rejects(resolveV2Selection(root, { mode: "all", token: second.token }), /changed|stale|refresh/i);
  const third = await listV2Candidates(root); await withV2State(s => { s.notices.push("A newer operator checkpoint"); }, root);
  assert.equal((await resolveV2Selection(root, { mode: "all", token: third.token })).candidateIds.length, third.candidates.length, "unrelated notices do not change photo selection");
  const fourth = await listV2Candidates(root), filename = path.join(v2Dir(root), "config.json"), config = JSON.parse(await fs.readFile(filename, "utf8")); config.pairing = "alternating"; await fs.writeFile(filename, JSON.stringify(config));
  await assert.rejects(resolveV2Selection(root, { mode: "all", token: fourth.token }), /changed|stale|refresh/i);
}));

test("a half pair cannot be selected or counted as a complete card", () => fixture(async (root, folder) => {
  await image(folder, "orphan-front.png", 97);
  const snapshot = await listV2Candidates(root); assert.equal(snapshot.candidates.length, 0); assert.equal(snapshot.unmatchedPhotos, 1);
  await assert.rejects(resolveV2Selection(root, { mode: "selected", token: snapshot.token, candidateIds: [digest("orphan-front.png")] }));
}, 0));

test("processing one selected pair does not admit or identify other loose pairs", () => fixture(async root => {
  const snapshot = await listV2Candidates(root), chosen = snapshot.candidates[0], selection = await resolveV2Selection(root, { mode: "selected", token: snapshot.token, candidateIds: [chosen.id] });
  let calls = 0;
  const state = await runV2(root, "selected-one-only", { selection, legacyHashes: async () => [], identify: async () => { calls++; return result(); } });
  assert.equal(calls, 1); assert.equal(Object.keys(state.cards).length, 1); assert.equal(state.calls.length, 1);
  assert.equal(state.lastRun!.selection!.photoCount, 2); assert.deepEqual(state.lastRun!.selection!.candidateIds, [chosen.id]);
  const card = Object.values(state.cards)[0]; assert.deepEqual(card.photos.map(photo => photo.hash).sort(), selection.captures[0].photos.map(photo => photo.hash).sort());
  assert.equal((await listV2Candidates(root)).candidates.filter(candidate => candidate.cardId === undefined && candidate.eligible).length, 2);
}));

test("all mode binds exactly the current eligible candidate set and performs no implicit future expansion", () => fixture(async (root, folder) => {
  const snapshot = await listV2Candidates(root), selection = await resolveV2Selection(root, { mode: "all", token: snapshot.token });
  assert.deepEqual([...selection.candidateIds].sort(), snapshot.candidates.filter(candidate => candidate.eligible).map(candidate => candidate.id).sort());
  await pair(folder, 4);
  let calls = 0; await assert.rejects(runV2(root, "stale-all-selection", { selection, legacyHashes: async () => [], identify: async () => { calls++; return result(); } }));
  assert.equal(calls, 0); assert.equal(Object.keys((await readV2State(root)).cards).length, 0);
}));

test("choosing all three pairs processes the complete chosen scope even when automatic batch limit is one", () => fixture(async root => {
  const filename = path.join(v2Dir(root), "config.json"), config = JSON.parse(await fs.readFile(filename, "utf8")); config.batchLimit = 1; await fs.writeFile(filename, JSON.stringify(config));
  const snapshot = await listV2Candidates(root), selection = await resolveV2Selection(root, { mode: "all", token: snapshot.token }); let calls = 0;
  const deps = { legacyHashes: async () => [], identify: async () => { calls++; return result(); } };
  const state = await runV2(root, "explicit-all-exceeds-auto-limit", { ...deps, selection });
  assert.equal(calls, 3); assert.equal(state.calls.length, 3); assert.equal(Object.keys(state.cards).length, 3);
  assert.equal(state.lastRun!.selection!.photoCount, 6); assert.deepEqual([...state.lastRun!.selection!.candidateIds].sort(), [...selection.candidateIds].sort());
  const fresh = await listV2Candidates(root), retry = await resolveV2Selection(root, { mode: "all", token: fresh.token });
  await runV2(root, "explicit-all-no-paid-replay", { ...deps, selection: retry });
  assert.equal(calls, 3, "reprocessing chosen cards cannot repeat completed paid identification");
}));

test("selection cannot override a held card or repeat its already-settled paid identification", () => fixture(async root => {
  const snapshot = await listV2Candidates(root), selection = await resolveV2Selection(root, { mode: "selected", token: snapshot.token, candidateIds: [snapshot.candidates[0].id] }); let calls = 0;
  await runV2(root, "first-selected-paid-call", { selection, legacyHashes: async () => [], identify: async () => { calls++; return result(); } });
  const before = await readV2State(root), id = Object.keys(before.cards)[0];
  await withV2State(s => { s.cards[id].issues = [{ code: "SELLER_HOLD", detail: "Retain condition hold", owner: "Seller" }]; s.cards[id].stage = "exception"; }, root);
  const current = await listV2Candidates(root), held = current.candidates.find(candidate => candidate.cardId === id)!;
  assert.ok(held); assert.equal(held.eligible, false);
  await assert.rejects(resolveV2Selection(root, { mode: "selected", token: current.token, candidateIds: [held.id] }));
  assert.equal(calls, 1); assert.equal((await readV2State(root)).calls.length, 1);
}));

test("processing one existing waiting card leaves every unselected queued card untouched", () => fixture(async (root, folder) => {
  await seedWaitingCards(root, folder);
  const snapshot = await listV2Candidates(root), selected = snapshot.candidates[0], selection = await resolveV2Selection(root, { mode: "selected", token: snapshot.token, candidateIds: [selected.id] });
  const before = await readV2State(root); let calls = 0;
  const after = await runV2(root, "only-existing-selected-card", { selection, legacyHashes: async () => [], identify: async () => { calls++; return result(); } });
  assert.equal(calls, 1); assert.equal(Object.keys(after.cards).length, 3);
  for (const [id, card] of Object.entries(before.cards)) if (id !== selected.cardId) assert.deepEqual(after.cards[id], card, "selection must restrict existing work as well as new intake");
}));

test("an existing quantity group cannot be partially selected", () => fixture(async (root, folder) => {
  await seedWaitingCards(root, folder);
  await withV2State(s => { for (const card of Object.values(s.cards)) card.groupId = "existing-exact-quantity-group"; }, root);
  const snapshot = await listV2Candidates(root);
  await assert.rejects(resolveV2Selection(root, { mode: "selected", token: snapshot.token, candidateIds: [snapshot.candidates[0].id] }), /every card|group/i);
  const all = await resolveV2Selection(root, { mode: "all", token: snapshot.token }); assert.equal(all.candidateIds.length, 3);
}));

test("photo previews bind saved candidate hashes and never accept arbitrary paths", () => fixture(async (root, folder) => {
  const snapshot = await listV2Candidates(root), candidate = snapshot.candidates[0];
  const jpeg = await readV2CandidatePhoto(root, snapshot.token, candidate.id, "front"); assert.equal(jpeg[0], 255); assert.equal(jpeg[1], 216);
  await assert.rejects(readV2CandidatePhoto(root, "../outside", candidate.id, "front"));
  await assert.rejects(readV2CandidatePhoto(root, snapshot.token, "../outside", "front"));
  await image(folder, "1-front.png", 240);
  await assert.rejects(readV2CandidatePhoto(root, snapshot.token, candidate.id, "front"), /changed/i);
}));

test("selected processing handoffs cannot include unselected previously prepared cards", () => fixture(async root => {
  const filename = path.join(v2Dir(root), "config.json"), config = JSON.parse(await fs.readFile(filename, "utf8"));
  config.categories = [{ categoryId: "183454", source: "Synthetic exact category fixture", observedAt: new Date().toISOString(), requiredAspects: ["Game", "Language", "Character", "Card Number"], allowedValues: {}, conditionId: "4000", conditionDescriptorName: "Card Condition", conditionDescriptorValue: "400010", conditionLabel: "Near mint or better" }];
  await fs.writeFile(filename, JSON.stringify(config));
  const hostPhoto = async (_bytes: Uint8Array, hash: string) => ({ url: `https://i.ebayimg.com/${hash}.jpg`, expiresAt: new Date(Date.now() + 3 * 86400000).toISOString() });
  const initial = await listV2Candidates(root), firstSelection = await resolveV2Selection(root, { mode: "selected", token: initial.token, candidateIds: [initial.candidates[0].id] });
  await runV2(root, "prepare-first-selection", { selection: firstSelection, legacyHashes: async () => [], hostPhoto, identify: async () => result("Pikachu") });
  const current = await listV2Candidates(root), secondCandidate = current.candidates.find(candidate => candidate.cardId === undefined)!;
  const secondSelection = await resolveV2Selection(root, { mode: "selected", token: current.token, candidateIds: [secondCandidate.id] });
  const state = await runV2(root, "prepare-second-selection", { selection: secondSelection, legacyHashes: async () => [], hostPhoto, identify: async () => result("Charmander") });
  assert.equal(Object.keys(state.prepared).length, 2, "previous prepared work remains retained");
  const handoff = JSON.parse(await fs.readFile(path.join(v2Dir(root), "draft-handoff.json"), "utf8"));
  assert.equal(handoff.listings.length, 1, "only the chosen scope can proceed downstream from this run");
  const selectedHashes = secondSelection.captures[0].photos.map(photo => photo.hash).sort();
  const selectedCard = Object.values(state.cards).find(card => digest(card.photos.map(photo => photo.hash).sort()) === digest(selectedHashes))!;
  assert.deepEqual(handoff.listings[0].captureIds, [selectedCard.captureId]);
  const pricing = JSON.parse(await fs.readFile(path.join(v2Dir(root), "pricing-handoff.json"), "utf8"));
  assert.deepEqual(pricing.cards.map((card: { cardId: string }) => card.cardId), [selectedCard.id]);
}));

test("new live-shaped category metadata recovers selected completeness holds in the same invocation only", () => fixture(async root => {
  const initial = await listV2Candidates(root), initialSelection = await resolveV2Selection(root, { mode: "selected", token: initial.token, candidateIds: initial.candidates.slice(0, 2).map(candidate => candidate.id) });
  let identifyCalls = 0, uploads = 0, categoryCalls = 0;
  const hostPhoto = async (_bytes: Uint8Array, hash: string) => { uploads++; return { url: `https://i.ebayimg.com/images/g/${hash}/s-l1600.jpg`, expiresAt: new Date(Date.now() + 3 * 86400000).toISOString() }; };
  const identify = async () => {
    const identified = result(`Player ${++identifyCalls}`); Object.assign(identified.finding.identity!, { categoryId: "261328", sportOrGame: "Football", manufacturer: "Panini", product: "Donruss Optic" }); return identified;
  };
  const held = await runV2(root, "category-missing-before-refresh", { selection: initialSelection, legacyHashes: async () => [], hostPhoto, identify });
  assert.equal(Object.keys(held.cards).length, 2); assert.equal(identifyCalls, 2); assert.equal(uploads, 4);
  assert.ok(Object.values(held.cards).every(card => card.stage === "exception" && card.issues.some(issue => issue.code === "CATEGORY")));
  const next = await listV2Candidates(root), chosen = next.candidates.find(candidate => candidate.cardId !== undefined)!, selection = await resolveV2Selection(root, { mode: "selected", token: next.token, candidateIds: [chosen.id] });
  const before = await readV2State(root), unselected = Object.values(before.cards).find(card => card.id !== chosen.cardId)!;
  const categoryRequirements = async (ids: ("183454" | "261328" | "183050")[]): Promise<V2CategoryAcquisition> => {
    categoryCalls++; assert.deepEqual(ids, ["261328"]);
    const observedAt = new Date().toISOString(), aspects = { aspects: [
      { localizedAspectName: "Sport", aspectConstraint: { aspectRequired: true, aspectMode: "FREE_TEXT", aspectUsage: "RECOMMENDED" }, aspectValues: [{ localizedValue: "Football" }] },
      { localizedAspectName: "Player/Athlete", aspectConstraint: { aspectRequired: false, aspectMode: "FREE_TEXT", aspectUsage: "RECOMMENDED" }, aspectValues: Array.from({ length: 29797 }, (_, index) => ({ localizedValue: `Player ${index}` })) },
    ] }, policies = { itemConditionPolicies: [{ categoryId: "261328", categoryTreeId: "0", itemConditionRequired: true, itemConditions: [{ conditionId: "4000", conditionDescription: "Ungraded", conditionDescriptors: [{ conditionDescriptorId: "40001", conditionDescriptorName: "Card Condition", conditionDescriptorConstraint: { cardinality: "SINGLE", mode: "SELECTION_ONLY", usage: "REQUIRED" }, conditionDescriptorValues: [{ conditionDescriptorValueId: "400010", conditionDescriptorValueName: "Near mint or better" }] }] }] }] };
    const adapted = categoryFromMetadata("261328", "0", aspects, policies, observedAt);
    return { observedAt, categories: [adapted.category], capabilities: [adapted.capability], evidence: [{ resource: "category-aspects", observedAt, url: "https://api.ebay.com/commerce/taxonomy/v1/category_tree/0/get_item_aspects_for_category?category_id=261328", body: aspects, sha256: digest(aspects) }] };
  };
  const recovered = await runV2(root, "selected-category-single-pass-recovery", { selection, legacyHashes: async () => [], hostPhoto, identify, categoryRequirements });
  assert.equal(categoryCalls, 1); assert.equal(identifyCalls, 2, "new metadata must not repeat successful paid identification"); assert.equal(uploads, 4, "existing reviewed hosted media must be reused");
  assert.equal(recovered.cards[chosen.cardId!].stage, "prepared"); assert.deepEqual(recovered.cards[chosen.cardId!].issues, []);
  assert.deepEqual(recovered.cards[unselected.id], unselected, "a shared category refresh does not recover or mutate unselected work");
  assert.equal(Object.keys(recovered.cards).length, 2, "unselected loose captures must not be admitted during recovery");
  assert.equal(recovered.calls.length, before.calls.length);
  const handoff = JSON.parse(await fs.readFile(path.join(v2Dir(root), "draft-handoff.json"), "utf8")); assert.equal(handoff.listings.length, 1);
  assert.deepEqual(handoff.listings[0].captureIds, [recovered.cards[chosen.cardId!].captureId]);
}));

test('exact selection recovers only never-sent budget holds after settled fresh headroom, preserving paid calls',()=>fixture(async(root,folder)=>{
  await seedWaitingCards(root,folder);
  await withV2State(s=>{for(const c of Object.values(s.cards)){c.stage='exception';c.issues=[{code:'IDENTIFICATION_BUDGET',detail:'Synthetic exhausted budget',owner:'Provider accounting'}];}},root);
  const initial=await readV2State(root),ids=Object.keys(initial.cards);
  await withV2State(s=>{const c=s.cards[ids[2]];s.calls.push({id:'prior-paid',cardId:c.id,key:digest(['openai-identification-v2',c.photos.map(p=>p.hash),'test-identification-only']),provider:'openai',model:'test-identification-only',status:'settled',reservedMicros:12000,actualMicros:200,at:new Date().toISOString()});},root);
  let snapshot=await listV2Candidates(root);assert.equal(snapshot.candidates.filter(c=>c.eligible).length,2);assert.equal(snapshot.candidates.find(c=>c.cardId===ids[2])!.eligible,false);
  const chosen=snapshot.candidates.find(c=>c.cardId===ids[0])!;
  const selection=await resolveV2Selection(root,{mode:'selected',token:snapshot.token,candidateIds:[chosen.id]});let calls=0;
  const state=await runV2(root,'budget-selected-recovery',{selection,legacyHashes:async()=>[],identify:async()=>{calls++;return result();}});
  assert.equal(calls,1);assert.ok(state.cards[ids[0]].identity);assert.equal(state.cards[ids[1]].issues[0].code,'IDENTIFICATION_BUDGET');assert.equal(state.cards[ids[2]].issues[0].code,'IDENTIFICATION_BUDGET');assert.equal(state.calls.find(c=>c.id==='prior-paid')!.actualMicros,200);assert.equal(state.calls.length,2);
  await runV2(root,'unscoped-no-budget-release',{legacyHashes:async()=>[],identify:async()=>{calls++;return result();}});assert.equal(calls,1);
}));

test('budget selection retains holds with expired authority, insufficient funds, uncertain usage or separate holds',()=>fixture(async(root,folder)=>{
  await seedWaitingCards(root,folder);await withV2State(s=>{for(const c of Object.values(s.cards)){c.stage='exception';c.issues=[{code:'IDENTIFICATION_BUDGET',detail:'Synthetic budget hold',owner:'Provider accounting'}];}},root);
  const filename=path.join(v2Dir(root),'config.json'),original=JSON.parse(await fs.readFile(filename,'utf8'));
  for(const patch of [{capMicros:1},{expiresAt:new Date(Date.now()-1000).toISOString()}]){await fs.writeFile(filename,JSON.stringify({...original,identification:{...original.identification,...patch}}));assert.equal((await listV2Candidates(root)).candidates.some(c=>c.eligible),false);}
  await fs.writeFile(filename,JSON.stringify(original));
  await withV2State(s=>{s.calls.push({id:'uncertain-other',cardId:'foreign',key:'f'.repeat(64),provider:'openai',model:'test-identification-only',status:'uncertain',reservedMicros:12000,actualMicros:null,at:new Date().toISOString()});},root);
  assert.equal((await listV2Candidates(root)).candidates.some(c=>c.eligible),false);
  await withV2State(s=>{const {authority,pricingSource,inputUsdPerMillion,outputUsdPerMillion,maxInputTokens,maxOutputTokens}=original.identification;s.calls[0].bound={authority,pricingSource,inputUsdPerMillion,outputUsdPerMillion,maxInputTokens,maxOutputTokens};},root);
  assert.equal((await listV2Candidates(root)).candidates.filter(c=>c.eligible).length,3,'valid worst-case reservation isolates unknown prior actual cost');
  await withV2State(s=>{s.calls[0].cardId='V2-existing-0';},root);
  assert.equal((await listV2Candidates(root)).candidates.filter(c=>c.eligible).length,2,'the charged physical card remains fenced');
  await withV2State(s=>{s.calls[0].status='settled';s.calls[0].actualMicros=200;for(const c of Object.values(s.cards))c.issues.push({code:'IDENTITY_REVIEW',detail:'Separate ambiguity',owner:'Identity review'});},root);
  assert.equal((await listV2Candidates(root)).candidates.some(c=>c.eligible),false);
}));

test("named ready scope is explicit, UUID-bound and cannot combine with a legacy transfer",()=>fixture(async root=>{
 const current=await listV2Candidates(root),known=current.candidates[0].id;
 for(const scope of [{readyBatchId:'../../arbitrary-folder'},{readyBatchId:randomUUID(),sourceTransferId:'legacy-transfer'}])await assert.rejects(resolveV2Selection(root,{mode:'selected',token:current.token,candidateIds:[known],...scope}));
}));


test("unrelated card, timing and import checkpoints preserve selection token and its retained evidence",()=>fixture(async(root,folder)=>{
  await seedWaitingCards(root,folder);
  await withV2State(s=>{const card=Object.values(s.cards)[0];s.cards['unrelated-outside-folder']={...structuredClone(card),id:'unrelated-outside-folder',sku:'unrelated-outside-folder',captureId:digest('outside-capture'),photos:card.photos.map((p,n)=>({...p,path:path.join(root,'outside-'+n+'.png'),hash:digest('outside-'+n)}))};},root);
  const before=await listV2Candidates(root),file=path.join(v2Dir(root),'selections',before.token+'.json'),savedBytes=await fs.readFile(file),revision=(await readV2State(root)).revision;
  await withV2State(s=>{const at=new Date().toISOString();s.cards['unrelated-outside-folder'].nextAction='Unrelated draft import completed';s.cards['unrelated-outside-folder'].updatedAt=at;s.events.push({at,stage:'import-recorded',detail:'Unrelated background upload result checkpoint',cardId:'unrelated-outside-folder'});s.timings.push({id:'unrelated-import-timing',step:'import-results',cardId:'unrelated-outside-folder',runId:'unrelated-run',pid:process.pid,startedAt:at,endedAt:at,durationMs:0,status:'completed'});},root);
  assert.ok((await readV2State(root)).revision>revision);
  const after=await listV2Candidates(root);assert.equal(after.token,before.token);
  assert.deepEqual(await fs.readFile(file),savedBytes,'same retained snapshot is never rewritten');
  const legacy=JSON.parse(savedBytes.toString('utf8'));legacy.content.revision=revision;legacy.token=digest(legacy.content);const legacyFile=path.join(v2Dir(root),'selections',legacy.token+'.json'),legacyBytes=Buffer.from(JSON.stringify(legacy));await fs.writeFile(legacyFile,legacyBytes,{flag:'wx'});assert.equal((await readV2CandidatePhoto(root,legacy.token,before.candidates[0].id,'front'))[0],255);assert.deepEqual(await fs.readFile(legacyFile),legacyBytes,'historical revision-bearing snapshot remains valid against its own hash');
  assert.equal((await resolveV2Selection(root,{mode:'selected',token:before.token,candidateIds:[before.candidates[0].id]})).captures.length,1);
}));

test("actual selected status, ownership and model configuration still invalidate selection",()=>fixture(async(root,folder)=>{
  await seedWaitingCards(root,folder);let before=await listV2Candidates(root);const cardId=before.candidates[0].cardId!;
  await withV2State(s=>{s.cards[cardId].issues=[{code:'SELLER_HOLD',detail:'Exact card held',owner:'Seller'}];s.cards[cardId].stage='exception';},root);
  await assert.rejects(resolveV2Selection(root,{mode:'selected',token:before.token,candidateIds:[before.candidates[0].id]}),/changed|refresh/i);
  before=await listV2Candidates(root);await withV2State(s=>{s.cards[cardId].issues=[];s.cards[cardId].stage='waiting';s.cards[cardId].groupId='new-exact-quantity-owner';},root);
  await assert.rejects(resolveV2Selection(root,{mode:'all',token:before.token}),/changed|refresh/i);
  before=await listV2Candidates(root);await withV2State(s=>{s.cards[cardId].draftId='123456789012';},root);
  await assert.rejects(resolveV2Selection(root,{mode:'all',token:before.token}),/changed|refresh/i);
  before=await listV2Candidates(root);const configFile=path.join(v2Dir(root),'config.json'),config=JSON.parse(await fs.readFile(configFile,'utf8'));config.identification.model='changed-supported-model';await fs.writeFile(configFile,JSON.stringify(config));
  await assert.rejects(resolveV2Selection(root,{mode:'all',token:before.token}),/changed|refresh/i);
}));
