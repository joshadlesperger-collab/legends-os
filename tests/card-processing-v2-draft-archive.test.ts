import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { digest, type V2Card, type V2Payload } from "../lib/card-processing-v2.ts";
import { archiveV2DraftPhotos, recoverV2DraftArchives, resolveV2ArchivedPhoto } from "../lib/card-processing-v2-draft-archive.ts";
import { readV2State, withV2State, v2Dir } from "../lib/card-processing-v2-store.ts";
import { runV2 } from "../lib/card-processing-v2-worker.ts";
const sha=(b:string)=>createHash("sha256").update(b).digest("hex");
async function fixture(run:(root:string,card:V2Card,authority:any)=>Promise<void>){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"v2-draft-archive-")),folder=path.join(root,"scans"),at=new Date().toISOString();
  try{await fs.mkdir(folder);const photos:V2Card["photos"]=[];for(const side of ["front","back"] as const){const file=path.join(folder,`${side}.jpg`);await fs.writeFile(file,side);photos.push({path:file,hash:sha(side),side});}
  const c:V2Card={id:"card",sku:"card",captureId:digest("capture"),photos,stage:"prepared",condition:"Near mint or better",groupId:"group",draftId:"1234",title:"Title",description:"Original",descriptionSource:"factual",issues:[],nextAction:"Partial",createdAt:at,updatedAt:at,nonpriceVerification:{scope:"non-price-fields",observedAt:at,evidence:"artifacts/review#hash",draftId:"1234",pricing:"deferred-preserved"},identity:{name:"Player",year:"2025",manufacturer:"Panini",product:"Optic",number:"1",categoryId:"261328",language:"English",variant:"Blue",artwork:"Player",sportOrGame:"Basketball",team:"Team",serial:"",graded:false,damage:false,specifics:{}}};
  const payload:V2Payload={sku:c.sku,captureIds:[c.captureId],title:c.title,categoryId:"261328",specifics:{Sport:["Basketball"]},quantity:1,photos:photos.map(p=>({hash:p.hash,url:`https://i.ebayimg.com/images/g/${p.hash}/s-l1600.jpg`,expiresAt:at,upright:true})),conditionId:"4000",conditionDescriptorName:"Card Condition",conditionDescriptorValue:"400010",condition:c.condition,description:c.description,descriptionSource:"factual",pricing:"unpriced-grok-pending"};
  await withV2State(s=>{s.cards[c.id]=c;s.submissions[digest("intent")]={key:digest("intent"),groupId:c.groupId!,payload,status:"submitted",draftId:c.draftId,at};},root);await fs.writeFile(path.join(v2Dir(root),"config.json"),JSON.stringify({folder}));
  const instruction={id:"archive-authority",text:"Move the five completed original pairs to Drafted",taskIds:["v2-draft-archive-enforcement-20261103"]};const bytes=JSON.stringify({instruction}),relative="artifacts/authority.json";await fs.writeFile(path.join(root,relative),bytes);await fs.mkdir(path.join(root,"artifacts","engineering-mission"));await fs.writeFile(path.join(root,"artifacts","engineering-mission","work-queue.json"),JSON.stringify({instructions:[instruction]}));await run(root,c,{instructionId:"archive-authority",evidence:{path:relative,sha256:sha(bytes)}});
  }finally{await fs.rm(root,{recursive:true,force:true});}
}
test("verified partial draft pair moves with hashes and original capture references preserved; retry idempotent",()=>fixture(async(root,c,a)=>{
  const before=await readV2State(root);assert.deepEqual(await archiveV2DraftPhotos(root,[c.id],a),[{cardId:c.id,status:"moved"}]);const after=await readV2State(root),moved=after.cards[c.id];assert.equal(moved.draftArchive?.status,"moved");assert.deepEqual(moved.photos,c.photos);assert.deepEqual(after.submissions,before.submissions);assert.equal(moved.stage,"prepared");assert.equal(moved.verification,undefined);
  for(const p of c.photos){await assert.rejects(fs.stat(p.path),{code:"ENOENT"});assert.equal(sha(await fs.readFile(await resolveV2ArchivedPhoto(root,moved,p),"utf8")),p.hash);}
  const events=after.events.length;await archiveV2DraftPhotos(root,[c.id],a);assert.equal((await readV2State(root)).events.length,events);assert.deepEqual(await recoverV2DraftArchives(root),[]);
}));
test("changed original blocks both removals",()=>fixture(async(root,c,a)=>{
  await fs.writeFile(c.photos[1].path,"changed");assert.equal((await archiveV2DraftPhotos(root,[c.id],a))[0].status,"held");assert.equal(await fs.readFile(c.photos[0].path,"utf8"),"front");assert.equal(await fs.readFile(c.photos[1].path,"utf8"),"changed");
}));
test("exclusive destination conflict preserves originals and unrelated bytes",()=>fixture(async(root,c,a)=>{
  const dir=path.join(path.dirname(c.photos[0].path),"Drafted",c.draftId!);await fs.mkdir(dir,{recursive:true});const dest=path.join(dir,`front-${c.photos[0].hash}.jpg`);await fs.writeFile(dest,"foreign");assert.equal((await archiveV2DraftPhotos(root,[c.id],a))[0].status,"held");assert.equal(await fs.readFile(dest,"utf8"),"foreign");for(const p of c.photos)await fs.stat(p.path);assert.equal((await readV2State(root)).cards[c.id].draftArchive?.status,"held");
}));
test("durable copied checkpoint recovers missing source without second inventory count",()=>fixture(async(root,c,a)=>{
  await archiveV2DraftPhotos(root,[c.id],a);await withV2State(s=>{s.cards[c.id].draftArchive!.status="copied";},root);assert.deepEqual(await recoverV2DraftArchives(root),[{cardId:c.id,status:"moved"}]);assert.equal((await readV2State(root)).submissions[digest("intent")].payload.quantity,1);
}));
test("seller hold, missing saved receipt and forged authority preserve originals",()=>fixture(async(root,c,a)=>{
  await assert.rejects(archiveV2DraftPhotos(root,[c.id],{...a,evidence:{...a.evidence,sha256:digest("wrong")}}),/hash/);await withV2State(s=>{s.cards[c.id].issues.push({code:"SELLER",detail:"hold",owner:"seller"});},root);assert.equal((await archiveV2DraftPhotos(root,[c.id],a))[0].status,"held");for(const p of c.photos)await fs.stat(p.path);
  await withV2State(s=>{s.cards[c.id].issues=[];delete s.cards[c.id].nonpriceVerification;},root);assert.equal((await archiveV2DraftPhotos(root,[c.id],a))[0].status,"held");for(const p of c.photos)await fs.stat(p.path);
}));
test("a missing source without durable archive plan cannot be adopted from guessed destination",()=>fixture(async(root,c,a)=>{
  await fs.unlink(c.photos[0].path);assert.equal((await archiveV2DraftPhotos(root,[c.id],a))[0].status,"held");await fs.stat(c.photos[1].path);
}));
test("standing authority starts future reviewed pairs while leaving unreviewed captures untouched",()=>fixture(async(root,c,a)=>{
  assert.deepEqual(await recoverV2DraftArchives(root),[]);await archiveV2DraftPhotos(root,[c.id],a);
  const other=structuredClone(c);other.id="future";other.sku="future";other.captureId=digest("future");other.draftId="5678";other.groupId="futuregroup";other.nonpriceVerification!.draftId="5678";
  other.photos=[];for(const side of ["front","back"] as const){const source=path.join(path.dirname(c.photos[0].path),`future-${side}.jpg`);await fs.writeFile(source,`future-${side}`);other.photos.push({path:source,hash:sha(`future-${side}`),side});}
  await withV2State(s=>{s.cards.future=other;const sub=structuredClone(s.submissions[digest("intent")]);sub.key=digest("future");sub.groupId=other.groupId!;sub.draftId=other.draftId;sub.payload.sku=other.sku;sub.payload.captureIds=[other.captureId];sub.payload.photos=other.photos.map(p=>({hash:p.hash,url:`https://i.ebayimg.com/images/g/${p.hash}/s-l1600.jpg`,expiresAt:new Date().toISOString(),upright:true}));s.submissions[sub.key]=sub;},root);
  await withV2State(s=>{s.cards.unreviewed={...structuredClone(c),id:"unreviewed",sku:"unreviewed",captureId:digest("unreviewed"),stage:"identified",draftId:undefined,groupId:undefined,nonpriceVerification:undefined};},root);
  const untouched=(await readV2State(root)).cards.unreviewed;
  assert.deepEqual(await recoverV2DraftArchives(root),[{cardId:"future",status:"moved"}]);assert.deepEqual((await readV2State(root)).cards.unreviewed,untouched);
}));
test("normal worker releases its lease before recovering pending draft archives",()=>fixture(async(root,c,a)=>{
  await archiveV2DraftPhotos(root,[c.id],a);await withV2State(s=>{s.cards[c.id].draftArchive!.status="copied";s.baseline={initializedAt:new Date().toISOString(),hashes:[],paths:[],fileCount:0};},root);
  const result=await runV2(root,"archive-recovery-test",{legacyHashes:async()=>[]});
  assert.equal(result.lastRun?.status,"finished");assert.equal(result.cards[c.id].draftArchive?.status,"moved");assert.equal(result.calls.length,0);
}));
