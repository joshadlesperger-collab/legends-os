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
import {registerV2BatchContext,loadV2IdentificationContext,buildV2IdentificationPrompt} from "../lib/card-processing-v2-batch-context.ts";
import {listV2Candidates} from "../lib/card-processing-v2-selection.ts";


async function contextPacket(root:string,ids?:string[]){const instruction={id:'context-authority',text:'Use exact selected original pairs with verified product reference for identification only',taskIds:['v2-next-run-controls-20261103']};const source={url:'https://example.com/verified-checklist',finding:'2025 Pokemon Journey Together; Base; print run 249'};const dir=path.join(root,'artifacts/engineering-mission');await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,'work-queue.json'),JSON.stringify({instructions:[instruction]}));async function write(name:string,x:unknown){const b=JSON.stringify(x),p=`artifacts/${name}.json`;await fs.writeFile(path.join(root,p),b);return{path:p,sha256:createHash('sha256').update(b).digest('hex')};}const candidates=await listV2Candidates(root);return{selection:{mode:'selected',token:candidates.token,candidateIds:ids??[candidates.candidates[0].id]},authority:{instructionId:instruction.id,evidence:await write('context-authority',{instruction})},source:{kind:'verified-reference',evidence:await write('reference',source),sourceUrl:source.url,reviewer:'Independent fixture reviewer',observedAt:new Date().toISOString()},facts:{year:'2025',manufacturer:'Pokemon',product:'Journey Together'},expiresAt:new Date(Date.now()+3600000).toISOString()};}
test('context registration binds only selected immutable pair and prompt preserves per-copy uncertainty',()=>temporary(async(root,folder)=>{await config(root,folder);await initializeV2(root);await pair(folder,'a',10);await pair(folder,'b',20);const p=await contextPacket(root),r=await registerV2BatchContext(root,p);assert.equal(r.registered,1);const files=await scanV2Folder(folder),pairs=pairV2Photos(files,'named').pairs;let contexts=0;for(const photos of pairs){const c=await loadV2IdentificationContext(root,{photos:photos.map((v,n)=>({...v,side:n===0?'front':'back'}))});if(c){contexts++;const prompt=buildV2IdentificationPrompt(c);assert.match(prompt,/Journey Together/);assert.match(prompt,/never infer a numerator/);assert.match(prompt,/not proof/);}}assert.equal(contexts,1);assert.doesNotMatch(buildV2IdentificationPrompt(),/Journey Together|Skewed/);assert.equal((await readV2State(root)).calls.length,0);}));
test('stale selection, unsupported fact, changed evidence and expired context are refused before provider work',()=>temporary(async(root,folder)=>{await config(root,folder);await initializeV2(root);await pair(folder,'a',31);const p=await contextPacket(root);await assert.rejects(registerV2BatchContext(root,{...p,selection:{...p.selection,token:digest('stale')}}),/changed/);await assert.rejects(registerV2BatchContext(root,{...p,facts:{product:'Wrong product'}}),/source/);await registerV2BatchContext(root,p);const photos=pairV2Photos(await scanV2Folder(folder),'named').pairs[0].map((v,n)=>({...v,side:(n===0?'front':'back') as 'front'|'back'}));const ctx=await loadV2IdentificationContext(root,{photos});assert.ok(ctx);await fs.appendFile(path.join(root,p.source.evidence.path),' ');await assert.rejects(loadV2IdentificationContext(root,{photos}),/hash/);await fs.writeFile(path.join(root,p.source.evidence.path),JSON.stringify({url:'https://example.com/verified-checklist',finding:'2025 Pokemon Journey Together; Base; print run 249'}));const file=path.join(v2Dir(root),'batch-contexts',`${ctx!.candidateId}.json`);ctx!.expiresAt=new Date(Date.now()-1).toISOString();await fs.writeFile(file,JSON.stringify(ctx));await assert.rejects(loadV2IdentificationContext(root,{photos}),/Fresh/);assert.equal((await readV2State(root)).calls.length,0);}));
test('worker forwards context only to exact original pair; changed context never repeats completed identification',()=>temporary(async(root,folder)=>{await config(root,folder);await initializeV2(root);await pair(folder,'a',42);await pair(folder,'b',52);let p=await contextPacket(root);await registerV2BatchContext(root,p);const seen:(string|undefined)[]=[];const deps={legacyHashes:noLegacy,identify:async(_images:string[],_settings:unknown,context:any)=>{seen.push(context?.facts.product);return result();}};await runV2(root,'context-run',deps);assert.equal(seen.length,2);assert.equal(seen.filter(v=>v==='Journey Together').length,1);assert.equal(seen.filter(v=>v===undefined).length,1);const before=await readV2State(root);p=await contextPacket(root,(await listV2Candidates(root)).candidates.map(c=>c.id));p.source.reviewer='A different independently retained reviewer';await registerV2BatchContext(root,p);await runV2(root,'context-rerun',deps);assert.equal(seen.length,2);assert.deepEqual((await readV2State(root)).calls,before.calls);}));

test('expired registered context blocks paid work and fresh supported replacement resumes only the unpaid card',()=>temporary(async(root,folder)=>{await config(root,folder);await initializeV2(root);await pair(folder,'a',63);let p=await contextPacket(root);const r=await registerV2BatchContext(root,p),file=path.join(v2Dir(root),'batch-contexts',`${r.contexts[0].candidateId}.json`),c=JSON.parse(await fs.readFile(file,'utf8'));c.expiresAt=new Date(Date.now()-1).toISOString();await fs.writeFile(file,JSON.stringify(c));let count=0;const deps={legacyHashes:noLegacy,identify:async()=>{count++;return result();}};await runV2(root,'stale-context',deps);let state=await readV2State(root);assert.equal(count,0);assert.equal(state.calls.length,0);assert.equal(Object.values(state.cards)[0].issues[0].code,'IDENTIFICATION_CONTEXT');p=await contextPacket(root);await registerV2BatchContext(root,p);await runV2(root,'repaired-context',deps);assert.equal(count,1);state=await readV2State(root);assert.equal(state.calls.length,1);const retained=JSON.parse(await fs.readFile(path.join(v2Dir(root),'identification-results',`${state.calls[0].id}.json`),'utf8'));assert.equal(retained.identificationContext.facts.product,'Journey Together');}));


test('accepted context prompt separates retained source facts from genuine per-copy uncertainty without inheriting a prior parallel',()=>temporary(async(root,folder)=>{
 await config(root,folder);await initializeV2(root);await pair(folder,'one',81);await pair(folder,'unrelated',91);
 const packet=await contextPacket(root);await registerV2BatchContext(root,packet);
 const pairs=pairV2Photos(await scanV2Folder(folder),'named').pairs;let accepted=0,unknown=0;
 for(const pair of pairs){const photos=pair.map((p,n)=>({...p,side:(n===0?'front':'back')as 'front'|'back'})),context=await loadV2IdentificationContext(root,{photos});const prompt=buildV2IdentificationPrompt(context);
 if(context){accepted++;assert.match(prompt,/source provenance are already retained separately/);assert.match(prompt,/Do not repeat supported product facts or source acknowledgements in warnings/);assert.match(prompt,/exact conflicting field or unreadable marking and visual basis/);assert.match(prompt,/retain null identity when required/);assert.match(prompt,/unreadable serial, damage or pairing\/orientation uncertainty/);assert.match(prompt,/shared color or similar parallel name is not proof/);assert.ok(!prompt.includes('Red Prizm'));assert.ok(!prompt.includes('/299'));assert.match(prompt,/never infer a numerator/i);assert.equal(context.facts.parallelDefinitions,undefined);assert.equal(context.facts.product,'Journey Together');}
 else{unknown++;assert.ok(!prompt.includes('Journey Together'));assert.ok(!prompt.includes('Red Prizm'));}
 }
 assert.equal(accepted,1);assert.equal(unknown,1);assert.equal((await readV2State(root)).calls.length,0);
}));
