import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { digest, type V2Identification, type V2Identity } from "../lib/card-processing-v2.ts";
import { readV2State, v2Dir, withV2State, type V2Config } from "../lib/card-processing-v2-store.ts";
import { initializeV2, pairV2Photos, runV2, scanV2Folder, type IdentificationResult } from "../lib/card-processing-v2-worker.ts";
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
import {reconcileV2AdvisoryWarnings} from "../lib/card-processing-v2-advisory-recovery.ts";
import {candidateId} from "../lib/card-processing-v2-selection.ts";

async function held(root:string,folder:string,warning='Card is photographed inside a sleeve and rigid holder; surface marks on the holder cannot reliably be distinguished from marks on the card. No definite card damage is visible.') {await config(root,folder);await initializeV2(root);await pair(folder,'a',74);await runV2(root,'settled-fixture',{legacyHashes:noLegacy,identify:async()=>result(finding({warnings:[warning]}))});const state=await readV2State(root),card=Object.values(state.cards)[0];await withV2State(s=>{const c=s.cards[card.id];delete c.identity;c.stage='exception';c.issues=[{code:'IDENTITY_REVIEW',detail:warning,owner:'Identity review'}];},root);const b=JSON.stringify({captures:[{candidateId:candidateId(card.photos),photos:card.photos}]}),file='artifacts/selection-proof.json';await fs.writeFile(path.join(root,file),b);return{cardIds:[card.id],selectionEvidence:{path:file,sha256:createHash('sha256').update(b).digest('hex')}};}
test('advisory recovery derives exact identity from immutable settled result without repeat call or manual review claim',()=>temporary(async(root,folder)=>{const p=await held(root,folder),before=await readV2State(root),r=await reconcileV2AdvisoryWarnings(root,p),after=await readV2State(root);assert.equal(r.results[0].status,'identified');assert.equal(r.providerCalls,0);assert.equal(r.manualInspectionClaimed,false);assert.deepEqual(after.calls,before.calls);const c=after.cards[p.cardIds[0]];assert.equal(c.identity?.name,'Pikachu');assert.deepEqual(c.identification,before.cards[c.id].identification);assert.equal(c.identityReview,undefined);assert.equal(c.issues.length,0);const again=await reconcileV2AdvisoryWarnings(root,p);assert.equal(again.results[0].status,'already-reconciled');assert.equal((await readV2State(root)).events.filter(e=>e.stage==='advisory-warning-reconciled').length,1);}));
test('real defect uncertainty and separate holds are never cleared',()=>temporary(async(root,folder)=>{const p=await held(root,folder,'The card is photographed inside a sleeve and rigid holder; surface marks and apparent lower-edge wear cannot be reliably distinguished from marks on the protective materials.');assert.equal((await reconcileV2AdvisoryWarnings(root,p)).results[0].status,'held');await withV2State(s=>{s.cards[p.cardIds[0]].issues.push({code:'SOURCE',detail:'source hold',owner:'seller'});},root);const before=await readV2State(root);assert.equal((await reconcileV2AdvisoryWarnings(root,p)).results[0].status,'held');assert.deepEqual((await readV2State(root)).cards,before.cards);}));
test('changed originals, tampered provider finding and foreign selection remain held',()=>temporary(async(root,folder)=>{const p=await held(root,folder),s=await readV2State(root),c=s.cards[p.cardIds[0]];await fs.writeFile(c.photos[0].path,'changed');assert.equal((await reconcileV2AdvisoryWarnings(root,p)).results[0].status,'held');const file=path.join(v2Dir(root),'identification-results',`${s.calls[0].id}.json`),r=JSON.parse(await fs.readFile(file,'utf8'));r.finding.identity.number='999';await fs.writeFile(file,JSON.stringify(r));assert.equal((await reconcileV2AdvisoryWarnings(root,p)).results[0].status,'held');await assert.rejects(reconcileV2AdvisoryWarnings(root,{...p,selectionEvidence:{...p.selectionEvidence,sha256:digest('forged')}}),/hash/);}));

