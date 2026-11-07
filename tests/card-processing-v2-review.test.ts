import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { digest, type V2Card, type V2Identification, type V2Payload } from "../lib/card-processing-v2.ts";
import { reviewV2Identity, reconcileV2Usage } from "../lib/card-processing-v2-review.ts";
import { readV2State, v2Dir, withV2State } from "../lib/card-processing-v2-store.ts";
import { initializeV2, runV2 } from "../lib/card-processing-v2-worker.ts";

const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
function finding(): V2Identification { return { pairMatches: true, frontImageIndex: "0", upright: true, warnings: [], identity: {
  name: "Pikachu", year: "2025", manufacturer: "Pokemon", product: "Journey Together", number: "35", categoryId: "183454",
  language: "English", variant: "Base", artwork: "Pikachu standing", sportOrGame: "Pokemon TCG", team: "", serial: "", graded: false, damage: false, specifics: {},
} }; }
async function temporary<T>(run: (root: string, card: V2Card) => Promise<T>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "v2-review-"));
  try {
    const folder = path.join(root, "scans"); await fs.mkdir(folder); const photos: V2Card["photos"] = [];
    for (const [index, side] of Array.from((["front", "back"] as const).entries())) {
      const bytes = await sharp({ create: { width: 30, height: 45, channels: 3, background: { r: index * 100, g: 40, b: 50 } } }).png().toBuffer();
      const filename = path.join(folder, `held-${side}.png`); await fs.writeFile(filename, bytes); const old = new Date(Date.now() - 5000); await fs.utimes(filename, old, old);
      photos.push({ path: filename, hash: sha(bytes), side });
    }
    const card: V2Card = { id: "V2-held", sku: "V2-held", captureId: digest(["review-card", photos[0].hash]), photos, stage: "exception", condition: "Near mint or better", title: "", description: "", descriptionSource: "factual",
      issues: [{ code: "IDENTITY_REVIEW", detail: "Read card number from original", owner: "Identity review" }], nextAction: "Review both originals", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await withV2State(s => { s.cards[card.id] = structuredClone(card); }, root);
    return await run(root, card);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
async function packet<T extends object>(root: string, body: T, name = "review") {
  const relative = `artifacts/reviews/${name}.json`, filename = path.join(root, relative); await fs.mkdir(path.dirname(filename), { recursive: true });
  const bytes = JSON.stringify(body); await fs.writeFile(filename, bytes);
  return { ...body, evidence: { path: relative, sha256: sha(bytes) } };
}
function identityBody(card: V2Card) { return { kind: "original-pair-identity-review" as const, cardId: card.id, reviewer: "Unit test original-pair reviewer", observedAt: new Date().toISOString(), photoHashes: card.photos.map(p => p.hash), finding: finding() }; }
const bound = { authority: "synthetic test accounting", pricingSource: "https://example.com/test-cost-bound", inputUsdPerMillion: 2, outputUsdPerMillion: 3, maxInputTokens: 10000, maxOutputTokens: 1000 };
async function uncertain(root: string, card: V2Card) {
  await withV2State(s => { s.calls.push({ id: "uncertain-call", cardId: card.id, key: digest(["openai-identification-v2", card.photos.map(p => p.hash), "test-identify"]), provider: "openai", model: "test-identify", status: "uncertain", reservedMicros: 23000, actualMicros: null, bound, at: new Date().toISOString() }); }, root);
}
function usageBody() { return { kind: "provider-usage-reconciliation" as const, provider: "openai" as const, callId: "uncertain-call", model: "test-identify", observedAt: new Date().toISOString(), source: "Synthetic attributable billing fixture, no actual provider call", inputTokens: 100, outputTokens: 50 }; }
function payload(card: V2Card): V2Payload { return { sku: card.sku, captureIds: [card.captureId], title: "2025 Journey Together Pikachu #35", categoryId: "183454", specifics: { Game: ["Pokemon TCG"] }, quantity: 1,
  photos: card.photos.map(p => ({ hash: p.hash, url: `https://i.ebayimg.com/images/g/${p.hash}/s-l1600.jpg`, expiresAt: new Date(Date.now() + 3 * 86400000).toISOString(), upright: true })),
  conditionId: "4000", conditionDescriptorName: "Card Condition", conditionDescriptorValue: "400010", condition: "Near mint or better", description: "Pictured card", descriptionSource: "factual", pricing: "unpriced-grok-pending" }; }

test("fresh hash-bound original-pair review resolves ambiguity without another provider call", async () => temporary(async (root, card) => {
  const request = await packet(root, identityBody(card)); const result = await reviewV2Identity(root, request), state = await readV2State(root);
  assert.equal(result.stage, "identified"); assert.deepEqual(state.cards[card.id].identity, finding().identity);
  assert.deepEqual(state.cards[card.id].issues, []); assert.equal(state.calls.length, 0);
  assert.equal(state.cards[card.id].groupId, undefined); assert.ok(state.events.some(e => e.stage === "identity-reviewed"));
}));

test("identity review rejects mismatched capture hashes and changed original bytes", async () => temporary(async (root, card) => {
  const mismatch = identityBody(card); mismatch.photoHashes.reverse();
  await assert.rejects(reviewV2Identity(root, await packet(root, mismatch)), /original pair/);
  const valid = await packet(root, identityBody(card), "changed-original"); await fs.writeFile(card.photos[0].path, "changed after observation");
  await assert.rejects(reviewV2Identity(root, valid), /Original changed/);
  assert.equal((await readV2State(root)).cards[card.id].stage, "exception");
}));

test("identity reviews require non-future observed evidence and confirmed undamaged raw identity", async () => temporary(async (root, card) => {
  const mutations: Array<(body: ReturnType<typeof identityBody>) => void> = [
    body => { body.observedAt = new Date(Date.now() + 60000).toISOString(); },
    body => { body.finding.pairMatches = false; }, body => { body.finding.upright = false; },
    body => { body.finding.frontImageIndex = "unknown"; }, body => { body.finding.warnings = ["Number unreadable"]; },
    body => { body.finding.identity!.damage = true; }, body => { body.finding.identity!.graded = true; },
    body => { body.finding.identity = null; },
  ];
  for (const [index, mutate] of Array.from(mutations.entries())) {
    const body = identityBody(card); mutate(body);
    await assert.rejects(reviewV2Identity(root, await packet(root, body, `invalid-${index}`)), /non-future|Unresolved/);
  }
}));

test("saved drafts and submission intents cannot be reassigned by identity review", async () => temporary(async (root, card) => {
  const request = await packet(root, identityBody(card));
  await withV2State(s => { s.cards[card.id].draftId = "12345"; }, root);
  await assert.rejects(reviewV2Identity(root, request), /original pair/);
  await withV2State(s => { delete s.cards[card.id].draftId; s.cards[card.id].groupId = "existing-group"; const key = digest("submission"); s.submissions[key] = { key, groupId: "existing-group", payload: payload(card), status: "intent", at: new Date().toISOString() }; }, root);
  await assert.rejects(reviewV2Identity(root, request), /original pair/);
}));

test("source, seller and condition holds are retained independently of identity review", async () => temporary(async (root, card) => {
  const request = await packet(root, identityBody(card));
  for (const code of ["SOURCE_HOLD", "SELLER_HOLD", "CONDITION", "ORIGINAL_CHANGED"]) {
    await withV2State(s => { s.cards[card.id].issues = [{ code, detail: "Preserve independent hold", owner: "Seller" }]; }, root);
    await assert.rejects(reviewV2Identity(root, request), /separate source\/condition\/ownership hold/);
    assert.equal((await readV2State(root)).cards[card.id].issues[0].code, code);
  }
}));

test("active V2 execution prevents concurrent identity or accounting reconciliation", async () => temporary(async (root, card) => {
  await uncertain(root, card);
  await withV2State(s => { s.lastRun = { id: "live-worker", pid: process.pid, startedAt: new Date().toISOString(), status: "running" }; }, root);
  await assert.rejects(reviewV2Identity(root, await packet(root, identityBody(card))), /current V2 worker/);
  await assert.rejects(reconcileV2Usage(root, await packet(root, usageBody(), "usage")), /current V2 worker/);
}));

test("review evidence must match its immutable hash and the exact request body", async () => temporary(async (root, card) => {
  const request = await packet(root, identityBody(card)); request.evidence.sha256 = "f".repeat(64);
  await assert.rejects(reviewV2Identity(root, request), /evidence does not match/);
  const changedBody = await packet(root, identityBody(card), "body"); changedBody.reviewer = "Different reviewer";
  await assert.rejects(reviewV2Identity(root, changedBody), /evidence does not match/);
  const changedFile = await packet(root, identityBody(card), "changed-file"); await fs.appendFile(path.join(root, changedFile.evidence.path), " ");
  await assert.rejects(reviewV2Identity(root, changedFile), /evidence does not match/);
}));

test("review evidence paths cannot escape artifacts or use absolute paths", async () => temporary(async (root, card) => {
  for (const unsafe of ["../outside.json", path.join(root, "outside.json"), "scans/held-front.png"]) {
    const request = await packet(root, identityBody(card)); request.evidence.path = unsafe;
    await assert.rejects(reviewV2Identity(root, request), /under artifacts/);
  }
}));

test("uncertain usage settles the exact bounded call without clearing the card's identity review", async () => temporary(async (root, card) => {
  await uncertain(root, card);
  const result = await reconcileV2Usage(root, await packet(root, usageBody(), "usage")), state = await readV2State(root);
  assert.deepEqual(result, { callId: "uncertain-call", actualMicros: 350, repeatsAllowed: false });
  assert.equal(state.calls[0].status, "settled"); assert.equal(state.calls[0].inputTokens, 100); assert.equal(state.calls[0].outputTokens, 50);
  assert.equal(state.cards[card.id].stage, "exception"); assert.ok(state.cards[card.id].issues.some(i => i.code === "IDENTITY_REVIEW"));
  await assert.rejects(reconcileV2Usage(root, await packet(root, usageBody(), "repeat-usage")), /exact retained bounded call/);
}));

test("usage reconciliation refuses wrong call, wrong model, missing historical bound and exceeded token limits", async () => temporary(async (root, card) => {
  await uncertain(root, card);
  const mutations: Array<(body: ReturnType<typeof usageBody>) => void> = [
    body => { body.callId = "another-call"; }, body => { body.model = "another-model"; },
    body => { body.inputTokens = 10001; }, body => { body.outputTokens = 1001; },
  ];
  for (const [index, mutate] of Array.from(mutations.entries())) {
    const body = usageBody(); mutate(body);
    await assert.rejects(reconcileV2Usage(root, await packet(root, body, `bad-usage-${index}`)), /exact retained bounded call/);
  }
  await withV2State(s => { delete s.calls[0].bound; }, root);
  await assert.rejects(reconcileV2Usage(root, await packet(root, usageBody(), "missing-bound")), /exact retained bounded call/);
  assert.equal((await readV2State(root)).calls[0].status, "uncertain");
}));

test("reconciling usage permits an independent card's call while the old paid identification is never replayed", async () => temporary(async (root, card) => {
  const folder = path.dirname(card.photos[0].path); const config = { folder, pairing: "named", batchLimit: 10, categories: [], identification: {
    model: "test-identify", authority: bound.authority, expiresAt: new Date(Date.now() + 86400000).toISOString(), pricingSource: bound.pricingSource,
    inputUsdPerMillion: bound.inputUsdPerMillion, outputUsdPerMillion: bound.outputUsdPerMillion, maxInputTokens: bound.maxInputTokens, maxOutputTokens: bound.maxOutputTokens, maxRequestBytes: 1000000, capMicros: 1000000,
  } };
  await fs.writeFile(path.join(v2Dir(root), "config.json"), JSON.stringify(config)); await initializeV2(root); await uncertain(root, card);
  await reconcileV2Usage(root, await packet(root, usageBody(), "settle-for-independent"));
  for (const [index, side] of Array.from((["front", "back"] as const).entries())) {
    const bytes = await sharp({ create: { width: 30, height: 45, channels: 3, background: { r: 20 + index * 100, g: 90, b: 70 } } }).png().toBuffer();
    const filename = path.join(folder, `new-${side}.png`); await fs.writeFile(filename, bytes); const old = new Date(Date.now() - 5000); await fs.utimes(filename, old, old);
  }
  let calls = 0;
  const state = await runV2(root, "independent-after-reconciliation", { legacyHashes: async () => [], identify: async () => { calls++; return { finding: finding(), inputTokens: 100, outputTokens: 50 }; } });
  assert.equal(calls, 1); assert.equal(state.calls.length, 2); assert.equal(state.calls.filter(c => c.cardId === card.id).length, 1);
  assert.equal(state.calls[0].status, "settled"); assert.ok(state.cards[card.id].issues.some(i => i.code === "IDENTITY_REVIEW"));
}));

test('reviewed corrected identity can recover TITLE only then regenerates title through consolidation/completeness',async()=>temporary(async(root,card)=>{
 await withV2State(s=>{const c=s.cards[card.id];c.identity=finding().identity!;c.title='Old overflowing title '.repeat(8);c.groupId=digest('old-derived-group');c.completenessInputKey=digest('old');c.issues=[{code:'TITLE',detail:'Title exceeds limit',owner:'Completeness'}];},root);
 await reviewV2Identity(root,await packet(root,identityBody(card),'title-recovery'));const s=await readV2State(root),c=s.cards[card.id];assert.equal(c.stage,'identified');assert.equal(c.title,'');assert.equal(c.groupId,undefined);assert.equal(c.completenessInputKey,undefined);assert.equal(c.draftId,undefined);assert.match(c.nextAction,/rerun completeness/);
 const{consolidate,completeness,searchableTitle}=await import('../lib/card-processing-v2.ts');consolidate(s,new Set([card.id]));assert.equal(c.title,searchableTitle(finding().identity!));assert.equal(c.stage,'consolidated');assert.ok(completeness(c,undefined,[]).some(i=>i.code==='CATEGORY'),'review does not bypass remaining completeness');
}));
test('TITLE recovery rejects overflow, placeholder identity, invalid serial and real independent holds',async()=>temporary(async(root,card)=>{
 await withV2State(s=>{s.cards[card.id].issues=[{code:'TITLE',detail:'Overflow',owner:'Completeness'}];},root);
 for(const[which,mutate]of [['overflow',(b:ReturnType<typeof identityBody>)=>{b.finding.identity!.product='Complete supported product name '.repeat(5).trim();}],['placeholder',(b:ReturnType<typeof identityBody>)=>{b.finding.identity!.product='unknown';}],['serial',(b:ReturnType<typeof identityBody>)=>{b.finding.identity!.serial='225/149';}]] as const){const body=identityBody(card);mutate(body);await assert.rejects(reviewV2Identity(root,await packet(root,body,which)),/TITLE remains held|Unresolved identity/);assert.equal((await readV2State(root)).cards[card.id].issues[0].code,'TITLE');}
 for(const code of ['SOURCE_HOLD','CONDITION','UPLOAD_UNCERTAIN','IDENTIFICATION_UNCERTAIN','IDENTIFICATION_BUDGET']){await withV2State(s=>{s.cards[card.id].issues=[{code:'TITLE',detail:'Overflow',owner:'Completeness'},{code,detail:'Preserve separate evidence',owner:'Operator'}];},root);await assert.rejects(reviewV2Identity(root,await packet(root,identityBody(card),'preserve-'+code)),/separate source/);assert.equal((await readV2State(root)).cards[card.id].issues[1].code,code);}
}));


test('reviewed second-image front canonicalizes only working order and preserves original evidence and uncertain accounting',()=>temporary(async(root,card)=>{
 await uncertain(root,card);const before=await readV2State(root),body=identityBody(card);body.finding.frontImageIndex='1';
 const request=await packet(root,body,'honest-second-front'),evidenceBefore=await fs.readFile(path.join(root,request.evidence.path),'utf8');
 await reviewV2Identity(root,request);const after=await readV2State(root),saved=after.cards[card.id];
 assert.deepEqual(saved.photos.map(p=>p.hash),card.photos.map(p=>p.hash).reverse());assert.deepEqual(saved.photos.map(p=>p.side),['front','back']);
 assert.equal(saved.identification?.frontImageIndex,'0');assert.equal(body.finding.frontImageIndex,'1');assert.equal(request.finding.frontImageIndex,'1');
 assert.equal(await fs.readFile(path.join(root,request.evidence.path),'utf8'),evidenceBefore);assert.deepEqual(after.calls,before.calls);assert.equal(saved.captureId,card.captureId);
 for(const photo of saved.photos)assert.equal(sha(await fs.readFile(photo.path)),photo.hash);
 await assert.rejects(reviewV2Identity(root,request),/original pair/);assert.deepEqual((await readV2State(root)).calls,before.calls);
}));

test('front-zero review preserves complete original order and bytes',()=>temporary(async(root,card)=>{
 const before=structuredClone(card.photos);await reviewV2Identity(root,await packet(root,identityBody(card),'already-front-zero'));
 assert.deepEqual((await readV2State(root)).cards[card.id].photos,before);
 for(const photo of before)assert.equal(sha(await fs.readFile(photo.path)),photo.hash);
}));

test('second-front review refuses changed originals and capture-owned submissions even if group metadata is missing',()=>temporary(async(root,card)=>{
 const body=identityBody(card);body.finding.frontImageIndex='1';const request=await packet(root,body,'no-bound-reordering');
 await withV2State(s=>{const key=digest('capture-owner');s.submissions[key]={key,groupId:'another-group',payload:payload(card),status:'intent',at:new Date().toISOString()};},root);
 await assert.rejects(reviewV2Identity(root,request),/original pair/);assert.deepEqual((await readV2State(root)).cards[card.id].photos,card.photos);
 await withV2State(s=>{s.submissions={};},root);await fs.writeFile(card.photos[1].path,'changed source');
 await assert.rejects(reviewV2Identity(root,request),/Original changed/);assert.deepEqual((await readV2State(root)).cards[card.id].photos,card.photos);
}));
test('TITLE plus generated DESCRIPTION recovery accepts corrected CCG collector numbers without bypassing other holds',async()=>temporary(async(root,card)=>{
 const body=identityBody(card);Object.assign(body.finding.identity!,{name:'Houndstone',year:'2024',product:'Trick or Trade',categoryId:'183454',number:'043/091',team:'',serial:''});
 const {factualV2Description}=await import('../lib/card-processing-v2-description.ts');
 await withV2State(s=>{const c=s.cards[card.id];c.identity=structuredClone(body.finding.identity!);c.description=factualV2Description(c.identity);c.descriptionSource='factual';c.issues=[{code:'TITLE',detail:'Old derived title',owner:'Completeness'},{code:'DESCRIPTION',detail:'Old fraction parser rejection',owner:'Completeness'}];},root);
 await reviewV2Identity(root,await packet(root,body,'ccg-generated-description'));assert.equal((await readV2State(root)).cards[card.id].issues.length,0);
 for(const source of ['ebay-ai-reviewed','factual'] as const){await withV2State(s=>{const c=s.cards[card.id];c.descriptionSource=source;c.description='Unsafe fabricated alternate text';c.issues=[{code:'TITLE',detail:'Old',owner:'Completeness'},{code:'DESCRIPTION',detail:'Keep actual defect',owner:'Completeness'}];},root);await assert.rejects(reviewV2Identity(root,await packet(root,body,'reject-description-'+source)),/Generated factual description/);}
}));

test('prepared derivatives resolve orientation while raw review remains honestly sideways',()=>temporary(async(root,card)=>{
 const {registerV2PhotoRotations}=await import('../lib/card-processing-v2-photo-rotation.ts');
 const raw=identityBody(card);raw.finding.upright=false;raw.finding.warnings=['Protective holder reflections limit fine surface inspection. No definite card damage is visible.'];const visual=await packet(root,raw,'raw-sideways');
 await fs.mkdir(path.join(root,'artifacts/engineering-mission'),{recursive:true});await fs.writeFile(path.join(root,'artifacts/engineering-mission/work-queue.json'),JSON.stringify({instructions:[{id:'authority',text:'Prepare only these new scans as drafts',taskIds:['task'],policyRefs:['draft-only-no-publication']}]}));
 const selection=await packet(root,{instructionId:'authority',taskId:'task',captures:[{cardId:card.id,captureId:card.captureId,photos:card.photos}]},'selection');
 const rotation=await packet(root,{kind:'v2-reviewed-original-pair-rotation',instructionId:'authority',taskId:'task',reviewer:'Original photo orientation reviewer',observedAt:new Date().toISOString(),sourceScope:'authorized-new-scans',selection:selection.evidence,rows:[{cardId:card.id,captureId:card.captureId,photos:card.photos.map((p,i)=>({...p,clockwiseDegrees:i?270:0,visualEvidence:visual.evidence}))}]},'rotation');
 await assert.rejects(reviewV2Identity(root,visual),/Unresolved/);await registerV2PhotoRotations(root,rotation.evidence);
 await reviewV2Identity(root,await packet(root,{...raw,preparedOrientation:rotation.evidence},'prepared-review'));
 assert.equal((await readV2State(root)).cards[card.id].identification?.upright,true);assert.equal(JSON.parse(await fs.readFile(path.join(root,visual.evidence.path),'utf8')).finding.upright,false);
}));

test('old immutable identity evidence remains valid without retimestamping or new provider usage',()=>temporary(async(root,card)=>{
 const body={...identityBody(card),observedAt:new Date(Date.now()-7*86400000).toISOString()},request=await packet(root,body,'old-identity'),before=await fs.readFile(path.join(root,request.evidence.path));await reviewV2Identity(root,request);const state=await readV2State(root);assert.equal(state.cards[card.id].identityReview!.observedAt,body.observedAt);assert.equal(state.cards[card.id].identityReview!.sha256,request.evidence.sha256);assert.equal(state.calls.length,0);assert.deepEqual(await fs.readFile(path.join(root,request.evidence.path)),before);
}));
test('old identity evidence still rejects changed bytes, changed ordered ownership and a new submission owner',()=>temporary(async(root,card)=>{
 const body={...identityBody(card),observedAt:new Date(Date.now()-7*86400000).toISOString()},request=await packet(root,body,'old-bound'),original=await fs.readFile(card.photos[0].path);await fs.appendFile(card.photos[0].path,'changed');await assert.rejects(reviewV2Identity(root,request),/Original changed/);await fs.writeFile(card.photos[0].path,original);
 await withV2State(s=>{s.cards[card.id].photos.reverse();},root);await assert.rejects(reviewV2Identity(root,request),/original pair/);await withV2State(s=>{s.cards[card.id].photos.reverse();const key=digest('new-owner');s.submissions[key]={key,groupId:'new-different-group',payload:payload(card),status:'intent',at:new Date().toISOString()};},root);await assert.rejects(reviewV2Identity(root,request),/original pair/);assert.equal((await readV2State(root)).cards[card.id].stage,'exception');
}));
test('provider usage reconciliation keeps its sixty-minute freshness requirement',()=>temporary(async(root,card)=>{
 await uncertain(root,card);const body={...usageBody(),observedAt:new Date(Date.now()-2*3600000).toISOString()};await assert.rejects(reconcileV2Usage(root,await packet(root,body,'old-usage')),/fresh.*sixty minutes/);assert.equal((await readV2State(root)).calls[0].status,'uncertain');
}));
