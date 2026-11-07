import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { digest, type V2Identification, type V2Identity, type V2Card, type V2Payload, type V2Category } from "../lib/card-processing-v2.ts";
import { readV2Config, readV2State, v2Dir, withV2State, type V2Config } from "../lib/card-processing-v2-store.ts";
import { enqueueV2PreparedBrowserJobs, v2Provider429, recoverCompletenessHolds, initializeV2, pairV2Photos, runV2, scanV2Folder, type IdentificationResult } from "../lib/card-processing-v2-worker.ts";
import { newQueue } from "../lib/card-orchestrator.ts";

async function temporary<T>(run: (root: string, folder: string) => Promise<T>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "v2-worker-")), folder = path.join(root, "scans");
  try { await fs.mkdir(folder); return await run(root, folder); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}
function settings(): NonNullable<V2Config["identification"]> {
  return { model: "test-identification-only", authority: "synthetic-unit-test-only", expiresAt: new Date(Date.now() + 86400000).toISOString(),
    pricingSource: "https://example.com/test-cost-bound", inputUsdPerMillion: 1, outputUsdPerMillion: 2,
    maxInputTokens: 10000, maxOutputTokens: 1000, maxRequestBytes: 1000000, capMicros: 1000000 };
}
function identity(name = "Pikachu"): V2Identity {
  return { name, year: "2025", manufacturer: "Pokemon", product: "Journey Together", number: "35", categoryId: "183454",
    language: "English", variant: "Base", artwork: "Pikachu standing", sportOrGame: "Pokemon TCG", team: "", serial: "", graded: false, damage: false, specifics: {} };
}
function finding(overrides: Partial<V2Identification> = {}): V2Identification {
  return { pairMatches: true, frontImageIndex: "0", upright: true, identity: identity(), warnings: [], ...overrides };
}
function result(value = finding()): IdentificationResult { return { finding: value, inputTokens: 100, outputTokens: 50 }; }
async function config(root: string, folder: string, identification = true, categories = false) {
  await fs.mkdir(v2Dir(root), { recursive: true });
  const value = { folder, pairing: "named", batchLimit: 10, ...(identification ? { identification: settings() } : {}),
    categories: categories ? [{ categoryId: "183454", source: "synthetic unit-test category", observedAt: new Date(Date.now() - 1000).toISOString(), requiredAspects: ["Game", "Language", "Character", "Card Number"], allowedValues: {}, conditionId: "4000", conditionDescriptorName: "Card Condition", conditionDescriptorValue: "400010", conditionLabel: "Near mint or better" }] : [] };
  await fs.writeFile(path.join(v2Dir(root), "config.json"), JSON.stringify(value));
}
async function photo(folder: string, filename: string, seed: number) {
  const bytes = await sharp({ create: { width: 40, height: 60, channels: 3, background: { r: seed % 255, g: (seed * 3) % 255, b: (seed * 7) % 255 } } }).png().toBuffer();
  const filenamePath = path.join(folder, filename); await fs.writeFile(filenamePath, bytes);
  const old = new Date(Date.now() - 5000); await fs.utimes(filenamePath, old, old);
  return { path: filenamePath, hash: createHash("sha256").update(bytes).digest("hex") };
}
async function pair(folder: string, prefix: string, seed: number) {
  return [await photo(folder, `${prefix}-front.png`, seed), await photo(folder, `${prefix}-back.png`, seed + 1)];
}
const noLegacy = async () => [];

test('worker overlaps three identification requests and photo uploads without repeating calls or losing reservations', {timeout:15000}, async()=>temporary(async(root,folder)=>{
  await config(root,folder,true,true);await initializeV2(root);
  for(let n=0;n<7;n++)await pair(folder,`parallel-${n}`,30+n*10);
  let identifyActive=0,identifyMax=0,calls=0,photoActive=0,photoMax=0;
  let identifyRelease!:()=>void,photoRelease!:()=>void;
  const identifyGate=new Promise<void>(r=>{identifyRelease=r;}),photoGate=new Promise<void>(r=>{photoRelease=r;});
  const uploaded=new Set<string>();
  const deps={legacyHashes:noLegacy,identify:async()=>{
    const n=calls++;identifyActive++;identifyMax=Math.max(identifyMax,identifyActive);
    if(identifyActive===3)identifyRelease();
    try{await identifyGate;return result(finding({identity:identity(`Card${n}`)}));}finally{identifyActive--;}
  },hostPhoto:async(_bytes:Uint8Array,hash:string)=>{
    assert.equal(uploaded.has(hash),false);uploaded.add(hash);photoActive++;photoMax=Math.max(photoMax,photoActive);
    if(photoActive===3)photoRelease();
    try{await photoGate;return{url:`https://i.ebayimg.com/images/g/${hash}/s-l1600.jpg`,expiresAt:new Date(Date.now()+2*86400000).toISOString()};}finally{photoActive--;}
  }};
  const state=await runV2(root,'bounded-parallel',deps);
  assert.equal(identifyMax,3);assert.equal(photoMax,3);assert.equal(calls,7);assert.equal(uploaded.size,14);
  assert.equal(state.calls.length,7);assert.ok(state.calls.every(c=>c.status==='settled'&&c.actualMicros!==null));
  assert.equal(new Set(state.calls.map(c=>c.key)).size,7);assert.ok(Object.values(state.cards).every(c=>c.stage==='prepared'));
  assert.equal(Object.keys(state.prepared).length,7);
  assert.ok(Object.values(state.media).every(media=>typeof media.orientationHash==='string'),'Internal derivative provenance must stay durable');
  assert.ok(Object.values(state.prepared).every(payload=>payload.photos.every(photo=>!Object.hasOwn(photo,'orientationHash'))),'Internal media metadata must not leak into the strict eBay payload');
  await runV2(root,'parallel-retry',deps);assert.equal(calls,7);assert.equal(uploaded.size,14);
}));

test('bounded uncertain reservation isolates cost while independent cards continue without replay',async()=>temporary(async(root,folder)=>{
  await config(root,folder);await initializeV2(root);await pair(folder,'uncertain-first',171);let calls=0;
  await runV2(root,'unknown-prior',{legacyHashes:noLegacy,identify:async()=>{calls++;throw Error('synthetic provider failure');}});
  for(let n=0;n<4;n++)await pair(folder,`later-${n}`,180+n*10);
  const state=await runV2(root,'unknown-protected',{legacyHashes:noLegacy,identify:async()=>{calls++;return result();}});
  assert.equal(calls,5);assert.equal(state.calls.length,5);assert.equal(state.calls[0].status,'uncertain');assert.equal(state.calls[0].actualMicros,null);
  assert.equal(state.calls.filter(c=>c.status==='settled').length,4);
  await runV2(root,'independent-replay-fenced',{legacyHashes:noLegacy,identify:async()=>{calls++;return result();}});assert.equal(calls,5);
}));

test("first-pass holder advice stays retained and the immutable original result precedes orientation normalization", async () => temporary(async (root, folder) => {
  await config(root, folder, true, true); await initializeV2(root); await pair(folder, "holder", 79);
  const warning = "Surface scratches are visible on the protective holder; card-surface condition cannot be fully assessed through it.";
  let calls = 0;
  const deps = { legacyHashes: noLegacy, identify: async () => { calls++; return result(finding({ frontImageIndex: "1", warnings: [warning] })); },
    hostPhoto: async (_bytes: Uint8Array, hash: string) => ({ url: `https://i.ebayimg.com/images/g/${hash}/s-l1600.jpg`, expiresAt: new Date(Date.now() + 2 * 86400000).toISOString() }) };
  const state = await runV2(root, "first-pass-holder", deps), card = Object.values(state.cards)[0];
  assert.equal(card.stage, "prepared"); assert.deepEqual(card.identification?.warnings, [warning]);
  assert.equal(card.identification?.frontImageIndex, "0");
  const files = await fs.readdir(path.join(v2Dir(root), "identification-results")); assert.equal(files.length, 1);
  const file = path.join(v2Dir(root), "identification-results", files[0]), bytes = await fs.readFile(file, "utf8"), original = JSON.parse(bytes);
  assert.equal(original.callId, state.calls[0].id); assert.equal(original.finding.frontImageIndex, "1"); assert.deepEqual(original.finding.warnings, [warning]);
  await runV2(root, "same-card-retry", deps); assert.equal(calls, 1); assert.equal(await fs.readFile(file, "utf8"), bytes);
}));

test("worker timings inherit run identity and exact card bindings with durable provider failure",async()=>temporary(async(root,folder)=>{
  await config(root,folder);await initializeV2(root);await pair(folder,"timed",211);let injectedCalls=0;
  const state=await runV2(root,"timing-integration",{legacyHashes:noLegacy,identify:async()=>{injectedCalls++;throw Error("synthetic provider failure no external call");}});
  assert.equal(injectedCalls,1);const card=Object.values(state.cards)[0];assert.ok(card);assert.ok(card.issues.some(i=>i.code==="IDENTIFICATION_UNCERTAIN"));
  const timings=state.timings.filter(t=>t.runId==="timing-integration");assert.ok(timings.some(t=>t.step==="scan-intake"&&t.status==="completed"));
  const image=timings.find(t=>t.step==="image-preparation"),provider=timings.find(t=>t.step==="openai-identification"),identify=timings.find(t=>t.step==="identification");
  assert.equal(image?.cardId,card.id);assert.equal(provider?.cardId,card.id);assert.equal(identify?.cardId,card.id);assert.equal(provider?.status,"failed");assert.equal(identify?.status,"completed","wrapper records normal completion of durable uncertainty handling");assert.ok(provider?.durationMs!==undefined);assert.ok(provider?.endedAt);assert.ok(!JSON.stringify(state.timings).includes("synthetic provider failure"));
  const retained=await readV2State(root);assert.deepEqual(retained.timings,state.timings);assert.equal(retained.calls.length,1);assert.equal(retained.calls[0].status,"uncertain");
}));

test("activation protects existing loose scans without moving originals or modifying Listing Factory", async () => temporary(async (root, folder) => {
  await config(root, folder); const old = await pair(folder, "existing", 11);
  const legacyDirectory = path.join(root, "artifacts/card-orchestrator"); await fs.mkdir(legacyDirectory, { recursive: true });
  const legacyFile = path.join(legacyDirectory, "state.json"), legacyBytes = JSON.stringify(newQueue()); await fs.writeFile(legacyFile, legacyBytes);
  assert.deepEqual(await initializeV2(root), { initialized: true, files: 2 });
  let calls = 0;
  const state = await runV2(root, "existing-baseline", { legacyHashes: noLegacy, identify: async () => { calls++; return result(); } });
  assert.equal(calls, 0); assert.equal(Object.keys(state.cards).length, 0);
  assert.deepEqual(state.baseline!.hashes.sort(), old.map(p => p.hash).sort());
  for (const image of old) assert.ok((await fs.stat(image.path)).isFile());
  assert.equal(await fs.readFile(legacyFile, "utf8"), legacyBytes);
  assert.deepEqual(await initializeV2(root), { initialized: false, files: 2 });
}));

test("only newly scanned top-level named pairs enter V2; archive subfolders remain untouched", async () => temporary(async (root, folder) => {
  await config(root, folder); await initializeV2(root);
  await pair(folder, "new", 21); const archived = path.join(folder, "Drafted"); await fs.mkdir(archived); await pair(archived, "old", 31);
  let calls = 0;
  const state = await runV2(root, "new-pairs", { legacyHashes: noLegacy, identify: async images => { calls++; assert.equal(images.length, 2); assert.ok(images.every(image => image.startsWith("data:image/jpeg;base64,"))); return result(); } });
  assert.equal(Object.keys(state.cards).length, 1); assert.equal(calls, 1);
  assert.equal(Object.values(state.cards)[0].stage, "exception");
  assert.ok(Object.values(state.cards)[0].identity, "new pair is identified even while missing completeness evidence is held");
  assert.equal((await fs.readdir(archived)).length, 2);
}));

test("legacy-owned originals and copied files cannot be admitted as additional physical cards", async () => temporary(async (root, folder) => {
  await config(root, folder); await initializeV2(root); const legacy = await pair(folder, "legacy", 41), fresh = await pair(folder, "new", 51);
  for (const side of ["front", "back"]) { const source = fresh.find(p => p.path.includes(`-${side}.`))!; const destination = path.join(folder, `copied-${side}.png`); await fs.copyFile(source.path, destination); const old = new Date(Date.now() - 5000); await fs.utimes(destination, old, old); }
  let calls = 0; const deps = { legacyHashes: async () => [legacy[0].hash], identify: async () => { calls++; return result(); } };
  const first = await runV2(root, "dedup-first", deps), second = await runV2(root, "dedup-restart", deps);
  assert.equal(Object.keys(first.cards).length, 1); assert.equal(Object.keys(second.cards).length, 1);
  assert.equal(calls, 1); assert.equal(second.calls.length, 1);
}));

test("missing or ambiguous named pairs remain unmatched instead of shifting other pairs", () => {
  const p = (filename: string) => ({ path: path.join("scans", filename), hash: digest(filename) });
  const files = [p("01-front.png"), p("02-front.png"), p("02-back.png"), p("03-front.png"), p("03-f.jpg"), p("03-back.png"), p("loose.png")];
  const named = pairV2Photos(files, "named");
  assert.equal(named.pairs.length, 1); assert.equal(path.basename(named.pairs[0][0].path), "02-front.png");
  assert.equal(named.unmatched.length, 5);
  const alternating = pairV2Photos(files, "alternating"); assert.equal(alternating.pairs.length, 3); assert.equal(alternating.unmatched.length, 1);
});

test("existing CardScans front/back filenames bind both card number and six-digit scan session", () => {
  const p = (filename: string) => ({ path: path.join("scans", filename), hash: digest(filename) });
  const files = [p("Card0001B162155.jpg"), p("Card0001F162155.jpg"), p("Card0001B172300.jpg"), p("Card0001F172300.jpg"), p("Card0002B162155.jpg"), p("Card0002F162155.jpg")];
  const grouped = pairV2Photos(files, "named");
  assert.equal(grouped.pairs.length, 3); assert.equal(grouped.unmatched.length, 0);
  assert.deepEqual(grouped.pairs.map(([front, back]) => [path.basename(front.path), path.basename(back.path)]), [
    ["Card0001F162155.jpg", "Card0001B162155.jpg"], ["Card0001F172300.jpg", "Card0001B172300.jpg"], ["Card0002F162155.jpg", "Card0002B162155.jpg"],
  ]);
});

test("mismatched scanner session stamps are never guessed into a physical pair", () => {
  const p = (filename: string) => ({ path: path.join("scans", filename), hash: digest(filename) });
  const files = [p("Card0001F162155.jpg"), p("Card0001B162156.jpg"), p("Card0002F162155.jpg"), p("Card0002B162155.jpg"), p("Card0003F12345.jpg"), p("Card0003B12345.jpg")];
  const grouped = pairV2Photos(files, "named");
  assert.equal(grouped.pairs.length, 1); assert.equal(grouped.unmatched.length, 4);
  assert.equal(path.basename(grouped.pairs[0][0].path), "Card0002F162155.jpg");
});

test("the worker processes actual scanner naming without requiring file renames", async () => temporary(async (root, folder) => {
  await config(root, folder); await initializeV2(root);
  const back = await photo(folder, "Card0001B162155.jpg", 19), front = await photo(folder, "Card0001F162155.jpg", 20); let calls = 0;
  const state = await runV2(root, "actual-scanner-names", { legacyHashes: noLegacy, identify: async () => { calls++; return result(); } });
  assert.equal(calls, 1); const cards = Object.values(state.cards); assert.equal(cards.length, 1);
  assert.deepEqual(cards[0].photos.map(p => p.hash), [front.hash, back.hash]);
  assert.ok(cards[0].identity);
}));

test("unmatched images are visible while independent pairs continue", async () => temporary(async (root, folder) => {
  await config(root, folder); await initializeV2(root); await pair(folder, "good", 61); await photo(folder, "orphan-front.png", 71);
  const state = await runV2(root, "unmatched", { legacyHashes: noLegacy, identify: async () => result() });
  assert.equal(Object.keys(state.cards).length, 1); assert.ok(state.notices.some(n => /1 unmatched image/.test(n)));
}));

test("missing identification configuration makes no provider call and recovers after current setup arrives", async () => temporary(async (root, folder) => {
  await config(root, folder, false); await initializeV2(root); await pair(folder, "new", 81); let calls = 0;
  const deps = { legacyHashes: noLegacy, identify: async () => { calls++; return result(); } };
  const held = await runV2(root, "missing-setup", deps);
  assert.equal(calls, 0); assert.equal(held.calls.length, 0);
  assert.ok(Object.values(held.cards)[0].issues.some(i => i.code === "IDENTIFICATION_SETUP"));
  await config(root, folder, true);
  const resumed = await runV2(root, "configured-setup", deps);
  assert.equal(calls, 1); assert.ok(Object.values(resumed.cards)[0].identity);
}));

test("identification runs once, retains actual token cost and survives repeated processing", async () => temporary(async (root, folder) => {
  await config(root, folder); await initializeV2(root); await pair(folder, "new", 91); let calls = 0;
  const deps = { legacyHashes: noLegacy, identify: async () => { calls++; return result(); } };
  await runV2(root, "identify-once", deps); const state = await runV2(root, "identify-restart", deps);
  assert.equal(calls, 1); assert.equal(state.calls.length, 1);
  assert.equal(state.calls[0].status, "settled"); assert.equal(state.calls[0].actualMicros, 200);
  assert.equal(state.calls[0].inputTokens, 100); assert.equal(state.calls[0].outputTokens, 50);
  assert.equal(state.calls[0].reservedMicros, 12000);
}));
for(const mode of ["settled-actual","actual-cap","unknown"] as const)test(`identification budget uses actual settled usage and fails closed for ${mode}`,async()=>temporary(async(root,folder)=>{
  await config(root,folder);await initializeV2(root);await pair(folder,"budget-new",231);const cfg=JSON.parse(await fs.readFile(path.join(v2Dir(root),"config.json"),"utf8"));cfg.identification.capMicros=2000000;await fs.writeFile(path.join(v2Dir(root),"config.json"),JSON.stringify(cfg));
  await withV2State(s=>{for(let i=0;i<20;i++)s.calls.push({id:`old-${i}`,cardId:`historical-${i}`,key:digest(`old-${i}`),provider:"openai",model:"historical-identification",status:"settled",reservedMicros:100000,actualMicros:mode==="actual-cap"?99500:mode==="unknown"&&i===0?null:11000,at:new Date().toISOString()});},root);
  let calls=0;const state=await runV2(root,`budget-${mode}`,{legacyHashes:noLegacy,identify:async()=>{calls++;return result();}});
  assert.equal(calls,mode==="settled-actual"?1:0);assert.equal(state.calls.length,mode==="settled-actual"?21:20);if(mode!=="settled-actual")assert.ok(Object.values(state.cards)[0].issues.some(i=>i.code==="IDENTIFICATION_BUDGET"));
}));

test("ambiguous identity is held without preventing independent cards from identification", async () => temporary(async (root, folder) => {
  await config(root, folder); await initializeV2(root); await pair(folder, "01-ambiguous", 101); await pair(folder, "02-good", 111); let calls = 0;
  const state = await runV2(root, "independent-cards", { legacyHashes: noLegacy, identify: async () => { calls++; return calls === 1 ? result(finding({ identity: null, warnings: ["Card number unreadable"] })) : result(); } });
  assert.equal(calls, 2); assert.equal(state.calls.filter(c => c.status === "settled").length, 2);
  const cards = Object.values(state.cards);
  assert.equal(cards.filter(c => c.issues.some(i => i.code === "IDENTITY_REVIEW")).length, 1);
  assert.equal(cards.filter(c => c.identity).length, 1);
  await runV2(root, "independent-restart", { legacyHashes: noLegacy, identify: async () => { calls++; return result(); } });
  assert.equal(calls, 2, "unresolved visual holds do not repeat paid calls");
}));

test("provider failure retains uncertain spending and never repeats the call on restart", async () => temporary(async (root, folder) => {
  await config(root, folder); await initializeV2(root); await pair(folder, "new", 121); let calls = 0;
  const deps = { legacyHashes: noLegacy, identify: async () => { calls++; throw Error("synthetic provider failure, no actual external call"); } };
  const first = await runV2(root, "uncertain-call", deps), second = await runV2(root, "uncertain-restart", deps);
  assert.equal(calls, 1); assert.equal(first.calls[0].status, "uncertain"); assert.equal(second.calls[0].status, "uncertain");
  assert.equal(second.calls[0].actualMicros, null);
  assert.ok(Object.values(second.cards)[0].issues.some(i => i.code === "IDENTIFICATION_UNCERTAIN"));
}));

test("interrupted reserved calls become uncertain before any new provider attempt", async () => temporary(async (root, folder) => {
  await config(root, folder); await initializeV2(root); await pair(folder, "new", 131);
  await runV2(root, "initial-admission", { legacyHashes: noLegacy, identify: async () => result() });
  await withV2State(s => { s.calls[0].status = "reserved"; s.calls[0].actualMicros = null; s.lastRun!.status = "running"; s.lastRun!.pid = 2147483647; }, root);
  let calls = 0;
  const state = await runV2(root, "interrupted-resume", { legacyHashes: noLegacy, identify: async () => { calls++; return result(); } });
  assert.equal(calls, 0); assert.equal(state.calls[0].status, "uncertain");
  assert.ok(state.events.some(e => e.stage === "recovery"));
}));

test("configuration, media and category gaps recover from checkpoint without repeating identification", async () => temporary(async (root, folder) => {
  await config(root, folder); await initializeV2(root); await pair(folder, "new", 141); let calls = 0, uploads = 0;
  const identify = async () => { calls++; return result(); };
  const first = await runV2(root, "completeness-gap", { legacyHashes: noLegacy, identify });
  const initial = Object.values(first.cards)[0]; assert.ok(initial.issues.some(i => i.code === "CATEGORY")); assert.ok(initial.issues.some(i => i.code === "PHOTOS"));
  await config(root, folder, true, true);
  const deps = { legacyHashes: noLegacy, identify, hostPhoto: async (_bytes: Uint8Array, hash: string) => { uploads++; return { url: `https://i.ebayimg.com/images/g/${hash}/s-l1600.jpg`, expiresAt: new Date(Date.now() + 3 * 86400000).toISOString() }; } };
  const recovered = await runV2(root, "completeness-recover", deps), final = Object.values(recovered.cards)[0];
  assert.equal(final.stage, "prepared"); assert.deepEqual(final.issues, []); assert.equal(calls, 1); assert.equal(uploads, 2);
  const handoff = JSON.parse(await fs.readFile(path.join(v2Dir(root), "draft-handoff.json"), "utf8"));
  assert.equal(handoff.listings.length, 1); assert.equal(handoff.verifiedInEbay, false); assert.equal(handoff.canPublish, false);
  const handoffBytes = await fs.readFile(path.join(root, handoff.retainedBrowserHandoff.path), "utf8"), retainedHandoff = JSON.parse(handoffBytes);
  assert.equal(createHash("sha256").update(handoffBytes).digest("hex"), handoff.retainedBrowserHandoff.sha256);
  assert.equal(retainedHandoff.runId, "completeness-recover");
  assert.equal(retainedHandoff.status, "awaiting-internal-browser-agent");
  assert.equal(retainedHandoff.attachedExecutor, false); assert.equal(retainedHandoff.completed, false);
  assert.equal(retainedHandoff.jobs.length, 1);
  assert.match(final.nextAction, /Waiting for ChatGPT internal-browser uploader/);
  await assert.rejects(fs.stat(path.join(v2Dir(root), "draft-upload.csv")), { code: "ENOENT" });
  await runV2(root, "completeness-cache-reuse", deps); assert.equal(calls, 1); assert.equal(uploads, 2);
  assert.equal(await fs.readFile(path.join(root, handoff.retainedBrowserHandoff.path), "utf8"), handoffBytes, "a later run cannot overwrite the original browser handoff");
}));

test("exact verified identity knowledge reuses the original pair without a paid identification call", async () => temporary(async (root, folder) => {
  await config(root, folder, false); await initializeV2(root); const images = await pair(folder, "new", 151);
  await withV2State(s => { s.knowledge[digest(images.map(p => p.hash))] = { identity: identity(), photoHashes: images.map(p => p.hash), verifiedAt: new Date().toISOString(), evidence: "synthetic verified pair unit-test fixture" }; }, root);
  let calls = 0;
  const state = await runV2(root, "knowledge-reuse", { legacyHashes: noLegacy, identify: async () => { calls++; return result(); } });
  assert.equal(calls, 0); assert.equal(state.calls.length, 0); assert.ok(Object.values(state.cards)[0].identity);
}));

test("changed originals stop before provider calls and remain an explicit capture exception", async () => temporary(async (root, folder) => {
  await config(root, folder, false); await initializeV2(root); const images = await pair(folder, "new", 161);
  await runV2(root, "admit-originals", { legacyHashes: noLegacy });
  await fs.writeFile(images[0].path, "changed file, deliberately not an image"); await config(root, folder, true); let calls = 0;
  const state = await runV2(root, "changed-original", { legacyHashes: noLegacy, identify: async () => { calls++; return result(); } });
  assert.equal(calls, 0); assert.equal(state.calls.length, 0);
  assert.ok(Object.values(state.cards)[0].issues.some(i => i.code === "ORIGINAL_CHANGED"));
}));

test("scan excludes too-fresh files until stable and never enters archive directories", async () => temporary(async (_root, folder) => {
  await pair(folder, "stable", 171); await fs.mkdir(path.join(folder, "Listed")); await pair(path.join(folder, "Listed"), "archived", 181);
  await fs.writeFile(path.join(folder, "still-writing-front.png"), "partial scanner bytes");
  const scanned = await scanV2Folder(folder); assert.equal(scanned.length, 2); assert.ok(scanned.every(p => path.dirname(p.path) === folder));
}));

test("activation cannot silently omit existing photos that are still within the scanner stability window", async () => temporary(async (root, folder) => {
  await config(root, folder); const images = await pair(folder, "existing-still-writing", 191);
  for (const image of images) { const current = new Date(); await fs.utimes(image.path, current, current); }
  try {
    await initializeV2(root);
  } catch (error) {
    assert.match(error instanceof Error ? error.message : "", /stable|writing|scann|recent|wait/i);
    assert.equal((await readV2State(root)).baseline, undefined, "a refused activation must not create a partial baseline");
    return;
  }
  const state = await readV2State(root);
  assert.ok(state.baseline);
  assert.ok(images.every(image => state.baseline!.hashes.includes(image.hash) || state.baseline!.paths.includes(image.path)), "successful activation must protect every pre-existing loose photo by frozen path or hash");
  for (const image of images) { const stable = new Date(Date.now() - 5000); await fs.utimes(image.path, stable, stable); }
  let calls = 0;
  const processed = await runV2(root, "fresh-baseline-stable-later", { legacyHashes: noLegacy, identify: async () => { calls++; return result(); } });
  assert.equal(Object.keys(processed.cards).length, 0); assert.equal(calls, 0, "stabilization must not turn unfinished old scans into new inventory");
}));

test("previously prepared groups do not starve fresh groups in a later bounded run", async () => temporary(async (root, folder) => {
  await config(root, folder, true, true);
  const filename = path.join(v2Dir(root), "config.json"), settings = JSON.parse(await fs.readFile(filename, "utf8"));
  settings.batchLimit = 1; await fs.writeFile(filename, JSON.stringify(settings));
  await initializeV2(root); await pair(folder, "01-first", 201); let calls = 0;
  const deps = { legacyHashes: noLegacy,
    identify: async () => { calls++; return result(finding({ identity: identity(calls === 1 ? "Pikachu" : "Charmander") })); },
    hostPhoto: async (_bytes: Uint8Array, hash: string) => ({ url: `https://i.ebayimg.com/images/g/${hash}/s-l1600.jpg`, expiresAt: new Date(Date.now() + 3 * 86400000).toISOString() }),
  };
  const first = await runV2(root, "first-bounded-group", deps); assert.equal(Object.values(first.cards)[0].stage, "prepared");
  await pair(folder, "02-second", 211);
  const second = await runV2(root, "second-bounded-group", deps);
  assert.equal(calls, 2); assert.equal(Object.values(second.cards).filter(c => c.stage === "prepared").length, 2, "new groups must progress past old prepared rows");
  const handoff = JSON.parse(await fs.readFile(path.join(v2Dir(root), "draft-handoff.json"), "utf8"));
  assert.equal(handoff.listings.length, 2, "later bounded runs retain all prior prepared payloads");
}));

test("unchanged completeness holds retain their checkpoint without repeating the same preparation attempt", async () => temporary(async (root, folder) => {
  await config(root, folder); await initializeV2(root); await pair(folder, "new", 221); let calls = 0;
  const deps = { legacyHashes: noLegacy, identify: async () => { calls++; return result(); } };
  const first = await runV2(root, "first-completeness-hold", deps), card = Object.values(first.cards)[0];
  assert.equal(card.stage, "exception"); assert.ok(card.completenessInputKey);
  const previousHolds = first.events.filter(e => e.stage === "completeness-held").length;
  assert.equal(previousHolds, 1);
  const next = await runV2(root, "unchanged-completeness-hold", deps), retained = next.cards[card.id];
  assert.equal(calls, 1); assert.equal(retained.updatedAt, card.updatedAt);
  assert.equal(retained.completenessInputKey, card.completenessInputKey);
  assert.equal(next.events.filter(e => e.stage === "completeness-held").length, previousHolds);
}));

test("a new matching original capture updates the local group quantity once and preserves all capture IDs", async () => temporary(async (root, folder) => {
  await config(root, folder, true, true); await initializeV2(root); await pair(folder, "01-first", 231); let calls = 0, uploads = 0;
  const deps = { legacyHashes: noLegacy, identify: async () => { calls++; return result(); },
    hostPhoto: async (_bytes: Uint8Array, hash: string) => { uploads++; return { url: `https://i.ebayimg.com/images/g/${hash}/s-l1600.jpg`, expiresAt: new Date(Date.now() + 3 * 86400000).toISOString() }; },
  };
  const first = await runV2(root, "first-exact-copy", deps); const group = Object.values(first.cards)[0].groupId!;
  assert.equal(first.prepared[group].quantity, 1);
  await pair(folder, "02-second", 241);
  await assert.rejects(runV2(root, "second-exact-copy", deps), /did not finish/);
  const second = await readV2State(root);
  assert.equal(calls, 2); assert.equal(uploads, 2, "eligible exact-copy group reuses its representative pair");
  assert.equal(Object.keys(second.prepared).length, 1); assert.equal(second.prepared[group].quantity, 2);
  assert.deepEqual(second.prepared[group].captureIds, Object.values(second.cards).map(c => c.captureId).sort());
  for(const card of Object.values(second.cards)) assert.equal(card.description,second.prepared[group].description,"prepared duplicate descriptions must exactly match the intent payload");
  assert.match(second.prepared[group].description,/representative copy/);
  const {listV2BrowserJobs}=await import("../lib/card-processing-v2-browser-upload-workflow.ts");
  const oldJob=(await listV2BrowserJobs(root))[0];assert.equal(oldJob.groups[0].payload.quantity,1,"frozen browser scope cannot silently expand to the new copy");
  await withV2State(s=>{ for(const c of Object.values(s.cards)) c.description=Object.values(first.cards)[0].description; },root); // Reproduce the pre-fix staged payload/card mismatch.
  await assert.rejects(runV2(root,"matching-copy-retry",deps),/did not finish/);const third=await readV2State(root);
  assert.equal(calls, 2); assert.equal(third.prepared[group].quantity, 2); assert.equal(third.prepared[group].captureIds.length, 2);
  for(const c of Object.values(third.cards)) assert.equal(c.description,third.prepared[group].description,"retained unsubmitted drift recovers without another identification");
}));

test("expired hosted media invalidates the prepared checkpoint and recovers without reidentification", async () => temporary(async (root, folder) => {
  await config(root, folder, true, true); await initializeV2(root); await pair(folder, "new", 251); let calls = 0, uploads = 0;
  const deps = { legacyHashes: noLegacy, identify: async () => { calls++; return result(); },
    hostPhoto: async (_bytes: Uint8Array, hash: string) => { uploads++; return { url: `https://i.ebayimg.com/images/g/${hash}/s-l1600.jpg`, expiresAt: new Date(Date.now() + 3 * 86400000).toISOString() }; },
  };
  const first = await runV2(root, "valid-media", deps); const card = Object.values(first.cards)[0];
  assert.equal(card.stage, "prepared"); assert.equal(uploads, 2);
  await withV2State(s => { for (const media of Object.values(s.media)) media.expiresAt = new Date(Date.now() - 1000).toISOString(); }, root);
  await assert.rejects(runV2(root,"renew-media",deps),/did not finish/);
  const {listV2BrowserJobs,refreshV2PreparedBrowserJob}=await import("../lib/card-processing-v2-browser-upload-workflow.ts");
  const priorJob=(await listV2BrowserJobs(root))[0];await refreshV2PreparedBrowserJob(root,priorJob.id);
  const renewed = await runV2(root, "renew-media-after-explicit-refresh", deps);
  assert.equal(calls, 1); assert.equal(uploads, 4); assert.equal(renewed.cards[card.id].stage, "prepared");
  assert.ok(Object.values(renewed.media).every(p => Date.parse(p.expiresAt) > Date.now() + 86400000));
}));

test("submission-owned groups never reenter an upload handoff or refresh fields during an uncertain import", async () => temporary(async (root, folder) => {
  await config(root, folder, true, true); await initializeV2(root); await pair(folder, "first", 101);
  let calls = 0, uploads = 0;
  const deps = { legacyHashes: noLegacy, identify: async () => { calls++; return result(); }, hostPhoto: async (_bytes: Uint8Array, hash: string) => {
    uploads++; return { url: `https://i.ebayimg.com/images/g/${hash}/s-l1600.jpg`, expiresAt: new Date(Date.now() + 3 * 86400000).toISOString() };
  } };
  const prepared = await runV2(root, "prepare-once", deps), card = Object.values(prepared.cards)[0], groupId = card.groupId!, key = digest("synthetic-intent-no-external-upload");
  await withV2State(s => {
    s.submissions[key] = { key, groupId, payload: s.prepared[groupId], status: "intent", at: new Date().toISOString() };
    for (const media of Object.values(s.media)) media.expiresAt = new Date(Date.now() - 1000).toISOString();
  }, root);
  const retained = await runV2(root, "uncertain-import-restart", deps);
  assert.equal(calls, 1); assert.equal(uploads, 2, "an owned intent must not rehost or change its frozen fields");
  assert.equal(retained.submissions[key].status, "intent"); assert.deepEqual(retained.submissions[key].payload, prepared.prepared[groupId]);
  const handoff = JSON.parse(await fs.readFile(path.join(v2Dir(root), "draft-handoff.json"), "utf8"));
  assert.deepEqual(handoff.listings, [], "already-owned captures must not be offered for another upload");
  await pair(folder, "second", 111);
  const added = await runV2(root, "additional-copy-after-intent", deps);
  assert.equal(calls, 2); assert.equal(Object.keys(added.submissions).length, 1);
  assert.ok(Object.values(added.cards).some(c => c.issues.some(i => i.code === "EXISTING_GROUP")));
}));

test("a same-run category refresh cannot clear an upload-owned completeness hold", async () => temporary(async (root, folder) => {
  await config(root, folder, true, true); await initializeV2(root); await pair(folder, "owned", 193);
  const initialConfig = JSON.parse(await fs.readFile(path.join(v2Dir(root), "config.json"), "utf8")); let calls = 0;
  const prepared = await runV2(root, "prepare-owned-category-fixture", { legacyHashes: noLegacy, identify: async () => { calls++; return result(); },
    hostPhoto: async (_bytes, hash) => ({ url: `https://i.ebayimg.com/images/g/${hash}/s-l1600.jpg`, expiresAt: new Date(Date.now() + 3 * 86400000).toISOString() }),
  });
  const card = Object.values(prepared.cards)[0], key = digest("owned-category-refresh-fixture");
  await withV2State(s => {
    s.submissions[key] = { key, groupId: card.groupId!, payload: s.prepared[card.groupId!], status: "intent", at: new Date().toISOString() };
    s.cards[card.id].stage = "exception"; s.cards[card.id].issues = [{ code: "CATEGORY", detail: "Frozen upload requires same-operation reconciliation", owner: "Listing completeness" }];
  }, root);
  await config(root, folder, true, false); const before = (await readV2State(root)).cards[card.id]; let categoryReads = 0;
  const after = await runV2(root, "refresh-while-upload-owned", { legacyHashes: noLegacy, identify: async () => { calls++; return result(); }, categoryRequirements: async () => {
    categoryReads++; return { observedAt: new Date().toISOString(), categories: initialConfig.categories.map((category: object) => ({ ...category, source: "A fresh actual-shaped category observation", observedAt: new Date().toISOString() })), capabilities: [], evidence: [] };
  } });
  assert.equal(categoryReads, 1); assert.equal(calls, 1); assert.deepEqual(after.cards[card.id], before);
  assert.equal(after.submissions[key].status, "intent"); assert.deepEqual(after.submissions[key].payload, prepared.prepared[card.groupId!]);
}));

async function seedPreparedGroups(root:string,sizes:number[]){const groups:string[]=[];await withV2State(s=>{for(const[n,size]of Array.from(sizes.entries())){const groupId=digest(['group',n]),at=new Date().toISOString(),cards:V2Card[]=[];for(let copy=0;copy<size;copy++){const id=`group-${n}-copy-${copy}`,i=identity(`Group${n}`),photos:V2Card['photos']=[{path:`${id}-front.png`,hash:digest([id,'front']),side:'front'},{path:`${id}-back.png`,hash:digest([id,'back']),side:'back'}];const card:V2Card={id,sku:id,captureId:digest([id,'capture']),photos,identity:i,identification:finding({identity:i}),stage:'prepared',groupId,condition:'Near mint or better',title:`2025 Group${n}`,description:'Pictured exact card',descriptionSource:'factual',issues:[],nextAction:'Await exact browser job',createdAt:at,updatedAt:at};cards.push(card);s.cards[id]=card;}const payload:V2Payload={sku:cards[0].sku,captureIds:cards.map(c=>c.captureId).sort(),title:cards[0].title,categoryId:'183454',specifics:{Game:['Pokemon TCG']},quantity:size,photos:cards[0].photos.map(p=>({hash:p.hash,url:`https://i.ebayimg.com/images/g/${p.hash}/s-l1600.jpg`,expiresAt:new Date(Date.now()+86400000*3).toISOString(),upright:true})),conditionId:'4000',conditionDescriptorName:'Card Condition',conditionDescriptorValue:'400010',condition:'Near mint or better',description:cards[0].description,descriptionSource:'factual',pricing:'unpriced-grok-pending'};s.prepared[groupId]=payload;groups.push(groupId);}},root);return groups;}
test('worker enqueues fourteen new groups beside six exact retained groups without dropping or replaying old work',()=>temporary(async(root)=>{
 const {enqueueV2BrowserUploadGroups,listV2BrowserJobs}=await import('../lib/card-processing-v2-browser-upload-workflow.ts');const groups=await seedPreparedGroups(root,Array(20).fill(1)),old=(await enqueueV2BrowserUploadGroups(root,groups.slice(0,6)))[0],before=await readV2State(root),jobs=await enqueueV2PreparedBrowserJobs(root,groups);
 assert.equal(jobs.length,2);assert.ok(jobs.some(j=>j.id===old.id));assert.equal(jobs.flatMap(j=>j.groups).length,20);assert.equal(new Set(jobs.flatMap(j=>j.groups.map(g=>g.groupId))).size,20);assert.deepEqual((await listV2BrowserJobs(root)).find(j=>j.id===old.id),old);assert.deepEqual((await readV2State(root)).calls,before.calls);assert.ok(jobs.every(j=>j.stage==='awaiting-reconciliation'&&!j.csvPath&&!j.uploadEvidence));assert.equal((await enqueueV2PreparedBrowserJobs(root,groups)).length,2);assert.equal((await listV2BrowserJobs(root)).length,2);
}));
test('worker packs quantity groups by at most twenty physical captures and rejects oversize single groups',()=>temporary(async(root)=>{
 const groups=await seedPreparedGroups(root,[4,4,4,4,4,4]),jobs=await enqueueV2PreparedBrowserJobs(root,groups);assert.deepEqual(jobs.map(j=>j.groups.reduce((n,g)=>n+g.cardIds.length,0)),[20,4]);assert.equal(jobs.flatMap(j=>j.groups).length,6);
 const other=path.join(root,'oversize');await fs.mkdir(other);const tooMany=await seedPreparedGroups(other,[21]);await assert.rejects(enqueueV2PreparedBrowserJobs(other,tooMany),/at most20/);
}));
test('worker rejects changed payload and foreign partial browser job overlap without silent supersession',()=>temporary(async(root)=>{
 const {enqueueV2BrowserUploadGroups,listV2BrowserJobs}=await import('../lib/card-processing-v2-browser-upload-workflow.ts');const groups=await seedPreparedGroups(root,[1,1,1]),old=(await enqueueV2BrowserUploadGroups(root,groups.slice(0,2)))[0];await assert.rejects(enqueueV2PreparedBrowserJobs(root,[groups[0],groups[2]]),/foreign overlap|changed payload/);await withV2State(s=>{s.prepared[groups[0]].title='Changed prepared identity';},root);await assert.rejects(enqueueV2PreparedBrowserJobs(root,groups),/foreign overlap|changed payload/);assert.deepEqual(await listV2BrowserJobs(root),[old]);assert.equal((await readV2State(root)).calls.length,0);
}));

async function mixedCategoryFixture(root:string,folder:string,failNonSport:boolean){
 await config(root,folder,true,false);const file=path.join(v2Dir(root),'config.json'),configured=JSON.parse(await fs.readFile(file,'utf8'));const observedAt=new Date(Date.now()-86400000).toISOString(),sports:V2Category={categoryId:'261328',source:'Synthetic actual-shaped retained sports metadata',observedAt,requiredAspects:['Language'],allowedValues:{},conditionId:'4000',conditionDescriptorName:'Card Condition',conditionDescriptorValue:'400010',conditionLabel:'Near mint or better'};
 await fs.writeFile(path.join(v2Dir(root),'category-metadata.json'),JSON.stringify({observedAt,categories:[sports],capabilities:[{categoryId:'261328',status:'ready',detail:'Retained sports metadata'}],evidence:[]}));await initializeV2(root);const seeded:V2Card[]=[];for(let n=0;n<55;n++){const p=await pair(folder,`mixed-${n}`,5+n*2),id=`mixed-${n}`,i=identity(n===54?'Captain Hook':`Sports Card${n}`);i.categoryId=n===54?'183050':'261328';i.product=n===54?'Phantom Disney':'Test Sports';i.manufacturer='Panini';i.sportOrGame=n===54?'Disney':'Basketball';i.number=String(n+1);const at=new Date().toISOString();seeded.push({id,sku:id,captureId:digest([id,p[0].hash]),photos:[{...p[0],side:'front'},{...p[1],side:'back'}],identity:i,identification:finding({identity:i}),stage:'identified',condition:'Near mint or better',title:'',description:'',descriptionSource:'factual',issues:[],nextAction:'Prepare',createdAt:at,updatedAt:at});}await withV2State(s=>{for(const c of seeded)s.cards[c.id]=c;},root);
 const {listV2Candidates,resolveV2Selection}=await import('../lib/card-processing-v2-selection.ts'),snapshot=await listV2Candidates(root),selection=await resolveV2Selection(root,{mode:'selected',token:snapshot.token,candidateIds:snapshot.candidates.map(c=>c.id)});let categoryReads=0;
 const state=await runV2(root,'mixed-category-selected55',{selection,legacyHashes:noLegacy,identify:async()=>{throw Error('Settled identity must not be repeated');},hostPhoto:async(_bytes,hash)=>({url:`https://i.ebayimg.com/images/g/${hash}/s-l1600.jpg`,expiresAt:new Date(Date.now()+86400000*3).toISOString()}),categoryRequirements:async ids=>{categoryReads++;assert.deepEqual(ids,['183050']);const time=new Date(Date.now()-1000).toISOString();return{observedAt:time,categories:failNonSport?[]:[{...sports,categoryId:'183050',source:'Synthetic newly acquired non-sport metadata',observedAt:time}],capabilities:[{categoryId:'183050',status:failNonSport?'blocked':'ready',detail:failNonSport?'Read failed':'Non-sport ready'}],evidence:[]};}});
 assert.equal(categoryReads,1);assert.equal(state.calls.length,0);assert.equal(Object.values(state.cards).filter(c=>c.identity?.categoryId==='261328'&&c.stage==='prepared').length,54);assert.equal(state.cards['mixed-54'].stage,failNonSport?'exception':'prepared');if(failNonSport)assert.ok(state.cards['mixed-54'].issues.some(i=>i.code==='CATEGORY'));const report=JSON.parse(await fs.readFile(path.join(v2Dir(root),'category-metadata.json'),'utf8'));assert.equal(report.categories.find((c:any)=>c.categoryId==='261328').observedAt,observedAt);assert.equal(report.capabilityObservedAt['261328'],observedAt);assert.equal(report.categories.length,failNonSport?1:2);assert.equal((await fs.readFile(file,'utf8')),JSON.stringify(configured),'read/merge never rewrites config');
}
test('mixed selected55 preserves54sports while acquiring one non-sport category',()=>temporary(async(root,folder)=>mixedCategoryFixture(root,folder,false)));
test('one category acquisition failure holds only that card while54 retained sports prepare',()=>temporary(async(root,folder)=>mixedCategoryFixture(root,folder,true)));

test('whole pending media scope blocks every identification call when a later original cannot decode',()=>temporary(async(root,folder)=>{
 await config(root,folder);await initializeV2(root);await photo(folder,'good-front.png',31);await photo(folder,'good-back.png',32);await photo(folder,'later-front.png',33);const bad=path.join(folder,'later-back.png');await fs.writeFile(bad,'corrupt image fixture');const old=new Date(Date.now()-5000);await fs.utimes(bad,old,old);let paid=0;
 const state=await runV2(root,'00000000-0000-4000-8000-000000000987',{legacyHashes:async()=>[],identify:async()=>{paid++;return result();}});assert.equal(state.lastRun?.status,'failed');assert.equal(paid,0);assert.equal(state.calls.length,0);const proof=JSON.parse(await fs.readFile(path.join(v2Dir(root),'media-preflight-latest.json'),'utf8'));assert.equal(proof.media.checkedPhotos,4);assert.equal(proof.media.ready,false);assert.equal(proof.providerCalls,0);
}));

test('mixed explicit selection gates known category metadata before spending on any unknown selected card',()=>temporary(async(root,folder)=>{
 await config(root,folder,false);await initializeV2(root);await pair(folder,'known',211);await pair(folder,'unknown',220);await runV2(root,'admit-known-category-fixture',{legacyHashes:noLegacy});await withV2State(s=>{const c=Object.values(s.cards).find(c=>c.photos.some(p=>path.basename(p.path).startsWith('known-')))!;c.identity=identity();c.stage='identified';c.issues=[];},root);await config(root,folder,true,false);
 const {listV2Candidates,resolveV2Selection}=await import('../lib/card-processing-v2-selection.ts');const choices=await listV2Candidates(root),selection=await resolveV2Selection(root,{mode:'all',token:choices.token});assert.equal(selection.captures.length,2);let calls=0;const state=await runV2(root,'known-category-pre-paid-gate',{selection,legacyHashes:noLegacy,identify:async()=>{calls++;return result();}});assert.equal(calls,0);assert.equal(state.calls.length,0);assert.equal(state.lastRun?.status,'failed');const proof=JSON.parse(await fs.readFile(path.join(v2Dir(root),'media-preflight-latest.json'),'utf8'));assert.equal(proof.media.ready,true);assert.equal(proof.categories.ready,false);assert.equal(proof.categories.unknownIdentityPairs,1);
}));


test('accepted real worker automatically retains preparation progress and overdue controller handoff after it exits',()=>temporary(async(root,folder)=>{
 await config(root,folder);await initializeV2(root);const photos=await pair(folder,'activity',233),{randomUUID}=await import('node:crypto'),jobId=randomUUID(),{writeV2ProcessingBatch}=await import('../lib/card-processing-v2-processing-batches.ts'),{candidateId}=await import('../lib/card-processing-v2-selection.ts'),{readV2ActivitySnapshot}=await import('../lib/card-processing-v2-activity.ts');await writeV2ProcessingBatch(root,{jobId,clickedAt:new Date(Date.now()-1000).toISOString(),acceptedAt:new Date().toISOString(),status:'accepted',captures:[{candidateId:candidateId(photos),photos:photos.map((p,n)=>({hash:p.hash,side:n?'back':'front'}))}],baselineCallIds:[]});
 const state=await runV2(root,jobId,{legacyHashes:noLegacy,identify:async()=>result()}),activity=await readV2ActivitySnapshot(root,jobId,new Date(Date.now()+35000).toISOString());assert.equal(state.calls.length,1);assert.equal(state.calls[0].status,'settled');assert.equal(activity.activePhases.length,0);assert.equal(activity.phases[0].phase,'preparation');assert.equal(activity.phases[0].status,'completed');assert.equal(activity.controller?.status,'overdue');assert.ok(activity.phases[0].lastStep.includes('Operation returned'));
}));


test('failure diagnostics omit messages and secrets; exceeded usage keeps independent spending fenced',()=>temporary(async(root,folder)=>{
 await config(root,folder);await initializeV2(root);await pair(folder,'first',241);
 const error=Object.assign(new Error('secret-token must never be retained'),{name:'AI_NoObjectGeneratedError',statusCode:429,usage:{inputTokens:10001,outputTokens:5},response:{headers:{authorization:'secret-token'}}});
 const first=await runV2(root,'exceeded-failure',{legacyHashes:noLegacy,identify:async()=>{throw error;}});
 assert.equal(first.calls[0].failure?.usageBoundExceeded,true);assert.equal(first.calls[0].actualMicros,null);
 const bytes=await fs.readFile(path.join(v2Dir(root),'identification-failures',`${first.calls[0].id}.json`),'utf8'),retained=JSON.parse(bytes);
 assert.equal(retained.errorType,'AI_NoObjectGeneratedError');assert.equal(retained.httpStatus,429);assert.equal(retained.usage.inputTokens,10001);assert.ok(!bytes.includes('secret-token'));assert.ok(!bytes.includes('authorization'));
 await pair(folder,'independent',251);let calls=0;await runV2(root,'exceeded-remains-fenced',{legacyHashes:noLegacy,identify:async()=>{calls++;return result();}});assert.equal(calls,0);
}));

test('queued media checks saved expiry at execution time and never retries an uncertain upload within the run',()=>temporary(async(root,folder)=>{
 await config(root,folder,true,true);await initializeV2(root);const originals=[];for(let n=0;n<3;n++)originals.push(await pair(folder,`expiry-${n}`,120+n*4));const target=originals[2][1].hash,realNow=Date.now,savedExpiry=new Date(Date.now()+36*3600000).toISOString();let offset=0,calls=0,active=0,release!:()=>void;const gate=new Promise<void>(r=>{release=r;}),uploads=new Map<string,number>();
 await withV2State(s=>{s.media[target]={hash:target,url:`https://i.ebayimg.com/images/g/${target}/s-l1600.jpg`,expiresAt:savedExpiry,upright:true};},root);
 Date.now=()=>realNow()+offset;try{const state=await runV2(root,'execution-time-media-expiry',{legacyHashes:noLegacy,identify:async()=>result(finding({identity:identity('Queued '+calls++)})),hostPhoto:async(_bytes,hash)=>{uploads.set(hash,(uploads.get(hash)??0)+1);active++;if(active===3){offset=2*86400000;release();}await gate;if(hash===target)throw Error('Uncertain target upload must not repeat');return{url:`https://i.ebayimg.com/images/g/${hash}/s-l1600.jpg`,expiresAt:new Date(Date.now()+3*86400000).toISOString()};}});assert.equal(uploads.get(target),1);assert.ok(Array.from(uploads.values()).every(n=>n===1));assert.equal(calls,3);assert.ok(Object.values(state.cards).some(c=>c.issues.some(i=>i.code==='PHOTOS')));assert.equal(state.media[target].expiresAt,savedExpiry);}finally{Date.now=realNow;release?.();}
}));


test('documented Panini title alias prepares long basketball identity first pass and repairs only unowned TITLE overflow',()=>temporary(async(root,folder)=>{
 await config(root,folder,true,true);const configPath=path.join(v2Dir(root),'config.json'),raw=JSON.parse(await fs.readFile(configPath,'utf8'));raw.categories[0]={...raw.categories[0],categoryId:'261328',requiredAspects:['Sport','Language','Card Number']};await fs.writeFile(configPath,JSON.stringify(raw));await initializeV2(root);await pair(folder,'nickeil',51);
 const i={...identity('Nickeil Alexander-Walker'),year:'2023-24',manufacturer:'Panini',product:'Prizm Basketball',number:'218',categoryId:'261328' as const,sportOrGame:'Basketball',team:'Minnesota Timberwolves',variant:'Blue Sparkle Prizms',serial:'030/144'};let calls=0;
 const first=await runV2(root,'nickeil-first-pass',{legacyHashes:noLegacy,identify:async()=>{calls++;return result(finding({identity:i}));},hostPhoto:async(_bytes,hash)=>({url:'https://i.ebayimg.com/'+hash+'.jpg',expiresAt:new Date(Date.now()+3*86400000).toISOString()})}),c=Object.values(first.cards)[0];assert.equal(c.stage,'prepared');assert.equal(c.title,'2023-24 Prizm Nickeil Alexander-Walker #218 Blue Sparkle Prizms 030/144');assert.equal(calls,1);
 const full='2023-24 Prizm Basketball Nickeil Alexander-Walker #218 Blue Sparkle Prizms 030/144',cfg=await readV2Config(root),state=structuredClone(first),held=state.cards[c.id];held.title=full;held.stage='exception';held.issues=[{code:'TITLE',detail:'Title exceeds80',owner:'Listing completeness'}];const category=cfg.categories[0];held.completenessInputKey=digest([cfg.inputVersion,Boolean(process.env.DATABASE_URL),held.title,held.description,held.identity,held.identification,category,true,held.photos.map(p=>[p.hash,state.media[p.hash],true])]);
 const foreign={...structuredClone(held),id:'foreign',captureId:'f'.repeat(64)},owned={...structuredClone(held),id:'owned',captureId:'e'.repeat(64),draftId:'123'};state.cards.foreign=foreign;state.cards.owned=owned;const beforeForeign=structuredClone(foreign),beforeOwned=structuredClone(owned);recoverCompletenessHolds(state,cfg,x=>x.id!==foreign.id);assert.equal(held.stage,'consolidated');assert.equal(held.issues.length,0);assert.equal(held.title,c.title);assert.deepEqual(held.identity,i);assert.deepEqual(state.cards.foreign,beforeForeign);assert.deepEqual(state.cards.owned,beforeOwned);
 const short={...structuredClone(c),id:'short',title:'2023-24 Prizm Basketball Nickeil Alexander-Walker #218',issues:[{code:'TITLE',detail:'Other title problem',owner:'Listing completeness'}]};short.completenessInputKey=digest([cfg.inputVersion,Boolean(process.env.DATABASE_URL),short.title,short.description,short.identity,short.identification,category,true,short.photos.map(p=>[p.hash,state.media[p.hash],true])]);state.cards.short=short;recoverCompletenessHolds(state,cfg,x=>x.id==='short');assert.equal(short.issues.length,1);assert.equal(short.title,'2023-24 Prizm Basketball Nickeil Alexander-Walker #218');
}));


test('provider 429 admission drains started work and leaves queued cards uncalled with unknown costs preserved',async()=>temporary(async(root,folder)=>{
  await config(root,folder);await initializeV2(root);
  for(let n=0;n<9;n++)await pair(folder,`quota-${n}`,40+n*10);
  let calls=0;
  await assert.rejects(runV2(root,'quota-circuit',{legacyHashes:noLegacy,identifyOnly:true,identify:async()=>{
    const n=calls++;
    if(n===0)throw Object.assign(Error('SECRET provider text'),{name:'AI_APICallError',statusCode:429,responseBody:JSON.stringify({error:{code:'insufficient_quota',message:'SECRET body'}})});
    await new Promise(r=>setTimeout(r,30));return result();
  }}));
  const state=await readV2State(root);
  assert.ok(calls>=1&&calls<=3);assert.equal(state.calls.length,calls);
  assert.equal(state.calls.filter(c=>c.status==='uncertain').length,1);
  assert.equal(state.calls.find(c=>c.status==='uncertain')?.actualMicros,null);
  assert.equal(state.calls.filter(c=>c.status==='settled').length,calls-1);
  const called=new Set(state.calls.map(c=>c.cardId));
  assert.equal(Object.values(state.cards).filter(c=>!called.has(c.id)&&!c.identity&&!c.issues.length).length,9-calls);
  const dir=path.join(v2Dir(root),'identification-failures'),files=await fs.readdir(dir);
  const body=await fs.readFile(path.join(dir,files[0]),'utf8');
  assert.deepEqual(JSON.parse(body).provider429,{httpStatus:429,providerCode:'insufficient_quota'});
  assert.ok(!body.includes('SECRET'));assert.equal(state.lastRun?.status,'failed');
}));

test('provider 429 diagnostics retain finite codes only and distinguish unknown from non-429',()=>{
  for(const code of ['credit_balance_exhausted','insufficient_quota','rate_limit_exceeded'])
    assert.deepEqual(v2Provider429({statusCode:429,data:{error:{type:code,message:'secret'}}}),{httpStatus:429,providerCode:code});
  assert.deepEqual(v2Provider429({status:429,responseBody:'secret malformed body'}),{httpStatus:429,providerCode:'unknown'});
  assert.equal(v2Provider429({statusCode:500,data:{error:{code:'insufficient_quota'}}}),undefined);
});
