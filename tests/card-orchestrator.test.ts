import test from "node:test";
import { archiveVerifiedPhotos, preparePhotoMove, finishPhotoMove } from "../lib/card-photo-archive.ts";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { CARD_POLICY_VERSION, calculateCardPrice, cardPremiumReasons, premiumCompAdjustment, roundUpCardPrice } from "../lib/card-orchestrator-policy.ts";
import { approvedRulePrice, correctSavedPrices, recordVerifiedReceipt, recordQuantityReceiptGroup, existingReceipt, claimJob, completeJob, createJobBlockerLookup, fingerprint, jobBlockers, kinds, listingTitle, localReviewListings, newQueue, quarantineImport, queueSummary, recordInventoryAccess, refreshJobs, retryHeld, setHoldRecovery, upsertCard, validateComps, type CardInput, type Identity, type JobKind, type QueueState } from "../lib/card-orchestrator.ts";
import { QueueBusyError, readQueue, withQueue, withQueueSnapshot } from "../lib/card-orchestrator-store.ts";
import { ReportSnapshotChanged, writeQueueReport, type ReportSnapshot } from "../lib/card-orchestrator-report.ts";
import { applySavedReceipts, importLegacyCard, prepareSavedReceipts, receiptManifestPaths, receiptManifestRows, savedReceiptDependencies, type SavedReceiptRow } from "../lib/card-orchestrator-import.ts";
import { flowPacket, flowHtml, pricingContext, reportHandoff, type AskingPriceApproval, type WorkflowDecision } from "../lib/card-orchestrator-flow.ts";
import { completeAutomaticJob, runAutomaticBatch } from "../lib/card-orchestrator-worker.ts";
import { loadCardBacklog } from "../lib/card-backlog-store.ts";
import { saveReview, withWorkflow } from "../lib/card-workflow-store.ts";

const now="2026-10-18T08:00:00.000Z";
test("CLI sync preserves direct scanner intake without a legacy row and clears its obsolete import rejection",async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"scanner-sync-"));
  try {
    for(const name of ["identity-queue","pricing-queue"])await fs.mkdir(path.join(root,"artifacts",name),{recursive:true});
    await fs.writeFile(path.join(root,"artifacts/identity-queue/cards.json"),JSON.stringify({cards:[]}));
    await fs.writeFile(path.join(root,"artifacts/pricing-queue/queue-state.json"),JSON.stringify({cards:[],comps:[]}));
    const state=identified();state.cards["card-1"].input.source="scanner-intake: verified fresh originals";
    state.rejectedImports={"card-1":{inputKey:"obsolete",reason:"Only individually identified quantity-one cards can enter this pilot"}};
    const directory=path.join(root,"artifacts/card-orchestrator");
    await withQueue(directory,s=>Object.assign(s,state));
    const script=fileURLToPath(new URL("../scripts/card-orchestrator.ts",import.meta.url));
    const result=JSON.parse(execFileSync(process.execPath,["--experimental-strip-types",script,"sync"],{cwd:root,encoding:"utf8",stdio:["ignore","pipe","pipe"]}));
    assert.deepEqual(result.skipped,[]);
    const actual=await readQueue(directory);
    assert.equal(actual.cards["card-1"].jobs.identity.state,"done");
    assert.deepEqual(actual.cards["card-1"].input.photos,state.cards["card-1"].input.photos);
    assert.equal(actual.rejectedImports?.["card-1"],undefined);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
async function archiveFixture() {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"card-archive-")),sourceRoot=path.join(root,"inbox"),archiveRoot=path.join(root,"archive");
  await fs.mkdir(sourceRoot);
  const i=input();
  for(const p of i.photos){p.path=path.join(sourceRoot,p.path);await fs.writeFile(p.path,p.side);p.sha256=createHash("sha256").update(p.side).digest("hex");}
  const state=newQueue();upsertCard(state,i,now);
  finish(state,"photos",{hashes:i.photos.map(({side,sha256})=>({side,sha256})),evidence:"original bytes verified"});
  finish(state,"identity",{identity,pairMatches:true,frontFirst:true,serialInspected:true,evidence:"both originals read"});
  state.cards[i.id].input.knownDraft="12345";
  recordVerifiedReceipt(state,{observationId:randomUUID(),seller:"imaydit58",cardId:i.id,sku:i.sku,frontHash:i.photos[0].sha256,backHash:i.photos[1].sha256,identityKey:fingerprint(identity),draftId:"12345",liveItemId:"67890",observedAt:now,photosVerified:true,source:"https://www.ebay.com/itm/67890",evidence:"Original pair verified against live listing"},now);
  return {root,state,sourceRoot,archiveRoot,now,observation:{seller:"imaydit58",cardId:i.id,sku:i.sku,liveItemId:"67890",observedAt:now,source:"https://www.ebay.com/itm/67890"}};
}
async function draftArchiveFixture() {
  const f=await archiveFixture();
  delete f.state.cards["card-1"].exclusion;
  const receipt=Object.values(f.state.verifiedReceipts!)[0];
  delete receipt.liveItemId;
  receipt.source="https://www.ebay.com/sl/list?draft_id=12345";
  return {...f,archiveRoot:path.join(f.sourceRoot,"Drafted"),observation:{seller:"imaydit58",cardId:"card-1",sku:receipt.sku,draftId:"12345",observedAt:now,source:receipt.source}};
}
test("verified draft moves once, preserves identity, and later advances to Listed",async()=>{
  const f=await draftArchiveFixture();try{
    const before=JSON.stringify(f.state.cards["card-1"].input);
    const draft=await preparePhotoMove(f);
    await finishPhotoMove(f.state,"card-1",[f.sourceRoot]);
    assert.equal(draft.draftId,"12345");assert.equal(draft.liveItemId,undefined);
    assert.equal(await preparePhotoMove(f),draft);
    assert.equal(claimJob(f.state,"retry",undefined,"card-1",now),null);
    for(const file of draft.files){await assert.rejects(fs.access(file.source),{code:"ENOENT"});await fs.access(file.destination);}
    const originalReceipt=Object.values(f.state.verifiedReceipts!)[0];
    recordVerifiedReceipt(f.state,{...originalReceipt,observationId:randomUUID(),liveItemId:"67890",source:"https://www.ebay.com/itm/67890"},now);
    const live=await preparePhotoMove({...f,archiveRoot:path.join(f.sourceRoot,"Listed"),observation:{...f.observation,draftId:undefined,liveItemId:"67890",source:"https://www.ebay.com/itm/67890"}});
    await finishPhotoMove(f.state,"card-1",[f.sourceRoot]);
    for(const file of live.files){assert.ok(file.source.includes("Drafted"));assert.ok(file.destination.includes("Listed"));await assert.rejects(fs.access(file.source),{code:"ENOENT"});assert.equal(createHash("sha256").update(await fs.readFile(file.destination)).digest("hex"),file.sha256);}
    assert.equal(JSON.stringify(f.state.cards["card-1"].input),before);
    await assert.rejects(preparePhotoMove(f),/conflict/);
  }finally{await fs.rm(f.root,{recursive:true,force:true});}
});
test("verified draft archive preserves pricing holds without price approval",async()=>{
  const f=await draftArchiveFixture();try{
    const card=f.state.cards["card-1"];card.jobs.pricing.state="held";
    await assert.rejects(preparePhotoMove({...f,sellerHold:"Keep originals"}),/held/);
    card.jobs.reconcile.state="held";
    await assert.rejects(preparePhotoMove({...f,manualPriceApproved:true}),/held/);
    card.jobs.reconcile.state="todo";
    const moved=await preparePhotoMove(f);
    for(const file of moved.files)await fs.access(file.source);
    await finishPhotoMove(f.state,"card-1",[f.sourceRoot]);
    assert.equal(card.jobs.pricing.state,"held");
    for(const file of moved.files){await assert.rejects(fs.access(file.source),{code:"ENOENT"});await fs.access(file.destination);}
  }finally{await fs.rm(f.root,{recursive:true,force:true});}
});

test("verified live archives preserve pricing holds without requiring new price approval",async()=>{
  const f=await archiveFixture();try{
    const card=f.state.cards['card-1'];card.jobs.pricing.state='held';
    await assert.rejects(preparePhotoMove({...f,sellerHold:'Preserve originals'}),/held/);
    card.jobs.reconcile.state='held';
    await assert.rejects(preparePhotoMove(f),/held/);
    card.jobs.reconcile.state='todo';
    const moved=await preparePhotoMove(f);
    await assert.rejects(finishPhotoMove(f.state,'card-1',[f.sourceRoot],'Preserve originals'),/held/);
    card.jobs.pricing.state='leased';
    await assert.rejects(finishPhotoMove(f.state,'card-1',[f.sourceRoot]),/held/);
    card.jobs.pricing.state='held';
    const receipts=f.state.verifiedReceipts;f.state.verifiedReceipts={};
    await assert.rejects(finishPhotoMove(f.state,'card-1',[f.sourceRoot]),/receipt missing/);
    for(const file of moved.files)await fs.access(file.source);
    f.state.verifiedReceipts=receipts;
    await finishPhotoMove(f.state,'card-1',[f.sourceRoot]);
    assert.equal(card.jobs.pricing.state,'held');assert.equal(moved.status,'moved');
    for(const file of moved.files)assert.equal(createHash('sha256').update(await fs.readFile(file.destination)).digest('hex'),file.sha256);
  }finally{await fs.rm(f.root,{recursive:true,force:true});}
});

test("draft archive requires verified receipt, matching URL and intact originals",async()=>{
  const f=await draftArchiveFixture();try{
    await assert.rejects(preparePhotoMove({...f,observation:{...f.observation,source:"https://www.ebay.com/sl/list?draft_id=99"}}),/URL/);
    const receipts=f.state.verifiedReceipts;f.state.verifiedReceipts={};
    await assert.rejects(preparePhotoMove(f),/receipt required/);
    f.state.verifiedReceipts=receipts;
    await fs.writeFile(f.state.cards["card-1"].input.photos[0].path,"changed");
    await assert.rejects(preparePhotoMove(f),/bytes changed/);
    assert.equal(f.state.photoArchives,undefined);
  }finally{await fs.rm(f.root,{recursive:true,force:true});}
});
test("draft archive CLI moves scanner originals under scanner Drafted and replay is safe",async()=>{
  const f=await draftArchiveFixture();try{
    const dir=path.join(f.root,"artifacts/card-orchestrator");
    await withQueue(dir,s=>Object.assign(s,f.state));
    const receipt={...Object.values(f.state.verifiedReceipts!)[0],observationId:randomUUID(),observedAt:new Date().toISOString()};
    const file=path.join(f.root,"draft.json");await fs.writeFile(file,JSON.stringify(receipt));
    const script=fileURLToPath(new URL("../scripts/card-orchestrator.ts",import.meta.url));
    const run=()=>JSON.parse(execFileSync(process.execPath,["--experimental-strip-types",script,"record-receipt","--file",file],{cwd:f.root,encoding:"utf8",stdio:["ignore","pipe","pipe"],env:{...process.env,CARD_INBOX_PATH:path.join(f.root,"other-inbox"),CARD_SCANNER_PATH:f.sourceRoot,CARD_WORKFLOW_REVIEW_ROOT:f.root}}));
    const first=run();assert.equal(first.archive.status,"moved");
    assert.ok(first.archive.files.every((p:{destination:string})=>p.destination.startsWith(path.join(f.sourceRoot,"Drafted","12345"))));
    assert.equal(run().archive.status,"moved");
  }finally{await fs.rm(f.root,{recursive:true,force:true});}
});
test("live photo archive is idempotent and preserves references, capture identity and all queue state",async()=>{
  const f=await archiveFixture();try{
    const before=JSON.stringify(f.state),first=await archiveVerifiedPhotos(f),second=await archiveVerifiedPhotos(f);
    assert.deepEqual(first,second);assert.equal(JSON.stringify(f.state),before);
    for(const p of first.files)assert.deepEqual(await fs.readFile(p.source),await fs.readFile(p.destination));
    const dashboard=await loadCardBacklog({root:f.root,scans:[],now});
    assert.equal(dashboard.cards.length,0,"Archive manifest alone cannot invent inventory");
    await fs.writeFile(first.files[0].destination,"different existing bytes");
    await assert.rejects(archiveVerifiedPhotos(f),/destination conflict/);
    assert.equal(await fs.readFile(first.files[0].destination,"utf8"),"different existing bytes");
  }finally{await fs.rm(f.root,{recursive:true,force:true});}
});
test("archive rejects held, stale, mismatched, unverified and duplicate ownership without clearing holds",async()=>{
  const f=await archiveFixture();try{
    const before=JSON.stringify(f.state);
    await assert.rejects(archiveVerifiedPhotos({...f,sellerHold:"Seller says keep"}),/held/);
    await assert.rejects(archiveVerifiedPhotos({...f,now:"2026-10-18T10:00:00.000Z"}),/Fresh/);
    await assert.rejects(archiveVerifiedPhotos({...f,observation:{...f.observation,liveItemId:"999"}}),/URL/);
    for(const mutation of [
      (s:QueueState)=>{s.cards["card-1"].jobs.reconcile.state="held";},
      (s:QueueState)=>{s.cards["card-1"].input.sourceHold="Pairing conflict";},
      (s:QueueState)=>{s.verifiedReceipts={};},
      (s:QueueState)=>{upsertCard(s,{...input("other"),knownDraft:"67890"},now);},
    ]) {const state=structuredClone(f.state);mutation(state);const saved=JSON.stringify(state);await assert.rejects(archiveVerifiedPhotos({...f,state}));assert.equal(JSON.stringify(state),saved);}
    assert.equal(JSON.stringify(f.state),before);
    await fs.writeFile(f.state.cards["card-1"].input.photos[1].path,"changed");
    await assert.rejects(archiveVerifiedPhotos(f),/Original bytes changed/);
    await assert.rejects(fs.access(f.archiveRoot),{code:"ENOENT"});
  }finally{await fs.rm(f.root,{recursive:true,force:true});}
});
function receiptFixture() {
  const state=identified(),card=state.cards["card-1"];card.input.knownDraft="12345";
  const observation={observationId:randomUUID(),seller:"imaydit58",cardId:"card-1",sku:"card-1",frontHash:"a".repeat(64),backHash:"b".repeat(64),identityKey:fingerprint(identity),draftId:"12345",liveItemId:"67890",observedAt:now,photosVerified:true,source:"saved verification report",evidence:"Both hosted photos and serial inspected against originals."};
  return {state,card,observation};
}
test("saved drafts can receive positive reconciliation without clearing pricing holds or permitting Add",()=>{
  const {state,card}=receiptFixture();
  card.jobs.pricing.state="held";card.jobs.pricing.reason="No eligible sold evidence";
  const pricing=JSON.stringify(card.jobs.pricing),claim=claimJob(state,"receipt-check","reconcile",card.input.id,now);
  assert.ok(claim);
  const data={seller:"imaydit58",disposition:"clear",checkedAt:now,scopes:["active","drafts","scheduled","sold"],evidence:"No match"};
  assert.throws(()=>completeJob(state,card.input.id,"reconcile",claim.job.lease!.token,{outcome:"done",data},now),/cannot be cleared/);
  assert.throws(()=>completeJob(state,card.input.id,"reconcile",claim.job.lease!.token,{outcome:"done",data:{...data,disposition:"draft",itemId:"999"}},now),/different draft/);
  completeJob(state,card.input.id,"reconcile",claim.job.lease!.token,{outcome:"done",data:{...data,disposition:"live",itemId:"67890",scopes:["active"],evidence:"Exact saved SKU and full identity matched in seller active inventory"}},now);
  assert.equal(existingReceipt(card)?.itemId,"67890");assert.equal(JSON.stringify(card.jobs.pricing),pricing);
  assert.equal(claimJob(state,"writer","listing",card.input.id,now),null);
  const held=receiptFixture();assert.equal(claimJob(held.state,"worker","reconcile","card-1",now,{"card-1":"Seller hold"}),null);
});
test("verified receipt feedback persists across CLI restarts and reaches dashboard and handoff without approval",async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"verified-receipt-"));
  try {
    const {state,observation}=receiptFixture(),dir=path.join(root,"artifacts/card-orchestrator");
    await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,"state.json"),JSON.stringify(state));
    await fs.mkdir(path.join(root,"artifacts/identity-queue"),{recursive:true});await fs.writeFile(path.join(root,"artifacts/identity-queue/cards.json"),JSON.stringify({cards:[]}));
    const file=path.join(root,"receipt.json");await fs.writeFile(file,JSON.stringify(observation));
    const script=fileURLToPath(new URL("../scripts/card-orchestrator.ts",import.meta.url));
    const run=()=>JSON.parse(execFileSync(process.execPath,["--experimental-strip-types",script,"record-receipt","--file",file],{cwd:root,encoding:"utf8",stdio:["ignore","pipe","pipe"]}));
    assert.equal(run().recorded,true);const first=await fs.readFile(path.join(dir,"state.json"),"utf8");
    assert.equal(run().recorded,false);assert.equal(await fs.readFile(path.join(dir,"state.json"),"utf8"),first);
    const saved=await readQueue(dir);assert.deepEqual(saved.cards["card-1"].jobs,JSON.parse(JSON.stringify(state.cards["card-1"].jobs)));
    const packet=flowPacket(saved,["card-1"],now).cards[0];assert.equal(packet.route,"excluded");assert.equal(packet.pricing.approved,false);assert.equal(packet.canUpload,false);
    const dashboard=await loadCardBacklog({root,scans:[],now});assert.equal(dashboard.counts.distinctLiveReceipts,1);assert.equal(dashboard.cards[0].excludedFromNewListing,true);
    upsertCard(saved,input(),now);assert.deepEqual(existingReceipt(saved.cards["card-1"]),{disposition:"live",itemId:"67890"});
    assert.equal(saved.inventoryAccess,undefined);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
test("verified receipts reject mismatches and conflicting ownership without changing any queue state",()=>{
  for(const patch of [{seller:"other"},{frontHash:"c".repeat(64)},{backHash:"a".repeat(64)},{identityKey:"f".repeat(64)},{draftId:"99999"},{observedAt:"2099-01-01T00:00:00.000Z"},{photosVerified:false},{canPublish:true},{liveItemId:"bad"}]) {
    const {state,observation}=receiptFixture(),before=JSON.stringify(state);
    assert.throws(()=>recordVerifiedReceipt(state,{...observation,...patch},now));assert.equal(JSON.stringify(state),before);
  }
  const {state,observation}=receiptFixture();upsertCard(state,{...input("other","26/99"),knownDraft:"67890"},now);
  const before=JSON.stringify(state);assert.throws(()=>recordVerifiedReceipt(state,observation,now),/Conflicting/);assert.equal(JSON.stringify(state),before);
});
test("receipt feedback retains holds, attempts, positive live status and rejects reused observation IDs",()=>{
  const {state,card,observation}=receiptFixture();card.jobs.reconcile.state="held";card.jobs.reconcile.reason="Retained hold";card.jobs.reconcile.attempts=2;
  const jobs=JSON.stringify(card.jobs);assert.equal(recordVerifiedReceipt(state,observation,now),true);assert.equal(JSON.stringify(card.jobs),jobs);
  assert.throws(()=>recordVerifiedReceipt(state,{...observation,evidence:"Different evidence for same ID"},now),/Observation ID/);
  assert.throws(()=>recordVerifiedReceipt(state,{...observation,observationId:randomUUID(),liveItemId:"999"},now),/Conflicting live/);
  const {liveItemId,...draftOnly}=observation;recordVerifiedReceipt(state,{...draftOnly,observationId:randomUUID()},now);
  assert.equal(existingReceipt(card)?.disposition,"live");
  card.exclusion={disposition:"sold",itemId:"67890",evidence:"sold"};assert.throws(()=>recordVerifiedReceipt(state,{...observation,observationId:randomUUID()},now),/sold\/scheduled/);
});
const identity:Identity={player:"Payton Pritchard",season:"2024-25",set:"Panini Prizm Black",manufacturer:"Panini",cardNumber:"212",sport:"Basketball",team:"Boston Celtics",parallel:"Purple Prizm",serial:"25/99",printRun:99,condition:"Near mint or better",autograph:false,patch:false};
const input=(id="card-1",serial="25/99"):CardInput=>({id,sku:id,identity:{...identity,serial},photos:[{side:"front",path:"front.jpg",sha256:(id==="card-1"?"a":"c").repeat(64)},{side:"back",path:"back.jpg",sha256:(id==="card-1"?"b":"d").repeat(64)}],candidates:[],source:"test"});
const seeded=()=>{const s=newQueue();upsertCard(s,input(),now);return s;};
function finish(s:QueueState,kind:JobKind,data:unknown,id="card-1") {const c=claimJob(s,"worker",kind,id,now)!;assert.ok(c);completeJob(s,id,kind,c.job.lease!.token,{outcome:"done",data},now);}
function identified(){const s=seeded();finish(s,"photos",{hashes:s.cards["card-1"].input.photos.map(({side,sha256})=>({side,sha256})),evidence:"original files"});finish(s,"identity",{identity,pairMatches:true,frontFirst:true,serialInspected:true,evidence:"both originals read"});return s;}
const comp=(changes:Record<string,unknown>={})=>({saleId:"407092203088",sourceUrl:"https://www.ebay.com/itm/407092203088",soldDate:"2026-07-27",itemPrice:1.75,shipping:0,currency:"USD",identity:{...identity,serial:"9/99"},serialObserved:true,priceDisclosed:true,ownAcquisition:false,graded:false,lot:false,condition:"Near mint or better",evidenceMode:"original-sale",evidence:"Original sale verified",...changes});

const priceFixture=(s:QueueState)=>finish(s,"pricing",{comps:[comp()],tracked:false,envelopeEligible:true,evidence:"Validated fixture sale"});
function reportFixture(snapshot:ReportSnapshot,label:string) {
  return {files:{"status.json":JSON.stringify({reportSnapshot:snapshot,label}),
    "status.html":label,"review-listings.json":JSON.stringify({reportSnapshot:snapshot,label})},result:label};
}
function reportReviews(directory:string,stamps={reviewStamp:"reviews-1",approvalStamp:"approvals-1"}) {
  return {read:async()=>({revision:(await readQueue(directory)).revision,...stamps}),
    isCurrent:async(review:{reviewStamp:string;approvalStamp:string})=>review.reviewStamp===stamps.reviewStamp&&review.approvalStamp===stamps.approvalStamp};
}
test("snapshot reads fence writers, never commit mutations, and release after failure",async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"queue-snapshot-"));
  try {
    await withQueue(dir,s=>Object.assign(s,seeded()));
    const before=await fs.readFile(path.join(dir,"state.json"),"utf8");
    let calls=0;
    await assert.rejects(withQueueSnapshot(dir,async s=>{
      calls++;s.cards={};
      await assert.rejects(withQueue(dir,()=>{}, {lockWaitMs:0}),QueueBusyError);
      throw Error("snapshot failure");
    }),/snapshot failure/);
    assert.equal(calls,1);assert.equal(await fs.readFile(path.join(dir,"state.json"),"utf8"),before);
    const snapshot=await withQueueSnapshot(dir,s=>s);snapshot.cards={};
    assert.equal(await fs.readFile(path.join(dir,"state.json"),"utf8"),before);
    await withQueue(dir,s=>{s.externalWriterPossible=true;});
    assert.equal((await readQueue(dir)).externalWriterPossible,true);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test("report rendering releases the queue lock, retries concurrent claims and never saves its projection",async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"report-concurrent-"));
  try {
    await withQueue(dir,s=>Object.assign(s,seeded()));
    const before=await readQueue(dir);let renders=0;
    const result=await writeQueueReport(dir,reportReviews(dir),async(s,_review,snapshot)=>{
      renders++;
      if(renders===1)await withQueue(dir,current=>assert.ok(claimJob(current,"other-worker","photos","card-1")));
      s.cards["card-1"].input.identity.player="Only in the report projection";
      return reportFixture(snapshot,String(s.revision));
    });
    assert.equal(renders,2);assert.equal(result.reportPublished,true);
    const saved=await readQueue(dir);
    assert.equal(saved.revision,before.revision+1);assert.equal(saved.cards["card-1"].jobs.photos.state,"leased");
    assert.equal(saved.cards["card-1"].input.identity.player,identity.player);
    assert.equal(result.reportSnapshot.queueRevision,saved.revision);
    assert.deepEqual((await fs.readdir(dir)).sort(),["review-listings.json","state.json","status.html","status.json"]);
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});
test("reports retry changed seller holds and approvals even without a queue revision change",async()=>{
  for(const field of ["reviewStamp","approvalStamp"] as const) {
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),"report-decisions-"));
    try {
      await withQueue(dir,s=>Object.assign(s,seeded()));
      const stamps={reviewStamp:"reviews-1",approvalStamp:"approvals-1"};let renders=0;
      const result=await writeQueueReport(dir,reportReviews(dir,stamps),(_s,review,snapshot)=>{
        if(++renders===1)stamps[field]="changed";
        return reportFixture(snapshot,review[field]);
      });
      assert.equal(renders,2);assert.equal(result.result,"changed");assert.equal(result.reportSnapshot[field],"changed");
      assert.equal((await readQueue(dir)).revision,1);
    } finally {await fs.rm(dir,{recursive:true,force:true});}
  }
});
test("repeated report source changes stop after three attempts and preserve the previous reports",async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"report-churn-"));
  try {
    await withQueue(dir,s=>Object.assign(s,seeded()));
    await writeQueueReport(dir,reportReviews(dir),(_s,_r,snapshot)=>reportFixture(snapshot,"previous"));
    const previous=await fs.readFile(path.join(dir,"status.json"),"utf8");let renders=0;
    await assert.rejects(writeQueueReport(dir,reportReviews(dir),async(_s,_r,snapshot)=>{
      renders++;
      await withQueue(dir,s=>{s.events.push({at:now,cardId:"card-1",kind:"photos",event:"fixture-change",detail:"fixture"});});
      return reportFixture(snapshot,"stale");
    }),ReportSnapshotChanged);
    assert.equal(renders,3);assert.equal(await fs.readFile(path.join(dir,"status.json"),"utf8"),previous);
    assert.equal(await fs.readFile(path.join(dir,"status.html"),"utf8"),"previous");
    assert.equal(JSON.parse(await fs.readFile(path.join(dir,"review-listings.json"),"utf8")).label,"previous");
    assert.ok(!(await fs.readdir(dir)).some(name=>name==="queue.lock"||name.startsWith("report-stage-")));
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});
test("an older slow report cannot replace a newer report from the same queue revision",async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"report-order-"));
  let release!:()=>void,started!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;}),captured=new Promise<void>(resolve=>{started=resolve;});
  let older:ReturnType<typeof writeQueueReport>|undefined;
  try {
    await withQueue(dir,s=>Object.assign(s,seeded()));
    older=writeQueueReport(dir,reportReviews(dir),async(_s,_r,snapshot)=>{
      started();await gate;return reportFixture(snapshot,"older");
    });
    await captured;await new Promise(resolve=>setTimeout(resolve,10));
    const newer=await writeQueueReport(dir,reportReviews(dir),(_s,_r,snapshot)=>reportFixture(snapshot,"newer"));
    release();assert.equal((await older).reportPublished,false);
    const saved=JSON.parse(await fs.readFile(path.join(dir,"status.json"),"utf8"));
    assert.equal(saved.label,"newer");assert.equal(saved.reportSnapshot.reportId,newer.reportSnapshot.reportId);
    assert.equal(await fs.readFile(path.join(dir,"status.html"),"utf8"),"newer");
  } finally {release();await older;await fs.rm(dir,{recursive:true,force:true});}
});
test("failed report rendering leaves durable state and previous report files intact",async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"report-failure-"));
  try {
    await withQueue(dir,s=>Object.assign(s,seeded()));
    await writeQueueReport(dir,reportReviews(dir),(_s,_r,snapshot)=>reportFixture(snapshot,"previous"));
    const before=await fs.readFile(path.join(dir,"state.json"),"utf8");
    await assert.rejects(writeQueueReport(dir,reportReviews(dir),s=>{s.cards={};throw new Error("fixture renderer failure");}),/fixture renderer failure/);
    assert.equal(await fs.readFile(path.join(dir,"state.json"),"utf8"),before);
    assert.equal(await fs.readFile(path.join(dir,"status.html"),"utf8"),"previous");
    assert.ok(!(await fs.readdir(dir)).includes("queue.lock"));
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});
test("a truncated derived status report can be regenerated without changing durable work",async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"report-truncated-"));
  try {
    await withQueue(dir,s=>Object.assign(s,seeded()));
    const before=await fs.readFile(path.join(dir,"state.json"),"utf8");
    await fs.writeFile(path.join(dir,"status.json"),'{"asOf":');
    const result=await writeQueueReport(dir,reportReviews(dir),(_s,_r,snapshot)=>reportFixture(snapshot,"recovered"));
    assert.equal(result.reportPublished,true);
    assert.equal(JSON.parse(await fs.readFile(path.join(dir,"status.json"),"utf8")).label,"recovered");
    assert.equal(await fs.readFile(path.join(dir,"state.json"),"utf8"),before);
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});
test("CLI status projects expired leases without changing queue state and tags every report generation",async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"report-cli-")),queue=path.join(dir,"artifacts/card-orchestrator");
  try {
    await withQueue(queue,s=>{Object.assign(s,seeded());assert.ok(claimJob(s,"expired-worker","photos","card-1",now));});
    const before=await fs.readFile(path.join(queue,"state.json"),"utf8");
    const script=fileURLToPath(new URL("../scripts/card-orchestrator.ts",import.meta.url));
    const result=JSON.parse(execFileSync(process.execPath,["--experimental-strip-types",script,"status"],{cwd:dir,env:{...process.env,CARD_WORKFLOW_REVIEW_ROOT:dir},encoding:"utf8",stdio:["ignore","pipe","pipe"]}));
    assert.equal(result.reportPublished,true);
    assert.equal(await fs.readFile(path.join(queue,"state.json"),"utf8"),before);
    const status=JSON.parse(await fs.readFile(path.join(queue,"status.json"),"utf8"));
    const review=JSON.parse(await fs.readFile(path.join(queue,"review-listings.json"),"utf8"));
    assert.equal(status.cards[0].jobs.find((job:{kind:string})=>job.kind==="photos").state,"todo");
    assert.deepEqual(status.reportSnapshot,result.reportSnapshot);assert.deepEqual(status.reportSnapshot,review.reportSnapshot);
    assert.ok((await fs.readFile(path.join(queue,"status.html"),"utf8")).includes(status.reportSnapshot.reportId));
    assert.equal(review.canUpload,false);assert.equal(review.canPublish,false);
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});
test("snapshot blocker lookup preserves duplicate, pairing, receipt and seller guards for every stage",()=>{
  const s=newQueue();
  for(let n=1;n<=12;n++) {
    const i=input(`fixture-${n}`,`${n}/99`);
    i.photos=i.photos.map(p=>({...p,sha256:createHash("sha256").update(`${n}-${p.side}`).digest("hex")}));
    if(n===2)i.sku="fixture-1";
    if(n===4)i.photos=structuredClone(s.cards["fixture-3"].input.photos).reverse();
    if(n===6)i.photos[0].sha256=s.cards["fixture-5"].input.photos[0].sha256.toUpperCase();
    if(n===8)i.identity.serial="007/99";
    if(n>=9){i.identity.serial="";i.identity.printRun=null;}
    if(n===11)i.identity.player="";
    if(n>=10)i.knownDraft="shared-receipt";
    upsertCard(s,i,now);
  }
  const before=fingerprint(s),lookup=createJobBlockerLookup(s);
  for(const c of Object.values(s.cards))for(const kind of kinds)for(const hold of [undefined,"Seller hold retained"]) {
    assert.deepEqual(lookup(c,kind,hold),jobBlockers(s,c,kind,hold),`${c.input.id} ${kind}`);
  }
  assert.match(lookup(s.cards["fixture-1"],"photos").join(";"),/SKU also belongs/);
  assert.match(lookup(s.cards["fixture-3"],"photos").join(";"),/Same original photo bytes/);
  assert.match(lookup(s.cards["fixture-5"],"photos").join(";"),/conflicting back photos/);
  assert.match(lookup(s.cards["fixture-7"],"photos").join(";"),/Exact serialized identity/);
  assert.equal(lookup(s.cards["fixture-9"],"photos").length,0);
  assert.match(lookup(s.cards["fixture-10"],"photos").join(";"),/Conflicting draft receipt ownership/);
  assert.equal(fingerprint(s),before);
});
const clearFixture=(at=now)=>({seller:"imaydit58",disposition:"clear",checkedAt:at,scopes:["active","drafts","scheduled","sold"],evidence:"Four scopes inspected"});
function holdReconciliation(s:QueueState,recovery?:{when:"pricing-ready"|"inventory-access"}) {
  const claim=claimJob(s,"worker","reconcile","card-1",now)!;
  completeJob(s,"card-1","reconcile",claim.job.lease!.token,{outcome:"held",reason:"Fixture dependency unavailable",recovery},now);
}
test("expired clearances wait for usable pricing, then claim a fresh read without losing attempt history",async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"clearance-recovery-")),later="2026-10-18T09:01:00.000Z";
  try {
    await withQueue(dir,s=>Object.assign(s,identified()));
    await withQueue(dir,s=>finish(s,"reconcile",clearFixture()));
    await withQueue(dir,s=>{
      assert.equal(claimJob(s,"worker","reconcile","card-1",later),null);
      assert.equal(s.cards["card-1"].jobs.reconcile.recovery?.when,"clearance-expired");
      priceFixture(s);
    });
    await withQueue(dir,s=>{
      assert.equal(claimJob(s,"worker","reconcile","card-1",later,{"card-1":"Keep held"}),null);
      assert.equal(s.cards["card-1"].jobs.reconcile.state,"held");
      assert.equal(queueSummary(s,later).cards[0].jobs.find(j=>j.kind==="reconcile")?.recoverable,true);
      const claim=claimJob(s,"worker","reconcile","card-1",later)!;
      assert.ok(claim);assert.equal(claim.job.attempts,2);assert.equal(claim.job.attemptsSinceClearance,1);
      assert.equal(flowPacket(s,["card-1"],later).cards[0].canUpload,false);
      assert.ok(flowPacket(s,["card-1"],later).cards[0].blockers.includes("Fresh four-scope inventory clearance required"));
      completeJob(s,"card-1","reconcile",claim.job.lease!.token,{outcome:"done",data:clearFixture(later)},later);
    });
    const saved=await readQueue(dir);assert.equal(saved.cards["card-1"].jobs.reconcile.state,"done");
    assert.equal(saved.events.filter(e=>e.event==="hold-recovered").length,1);
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});
test("pricing-dependent recovery is selective, bounded and accepts a currently bound seller price",()=>{
  const s=identified();holdReconciliation(s,{when:"pricing-ready"});
  for(let n=0;n<3;n++)assert.equal(claimJob(s,"worker","reconcile","card-1",now),null);
  assert.equal(s.cards["card-1"].jobs.reconcile.attempts,1);
  let approvalChecks=0;
  assert.equal(claimJob(s,"worker","photos","card-1",now,{},[],()=>{approvalChecks++;return true;}),null);
  assert.equal(claimJob(s,"worker","reconcile","card-1",now,{"card-1":"Seller hold"},[],()=>{approvalChecks++;return true;}),null);
  assert.equal(approvalChecks,0);
  priceFixture(s);
  const claim=claimJob(s,"worker","reconcile","card-1",now)!;assert.ok(claim);
  completeJob(s,"card-1","reconcile",claim.job.lease!.token,{outcome:"held",reason:"Still waiting",recovery:{when:"pricing-ready"}},now);
  assert.equal(claimJob(s,"worker","reconcile","card-1",now),null);
  assert.equal(s.cards["card-1"].jobs.reconcile.attempts,2);
  const manual=identified();holdReconciliation(manual,{when:"pricing-ready"});
  assert.ok(claimJob(manual,"worker","reconcile","card-1",now,{},[],["card-1"]));
  for(const reason of ["Unknown submission outcome","Receipt conflict","Needs seller decision"]) {
    const held=identified();holdReconciliation(held);held.cards["card-1"].jobs.reconcile.reason=reason;priceFixture(held);
    assert.equal(claimJob(held,"worker","reconcile","card-1",now),null,reason);
  }
  const receipt=identified();holdReconciliation(receipt,{when:"pricing-ready"});priceFixture(receipt);
  receipt.cards["card-1"].exclusion={disposition:"draft",itemId:"123",evidence:"Saved positive match"};
  assert.equal(claimJob(receipt,"worker","reconcile","card-1",now),null);
});
test("inventory dependency outages pause shared claims and wake only on a new fresh successful observation",async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"access-recovery-"));
  try {
    await withQueue(dir,s=>{
      Object.assign(s,identified());priceFixture(s);holdReconciliation(s,{when:"inventory-access"});
      upsertCard(s,input("card-2","26/99"),now);
      finish(s,"photos",{hashes:s.cards["card-2"].input.photos.map(({side,sha256})=>({side,sha256})),evidence:"Other original pair"},"card-2");
      finish(s,"identity",{identity:{...identity,serial:"26/99"},pairMatches:true,frontFirst:true,serialInspected:true,evidence:"Other copy reviewed"},"card-2");
    });
    await withQueue(dir,s=>{
      for(let i=0;i<3;i++)assert.equal(claimJob(s,"worker","reconcile",undefined,now),null);
      assert.equal(s.cards["card-2"].jobs.reconcile.attempts,0);
      assert.equal(s.cards["card-1"].jobs.reconcile.attempts,1);
      recordInventoryAccess(s,{observationId:"failed-probe",available:false,evidence:"Still unavailable"},now);
      assert.equal(claimJob(s,"worker","reconcile","card-1",now),null);
      recordInventoryAccess(s,{observationId:"success-probe",available:true,evidence:"Inventory reads available again"},now);
      assert.equal(recordInventoryAccess(s,{observationId:"success-probe",available:true,evidence:"Inventory reads available again"},now),false);
      assert.throws(()=>recordInventoryAccess(s,{observationId:"success-probe",available:false,evidence:"Changed"},now),/different evidence/);
      assert.equal(claimJob(s,"worker","reconcile","card-1","2026-10-18T09:01:00.000Z"),null);
      recordInventoryAccess(s,{observationId:"later-outage",available:false,evidence:"Access failed again"},"2026-10-18T09:01:00.000Z");
      assert.equal(recordInventoryAccess(s,{observationId:"success-probe",available:true,evidence:"Inventory reads available again"},"2026-10-18T09:01:00.000Z"),false);
      assert.equal(s.inventoryAccess?.available,false);
      recordInventoryAccess(s,{observationId:"fresh-probe",available:true,evidence:"Fresh supported read"},"2026-10-18T09:01:00.000Z");
      assert.ok(claimJob(s,"worker","reconcile","card-1","2026-10-18T09:01:00.000Z"));
      assert.equal(s.cards["card-1"].jobs.reconcile.attempts,2);
    });
    assert.equal((await readQueue(dir)).inventoryAccess?.observationId,"fresh-probe");
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});
test("legacy hold classification requires the exact snapshot and never resets attempts or infers clearance",()=>{
  const s=identified();holdReconciliation(s);const j=s.cards["card-1"].jobs.reconcile;
  const data={inputKey:j.inputKey,reason:j.reason,evidence:"Reviewed dependency-only deferral",recovery:{when:"pricing-ready"}};
  assert.throws(()=>setHoldRecovery(s,"card-1",{...data,inputKey:"stale"},now),/snapshot changed/);
  assert.throws(()=>setHoldRecovery(s,"card-1",data,now,{"card-1":"Seller pause"}),/Seller hold/);
  setHoldRecovery(s,"card-1",data,now);
  assert.equal(j.state,"held");assert.equal(j.attempts,1);assert.equal(j.result,undefined);
  assert.throws(()=>setHoldRecovery(s,"card-1",data,now),/already has/);
  assert.equal(claimJob(s,"worker","reconcile","card-1",now),null);
  priceFixture(s);assert.ok(claimJob(s,"worker","reconcile","card-1",now));
});

test("classifying historical access holds preserves newer observations and requires success after the original failure",()=>{
  const later="2026-10-18T08:10:00.000Z",earlier="2026-10-18T07:59:00.000Z";
  for(const observation of [undefined,{available:true,at:later},{available:false,at:later},{available:true,at:earlier}]) {
    const s=identified();holdReconciliation(s);priceFixture(s);
    if(observation)recordInventoryAccess(s,{observationId:"verified-observation",available:observation.available,evidence:"Supported inventory read"},observation.at);
    const before=structuredClone(s.inventoryAccess),events=s.events.length,j=s.cards["card-1"].jobs.reconcile;
    const data={inputKey:j.inputKey,reason:j.reason,evidence:"Original held event documents access failure",recovery:{when:"inventory-access"}};
    setHoldRecovery(s,"card-1",data,later);
    assert.deepEqual(s.inventoryAccess,before);assert.equal(s.events.length,events+1);
    assert.deepEqual(j.recovery,{when:"inventory-access",blockedAt:now,observedAccess:observation?.available===false?"verified-observation":undefined});
    assert.equal(j.state,"held");assert.equal(j.attempts,1);assert.equal(j.attemptsSinceClearance,1);assert.equal(j.result,undefined);
    assert.equal(!!claimJob(s,"worker","reconcile","card-1",later),observation?.available===true&&observation.at===later);
  }
});

test("historical access classification fails closed without matching chronology and retains freshness and hold guards",()=>{
  const later="2026-10-18T08:10:00.000Z";
  for(const damage of ["missing","different-reason","invalid-date","future-date"]) {
    const s=identified();holdReconciliation(s);const j=s.cards["card-1"].jobs.reconcile;
    const held=s.events.findLast(e=>e.event==="held")!;
    if(damage==="missing")s.events=s.events.filter(e=>e!==held);
    if(damage==="different-reason")held.detail="Different failure";
    if(damage==="invalid-date")held.at="invalid";
    if(damage==="future-date")held.at="2026-10-18T08:11:00.000Z";
    assert.throws(()=>setHoldRecovery(s,"card-1",{inputKey:j.inputKey,reason:j.reason,evidence:"Reviewed hold",recovery:{when:"inventory-access"}},later),/Matching dated hold/);
    assert.equal(j.recovery,undefined);assert.equal(s.inventoryAccess,undefined);
  }
  for(const observationAt of [now,"2026-10-18T09:02:00.000Z"]) {
    const s=identified();holdReconciliation(s);priceFixture(s);const j=s.cards["card-1"].jobs.reconcile;
    setHoldRecovery(s,"card-1",{inputKey:j.inputKey,reason:j.reason,evidence:"Reviewed hold",recovery:{when:"inventory-access"}},later);
    recordInventoryAccess(s,{observationId:"dated-success",available:true,evidence:"Supported read"},observationAt);
    assert.equal(claimJob(s,"worker","reconcile","card-1","2026-10-18T09:01:00.000Z"),null);
    assert.equal(j.attempts,1);
  }
  for(const guard of ["seller","receipt","attempts","photos","duplicate"]) {
    const s=identified();holdReconciliation(s);const j=s.cards["card-1"].jobs.reconcile;
    if(guard==="receipt")s.cards["card-1"].input.knownDraft="123";
    if(guard==="attempts")j.attemptsSinceClearance=2;
    if(guard==="photos")s.cards["card-1"].jobs.photos.state="held";
    if(guard==="duplicate")upsertCard(s,{...input(),id:"duplicate",sku:"duplicate"},now);
    assert.throws(()=>setHoldRecovery(s,"card-1",{inputKey:j.inputKey,reason:j.reason,evidence:"Reviewed hold",recovery:{when:"inventory-access"}},later,guard==="seller"?{"card-1":"Seller pause"}:{}));
    assert.equal(j.recovery,undefined);assert.equal(s.inventoryAccess,undefined);
  }
});

test("CLI recovery uses fresh bound approvals and persists explicit access observations",async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"recovery-handoff-cli-"));
  try {
    const stamp=new Date(Date.now()-1000).toISOString(),s=identified();holdReconciliation(s);
    const c=s.cards["card-1"],j=c.jobs.reconcile;
    c.input.pricingHandoff={status:"review-estimate",item:6.49,shipping:1.49,updatedAt:stamp,policyVersion:CARD_POLICY_VERSION,reason:"Saved proposal",source:"fixture",matchesOriginals:true,needsReview:true};
    const queueDir=path.join(dir,"artifacts/card-orchestrator");await withQueue(queueDir,q=>Object.assign(q,s));
    const classification=path.join(dir,"classification.json"),observation=path.join(dir,"observation.json");
    await fs.writeFile(classification,JSON.stringify({inputKey:j.inputKey,reason:j.reason,evidence:"Inspected dependency-only hold",recovery:{when:"pricing-ready"}}));
    const script=fileURLToPath(new URL("../scripts/card-orchestrator.ts",import.meta.url));
    const cli=(...args:string[])=>JSON.parse(execFileSync(process.execPath,["--experimental-strip-types",script,...args],{cwd:dir,encoding:"utf8",stdio:["ignore","pipe","pipe"]}));
    assert.equal(cli("classify-hold","--card","card-1","--file",classification).classified,"card-1");
    assert.equal(cli("claim","--kind","reconcile","--card","card-1"),null);
    const approval:AskingPriceApproval={cardId:"card-1",item:6.49,shipping:1.49,sourceUpdatedAt:stamp,policyVersion:CARD_POLICY_VERSION,
      photoHashes:c.input.photos.map(p=>p.sha256),approvedAt:stamp,sourceIdentityKey:fingerprint(c.input.identity)};
    const approvals=path.join(queueDir,"asking-price-approvals.json");
    await fs.writeFile(approvals,JSON.stringify({approvals:[{...approval,item:6.95}]}));
    assert.equal(cli("claim","--kind","reconcile","--card","card-1"),null);
    await fs.writeFile(approvals,JSON.stringify({approvals:[approval]}));
    await fs.writeFile(observation,JSON.stringify({observationId:"outage",available:false,evidence:"Read failed"}));
    assert.equal(cli("inventory-access","--file",observation).recorded,true);
    assert.equal(cli("claim","--kind","reconcile","--card","card-1"),null);
    await fs.writeFile(observation,JSON.stringify({observationId:"new-supported-read",available:true,evidence:"Inventory access restored"}));
    assert.equal(cli("inventory-access","--file",observation).recorded,true);
    assert.equal(cli("inventory-access","--file",observation).recorded,false);
    cli("status");
    const status=JSON.parse(await fs.readFile(path.join(queueDir,"status.json"),"utf8"));
    assert.equal(status.cards[0].jobs.find((job:any)=>job.kind==="reconcile").recoverable,true);
    const claim=cli("claim","--kind","reconcile","--card","card-1");assert.equal(claim.job.attempts,2);
    assert.equal((await readQueue(queueDir)).cards["card-1"].jobs.pricing.state,"todo");
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});

test("CLI historical access classification survives restart without manufacturing a shared outage",async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"historical-access-cli-"));
  try {
    const s=identified();holdReconciliation(s);
    const stamp=new Date().toISOString();
    // CLI runs at wall time; this test concerns access recovery, not comp expiry.
    const pricing=claimJob(s,"fixture","pricing","card-1",stamp)!;
    completeJob(s,"card-1","pricing",pricing.job.lease!.token,{outcome:"done",data:{comps:[comp({soldDate:stamp.slice(0,10)})],tracked:false,envelopeEligible:true,evidence:"Fresh fixture sale"}},stamp);
    const card=s.cards["card-1"],j=card.jobs.reconcile;
    recordInventoryAccess(s,{observationId:"fresh-read",available:true,evidence:"Supported read after the historical hold"},stamp);
    const queueDir=path.join(dir,"artifacts/card-orchestrator");await withQueue(queueDir,q=>Object.assign(q,s));
    const classification=path.join(dir,"classification.json");
    await fs.writeFile(classification,JSON.stringify({inputKey:j.inputKey,reason:j.reason,evidence:"Inspected dated access failure",recovery:{when:"inventory-access"}}));
    const script=fileURLToPath(new URL("../scripts/card-orchestrator.ts",import.meta.url));
    const cli=(...args:string[])=>JSON.parse(execFileSync(process.execPath,["--experimental-strip-types",script,...args],{cwd:dir,encoding:"utf8",stdio:["ignore","pipe","pipe"]}));
    assert.equal(cli("classify-hold","--card","card-1","--file",classification).classified,"card-1");
    const saved=await readQueue(queueDir);
    assert.deepEqual(saved.inventoryAccess,s.inventoryAccess);
    assert.deepEqual(saved.inventoryAccessObservations,s.inventoryAccessObservations);
    assert.equal(saved.cards["card-1"].jobs.reconcile.recovery?.blockedAt,now);
    assert.equal(saved.cards["card-1"].jobs.reconcile.state,"held");
    assert.equal(saved.cards["card-1"].jobs.reconcile.attempts,1);
    const claim=cli("claim","--kind","reconcile","--card","card-1");
    assert.equal(claim.job.attempts,2);assert.equal(claim.job.attemptsSinceClearance,2);
    assert.equal((await readQueue(queueDir)).cards["card-1"].jobs.reconcile.result,undefined);
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});

test("partial intake preserves uncertainty and requires complete reviewed identity before downstream work",()=>{
  const source={card_id:"card-1",source_key:"sku1",quantity:1,player:identity.player,condition_plan:identity.condition,print_run:99,
    front_original_path:"front.jpg",back_original_path:"back.jpg",front_sha256:"a".repeat(64),back_sha256:"b".repeat(64)};
  const imported=importLegacyCard(source,{...source,proposed_item_price:50,buyer_shipping:0},[]),s=newQueue();
  assert.equal(imported.identity.season,"");assert.equal(imported.identity.serial,"");assert.equal(imported.identity.printRun,99);
  assert.match(imported.identityIssue!,/season.*serial_text/);assert.equal(imported.pricingHandoff?.item,null);
  assert.equal(imported.pricingHandoff?.matchesOriginals,false);upsertCard(s,imported,now);
  finish(s,"photos",{hashes:imported.photos.map(({side,sha256})=>({side,sha256})),evidence:"Both originals inspected"});
  const claim=claimJob(s,"worker","identity","card-1",now)!;assert.ok(claim);
  for(const kind of ["pricing","reconcile","listing"] as const)assert.equal(claimJob(s,"worker",kind,"card-1",now),null);
  assert.equal(pricingContext(s,"card-1",now).identityReviewRequired,true);
  const sourcePolicy=pricingContext(s,"card-1",now).sourceFirst;
  assert.deepEqual(sourcePolicy.order,["active-listings","sold-listings","knowledge-graph"]);
  assert.equal(sourcePolicy.requiredBeforeExternalResearch,true);
  assert.equal(sourcePolicy.stopWhenFreshValidatedEvidenceExists,true);
  assert.equal(sourcePolicy.historyWindow,"all-available");
  assert.equal(sourcePolicy.pricingTimeboxSeconds,30);
  assert.deepEqual(pricingContext(s,"card-1",now).reusableEvidence,[]);
  const complete=(i:Identity)=>completeJob(s,"card-1","identity",claim.job.lease!.token,{outcome:"done",data:{identity:i,pairMatches:true,frontFirst:true,serialInspected:true,evidence:"Originals reviewed"}},now);
  assert.throws(()=>complete(imported.identity));assert.throws(()=>complete({...identity,serial:""}),/physical serial/);
  assert.throws(()=>complete({...identity,condition:"Excellent"}),/Condition override/);
  complete(identity);assert.ok(claimJob(s,"worker","pricing","card-1",now));
  assert.equal(s.cards["card-1"].input.identity.season,"");
  assert.throws(()=>upsertCard(newQueue(),{...imported,photos:[imported.photos[0]]},now),/photo pair/);
  assert.throws(()=>upsertCard(newQueue(),{...imported,photos:imported.photos.map(p=>({...p,sha256:"bad"}))},now),/hashes/);
  assert.throws(()=>importLegacyCard({...source,condition_plan:"Unknown"},{},[]),/condition/);
  const duplicates=newQueue();upsertCard(duplicates,imported,now);
  upsertCard(duplicates,{...imported,id:"copy",sku:"copy"},now);
  assert.equal(claimJob(duplicates,"worker","photos",undefined,now),null);
});

test("reports share preflight approval precedence and never rewrite saved research or authorize uploads",()=>{
  const s=identified(),c=s.cards["card-1"];
  c.input.pricingHandoff={status:"review-estimate",item:6.49,shipping:1.49,updatedAt:now,policyVersion:CARD_POLICY_VERSION,reason:"Retained estimate",source:"fixture",matchesOriginals:true,needsReview:true};
  finish(s,"listing",{prepare:true});
  const saved=JSON.stringify(c.jobs.listing.result);
  const approval:AskingPriceApproval={cardId:"card-1",item:6.49,shipping:1.49,sourceUpdatedAt:now,policyVersion:CARD_POLICY_VERSION,photoHashes:c.input.photos.map(p=>p.sha256),approvedAt:now,sourceIdentityKey:fingerprint(c.input.identity)};
  const price={item:8.88,shipping:0,source:"fixture",reviewRequired:false,approvedAt:now};
  const check=(approvals:AskingPriceApproval[],decisions:Record<string,WorkflowDecision>={})=>{
    const packet=flowPacket(s,["card-1"],now,approvals,{},decisions).cards[0];
    const report=reportHandoff(s,now,approvals,decisions),row=report.listings[0];
    assert.deepEqual(report.cards[0].pricing,packet.pricing);
    assert.deepEqual(row.approvedAskingPrice,packet.pricing.approvedProposal);
    assert.equal(row.priceNeedsReview,!packet.pricing.approved);
    assert.equal(row.canUpload,false);assert.equal(row.canPublish,false);
    assert.ok(row.blockers.some(b=>b.includes("save/reopen")));
    return row;
  };
  assert.deepEqual(check([approval]).pricing,{item:6.49,shipping:1.49});
  assert.deepEqual(check([],{"card-1":{approvedPrice:price}}).pricing,price);
  const manual={...price,item:7.77};assert.deepEqual(check([approval],{"card-1":{approvedPrice:price,manualPrice:manual}}).pricing,manual);
  assert.equal(check([{...approval,item:6.95}]).priceNeedsReview,true);
  assert.equal(check([approval]).pricingEvidenceValidated,false);
  assert.equal(JSON.stringify(c.jobs.listing.result),saved);
  assert.equal(reportHandoff(s,now,[approval],{"card-1":{holdReason:"Inspect package"}}).listings.length,0);
  finish(s,"pricing",{comps:[comp()],tracked:false,envelopeEligible:true,evidence:"Validated sale"});
  finish(s,"listing",{prepare:true});correctSavedPrices(s,["card-1"],"Seller authority",true,now);
  assert.equal(check([]).priceNeedsReview,false);assert.equal(check([]).pricingEvidenceValidated,true);
});

test("automatic batches isolate expired, superseded, changed-input and held claims across durable reloads",async()=>{
  for(const race of ["expired","superseded","changed-input","seller-hold"] as const) {
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),"card-isolated-batch-"));
    try {
      await withQueue(dir,s=>{for(let n=0;n<10;n++){
        const i=input(`card-${n}`,`${20+n}/99`);i.photos=i.photos.map(p=>({...p,sha256:createHash("sha256").update(`${n}:${p.side}`).digest("hex")}));upsertCard(s,i,now);
      }});
      let clock=now,firstId="";const holds:Record<string,string>={};
      const result=await runAutomaticBatch("photos",10,{
        claim:exclude=>withQueue(dir,s=>claimJob(s,"batch","photos",undefined,clock,holds,exclude)),
        prepare:async claim=>{
          const data={hashes:claim.card.photos,evidence:"Original photo audit"};
          if(!firstId){firstId=claim.card.id;
            if(race==="expired")clock="2026-10-18T08:06:00.000Z";
            if(race==="seller-hold")holds[firstId]="New packaging hold";
            if(race==="changed-input")await withQueue(dir,s=>upsertCard(s,{...s.cards[firstId].input,photos:s.cards[firstId].input.photos.map(p=>({...p,sha256:createHash("sha256").update(`changed:${p.side}`).digest("hex")}))},clock));
            if(race==="superseded"){
              clock="2026-10-18T08:06:00.000Z";
              await withQueue(dir,s=>{const newer=claimJob(s,"new-owner","photos",firstId,clock)!;completeJob(s,firstId,"photos",newer.job.lease!.token,{outcome:"done",data:{...data,evidence:"Newer worker result"}},clock);});
            }
          }
          return data;
        },
        complete:(claim,data)=>withQueue(dir,s=>completeAutomaticJob(s,claim,data,clock,holds)),
      });
      assert.equal(result.completed,9,race);assert.equal(result.held,0,race);assert.equal(result.skipped.length,1,race);
      const saved=await readQueue(dir),first=saved.cards[firstId].jobs.photos;
      assert.equal(Object.values(saved.cards).filter(c=>c.input.id!==firstId&&c.jobs.photos.state==="done").length,9);
      assert.equal(first.state,race==="superseded"?"done":race==="seller-hold"?"leased":"todo");
      assert.equal(first.result?.evidence,race==="superseded"?"Newer worker result":undefined);
      if(race==="expired")assert.equal(first.attempts,1);
    } finally {await fs.rm(dir,{recursive:true,force:true});}
  }
});

test("automatic worker preparation/validation failures hold only their card and storage failures remain fatal",async()=>{
  for(const failure of ["prepare","validate"]) {
    const s=seeded();upsertCard(s,input("card-2","26/99"),now);
    const result=await runAutomaticBatch("photos",10,{
      claim:async exclude=>claimJob(s,"worker","photos",undefined,now,{},exclude),
      prepare:async claim=>{
        if(claim.card.id==="card-1"&&failure==="prepare")throw new Error("Original file unavailable");
        return {hashes:claim.card.id==="card-1"?[]:claim.card.photos,evidence:"Photo audit"};
      },
      complete:async(claim,data)=>completeAutomaticJob(s,claim,data,now),
    });
    assert.equal(result.held,1);assert.equal(result.completed,1);assert.equal(s.cards["card-1"].jobs.photos.state,"held");
  }
  const isolated=seeded();let writes=0;
  await assert.rejects(runAutomaticBatch("photos",10,{
    claim:async exclude=>claimJob(isolated,"worker","photos",undefined,now,{},exclude),
    prepare:async claim=>({hashes:claim.card.photos,evidence:"Photo audit"}),
    complete:async()=>{writes++;throw new Error("Storage replace failed; outcome unknown");},
  }),/outcome unknown/);
  assert.equal(writes,1);assert.equal(isolated.cards["card-1"].jobs.photos.state,"leased");
});

test("condition normalization is per sale and independent of serial premiums and scarcity",()=>{
  for (const [condition, multiplier] of [["Excellent",1.10],["Very good",1.25]] as const) {
    const sale=comp({condition,itemPrice:10});
    const result=validateComps(identity,[sale],now);
    assert.equal(result.mean,10*multiplier);
    assert.equal(result.reviewEstimate,true);
    assert.equal(result.basisDetails[0].conditionMultiplier,multiplier);
    const related={...sale,identity:{...identity,parallel:"Blue",serial:"8/198",printRun:198}};
    const premium=validateComps({...identity,serial:"99/99"},[related],now,"related-print-run");
    assert.equal(premium.mean,10*2*1.15*multiplier);
  }
  assert.equal(validateComps(identity,[comp({condition:"Unknown",evidenceMode:"sold-result",itemPrice:10})],now).mean,10);
  assert.throws(()=>validateComps({...identity,condition:"Excellent"},[comp({condition:"Very good"})],now),/Unsupported condition/);
  assert.throws(()=>validateComps(identity,[comp({condition:"Poor"})],now));
});

test("observed denominator supports estimates without fabricating source serial or relaxing exclusions",()=>{
  const partial=comp({identity:{...identity,serial:"/99"},serialObserved:false,printRunObserved:true});
  assert.equal(validateComps(identity,[partial],now).reviewEstimate,true);
  for(const change of [{printRunObserved:false},{serialObserved:true},{ownAcquisition:true},{graded:true},{priceDisclosed:false},{identity:{...identity,serial:"/100"}}])assert.throws(()=>validateComps(identity,[{...partial,...change}],now));
  assert.throws(()=>validateComps(identity,[comp({identity:{...identity}})],now),/Own exact/);
  const related={...partial,identity:{...identity,parallel:"Other",serial:"/198",printRun:198}};
  assert.equal(validateComps(identity,[related],now,"related-print-run").basisDetails[0].multiplier,2);
  const premium=validateComps({...identity,serial:"1/99"},[partial],now);
  assert.equal(premium.basisDetails[0].premiumPercent,15);
});

test("premium detection uses complete serials and verified color evidence, once per card",()=>{
  assert.deepEqual(cardPremiumReasons({...identity,serial:"001/99"}),["First on print"]);
  assert.deepEqual(cardPremiumReasons({...identity,serial:"99/99"}),["Last on print"]);
  assert.deepEqual(cardPremiumReasons({...identity,serial:"1/100"}),[]);
  assert.deepEqual(cardPremiumReasons({...identity,colorMatch:{matches:true,evidence:""}}),[]);
  const target={...identity,serial:"1/99",colorMatch:{matches:true,evidence:"Original front matches the team uniform"}};
  assert.equal(premiumCompAdjustment(target,identity).multiplier,1.15);
  assert.equal(premiumCompAdjustment(target,target).multiplier,1);
  assert.throws(()=>premiumCompAdjustment(identity,target),/Premium comp/);
});
test("color match is priced by enough direct sales, with 15 percent only for estimates",()=>{
  const target={...identity,colorMatch:{matches:true,evidence:"Original green parallel matches the uniform"}};
  const sales=[comp(),comp({saleId:"407092203089",sourceUrl:"https://www.ebay.com/itm/407092203089",identity:{...identity,serial:"10/99"}})];
  assert.equal(validateComps(target,sales,now).mean,1.75);
  assert.equal(validateComps(target,sales,now).directColorMatch,true);
  assert.equal(validateComps(target,[sales[0]],now).mean,1.75*1.15);
  const related=comp({identity:{...identity,parallel:"Blue",serial:"3/199",printRun:199}});
  assert.equal(validateComps(target,[related],now,"related-print-run").mean,1.75*199/99*1.15);
  const alreadyPremium=comp({identity:{...target,serial:"9/99"}});
  assert.equal(validateComps(target,[alreadyPremium],now).mean,1.75);
  const bookend={...target,serial:"1/99"};
  assert.equal(validateComps(bookend,sales,now).mean,1.75*1.15);
  assert.throws(()=>validateComps(identity,[comp({identity:{...identity,serial:"1/99"}})],now),/Premium comp/);
});
test("audited corrections keep evidence, bind approval, preserve overrides and are repeatable",()=>{
  const s=identified();finish(s,"pricing",{comps:[comp()],tracked:false,envelopeEligible:true,evidence:"Independent sale"});finish(s,"listing",{prepare:true});
  const c=s.cards["card-1"],prior=JSON.stringify(s);
  assert.equal(correctSavedPrices(s,["card-1"],"Seller authorized current rules",false,now).rows[0].status,"proposed");
  assert.equal(JSON.stringify(s),prior);
  correctSavedPrices(s,["card-1"],"Seller authorized current rules",true,now);
  assert.equal(approvedRulePrice(c,now)?.projection.item,1.95);
  assert.equal(c.jobs.listing.state,"done");assert.equal(c.jobs.pricing.attempts,1);
  assert.equal(correctSavedPrices(s,["card-1"],"Seller authorized current rules",true,now).rows[0].status,"unchanged");
  const packet=flowPacket(s,["card-1"],now);assert.equal(packet.cards[0].pricing.approved,true);assert.equal(packet.cards[0].nextOwner,"listing-review");
  (c.jobs.pricing.result!.projection as {item:number}).item=100;
  assert.equal(approvedRulePrice(c,now),null);
  c.input.override={item:9.95,shipping:0,evidence:"Seller special price"};
  const skipped=correctSavedPrices(s,["card-1"],"Seller authorized current rules",true,now).rows[0];
  assert.ok("reason" in skipped);assert.match(skipped.reason,/override/);
});
test("last-on-print adjustment applies once before buyer-total rounding",()=>{
  const s=identified(),c=s.cards["card-1"];
  (c.jobs.identity.result!.identity as Identity).serial="99/99";
  // A new identity must invalidate the previous pricing dependency before claiming.
  finish(s,"pricing",{comps:[comp({itemPrice:3.85})],tracked:false,envelopeEligible:true,evidence:"Independent ordinary copy"});
  const p=c.jobs.pricing.result!.projection as ReturnType<typeof calculateCardPrice>;
  assert.equal(p.policyVersion,CARD_POLICY_VERSION);assert.equal(p.item,2.95);assert.equal(p.shipping,1.49);
  assert.equal(p.compMean,3.85*1.15);
});
test("preflight carries the manual asking price separately from incomplete evidence",()=>{
  const s=identified(),manual={item:7.77,shipping:0,source:"Seller-entered manual price",policy:"seller-manual-price-v1",updatedAt:now,approvedAt:now,reviewRequired:false};
  const p=flowPacket(s,["card-1"],now,[],{"card-1":manual}),c=p.cards[0];
  assert.equal(c.pricing.approvedProposal?.item,7.77);assert.equal(c.pricing.approved,true);
  assert.equal(c.pricing.validatedProposal,null);assert.equal(c.nextOwner,"listing-review");
  assert.equal(c.canPublish,false);assert.ok(!c.blockers.includes("No validated price"));
  assert.match(flowHtml(p),/Draft asking price:/);
});

test("current price rule targets buyer total with no buffer or added postage",()=>{
 const p=calculateCardPrice(1.75);assert.equal(p.item,1.95);assert.equal(p.shipping,0);assert.equal(p.premiumPercent,0);
 assert.equal(p.minimumOffer,1.56);assert.equal(p.autoAccept,1.76);
 assert.equal(calculateCardPrice(2).item,1.95);assert.equal(calculateCardPrice(3).item,1.49);assert.equal(calculateCardPrice(3).shipping,1.49);
 assert.throws(()=>calculateCardPrice(5,{premiumPercent:9}));
 assert.equal(roundUpCardPrice(6.95),6.95);assert.equal(roundUpCardPrice(6.96),7.49);
});
test("shipping tiers, floor, tracked exceptions and explicit overrides",()=>{
 assert.equal(calculateCardPrice(6,{patch:true}).shipping,1.95);
 assert.equal(calculateCardPrice(12).shipping,1.95);assert.equal(calculateCardPrice(20).shipping,6.29);
 const tracked=calculateCardPrice(1.75,{tracked:true});assert.equal(tracked.item,1.49);assert.equal(tracked.shipping,6.29);
 assert.throws(()=>calculateCardPrice(5,{override:{item:1,shipping:0,evidence:"Below floor"}}));
 assert.throws(()=>calculateCardPrice(0));assert.throws(()=>calculateCardPrice(5,{premiumPercent:50}));
});
test("new queue prices use known comp buyer totals; unknown shipping cannot approve",()=>{
 const s=identified();finish(s,"pricing",{comps:[comp({itemPrice:5,shipping:2})],tracked:false,envelopeEligible:true,evidence:"Known buyer total"});
 const p=s.cards["card-1"].jobs.pricing.result!.projection as ReturnType<typeof calculateCardPrice>;
 assert.equal(p.targetBuyerTotal,7);assert.equal(p.item,5.95);assert.equal(p.shipping,1.49);assert.equal(p.premiumPercent,0);
 const missing=identified();assert.throws(()=>finish(missing,"pricing",{comps:[comp({shipping:null})],tracked:false,envelopeEligible:true,evidence:"Unknown shipping"}),/buyer-total/);
});

test("jobs follow prerequisites, and no operation creates a publishable payload",()=>{
  const s=seeded();assert.equal(claimJob(s,"worker","identity",undefined,now),null);
  const ready=identified();finish(ready,"listing",{prepare:true});const result=ready.cards["card-1"].jobs.listing.result!;
  assert.equal(result.action,"");assert.equal(result.canPublish,false);assert.equal(result.canUpload,false);assert.equal(result.quantity,1);assert.equal(result.pricing,null);
  assert.equal(queueSummary(ready,now).counts.readyForUpload,0);
});
test("live and draft receipts exclude cards, even when subsequent source rows omit them",()=>{
  const s=seeded();upsertCard(s,{...input(),knownLive:{itemId:"123",url:"https://www.ebay.com/itm/123",observedAt:now,source:"test"}},now);
  upsertCard(s,input(),now);assert.equal(claimJob(s,"worker","listing",undefined,now),null);
  assert.ok(claimJob(s,"worker","photos",undefined,now));
  const d=seeded();upsertCard(d,{...input(),knownDraft:"456"},now);assert.equal(claimJob(d,"worker","listing",undefined,now),null);
  assert.ok(claimJob(d,"worker","photos",undefined,now));
});
test("a reviewed draft can finish pricing while Add and conflicting receipts stay blocked",()=>{
  const s=identified();upsertCard(s,{...input(),knownDraft:"456"},now);
  assert.equal(claimJob(s,"worker","listing","card-1",now),null);
  finish(s,"pricing",{comps:[comp({shipping:1.49})],tracked:false,envelopeEligible:true,evidence:"Reused pricing agent evidence"});
  assert.equal((s.cards["card-1"].jobs.pricing.result!.projection as {item:number}).item,1.95);
  assert.deepEqual(localReviewListings(s,now),[]);assert.equal(queueSummary(s,now).counts.readyForUpload,0);
  const conflict=identified();upsertCard(conflict,{...input(),knownDraft:"456"},now);
  upsertCard(conflict,{...input("card-2","26/99"),knownDraft:"456"},now);
  assert.equal(claimJob(conflict,"worker","pricing","card-1",now),null);
  const live=identified();upsertCard(live,{...input(),knownLive:{itemId:"123",url:"https://www.ebay.com/itm/123",observedAt:now,source:"test"}},now);
  finish(live,"pricing",{comps:[comp()],tracked:false,envelopeEligible:true,evidence:"Local evidence maintenance on existing live record"});
  assert.equal(claimJob(live,"worker","listing","card-1",now),null);
  assert.deepEqual(localReviewListings(live,now),[]);
  const sold=identified();upsertCard(sold,{...input(),knownLive:{itemId:"123",url:"https://www.ebay.com/itm/123",observedAt:now,source:"test"}},now);
  sold.cards["card-1"].exclusion={disposition:"sold",itemId:"123",evidence:"Sold receipt supersedes historical live receipt"};
  assert.equal(claimJob(sold,"worker","pricing","card-1",now),null);
});
test("same photos, same SKU and exact physical serial are independently blocked",()=>{
  for(const change of [{photos:input().photos},{sku:"card-1"},{identity}]){
    const s=seeded();upsertCard(s,{...input("card-2","26/99"),...change},now);assert.equal(claimJob(s,"worker",undefined,undefined,now),null);
  }
  const s=seeded();upsertCard(s,input("card-2","26/99"),now);assert.ok(claimJob(s,"worker","photos","card-2",now));
});

test("original front captures cannot be duplicated by changing the back, while distinct fronts remain inventory",()=>{
  const s=newQueue(),first={...input(),identity:{...identity,serial:"",printRun:null}};
  upsertCard(s,first,now);
  const lease=claimJob(s,"worker","photos","card-1",now)!;
  const second={...input("card-2"),identity:first.identity,photos:[{...first.photos[0],sha256:first.photos[0].sha256.toUpperCase()},input("card-2").photos[1]]};
  upsertCard(s,second,now);
  assert.equal(claimJob(s,"worker","photos","card-2",now),null);
  assert.match(queueSummary(s,now).cards[0].jobs[0].blockers.join(";"),/Same original front capture.*conflicting back/);
  assert.throws(()=>completeJob(s,"card-1","photos",lease.job.lease!.token,{outcome:"done",data:{hashes:first.photos,evidence:"Old claim"}},now),/prerequisites/);
  const separate=newQueue();upsertCard(separate,first,now);
  upsertCard(separate,{...second,photos:[input("card-2").photos[0],first.photos[1]]},now);
  assert.ok(claimJob(separate,"a","photos","card-1",now));
  assert.ok(claimJob(separate,"b","photos","card-2",now));
  assert.equal(upsertCard(separate,first,now),false);
  assert.equal(Object.keys(separate.cards).length,2);
});

test("successful reconciliation refreshes preserve total attempts without exhausting future cycles",async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"card-reconcile-cycles-"));
  try {
    const s=identified();await withQueue(dir,q=>Object.assign(q,s));
    for(let cycle=0;cycle<4;cycle++) {
      const at=new Date(Date.parse(now)+cycle*61*60000).toISOString();
      await withQueue(dir,q=>{
        const card=q.cards["card-1"];refreshJobs(card,at);
        if(cycle){assert.equal(card.jobs.reconcile.state,"held");retryHeld(q,"card-1","reconcile","Fresh inventory observation available",at);}
        const claim=claimJob(q,"worker","reconcile","card-1",at)!;assert.ok(claim);
        completeJob(q,"card-1","reconcile",claim.job.lease!.token,{outcome:"done",data:{seller:"imaydit58",disposition:"clear",checkedAt:at,scopes:["active","drafts","scheduled","sold"],evidence:"All four scopes checked"}},at);
      });
      const saved=(await readQueue(dir)).cards["card-1"].jobs.reconcile;
      assert.equal(saved.attempts,cycle+1);assert.equal(saved.attemptsSinceClearance,0);
    }
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});

test("legacy expired clearances recover once while failed and timed-out reconciliation stays bounded",()=>{
  const s=identified();finish(s,"reconcile",{seller:"imaydit58",disposition:"clear",checkedAt:now,scopes:["active","drafts","scheduled","sold"],evidence:"Old verified clearance"});
  const job=s.cards["card-1"].jobs.reconcile;job.attempts=5;delete job.attemptsSinceClearance;
  job.state="held";job.reason="Previous inventory clearance expired; fresh four-scope check required";
  const at="2026-10-18T10:00:00.000Z";retryHeld(s,"card-1","reconcile","Fresh observation available",at);
  const first=claimJob(s,"worker","reconcile","card-1",at)!;assert.ok(first);
  const second=claimJob(s,"worker","reconcile","card-1","2026-10-18T10:06:00.000Z")!;assert.ok(second);
  assert.throws(()=>completeJob(s,"card-1","reconcile",first.job.lease!.token,{outcome:"held",reason:"Late"},"2026-10-18T10:06:00.000Z"),/Lease/);
  assert.equal(claimJob(s,"worker","reconcile","card-1","2026-10-18T10:12:00.000Z"),null);
  assert.equal(job.attempts,7);assert.equal(job.attemptsSinceClearance,2);
  assert.throws(()=>retryHeld(s,"card-1","reconcile","No changed evidence","2026-10-18T10:12:00.000Z"),/attempt limit/);
  const failed=identified();
  for(let attempt=0;attempt<2;attempt++) {
    if(attempt)retryHeld(failed,"card-1","reconcile","Supported recovery",now);
    const claim=claimJob(failed,"worker","reconcile","card-1",now)!;
    completeJob(failed,"card-1","reconcile",claim.job.lease!.token,{outcome:"held",reason:"Inventory unavailable"},now);
  }
  delete failed.cards["card-1"].jobs.reconcile.attemptsSinceClearance;
  assert.throws(()=>retryHeld(failed,"card-1","reconcile","Same outage",now),/attempt limit/);
});

test("seller holds block claims, in-flight completion and local exports without deleting completed evidence",()=>{
  const s=identified(),holds={"card-1":"Inspect packaging"};finish(s,"listing",{prepare:true});
  const claim=claimJob(s,"worker","reconcile","card-1",now)!;
  assert.equal(claimJob(s,"worker","pricing","card-1",now,holds),null);
  assert.throws(()=>completeJob(s,"card-1","reconcile",claim.job.lease!.token,{outcome:"held",reason:"No evidence"},now,holds),/seller hold/);
  assert.deepEqual(localReviewListings(s,now,holds),[]);
  assert.equal(s.cards["card-1"].jobs.listing.state,"done");
  assert.equal(localReviewListings(s,now).length,1);
});

test("preflight retains exact downstream blockers and seller holds alongside asking-price approval",()=>{
  const s=identified();
  const claim=claimJob(s,"worker","reconcile","card-1",now)!;
  completeJob(s,"card-1","reconcile",claim.job.lease!.token,{outcome:"held",reason:"Seller Hub timed out"},now);
  const approved={item:7.77,shipping:0,source:"Workflow",updatedAt:now,approvedAt:now,policy:CARD_POLICY_VERSION,reviewRequired:false};
  const packet=flowPacket(s,["card-1"],now,[],{},{"card-1":{approvedPrice:approved,holdReason:"Inspect packaging"}}),card=packet.cards[0];
  assert.equal(card.pricing.approved,true);assert.equal(card.pricing.approvedProposal?.item,7.77);
  assert.equal(card.nextOwner,"seller-review");assert.equal(card.sellerHold,"Inspect packaging");
  assert.ok(card.blockers.includes("reconcile: Seller Hub timed out"));
  assert.ok(card.blockers.includes("No validated price"));
  assert.match(flowHtml(packet),/Seller hold: Inspect packaging/);
  assert.equal(card.canUpload,false);assert.equal(card.canPublish,false);
});
test("lease ownership prevents competing workers from overwriting results",()=>{
  const s=seeded(),first=claimJob(s,"a","photos",undefined,now)!;
  assert.equal(claimJob(s,"b","photos",undefined,now),null);
  assert.throws(()=>completeJob(s,"card-1","photos","wrong",{outcome:"held",reason:"x"},now),/Lease/);
  const later="2026-10-18T08:06:00.000Z",next=claimJob(s,"b","photos",undefined,later)!;assert.ok(next);
  assert.notEqual(first.job.lease!.token,next.job.lease!.token);
  assert.throws(()=>completeJob(s,"card-1","photos",first.job.lease!.token,{outcome:"held",reason:"late"},later),/Lease/);
  assert.equal(claimJob(s,"c","photos",undefined,"2026-10-18T08:12:00.000Z"),null);assert.equal(s.cards["card-1"].jobs.photos.state,"held");
});
test("changed photos invalidate identity, prices and local listing work",()=>{
  const s=identified();finish(s,"pricing",{comps:[comp()],tracked:false,envelopeEligible:true,evidence:"eligible"});finish(s,"listing",{prepare:true});
  const updated=input();updated.photos[0].sha256="e".repeat(64);upsertCard(s,updated,now);
  for(const kind of ["photos","identity","pricing","listing"] as const)assert.equal(s.cards["card-1"].jobs[kind].state,"todo");
});
test("changed source invalidates a worker's in-flight completion",()=>{
  const s=seeded(),claim=claimJob(s,"a","photos",undefined,now)!;const updated=input();updated.photos[0].sha256="f".repeat(64);upsertCard(s,updated,now);
  assert.throws(()=>completeJob(s,"card-1","photos",claim.job.lease!.token,{outcome:"held",reason:"old input"},now),/Lease/);
});
test("held work stays quiet, and retries require evidence and stop at attempt limit",()=>{
  const s=seeded();let c=claimJob(s,"a","photos",undefined,now)!;completeJob(s,"card-1","photos",c.job.lease!.token,{outcome:"held",reason:"missing original"},now);
  assert.equal(claimJob(s,"a",undefined,undefined,now),null);assert.throws(()=>retryHeld(s,"card-1","photos","",now));
  retryHeld(s,"card-1","photos","Original restored",now);c=claimJob(s,"a","photos",undefined,now)!;completeJob(s,"card-1","photos",c.job.lease!.token,{outcome:"held",reason:"still missing"},now);
  assert.throws(()=>retryHeld(s,"card-1","photos","Try again",now));
});
test("bad import quarantines prepared work without erasing original data",()=>{
  const s=identified();finish(s,"listing",{prepare:true});quarantineImport(s,"card-1","invalid override",now);
  assert.equal(queueSummary(s,now).counts.localListingsPrepared,0);assert.equal(claimJob(s,"worker",undefined,undefined,now),null);
  assert.equal(s.cards["card-1"].input.photos[0].sha256,"a".repeat(64));
  upsertCard(s,input(),now);assert.equal(s.cards["card-1"].jobs.identity.state,"todo");
});
test("matching sold item amounts ignore unknown shipping; weak evidence stays review-only",()=>{
  const validated=validateComps(identity,[comp({condition:"Unknown",evidenceMode:"sold-result"})],now);
  assert.equal(validated.mean,1.75);assert.equal(validated.reviewEstimate,true);
  assert.equal(validateComps(identity,[comp({shipping:99})],now).mean,1.75);
});
test("comp safeguards reject own acquisition, wrong player, duplicate sale and stale evidence",()=>{
  assert.throws(()=>validateComps(identity,[comp({identity})],now),/Own exact/);
  assert.throws(()=>validateComps(identity,[comp({identity:{...identity,player:"Wrong",serial:"9/99"}})],now),/does not match/);
  assert.throws(()=>validateComps(identity,[comp(),comp({saleId:"other",sourceUrl:"https://www.ebay.com/itm/name/407092203088?x=y"})],now),/Duplicate/);
  assert.throws(()=>validateComps(identity,[comp({soldDate:"2026-01-01"})],now),/90-day/);
  assert.throws(()=>validateComps(identity,[comp({priceDisclosed:false})],now));
  assert.throws(()=>validateComps(identity,[comp({serialObserved:false})],now),/serial/);
  assert.throws(()=>validateComps(identity,[comp({condition:"Unknown"})],now),/condition/);
});

test("related numbered-parallel estimates scale item amounts and remain labeled for review",()=>{
  const s=identified();
  const related=comp({identity:{...identity,parallel:"Blue Prizm",serial:"14/198",printRun:198},shipping:99});
  finish(s,"pricing",{comps:[related],basis:"related-print-run",exactSearchEvidence:"Focused exact sold search found no usable independent sale",tracked:false,envelopeEligible:true,evidence:"Independent related original sale and physical serial reviewed"});
  const result=s.cards["card-1"].jobs.pricing.result!;
  assert.equal(result.mean,3.5);assert.equal(result.reviewEstimate,true);
  assert.deepEqual(result.basisDetails,[{saleId:"407092203088",sourceUrl:"https://www.ebay.com/itm/407092203088",itemPrice:1.75,sourcePrintRun:198,targetPrintRun:99,multiplier:2,premiumMultiplier:1,premiumPercent:0,conditionMultiplier:1,conditionPercent:0,sourceCondition:"Near mint or better",targetCondition:"Near mint or better",targetPremiums:[],sourcePremiums:[],adjustedItemPrice:3.5}]);
  assert.equal(result.buyerTotalMean,201.5);assert.equal((result.projection as {item:number}).item,195.49);
  finish(s,"listing",{prepare:true});
  const row=localReviewListings(s,now)[0];
  assert.equal(row.priceBasis,"related-print-run");assert.equal(row.reviewEstimate,true);assert.equal(row.priceNeedsReview,true);
  assert.deepEqual(row.priceBasisDetails,result.basisDetails);
  assert.equal(row.action,"");assert.equal(row.canUpload,false);assert.equal(row.canPublish,false);
  assert.equal(queueSummary(s,now).cards[0].jobs.find(j=>j.kind==="pricing")!.state,"done");
  queueSummary(s,"2026-11-01T08:00:00.000Z");
  assert.equal(s.cards["card-1"].jobs.pricing.state,"held");assert.equal(localReviewListings(s,"2026-11-01T08:00:00.000Z").length,0);
});

test("related estimate fallback requires exact-search evidence and retains acquisition safeguards",()=>{
  const related=comp({identity:{...identity,parallel:"Blue Prizm",serial:"14/198",printRun:198}});
  const s=identified(),claim=claimJob(s,"worker","pricing",undefined,now)!;
  const payload={comps:[related],basis:"related-print-run",tracked:false,envelopeEligible:true,evidence:"Related sale inspected"};
  assert.throws(()=>completeJob(s,"card-1","pricing",claim.job.lease!.token,{outcome:"done",data:payload},now),/exact sold/);
  assert.throws(()=>validateComps(identity,[related],now),/does not match/);
  assert.throws(()=>validateComps(identity,[comp()],now,"related-print-run"),/exact basis/);
  for(const changes of [{ownAcquisition:true},{priceDisclosed:false},{graded:true},{lot:true},{serialObserved:false}]) {
    assert.throws(()=>validateComps(identity,[{...related,...changes}],now,"related-print-run"));
  }
  assert.throws(()=>validateComps(identity,[{...related,identity:{...related.identity,cardNumber:"999"}}],now,"related-print-run"),/same card/);
  assert.throws(()=>validateComps({...identity,serial:"",printRun:null},[related],now,"related-print-run"),/known numbered/);
  assert.throws(()=>validateComps(identity,[{...related,identity:{...related.identity,serial:"",printRun:null}}],now,"related-print-run"),/known numbered/);
  assert.throws(()=>validateComps(identity,[related,related],now,"related-print-run"),/Duplicate/);
});

test("related arithmetic preserves unrounded means, exact low-price conversion and user overrides",()=>{
  const related=(id:string,price:number)=>comp({saleId:id,sourceUrl:`https://www.ebay.com/itm/${id}`,itemPrice:price,identity:{...identity,parallel:"White Prizm",serial:"7/50",printRun:50},shipping:500});
  const v=validateComps(identity,[related("100",1.01),related("101",2)],now,"related-print-run");
  assert.equal(v.mean,(1.01*50/99+2*50/99)/2);
  const s=identified();finish(s,"pricing",{comps:[comp({identity:{...identity,parallel:"Other Prizm",serial:"7/99"}})],basis:"related-print-run",exactSearchEvidence:"No exact parallel sale",tracked:false,envelopeEligible:true,evidence:"Independent related parallel"});
  assert.equal((s.cards["card-1"].jobs.pricing.result!.projection as {item:number}).item,1.95);
  const override={item:7.11,shipping:2.22,evidence:"Direct user override"};
  upsertCard(s,{...input(),override},now);
  finish(s,"pricing",{comps:[related("102",2)],basis:"related-print-run",exactSearchEvidence:"No usable exact sold comp",tracked:false,envelopeEligible:true,evidence:"Related original reviewed"});
  const p=s.cards["card-1"].jobs.pricing.result!.projection as {item:number;shipping:number;overridden:boolean};
  assert.deepEqual({item:p.item,shipping:p.shipping,overridden:p.overridden},{item:7.11,shipping:2.22,overridden:true});
});

test("numbered comp serials must be complete and consistent before pricing",()=>{
  for(const serial of ["25","25/98","0/99","100/99"])assert.throws(()=>validateComps(identity,[comp({identity:{...identity,serial}})],now),/complete numerator/);
  assert.throws(()=>validateComps(identity,[comp({identity:{...identity,serial:"025/099"}})],now),/Own exact/);
});
test("CLI review report preserves a related estimate and its source arithmetic across restart",async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"card-related-report-")),checkedAt=new Date().toISOString();
  try {
    await withQueue(path.join(dir,"artifacts/card-orchestrator"),s=>{
      upsertCard(s,input(),checkedAt);
      const done=(kind:JobKind,data:unknown)=>{
        const claimed=claimJob(s,"report-test",kind,"card-1",checkedAt)!;
        completeJob(s,"card-1",kind,claimed.job.lease!.token,{outcome:"done",data},checkedAt);
      };
      done("photos",{hashes:input().photos.map(({side,sha256})=>({side,sha256})),evidence:"Test fixture hashes"});
      done("identity",{identity,pairMatches:true,frontFirst:true,serialInspected:true,evidence:"Test fixture identity"});
      done("pricing",{basis:"related-print-run",exactSearchEvidence:"No usable exact sale in test fixture",tracked:false,envelopeEligible:true,evidence:"Test fixture related sale",comps:[comp({soldDate:checkedAt.slice(0,10),identity:{...identity,parallel:"Blue Prizm",printRun:198,serial:"14/198"}})]});
      done("listing",{prepare:true});
    });
    const script=fileURLToPath(new URL("../scripts/card-orchestrator.ts",import.meta.url));
    execFileSync(process.execPath,["--experimental-strip-types",script,"status"],{cwd:dir,stdio:["ignore","pipe","pipe"]});
    const html=await fs.readFile(path.join(dir,"artifacts/card-orchestrator/status.html"),"utf8");
    assert.match(html,/Related numbered-parallel estimate · Review price in eBay draft/);
    assert.match(html,/Source sold item \$1\.75 × 198\/99 × 1 feature adjustment = \$3\.5000 before premium and rounding/);
    assert.match(html,/https:\/\/www\.ebay\.com\/itm\/407092203088/);
    const saved=await readQueue(path.join(dir,"artifacts/card-orchestrator"));
    assert.equal(saved.cards["card-1"].jobs.pricing.state,"done");
    assert.equal(saved.cards["card-1"].jobs.listing.result!.canPublish,false);
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});

test("identity review cannot invent a serial or erase a user condition override",()=>{
  const s=seeded();finish(s,"photos",{hashes:input().photos.map(({side,sha256})=>({side,sha256})),evidence:"original"});
  const c=claimJob(s,"worker","identity",undefined,now)!;
  const submit=(i:Identity)=>completeJob(s,"card-1","identity",c.job.lease!.token,{outcome:"done",data:{identity:i,pairMatches:true,frontFirst:true,serialInspected:true,evidence:"viewed"}},now);
  assert.throws(()=>submit({...identity,serial:"100/99"}),/numerator/);assert.throws(()=>submit({...identity,condition:"Excellent"}),/override/);assert.throws(()=>submit({...identity,autograph:null}),/autograph/);
});
test("clear inventory requires fresh observations in all four scopes for the right seller",()=>{
  const s=identified(),c=claimJob(s,"worker","reconcile",undefined,now)!;
  const data={seller:"imaydit58",disposition:"clear",checkedAt:now,scopes:["active","drafts","scheduled","sold"],evidence:"SKU and exact identity checked"};
  const submit=(change:Record<string,unknown>)=>completeJob(s,"card-1","reconcile",c.job.lease!.token,{outcome:"done",data:{...data,...change}},now);
  assert.throws(()=>submit({scopes:["active"]}),/active, draft/);assert.throws(()=>submit({seller:"other"}));assert.throws(()=>submit({checkedAt:"2026-10-18T06:00:00.000Z"}),/fresh/);
  submit({});assert.equal(s.cards["card-1"].jobs.reconcile.state,"done");
});
test("a positive external receipt survives identity changes",()=>{
  const s=identified();finish(s,"reconcile",{seller:"imaydit58",disposition:"live",checkedAt:now,scopes:["active"],itemId:"123",evidence:"exact listing"});
  upsertCard(s,{...input(),identity:{...identity,team:"Corrected team"}},now);
  assert.equal(claimJob(s,"worker","listing",undefined,now),null);
  assert.equal(s.cards["card-1"].exclusion?.itemId,"123");
  assert.ok(claimJob(s,"worker","identity",undefined,now));
});
test("new external receipts remove prepared cards from the review export without erasing history",()=>{
  for(const disposition of ["live","draft","scheduled","sold"]){
    const s=identified();finish(s,"listing",{prepare:true});assert.equal(localReviewListings(s,now).length,1);
    finish(s,"reconcile",{seller:"imaydit58",disposition,checkedAt:now,scopes:[disposition==="live"?"active":disposition==="draft"?"drafts":disposition],itemId:"123",evidence:"Exact physical copy"});
    assert.deepEqual(localReviewListings(s,now),[]);
    const summary=queueSummary(s,now);assert.equal(summary.counts.localListingsPrepared,0);assert.equal(summary.counts.excludedPreparedListings,1);
    assert.deepEqual(summary.cards[0].existingReceipt,{disposition,itemId:"123"});assert.equal(summary.cards[0].liveItemId,disposition==="live"?"123":null);
    assert.equal(s.cards["card-1"].jobs.listing.state,"done");assert.ok(s.cards["card-1"].jobs.listing.result?.title);
  }
  const s=identified();finish(s,"listing",{prepare:true});upsertCard(s,{...input(),knownDraft:"456"},now);
  assert.equal(localReviewListings(s,now).length,0);assert.equal(queueSummary(s,now).cards[0].existingReceipt?.itemId,"456");
  const d=identified();finish(d,"listing",{prepare:true});upsertCard(d,{...input("card-2","26/99"),photos:input().photos},now);
  assert.equal(localReviewListings(d,now).length,0);
});
test("long player titles retain identifying details and only shorten redundant brand words",()=>{
  const long={...identity,player:"Nickeil Alexander-Walker",cardNumber:"193",parallel:"Purple Ice Prizm",serial:"051/149",printRun:149};
  const title=listingTitle(long);assert.ok(title.length<=80);assert.match(title,/Nickeil Alexander-Walker/);assert.match(title,/#193/);assert.match(title,/Purple Ice/);assert.match(title,/051\/149/);assert.match(title,/Prizm Black/);
  assert.equal(listingTitle(identity),"2024-25 Panini Prizm Black Payton Pritchard #212 Purple Prizm 25/99");
  assert.throws(()=>listingTitle({...long,parallel:"Unique Unabridgeable Parallel ".repeat(4)}),/needs review/);
});
test("overflow titles omit only the exact sport suffix and retain autograph and variant details",()=>{
  const card={...identity,season:"2025-26",set:"Topps Chrome Updates Basketball",manufacturer:"Topps",player:"Max Shulga",cardNumber:"TCA-MS",sport:"Basketball",parallel:"Purple Geometric Refractor",serial:"04/75",printRun:75,autograph:true};
  const before=structuredClone(card);
  assert.equal(listingTitle(card),"2025-26 Chrome Updates Max Shulga #TCA-MS Purple Geometric Refractor 04/75 Auto");
  assert.deepEqual(card,before);
  assert.throws(()=>listingTitle({...card,set:"Topps Chrome Updates Basketball Special Product"}),/needs review/);
  assert.throws(()=>listingTitle({...card,parallel:"Purple Geometric Extremely Long Unique Refractor"}),/needs review/);
  const soccer={...card,player:"Ismaily",season:"2019-20",set:"2019-20 Topps Chrome UEFA Champions League",sport:"Soccer",cardNumber:"46",parallel:"Gold Refractor",serial:"11/50",autograph:false};
  assert.equal(listingTitle(soccer),"2019-20 Chrome UEFA Champions League Ismaily #46 Gold Refractor 11/50");
  assert.throws(()=>listingTitle({...soccer,set:"2018-19 Topps Chrome UEFA Champions League"}),/needs review/);
});
test("a reused draft ID is surfaced as conflicting evidence while both physical cards remain excluded",()=>{
  const s=seeded();upsertCard(s,{...input(),knownDraft:"123"},now);
  upsertCard(s,{...input("card-2","26/99"),knownDraft:"456",savedReceipts:[{disposition:"draft",itemId:"123",source:"saved manifest"}]},now);
  const summary=queueSummary(s,now);assert.equal(summary.counts.receiptConflicts,1);assert.equal(summary.counts.alreadyListed,2);
  assert.deepEqual(summary.receiptConflicts,[{itemId:"123",cardIds:["card-1","card-2"]}]);assert.equal(summary.counts.actionableJobs,0);
});
test("expired comps and reconciliation clearance cannot remain ready indefinitely",()=>{
  const s=identified();finish(s,"pricing",{comps:[comp()],tracked:false,envelopeEligible:true,evidence:"eligible"});finish(s,"listing",{prepare:true});
  finish(s,"reconcile",{seller:"imaydit58",disposition:"clear",checkedAt:now,scopes:["active","drafts","scheduled","sold"],evidence:"four scopes checked"});
  queueSummary(s,"2026-11-01T08:00:00.000Z");
  assert.equal(s.cards["card-1"].jobs.pricing.state,"held");assert.equal(s.cards["card-1"].jobs.reconcile.state,"held");assert.equal(s.cards["card-1"].jobs.listing.state,"todo");
});
test("short queue contention waits for the current writer and claims independent work exactly once",async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"card-contention-"));
  let release!:()=>void,entered!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
  let first:Promise<string>|undefined;
  try {
    await withQueue(dir,s=>{upsertCard(s,input(),now);upsertCard(s,input("card-2","26/99"),now);});
    let calls=0;
    first=withQueue(dir,async s=>{
      calls++;const claim=claimJob(s,"first-worker","photos",undefined,now)!;assert.ok(claim);
      entered();await gate;return claim.card.id;
    });
    await started;
    const releaseTimer=setTimeout(release,100);
    let second:string;
    try {second=await withQueue(dir,s=>{calls++;const claim=claimJob(s,"second-worker","photos",undefined,now)!;assert.ok(claim);return claim.card.id;});}
    finally {clearTimeout(releaseTimer);release();}
    assert.notEqual(await first,second);assert.equal(calls,2);
    const saved=await readQueue(dir);
    assert.equal(saved.revision,3);
    assert.deepEqual(Object.values(saved.cards).map(c=>c.jobs.photos.attempts),[1,1]);
    assert.equal(saved.events.filter(e=>e.event==="claimed").length,2);
    assert.ok(!(await fs.readdir(dir)).includes("queue.lock"));
  } finally {release();await first;await fs.rm(dir,{recursive:true,force:true});}
});
test("queue lock waits are bounded and never alter an unverified owner's lock or durable work",async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"card-busy-"));
  try {
    await withQueue(dir,s=>upsertCard(s,input(),now));
    const before=await fs.readFile(path.join(dir,"state.json"),"utf8");
    const owner='{"fixture":"unverified owner; never steal"}';await fs.writeFile(path.join(dir,"queue.lock"),owner);
    let called=false;const started=performance.now();
    await assert.rejects(withQueue(dir,()=>{called=true;},{lockWaitMs:100}),QueueBusyError);
    assert.equal(called,false);assert.ok(performance.now()-started<2500);
    assert.equal(await fs.readFile(path.join(dir,"queue.lock"),"utf8"),owner);
    assert.equal(await fs.readFile(path.join(dir,"state.json"),"utf8"),before);
    await assert.rejects(withQueue(dir,()=>undefined,{lockWaitMs:-1}),/lock wait/);
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});
test("queue transaction failures are never retried even when they have the acquisition error code",async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"card-no-replay-"));
  try {
    await withQueue(dir,s=>upsertCard(s,input(),now));let calls=0;
    await assert.rejects(withQueue(dir,s=>{calls++;delete s.cards["card-1"];throw Object.assign(new Error("fixture write failed"),{code:"EEXIST"});}),/fixture write failed/);
    assert.equal(calls,1);assert.ok((await readQueue(dir)).cards["card-1"]);
    assert.equal((await readQueue(dir)).revision,1);
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});
test("file store persists results, rejects overlapping writers and fails closed on corrupt state",async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"card-orchestrator-test-"));
  try{
    await withQueue(dir,s=>upsertCard(s,input(),now));assert.equal((await readQueue(dir)).revision,1);
    await withQueue(dir,async()=>{await assert.rejects(()=>withQueue(dir,()=>undefined,{lockWaitMs:0}),/locked/);});
    assert.equal((await readQueue(dir)).revision,1);
    await assert.rejects(()=>withQueue(dir,s=>{delete s.cards["card-1"];throw new Error("simulated failure");}),/simulated/);
    assert.ok((await readQueue(dir)).cards["card-1"]);
    await fs.writeFile(path.join(dir,"state.json"),"broken");await assert.rejects(()=>withQueue(dir,()=>undefined));
    await assert.rejects(()=>fs.stat(path.join(dir,"queue.lock")),{code:"ENOENT"});
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test("importer refuses missing capture identifiers and ambiguous saved overrides",()=>{
  assert.throws(()=>importLegacyCard({}, {}, []));
  const row={card_id:"card-1",source_key:"sku1",quantity:1,player:identity.player,season:identity.season,set:identity.set,manufacturer:identity.manufacturer,card_number:identity.cardNumber,sport_game:identity.sport,parallel:identity.parallel,condition_plan:identity.condition,print_run:99,serial_text:"25/99",front_original_path:"front.jpg",back_original_path:"back.jpg",front_sha256:"a".repeat(64),back_sha256:"b".repeat(64)};
  assert.equal(importLegacyCard(row,{user_price_override:4.99,buyer_shipping:0},[]).override!.item,4.99);
  assert.throws(()=>importLegacyCard(row,{user_price_override:"confirmed"},[]),/override/);
});
test("pricing-agent estimates survive import as review information, never approved prices",()=>{
  const row={card_id:"card-1",source_key:"sku1",quantity:1,player:identity.player,season:identity.season,set:identity.set,manufacturer:identity.manufacturer,card_number:identity.cardNumber,sport_game:identity.sport,parallel:identity.parallel,condition_plan:identity.condition,print_run:99,serial_text:"25/99",front_original_path:"front.jpg",back_original_path:"back.jpg",front_sha256:"a".repeat(64),back_sha256:"b".repeat(64)};
  const pricing={...row,serial_text:"",serial_number:"025",status:"review-estimate",proposed_item_price:6.49,buyer_shipping:1.49,pricing_policy_version:"item-only",updated_at:now,review_reason:"Source serial unresolved"};
  const imported=importLegacyCard(row,pricing,[]);assert.equal(imported.pricingHandoff?.item,6.49);assert.equal(imported.pricingHandoff?.shipping,1.49);
  assert.equal(imported.pricingHandoff?.matchesOriginals,true);assert.equal(imported.pricingHandoff?.needsReview,true);
  const s=newQueue();upsertCard(s,imported,now);assert.equal(s.cards["card-1"].jobs.pricing.state,"todo");
  assert.equal(queueSummary(s,now).cards[0].pricingHandoff?.status,"review-estimate");
  for(const changed of [{back_sha256:"f".repeat(64)},{card_id:"other"},{serial_number:"26"},{parallel:"Different parallel"}]) {
    const mismatch=importLegacyCard(row,{...pricing,...changed},[]).pricingHandoff!;
    assert.equal(mismatch.item,null);assert.equal(mismatch.matchesOriginals,false);
  }
  assert.equal(importLegacyCard(row,{...pricing,proposed_item_price:""},[]).pricingHandoff?.item,null);
});
test("prepared receipt lookup preserves dependency keys, manifest order and exact-pair exclusions",()=>{
  const card=input(),raw={card_id:card.id,source_key:card.sku,front_sha256:card.photos[0].sha256,back_sha256:card.photos[1].sha256};
  const entries:SavedReceiptRow[]=[
    {source:"first",data:{cardId:card.id,key:card.sku,draftId:"123",frontHash:raw.front_sha256.toUpperCase(),backHash:raw.back_sha256}},
    {source:"archived",data:{draftId:"456",photoArchive:{files:card.photos.map(p=>({sha256:p.sha256}))}}},
    {source:"live",data:{card_id:card.id,source_key:card.sku,liveItemId:"789",files:[...card.photos].reverse().map(p=>({sha256:p.sha256}))}},
    {source:"unrelated",data:{cardId:"different",key:"different",draftId:"invalid unrelated ID",frontHash:"c".repeat(64),backHash:"d".repeat(64)}},
    {source:"no-receipt",data:{cardId:card.id,key:card.sku,frontHash:raw.front_sha256,backHash:raw.back_sha256}},
  ];
  const prepared=prepareSavedReceipts(entries);
  for(const current of [raw,{...raw,card_id:"alias",source_key:"alias"},{...raw,front_sha256:raw.back_sha256,back_sha256:raw.front_sha256},{...raw,front_sha256:""},{...raw,card_id:"",source_key:"",front_sha256:"",back_sha256:""}]) {
    assert.deepEqual(savedReceiptDependencies(current,prepared),savedReceiptDependencies(current,entries));
    assert.equal(fingerprint(savedReceiptDependencies(current,prepared)),fingerprint(savedReceiptDependencies(current,entries)));
  }
  assert.deepEqual(applySavedReceipts(card,prepared),applySavedReceipts(card,entries));
  assert.equal(applySavedReceipts(card,prepared).knownDraft,"123");
  assert.equal(applySavedReceipts(card,prepared).knownLive?.itemId,"789");
});
test("prepared receipts retain conflicting aliases, incomplete pairs and invalid IDs as blockers",()=>{
  const card=input(),raw={card_id:card.id,source_key:card.sku,front_sha256:card.photos[0].sha256,back_sha256:card.photos[1].sha256};
  for(const bad of [
    {cardId:card.id,draftId:"123"},
    {source_key:card.sku,draftId:"123",frontHash:raw.front_sha256,backHash:"f".repeat(64)},
    {draftId:"invalid",frontHash:raw.front_sha256,backHash:raw.back_sha256},
  ]) {
    const rows=[{source:"good",data:{draftId:"111",frontHash:raw.front_sha256,backHash:raw.back_sha256}},{source:"bad",data:bad}];
    const prepared=prepareSavedReceipts(rows);
    assert.deepEqual(savedReceiptDependencies(raw,prepared),savedReceiptDependencies(raw,rows));
    let expected="";try{applySavedReceipts(card,rows);}catch(error){expected=(error as Error).message;}
    assert.ok(expected);assert.throws(()=>applySavedReceipts(card,prepared),error=>(error as Error).message===expected);
  }
});
test("receipt indexes are scoped to a source snapshot and pick up later receipts when rebuilt",()=>{
  const card=input(),rows:SavedReceiptRow[]=[];const previous=prepareSavedReceipts(rows);
  rows.push({source:"later",data:{draftId:"123",frontHash:card.photos[0].sha256,backHash:card.photos[1].sha256}});
  assert.equal(applySavedReceipts(card,previous).knownDraft,undefined);
  assert.equal(applySavedReceipts(card,prepareSavedReceipts(rows)).knownDraft,"123");
  (rows[0].data as Record<string,unknown>).backHash="f".repeat(64);
  (rows[0].data as Record<string,unknown>).cardId=card.id;
  assert.throws(()=>applySavedReceipts(card,prepareSavedReceipts(rows)),/original photo pair/);
});
test("saved batch receipts exclude exact original pairs and fail closed on conflicting identifiers",()=>{
  const source="artifacts/batch-11/manifest.json",files=input().photos.map(p=>({sha256:p.sha256.toUpperCase()}));
  const draft=applySavedReceipts(input(),[{source,data:{key:"card-1",draftId:"123",files}}]);
  assert.equal(draft.knownDraft,"123");assert.equal(draft.savedReceipts?.[0].source,source);
  const s=newQueue();upsertCard(s,draft,now);assert.equal(claimJob(s,"worker","listing",undefined,now),null);
  assert.throws(()=>applySavedReceipts(input(),[{source,data:{key:"card-1",draftId:"123",files:[{sha256:"e".repeat(64)}]}}]),/reconcile/);
  assert.equal(applySavedReceipts(input(),[{source,data:{key:"unrelated",draftId:"123",files:[]}}]).knownDraft,undefined);
  const grouped=applySavedReceipts(input(),[{source:"artifacts/one-piece-processing.json",data:{liveItemId:"789",photoArchive:{files}}}]);assert.equal(grouped.knownLive?.itemId,"789");assert.equal(grouped.knownLive?.observedAt,"");
  const pilot=applySavedReceipts(input(),[{source,data:{cardId:"card-1",draftId:"456",frontHash:files[0].sha256,backHash:files[1].sha256}}]);assert.equal(pilot.knownDraft,"456");
  upsertCard(s,applySavedReceipts(input(),[]),now);assert.equal(s.cards["card-1"].input.knownDraft,"123");
});
test("receipt dependency keys ignore unrelated changes but detect new receipts and conflicting hashes",()=>{
  const i={card_id:"card-1",source_key:"card-1",front_sha256:"a".repeat(64),back_sha256:"b".repeat(64)},source="manifest";
  const unrelated={source,data:{key:"other",draftId:"789",frontHash:"c".repeat(64),backHash:"d".repeat(64)}};
  assert.deepEqual(savedReceiptDependencies(i,[unrelated]),[]);
  assert.deepEqual(savedReceiptDependencies({},[unrelated]),[]);
  const matching={source,data:{key:"card-1",draftId:"123",frontHash:i.front_sha256,backHash:i.back_sha256}};
  const key=(entries:Parameters<typeof savedReceiptDependencies>[1])=>fingerprint(savedReceiptDependencies(i,entries));
  assert.equal(key([matching]),key([unrelated,{...matching,data:{...matching.data,audit:"Changed description",price:99}}]));
  assert.notEqual(key([matching]),key([{...matching,data:{...matching.data,draftId:"456"}}]));
  assert.notEqual(key([matching]),key([{...matching,data:{...matching.data,backHash:"e".repeat(64)}}]));
  assert.notEqual(key([]),key([{source,data:{key:"renamed",draftId:"123",frontHash:i.front_sha256,backHash:i.back_sha256}}]));
});
test("CLI selectively admits cached partial identities once, keeping unrelated rejects and existing work",async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"partial-intake-cli-"));
  try {
    for(const folder of ["identity-queue","pricing-queue"])await fs.mkdir(path.join(dir,"artifacts",folder),{recursive:true});
    const source={card_id:"partial",source_key:"partial",quantity:1,player:"Known player",condition_plan:identity.condition,status:"identity-ready",
      front_original_path:"front.jpg",back_original_path:"back.jpg",front_sha256:"e".repeat(64),back_sha256:"f".repeat(64)};
    const other={...source,card_id:"conflict",source_key:"conflict"};
    const sourceFile=path.join(dir,"artifacts/identity-queue/cards.json"),contents=JSON.stringify({cards:[source,other]});
    await fs.writeFile(sourceFile,contents);
    await fs.writeFile(path.join(dir,"artifacts/pricing-queue/queue-state.json"),JSON.stringify({cards:[],comps:[]}));
    const queueDir=path.join(dir,"artifacts/card-orchestrator");
    await withQueue(queueDir,s=>{
      Object.assign(s,identified());
      // Legacy and current cache formats both retain unrelated rejection semantics.
      s.rejectedImports={partial:{inputKey:fingerprint([source,null,fingerprint([])]),reason:"Identity source is missing required fields; retain in identity inbox"},
        conflict:{inputKey:fingerprint(["per-card-receipts-v1",other,null,[]]),reason:"Saved receipt pair conflict"}};
    });
    // Keep the existing card's source present and unchanged through sync.
    const existing={...source,card_id:"card-1",source_key:"card-1",player:identity.player,season:identity.season,set:identity.set,manufacturer:identity.manufacturer,
      card_number:identity.cardNumber,sport_game:identity.sport,team:identity.team,parallel:identity.parallel,serial_text:identity.serial,print_run:99,autograph:"No",
      front_sha256:"a".repeat(64),back_sha256:"b".repeat(64)};
    await fs.writeFile(sourceFile,JSON.stringify({cards:[source,other,existing]}));
    await withQueue(queueDir,s=>{
      upsertCard(s,importLegacyCard(existing,{},[]),now);
      if(s.cards["card-1"].jobs.identity.state!=="done")finish(s,"identity",{identity,pairMatches:true,frontFirst:true,serialInspected:true,evidence:"Retained complete review"});
    });
    const prior=(await readQueue(queueDir)).cards["card-1"].jobs.identity;
    const bytes=await fs.readFile(sourceFile,"utf8"),script=fileURLToPath(new URL("../scripts/card-orchestrator.ts",import.meta.url));
    const cli=(...args:string[])=>JSON.parse(execFileSync(process.execPath,["--experimental-strip-types",script,...args],{cwd:dir,encoding:"utf8",stdio:["ignore","pipe","pipe"]}));
    cli("sync");assert.equal((await readQueue(queueDir)).cards.partial,undefined);
    const admitted=cli("sync","--new","--limit","1");assert.equal(admitted.changed,1);assert.equal(admitted.skipped.length,0);
    let saved=await readQueue(queueDir);assert.ok(saved.cards.partial);assert.equal(saved.rejectedImports?.partial,undefined);
    assert.equal(saved.rejectedImports?.conflict.reason,"Saved receipt pair conflict");assert.deepEqual(saved.cards["card-1"].jobs.identity,prior);
    const revision=saved.revision;assert.equal(cli("sync","--new","--limit","1").changed,0);
    saved=await readQueue(queueDir);assert.equal(saved.revision,revision);assert.equal(await fs.readFile(sourceFile,"utf8"),bytes);
    assert.ok(cli("claim","--kind","photos","--card","partial"));
    assert.equal(cli("claim","--kind","pricing","--card","partial"),null);
    const snapshot=await loadCardBacklog({root:dir,scans:[]});
    assert.notEqual(snapshot.cards.find(c=>c.aliases.includes("partial"))?.identityStatus,"identified");
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});

test("receipt discovery uses a shared allowlist and validates supported document layouts",()=>{
  const files=receiptManifestPaths(["batch-12","bulk-photo-ten-20261018","bulk-photo-pilot-20261018","bulk-draft-pilot","private","batch-12","batch-not-a-number"]);
  assert.equal(files.length,7);assert.equal(new Set(files).size,files.length);
  assert.ok(files.includes("artifacts/bulk-photo-ten-20261018/manifest.json"));assert.ok(files.includes("artifacts/batch-test/batch-audit.json"));
  assert.ok(files.every(file=>!file.includes("private")&&!file.includes("not-a-number")));
  const receipt={key:"sku",draftId:"123",frontHash:"a".repeat(64),backHash:"b".repeat(64)},source=files[0];
  for(const document of [[receipt],{cards:[receipt]},{groups:[receipt]},{records:[receipt]},{cards:[],groupedCaptures:[receipt]}]) {
    assert.deepEqual(receiptManifestRows(document,source),[{source,data:receipt}]);
  }
  const single="artifacts/goodman-test/ebay-saved-draft.json";
  assert.deepEqual(receiptManifestRows(receipt,single),[{source:single,data:receipt}]);
  for(const invalid of [{cards:{}},{unknown:[receipt]},{cards:[null]},{cards:[],groupedCaptures:{}}])assert.throws(()=>receiptManifestRows(invalid,source),/schema changed/);
});

test("CLI and dashboard discover the same native ten-card receipt and retain it across retries",async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"card-receipt-discovery-"));
  try {
    const write=async(file:string,data:unknown)=>{const target=path.join(dir,file);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,JSON.stringify(data));};
    const source={card_id:"saved-card",source_key:"saved-sku",quantity:1,player:identity.player,season:identity.season,set:identity.set,manufacturer:identity.manufacturer,
      card_number:identity.cardNumber,sport_game:identity.sport,parallel:identity.parallel,serial_text:identity.serial,print_run:identity.printRun,condition_plan:identity.condition,
      front_original_path:"front.jpg",back_original_path:"back.jpg",front_sha256:"a".repeat(64),back_sha256:"b".repeat(64),status:"identity-ready"};
    const sourceFile="artifacts/identity-queue/cards.json",receiptFile="artifacts/bulk-photo-ten-20261018/manifest.json";
    await write(sourceFile,{cards:[source]});await write("artifacts/pricing-queue/queue-state.json",{cards:[],comps:[]});
    await write(receiptFile,{cards:[{cardId:source.card_id,key:source.source_key,draftId:"123",frontHash:source.front_sha256,backHash:source.back_sha256}]});
    const before=await fs.readFile(path.join(dir,receiptFile),"utf8");
    const dashboard=await loadCardBacklog({root:dir,now,scans:[]});assert.equal(dashboard.cards[0].receipts[0].id,"123");
    const script=fileURLToPath(new URL("../scripts/card-orchestrator.ts",import.meta.url));
    const cli=(...args:string[])=>JSON.parse(execFileSync(process.execPath,["--experimental-strip-types",script,...args],{cwd:dir,encoding:"utf8",stdio:["ignore","pipe","pipe"]}));
    cli("sync","--new","--limit","1");
    const queueDir=path.join(dir,"artifacts/card-orchestrator");let queue=await readQueue(queueDir);
    assert.equal(queue.cards[source.card_id].input.knownDraft,"123");
    assert.ok(queue.cards[source.card_id].input.savedReceipts?.some(r=>r.itemId==="123"&&r.source===receiptFile));
    const revision=queue.revision;assert.equal(cli("sync").changed,0);assert.equal((await readQueue(queueDir)).revision,revision);
    let card=flowPacket(queue,[source.card_id],now).cards[0];assert.equal(card.route,"resume-existing-draft");assert.equal(card.canUpload,false);
    // A disappearing manifest must not erase the saved positive draft receipt.
    await fs.rename(path.join(dir,receiptFile),path.join(dir,receiptFile+".retained"));cli("sync");
    queue=await readQueue(queueDir);card=flowPacket(queue,[source.card_id],now).cards[0];assert.equal(card.receipt?.itemId,"123");
    assert.equal(card.route,"resume-existing-draft");assert.equal(await fs.readFile(path.join(dir,receiptFile+".retained"),"utf8"),before);
    // Discovery must retain the existing exact-pair guard, including for a changed manifest.
    await write(receiptFile,{cards:[{cardId:source.card_id,key:source.source_key,draftId:"456",frontHash:source.front_sha256,backHash:"c".repeat(64)}]});
    const conflict=cli("sync");assert.equal(conflict.skipped.length,1);assert.match(conflict.skipped[0].reason,/photo pair is missing or different/);
    queue=await readQueue(queueDir);assert.equal(queue.cards[source.card_id].input.knownDraft,"123");
    assert.ok(Object.values(queue.cards[source.card_id].jobs).every(job=>job.state==="held"));
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});

test("CLI resumes across processes and skips unchanged bad imports without blocking new cards",async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"card-orchestrator-cli-"));
  await fs.mkdir(path.join(dir,"artifacts/card-orchestrator"),{recursive:true});
  await fs.writeFile(path.join(dir,"artifacts/card-orchestrator/draft-handoff-holds.json"),"[]");
  try {
    await fs.mkdir(path.join(dir,"artifacts/identity-queue"),{recursive:true});await fs.mkdir(path.join(dir,"artifacts/pricing-queue"),{recursive:true});
    const front=path.join(dir,"front.jpg"),back=path.join(dir,"back.jpg");await fs.writeFile(front,"fixture front bytes");await fs.writeFile(back,"fixture back bytes");
    const good={card_id:"good",source_key:"sku-good",quantity:1,player:identity.player,season:identity.season,set:identity.set,manufacturer:identity.manufacturer,card_number:identity.cardNumber,sport_game:identity.sport,parallel:identity.parallel,condition_plan:identity.condition,print_run:99,serial_text:"25/99",front_original_path:front,back_original_path:back,front_sha256:createHash("sha256").update("fixture front bytes").digest("hex"),back_sha256:createHash("sha256").update("fixture back bytes").digest("hex")};
    await fs.writeFile(path.join(dir,"artifacts/identity-queue/cards.json"),JSON.stringify({generation:"test",cards:[{...good,card_id:"bad",quantity:2},good]}));
    await fs.writeFile(path.join(dir,"artifacts/pricing-queue/queue-state.json"),JSON.stringify({cards:[],comps:[]}));
    const script=fileURLToPath(new URL("../scripts/card-orchestrator.ts",import.meta.url));
    const run=()=>JSON.parse(execFileSync(process.execPath,["--experimental-strip-types",script,"run","--new","--limit","1"],{cwd:dir,encoding:"utf8",stdio:["ignore","pipe","pipe"]}));
    assert.equal(run().sync.skipped.length,1);
    await withQueue(path.join(dir,"artifacts/card-orchestrator"),s=>{
      s.rejectedImports!.bad.inputKey=fingerprint([{...good,card_id:"bad",quantity:2},null,fingerprint([])]);
    });
    const second=run();assert.equal(second.sync.changed,1);assert.equal(second.photos.completed,1);
    const state=await readQueue(path.join(dir,"artifacts/card-orchestrator"));assert.equal(state.cards.good.jobs.photos.state,"done");
    const third=run();assert.equal(third.sync.changed,0);assert.equal(third.photos.completed,0);
    assert.equal(third.sync.skipped.length,0);assert.equal(third.status.counts.importExceptions,1);
    const heldStatus=JSON.parse(await fs.readFile(path.join(dir,"artifacts/card-orchestrator/status.json"),"utf8"));
    assert.equal(heldStatus.importExceptions[0].id,"bad");assert.equal(heldStatus.importExceptions[0].sku,"sku-good");
    assert.match(await fs.readFile(path.join(dir,"artifacts/card-orchestrator/status.html"),"utf8"),/quantity-one cards/);
    assert.equal((await readQueue(path.join(dir,"artifacts/card-orchestrator"))).revision,state.revision);
    const review=JSON.parse(await fs.readFile(path.join(dir,"artifacts/card-orchestrator/review-listings.json"),"utf8"));assert.equal(review.canUpload,false);
    await fs.mkdir(path.join(dir,"artifacts/batch-11"));
    await fs.writeFile(path.join(dir,"artifacts/batch-11/manifest.json"),JSON.stringify({cards:[{key:"unrelated",draftId:"789",frontHash:"e".repeat(64),backHash:"f".repeat(64)}]}));
    const unrelatedUpdate=run();assert.equal(unrelatedUpdate.sync.skipped.length,0);assert.equal(unrelatedUpdate.status.counts.importExceptions,1);
    assert.equal((await readQueue(path.join(dir,"artifacts/card-orchestrator"))).revision,state.revision);
    await fs.writeFile(path.join(dir,"artifacts/batch-11/manifest.json"),JSON.stringify({cards:[{key:"sku-good",draftId:"123",files:[{sha256:good.front_sha256},{sha256:good.back_sha256}]}]}));
    const afterReceipt=run();assert.equal(afterReceipt.status.counts.alreadyListed,1);assert.equal(afterReceipt.status.counts.actionableJobs,1);
    const status=JSON.parse(await fs.readFile(path.join(dir,"artifacts/card-orchestrator/status.json"),"utf8"));assert.equal(status.cards[0].existingReceipt.disposition,"draft");
    await fs.mkdir(path.join(dir,"artifacts/bulk-photo-pilot-20261018"));
    await fs.writeFile(path.join(dir,"artifacts/bulk-photo-pilot-20261018/manifest.json"),JSON.stringify({cards:[{cardId:"good",key:"sku-good",draftId:"123",frontHash:good.front_sha256,backHash:good.back_sha256}]}));
    const nativeReceipt=run();assert.equal(nativeReceipt.status.counts.alreadyListed,1);assert.equal(nativeReceipt.status.counts.actionableJobs,1);
    const nativeState=await readQueue(path.join(dir,"artifacts/card-orchestrator"));
    assert.ok(nativeState.cards.good.input.savedReceipts?.some(r=>r.source==="artifacts/bulk-photo-pilot-20261018/manifest.json"&&r.itemId==="123"));
    assert.equal(run().sync.changed,0);
    await fs.writeFile(path.join(dir,"artifacts/pricing-queue/queue-state.json"),JSON.stringify({cards:[{...good,status:"review-estimate",proposed_item_price:6.49,buyer_shipping:1.49,updated_at:now,review_reason:"Source serial unresolved"}],comps:[]}));
    run();
    const handoffReport=JSON.parse(await fs.readFile(path.join(dir,"artifacts/card-orchestrator/status.json"),"utf8"));
    assert.equal(handoffReport.cards[0].existingReceipt.itemId,"123");assert.equal(handoffReport.cards[0].pricingHandoff.item,6.49);
    const handoffHtml=await fs.readFile(path.join(dir,"artifacts/card-orchestrator/status.html"),"utf8");
    assert.match(handoffHtml,/Price proposal:<\/b> item \$6\.49/);assert.match(handoffHtml,/eBay price not verified/);assert.match(handoffHtml,/Source serial unresolved/);
    assert.equal(handoffReport.cards[0].pricing.approved,false);
    const preflight=JSON.parse(execFileSync(process.execPath,["--experimental-strip-types",script,"preflight","--card","good"],{cwd:dir,encoding:"utf8",stdio:["ignore","pipe","pipe"]}));
    assert.equal(preflight.cards[0].route,"resume-existing-draft");assert.equal(preflight.cards[0].pricing.agentProposal.item,6.49);assert.equal(preflight.canUpload,false);
    assert.match(await fs.readFile(path.join(dir,"artifacts/card-orchestrator/handoff.html"),"utf8"),/Pricing evidence required/);
    assert.equal((await readQueue(path.join(dir,"artifacts/card-orchestrator"))).cards.good.jobs.pricing.state,"todo");
    await withQueue(path.join(dir,"artifacts/card-orchestrator"),s=>finish(s,"identity",{identity,pairMatches:true,frontFirst:true,serialInspected:true,evidence:"Reviewed fixture original pair"},"good"));
    const snapshot=await loadCardBacklog({root:dir,scans:[]}),workflow=await withWorkflow(snapshot,dir),card=snapshot.cards.find(c=>c.aliases.includes("good"))!;
    await saveReview({requestId:"b2ea150e-cfed-4ef2-bf1d-1cb703d30013",cardId:card.id,token:workflow.workflow[card.id].token,action:"set-price",note:"Fixture manual price",price:{item:7.77,shipping:0}},async()=>snapshot,dir);
    const manualPacket=JSON.parse(execFileSync(process.execPath,["--experimental-strip-types",script,"preflight","--card","good"],{cwd:dir,env:{...process.env,CARD_WORKFLOW_REVIEW_ROOT:dir},encoding:"utf8",stdio:["ignore","pipe","pipe"]}));
    assert.equal(manualPacket.cards[0].pricing.manualOverride.item,7.77);
    assert.equal(manualPacket.cards[0].pricing.approvedProposal.item,7.77);
    assert.equal(manualPacket.cards[0].nextOwner,"listing-review");
    await fs.writeFile(path.join(dir,"artifacts/identity-queue/cards.json"),JSON.stringify({generation:"corrected",cards:[{...good,card_id:"bad",source_key:"sku-repaired"},good]}));
    assert.equal(run().status.counts.importExceptions,0);
    assert.doesNotMatch(await fs.readFile(path.join(dir,"artifacts/card-orchestrator/status.html"),"utf8"),/quantity-one cards/);
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});

test("flow separates text completion, source estimates, evidence validation and publication",()=>{
  const s=identified();finish(s,"listing",{prepare:true});
  let packet=flowPacket(s,["card-1"],now);assert.equal(packet.cards[0].textPrepared,true);assert.equal(packet.cards[0].nextOwner,"pricing");
  upsertCard(s,{...input(),knownDraft:"456",pricingHandoff:{status:"review-estimate",item:6.49,shipping:1.49,updatedAt:now,policyVersion:"wrong-rule",reason:"Missing original serial",source:"test",matchesOriginals:true,needsReview:true}},now);
  packet=flowPacket(s,["card-1"],now);assert.equal(packet.cards[0].nextOwner,"pricing-review");assert.equal(packet.cards[0].route,"resume-existing-draft");
  assert.equal(packet.cards[0].pricing.approved,false);assert.equal(packet.cards[0].pricing.validatedProposal,null);assert.equal(packet.cards[0].pricing.agentProposal?.item,6.49);
  assert.ok(packet.cards[0].blockers.includes("Source proposal policy needs reconciliation"));assert.match(flowHtml(packet),/Missing original serial/);
  assert.equal(flowPacket(s,["card-1"],"2027-02-01T00:00:00Z").cards[0].pricing.sourceFresh,false);
  assert.throws(()=>flowPacket(s,["missing"],now));assert.throws(()=>flowPacket(s,["card-1","card-1"],now));
});

test("CLI carries durable workflow approvals and holds, rejects stale approvals, and preserves manual prices",async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"card-workflow-handoff-"));
  await fs.mkdir(path.join(dir,"artifacts/card-orchestrator"),{recursive:true});
  await fs.writeFile(path.join(dir,"artifacts/card-orchestrator/draft-handoff-holds.json"),"[]");
  try {
    const stamp=new Date(Date.now()-1000).toISOString();
    const source={card_id:"card-1",source_key:"card-1",quantity:1,player:identity.player,season:identity.season,set:identity.set,
      manufacturer:identity.manufacturer,card_number:identity.cardNumber,sport_game:identity.sport,team:identity.team,parallel:identity.parallel,
      condition_plan:identity.condition,autograph:"No",print_run:99,serial_text:"25/99",status:"identity-ready",
      front_original_path:path.join(dir,"front.jpg"),back_original_path:path.join(dir,"back.jpg"),front_sha256:"a".repeat(64),back_sha256:"b".repeat(64)};
    let price={...source,status:"review-estimate",proposed_item_price:6.49,buyer_shipping:1.49,updated_at:stamp,pricing_policy_version:CARD_POLICY_VERSION};
    for(const folder of ["identity-queue","pricing-queue"])await fs.mkdir(path.join(dir,"artifacts",folder),{recursive:true});
    const identityFile=path.join(dir,"artifacts/identity-queue/cards.json"),priceFile=path.join(dir,"artifacts/pricing-queue/queue-state.json");
    await fs.writeFile(identityFile,JSON.stringify({cards:[source]}));
    const writePrice=()=>fs.writeFile(priceFile,JSON.stringify({cards:[price],comps:[]}));await writePrice();
    await withQueue(path.join(dir,"artifacts/card-orchestrator"),s=>{
      const imported=importLegacyCard(source,price,[]);upsertCard(s,imported,stamp);
      for(const [kind,data] of [["photos",{hashes:imported.photos.map(({side,sha256})=>({side,sha256})),evidence:"Fixture bytes"}],
        ["identity",{identity:imported.identity,pairMatches:true,frontFirst:true,serialInspected:true,evidence:"Fixture reviewed pair"}],
        ["pricing",{comps:[comp({itemPrice:6,shipping:1.49,soldDate:stamp.slice(0,10)})],tracked:false,envelopeEligible:true,evidence:"Current independent fixture evidence"}]] as const) {
        const claim=claimJob(s,"fixture",kind,"card-1",stamp)!;completeJob(s,"card-1",kind,claim.job.lease!.token,{outcome:"done",data},stamp);
      }
    });
    const script=fileURLToPath(new URL("../scripts/card-orchestrator.ts",import.meta.url));
    const cli=(...args:string[])=>JSON.parse(execFileSync(process.execPath,["--experimental-strip-types",script,...args],
      {cwd:dir,env:{...process.env,CARD_WORKFLOW_REVIEW_ROOT:dir},encoding:"utf8",stdio:["ignore","pipe","pipe"]}));
    const load=()=>loadCardBacklog({root:dir,scans:[]});
    const decide=async(action:"approve-price"|"hold"|"resume"|"set-price",note="")=>{
      const snapshot=await load(),view=await withWorkflow(snapshot,dir),card=snapshot.cards.find(c=>c.aliases.includes("card-1"))!;
      await saveReview({requestId:randomUUID(),cardId:card.id,token:view.workflow[card.id].token,action,note,
        ...(action==="set-price"?{price:{item:7.77,shipping:0}}:{})},load,dir);
    };
    await decide("approve-price");
    let packet=cli("preflight","--card","card-1");
    assert.equal(packet.cards[0].pricing.approvedProposal.item,6.49);
    assert.equal(packet.cards[0].pricing.manualOverride,null);assert.equal(packet.cards[0].nextOwner,"listing-review");
    assert.equal(cli("pricing-context","--card","card-1").approvedAskingPrice.item,6.49);
    cli("prepare");cli("export-review");
    const readReport=async()=>JSON.parse(await fs.readFile(path.join(dir,"artifacts/card-orchestrator/review-listings.json"),"utf8"));
    let exported=await readReport();assert.equal(exported.listings[0].pricing.item,6.49);assert.equal(exported.listings[0].priceNeedsReview,false);
    assert.equal(exported.listings[0].pricingEvidenceValidated,true);
    await decide("hold","Check packaging before continuing");
    packet=cli("preflight","--card","card-1");
    assert.equal(packet.cards[0].sellerHold,"Check packaging before continuing");
    assert.equal(packet.cards[0].pricing.approved,true);assert.equal(packet.cards[0].nextOwner,"seller-review");
    assert.equal(cli("pricing-context","--card","card-1").sellerHold,"Check packaging before continuing");
    assert.equal(cli("claim","--kind","pricing","--card","card-1"),null);
    assert.throws(()=>cli("retry","--kind","pricing","--card","card-1","--evidence","Try again"),/Seller hold/);
    assert.throws(()=>cli("correct-prices","--card","card-1","--authority","Fixture authority","--apply"),/Seller hold/);
    assert.equal(cli("prepare").completed,0);
    cli("status");
    const status=JSON.parse(await fs.readFile(path.join(dir,"artifacts/card-orchestrator/status.json"),"utf8"));
    assert.ok(status.cards[0].jobs.every((job:{blockers:string[]})=>job.blockers.some(reason=>reason.startsWith("Seller hold:"))));
    assert.deepEqual(status.cards[0].pricing,packet.cards[0].pricing);
    price={...price,proposed_item_price:6.95};await writePrice();
    await withQueue(path.join(dir,"artifacts/card-orchestrator"),s=>{
      (s.cards["card-1"].jobs.pricing.result!.comps as {itemPrice:number}[])[0].itemPrice=6.8;
    });
    packet=cli("preflight","--card","card-1");
    assert.equal(packet.cards[0].sellerHold,"Check packaging before continuing");assert.equal(packet.cards[0].pricing.approved,false);
    assert.equal(cli("claim","--kind","pricing","--card","card-1"),null);
    await decide("resume");
    assert.equal(cli("preflight","--card","card-1").cards[0].pricing.approved,false);
    price={...price,proposed_item_price:6.95};await writePrice();
    packet=cli("preflight","--card","card-1");assert.equal(packet.cards[0].pricing.approved,false);
    assert.equal(packet.cards[0].sellerHold,null);
    await decide("set-price");
    price={...price,proposed_item_price:9.95};await writePrice();
    packet=cli("preflight","--card","card-1");assert.equal(packet.cards[0].pricing.manualOverride.item,7.77);
    cli("prepare");cli("export-review");exported=await readReport();
    assert.equal(exported.listings[0].pricing.item,7.77);assert.equal(exported.listings[0].pricing.shipping,0);assert.equal(exported.listings[0].priceNeedsReview,false);
    const manualStatus=JSON.parse(await fs.readFile(path.join(dir,"artifacts/card-orchestrator/status.json"),"utf8"));
    assert.deepEqual(manualStatus.cards[0].pricing,packet.cards[0].pricing);
    await withQueue(path.join(dir,"artifacts/card-orchestrator"),s=>{s.cards["card-1"].jobs.pricing.state="todo";});
    const claim=cli("claim","--kind","pricing","--card","card-1");assert.ok(claim);
    await decide("hold","New hold after the claim");
    const resultFile=path.join(dir,"worker-result.json");await fs.writeFile(resultFile,JSON.stringify({outcome:"held",reason:"No new evidence"}));
    assert.throws(()=>cli("complete","--card","card-1","--kind","pricing","--token",claim.job.lease.token,"--result",resultFile),/seller hold/);
    assert.equal((await readQueue(path.join(dir,"artifacts/card-orchestrator"))).cards["card-1"].jobs.pricing.state,"leased");
    await fs.rename(priceFile,`${priceFile}.missing`);
    assert.throws(()=>cli("claim","--kind","reconcile","--card","card-1"),/Workflow source is missing/);
    await fs.rename(`${priceFile}.missing`,priceFile);
    assert.equal(packet.canUpload,false);assert.equal(packet.canPublish,false);
    assert.equal(await fs.readFile(identityFile,"utf8"),JSON.stringify({cards:[source]}));
    assert.equal(await fs.readFile(priceFile,"utf8"),JSON.stringify({cards:[price],comps:[]}));
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});

test("asking-price approval is exact and never grants publication or validates comp evidence",()=>{
  const s=identified();
  const handoff={status:"review-estimate",item:6.49,shipping:1.49,updatedAt:now,policyVersion:CARD_POLICY_VERSION,reason:"Evidence review remains",source:"test",matchesOriginals:true,needsReview:true as const};
  upsertCard(s,{...input(),pricingHandoff:handoff},now);
  const a={cardId:"card-1",item:6.49,shipping:1.49,sourceUpdatedAt:now,policyVersion:handoff.policyVersion,photoHashes:input().photos.map(p=>p.sha256),sourceIdentityKey:fingerprint(input().identity),approvedAt:now};
  const packet=flowPacket(s,["card-1"],now,[a]);
  assert.equal(packet.cards[0].pricing.approved,true);
  assert.equal(packet.cards[0].nextOwner,"listing-review");
  assert.equal(packet.cards[0].pricing.validatedProposal,null);
  assert.equal(packet.cards[0].canPublish,false);
  assert.match(flowHtml(packet),/Seller-set \/ previously approved/);
  for(const changed of [{...a,item:6.95},{...a,shipping:0},{...a,sourceUpdatedAt:"2026-10-17T00:00:00Z"},{...a,photoHashes:[]},{...a,sourceIdentityKey:"changed"}])assert.equal(flowPacket(s,["card-1"],now,[changed]).cards[0].pricing.approved,false);
  const legacyPolicy="item-only-9pct-49-95-under3-exact149-free";
  s.cards["card-1"].input.pricingHandoff!.policyVersion=legacyPolicy;
  assert.equal(flowPacket(s,["card-1"],now,[{...a,policyVersion:legacyPolicy}]).cards[0].pricing.approved,false,"superseded-policy approvals cannot authorize a new draft");
  s.cards["card-1"].input.pricingHandoff!.policyVersion=CARD_POLICY_VERSION;
  s.cards["card-1"].input.override={item:5,shipping:0,evidence:"Individual seller override"};
  assert.equal(flowPacket(s,["card-1"],now,[a]).cards[0].pricing.approved,false);
});

test("matching copies share research context but cannot research concurrently or reuse own-copy sales",()=>{
  const s=identified();upsertCard(s,input("card-2","26/99"),now);
  finish(s,"photos",{hashes:s.cards["card-2"].input.photos.map(({side,sha256})=>({side,sha256})),evidence:"Originals"},"card-2");
  finish(s,"identity",{identity:{...identity,serial:"26/99"},pairMatches:true,frontFirst:true,serialInspected:true,evidence:"Original pair"},"card-2");
  const first=claimJob(s,"pricing-A","pricing","card-1",now)!;assert.ok(first);
  assert.equal(claimJob(s,"pricing-B","pricing","card-2",now),null);
  completeJob(s,"card-1","pricing",first.job.lease!.token,{outcome:"done",data:{comps:[comp({shipping:1})],tracked:false,envelopeEligible:true,evidence:"Shared source"}},now);
  assert.equal(pricingContext(s,"card-2",now).reusableEvidence.length,1);
  const result=s.cards["card-1"].jobs.pricing.result!;
  result.comps=[comp({shipping:1,identity:{...identity,serial:"26/99"}})];
  assert.equal(pricingContext(s,"card-2",now).reusableEvidence.length,0);
  assert.ok(claimJob(s,"pricing-B","pricing","card-2",now));
});

test("new sold evidence preserves failed attempts and requires a fresh fenced claim", async()=>{
  const {admitPricingEvidence}=await import('../lib/card-orchestrator.ts');
  const s=identified();const first=claimJob(s,'old','pricing','card-1',now)!;
  completeJob(s,'card-1','pricing',first.job.lease!.token,{outcome:'held',reason:'No independent sale'},now);
  retryHeld(s,'card-1','pricing','Focused source recovery',now);
  const second=claimJob(s,'old','pricing','card-1',now)!;
  completeJob(s,'card-1','pricing',second.job.lease!.token,{outcome:'held',reason:'Source unavailable'},now);
  const evidence={comps:[comp()],basis:'exact',evidence:'New independent sold source inspected'};
  assert.throws(()=>admitPricingEvidence(s,'card-1',{...evidence,comps:[comp({identity})]},now),/Own exact/);
  assert.equal(s.cards['card-1'].jobs.pricing.attempts,2);
  const receipt=admitPricingEvidence(s,'card-1',evidence,now);
  assert.equal(receipt.previousAttempts,2);assert.equal(receipt.state,'todo');
  assert.equal(s.cards['card-1'].jobs.photos.state,'done');assert.equal(s.cards['card-1'].jobs.identity.state,'done');
  assert.throws(()=>completeJob(s,'card-1','pricing',second.job.lease!.token,{outcome:'done',data:{}},now),/Lease/);
  upsertCard(s,input(),now);assert.equal(s.cards['card-1'].jobs.pricing.state,'todo');
  const fresh=claimJob(s,'fresh','pricing','card-1',now)!;
  completeJob(s,'card-1','pricing',fresh.job.lease!.token,{outcome:'held',reason:'Need further evidence'},now);
  assert.throws(()=>admitPricingEvidence(s,'card-1',{...evidence,evidence:'Different prose',comps:[comp({evidence:'Changed prose'})]},now),/already admitted/);
});

test("targeted photo write recovery preserves history and refuses genuine or changed holds",async()=>{
  const {recoverPhotoWriteFailure}=await import("../lib/card-orchestrator.ts");
  const s=seeded(),c=s.cards["card-1"],j=c.jobs.photos;
  j.state="held";j.attempts=1;j.reason="EPERM: operation not permitted, rename 'C:/queue/state.abc-123.tmp' -> 'C:/queue/state.json'";
  const observation={inputKey:j.inputKey,reason:j.reason,hashes:c.input.photos.map(({side,sha256})=>({side,sha256}))};
  for(const mutate of [
    (q:QueueState)=>{q.cards["card-1"].input.sourceHold="Pairing conflict";},
    (q:QueueState)=>{q.cards["card-1"].jobs.photos.reason="Original missing";},
    (q:QueueState)=>{q.cards["card-1"].jobs.photos.attempts=99;},
    (q:QueueState)=>{q.cards["card-1"].jobs.photos.state="leased";},
    (q:QueueState)=>{q.cards["card-1"].input.photos[0].sha256="f".repeat(64);},
  ]) {const copy=structuredClone(s);mutate(copy);const before=JSON.stringify(copy);assert.throws(()=>recoverPhotoWriteFailure(copy,"card-1",observation,now));assert.equal(JSON.stringify(copy),before);}
  assert.throws(()=>recoverPhotoWriteFailure(s,"card-1",observation,now,{"card-1":"Seller hold"}));
  const otherJobs=JSON.stringify({...c.jobs,photos:undefined});
  recoverPhotoWriteFailure(s,"card-1",observation,now);
  assert.equal(s.cards["card-1"].jobs.photos.state,"done");assert.equal(s.cards["card-1"].jobs.photos.attempts,2);
  assert.equal(JSON.stringify({...s.cards["card-1"].jobs,photos:undefined}),otherJobs);
  assert.throws(()=>recoverPhotoWriteFailure(s,"card-1",observation,now));
});

test("verified archive move retains hashes, survives partial removal and excludes repeat processing",async()=>{
  const f=await archiveFixture();try{
    const directory=path.join(f.root,"artifacts/card-orchestrator");
    await withQueue(directory,s=>Object.assign(s,f.state));
    const archive=await withQueue(directory,s=>preparePhotoMove({...f,state:s}));
    const copied=await readQueue(directory);
    assert.equal(copied.photoArchives?.["card-1"].status,"copied");
    for(const file of archive.files)assert.equal(createHash("sha256").update(await fs.readFile(file.destination)).digest("hex"),file.sha256);
    // Model interruption after removing the first source but before recording completion.
    await fs.unlink(archive.files[0].source);
    await withQueue(directory,s=>finishPhotoMove(s,"card-1",[f.sourceRoot]));
    const saved=await readQueue(directory);assert.equal(saved.photoArchives?.["card-1"].status,"moved");
    for(const file of archive.files){await assert.rejects(fs.access(file.source),{code:"ENOENT"});assert.equal(createHash("sha256").update(await fs.readFile(file.destination)).digest("hex"),file.sha256);}
    await withQueue(directory,s=>finishPhotoMove(s,"card-1",[f.sourceRoot]));
    assert.equal(claimJob(saved,"retry",undefined,"card-1",now),null);
    const dashboard=await loadCardBacklog({root:f.root,inbox:f.archiveRoot,now});
    assert.equal(dashboard.cards.length,1);assert.equal(dashboard.cards[0].physicalUnits,1);
    assert.equal(dashboard.cards[0].excludedFromNewListing,true);
    assert.ok(dashboard.cards[0].originalPaths.includes(archive.files[0].destination));
    assert.equal(dashboard.scan.unmatched.length,0);
  }finally{await fs.rm(f.root,{recursive:true,force:true});}
});
test("archive move with changed archive bytes or source leaves both originals available",async()=>{
  const f=await archiveFixture();try{
    const archive=await preparePhotoMove(f);
    await fs.writeFile(archive.files[1].destination,"corrupt");
    await assert.rejects(finishPhotoMove(f.state,"card-1",[f.sourceRoot]),/Archive hash mismatch/);
    for(const file of archive.files)await fs.access(file.source);
    await fs.writeFile(archive.files[1].destination,await fs.readFile(archive.files[1].source));
    await fs.writeFile(archive.files[1].source,"new scan");
    await assert.rejects(finishPhotoMove(f.state,"card-1",[f.sourceRoot]),/Source changed/);
    for(const file of archive.files)await fs.access(file.source);
  }finally{await fs.rm(f.root,{recursive:true,force:true});}
});

test("record-receipt automatically moves verified live originals into Listed and replay is safe",async()=>{
  const f=await archiveFixture();try{
    const dir=path.join(f.root,"artifacts/card-orchestrator");
    await withQueue(dir,s=>Object.assign(s,f.state));
    const prior=Object.values(f.state.verifiedReceipts!)[0];
    const observation={...prior,observationId:randomUUID(),observedAt:new Date().toISOString()};
    const file=path.join(f.root,"live.json");await fs.writeFile(file,JSON.stringify(observation));
    const script=fileURLToPath(new URL("../scripts/card-orchestrator.ts",import.meta.url));
    const run=()=>JSON.parse(execFileSync(process.execPath,["--experimental-strip-types",script,"record-receipt","--file",file],{cwd:f.root,encoding:"utf8",stdio:["ignore","pipe","pipe"],env:{...process.env,CARD_INBOX_PATH:f.sourceRoot,CARD_WORKFLOW_REVIEW_ROOT:f.root}}));
    const first=run();assert.equal(first.archive.status,"moved");
    for(const file of first.archive.files){assert.ok(file.destination.startsWith(path.join(f.sourceRoot,"Listed","67890")));await assert.rejects(fs.access(file.source),{code:"ENOENT"});await fs.access(file.destination);}
    assert.equal(run().archive.status,"moved");
    const state=await readQueue(dir);assert.equal(Object.keys(state.cards).length,1);assert.equal(claimJob(state,"automatic"),null);
  }finally{await fs.rm(f.root,{recursive:true,force:true});}
});

test("overflowing Champions League titles preserve Sapphire, player, parallel and serial",()=>{
  const card={...identity,player:"Sergio Busquets",season:"2021-22",set:"Topps Chrome Sapphire Edition UEFA Champions League",manufacturer:"Topps",cardNumber:"42",sport:"Soccer",team:"FC Barcelona",parallel:"Orange Sapphire",serial:"10/50",printRun:50};
  const before=JSON.stringify(card);
  const title=listingTitle(card);
  assert.equal(title,"2021-22 Chrome Sapphire Edition UCL Sergio Busquets #42 Orange Sapphire 10/50");
  assert.ok(title.length<=80);
  assert.equal(JSON.stringify(card),before);
  assert.throws(()=>listingTitle({...card,parallel:"Orange Unique Unabridgeable Parallel ".repeat(3)}),/needs review/);
});

 test("Mosaic Peacock overflow removes only redundant product word",()=>{
 const card={...identity,player:"Rafael Santos Borré",season:"2021-22",set:"Panini Mosaic Road to FIFA World Cup",manufacturer:"Panini",cardNumber:"182",sport:"Soccer",parallel:"Choice Peacock Mosaic",serial:"",printRun:null,autograph:false};
 const before=JSON.stringify(card);
 assert.equal(listingTitle(card),"2021-22 Mosaic Road to FIFA World Cup Rafael Santos Borré #182 Choice Peacock");
 assert.equal(JSON.stringify(card),before);
 assert.throws(()=>listingTitle({...card,parallel:"Unique long parallel ".repeat(8)}),/needs review/);
 });

test("Select Dragon Scale overflow preserves tier and full identity",()=>{
 const card={...identity,player:"Santiago Pierotti",season:"2025-26",set:"Select Serie A",manufacturer:"Panini",cardNumber:"188",sport:"Soccer",parallel:"Mezzanine Jade Dragon Scale Prizm",serial:"01/18",printRun:18,autograph:false};
 const before=JSON.stringify(card);
 assert.equal(listingTitle(card),"2025-26 Select Serie A Santiago Pierotti #188 Mezzanine Jade Dragon Scale 01/18");
 assert.equal(JSON.stringify(card),before);
 assert.throws(()=>listingTitle({...card,set:"Other Serie A"}),/needs review/);
 assert.throws(()=>listingTitle({...card,parallel:"Unique long parallel ".repeat(8)}),/needs review/);
});

test("receipt SHA256 field aliases retain exact-pair protection",()=>{
 const card=input();const entries:SavedReceiptRow[]=[{source:"manifest",data:{key:card.sku,liveItemId:"123",frontSha256:card.photos[0].sha256.toUpperCase(),backSha256:card.photos[1].sha256}}];
 assert.equal(applySavedReceipts(card,prepareSavedReceipts(entries)).knownLive?.itemId,"123");
 const changed=structuredClone(card);changed.photos[1].sha256="e".repeat(64);
 assert.throws(()=>applySavedReceipts(changed,prepareSavedReceipts(entries)),/missing or different/);
 const missing:SavedReceiptRow[]=[{source:"manifest",data:{key:card.sku,liveItemId:"123",frontSha256:card.photos[0].sha256}}];
 assert.throws(()=>applySavedReceipts(card,missing),/missing or different/);
});

test("contradictory receipt hash aliases fail closed even on hash-only matches",()=>{
 const card=input();
 for(const side of ["front","back"]){
  for(const identified of [true,false]){
   const data:Record<string,unknown>={liveItemId:"123",frontHash:card.photos[0].sha256,backHash:card.photos[1].sha256};
   if(identified)data.key=card.sku;
   data[`${side}Sha256`]="e".repeat(64);
   const entries:SavedReceiptRow[]=[{source:"conflicting-manifest",data}];
   const original=structuredClone(card);
   for(const receipts of [entries,prepareSavedReceipts(entries)])assert.throws(()=>applySavedReceipts(card,receipts),/conflicting original photo hash aliases/);
   assert.deepEqual(card,original);
  }
 }
 const matching:SavedReceiptRow[]=[{source:"manifest",data:{liveItemId:"123",frontHash:card.photos[0].sha256,frontSha256:card.photos[0].sha256.toUpperCase(),backHash:card.photos[1].sha256,backSha256:card.photos[1].sha256}}];
 assert.equal(applySavedReceipts(card,prepareSavedReceipts(matching)).knownLive?.itemId,"123");
});
import { recoverExpiredIdentity } from "../lib/card-orchestrator.ts";
test("expired identity recovery is atomic, one-shot and preserves attempts",()=>{
  const fixture=()=>{const s=identified();Object.assign(s.cards['card-1'].jobs.identity,{state:'held',attempts:2,reason:'Lease expired; prior worker is fenced from completing',result:undefined});return s;};
  const packet=(s:QueueState)=>({snapshot:fingerprint(s.cards['card-1']),hashes:s.cards['card-1'].input.photos.map(({side,sha256})=>({side,sha256})),result:{outcome:'done',data:{identity,pairMatches:true,frontFirst:true,serialInspected:true,evidence:'Fresh original pair inspection'}}});
  const s=fixture(),p=packet(s);recoverExpiredIdentity(s,'card-1',p,now);
  assert.equal(s.cards['card-1'].jobs.identity.state,'done');assert.equal(s.cards['card-1'].jobs.identity.attempts,3);
  assert.equal(s.cards['card-1'].identityReviewHistory?.[0].jobs.identity.attempts,2);
  assert.throws(()=>recoverExpiredIdentity(s,'card-1',p,now));
  for(const mode of ['snapshot','hash','seller','source','lease','reason','serial','ownership']){
    const q=fixture();if(mode==='source')q.cards['card-1'].input.sourceHold='Explicit source hold';
    if(mode==='lease')q.cards['card-1'].jobs.pricing.state='leased';
    if(mode==='reason')q.cards['card-1'].jobs.identity.reason='Uncertain foil';
    if(mode==='ownership'){const other=structuredClone(q.cards['card-1']);other.input.id='other';q.cards.other=other;}
    const r=packet(q);if(mode==='snapshot')r.snapshot='stale';if(mode==='hash')r.hashes[0].sha256='wrong';if(mode==='serial')r.result.data.serialInspected=false;
    const before=JSON.stringify(q);assert.throws(()=>recoverExpiredIdentity(q,'card-1',r,now,mode==='seller'?{'card-1':'Seller hold'}:{}),mode);assert.equal(JSON.stringify(q),before,mode);
  }
});
import { renameReportFile } from "../lib/card-orchestrator-report.ts";
test("report rename retries sharing failures with source revalidation and bounded failure",async()=>{
  for(const code of ['EPERM','EBUSY']){
    let calls=0,checks=0;const waits:number[]=[];
    await renameReportFile('staged','target',async()=>{checks++;},async(s,d)=>{assert.equal(s,'staged');assert.equal(d,'target');if(++calls<3)throw Object.assign(new Error('sharing'),{code});},async ms=>{waits.push(ms);});
    assert.equal(calls,3);assert.equal(checks,3);assert.deepEqual(waits,[50,150]);
  }
  let calls=0;await assert.rejects(renameReportFile('s','d',async()=>{},async()=>{calls++;throw Object.assign(new Error('persistent'),{code:'EPERM'});},async()=>{}),/persistent/);assert.equal(calls,3);
  calls=0;await assert.rejects(renameReportFile('s','d',async()=>{},async()=>{calls++;throw Object.assign(new Error('missing'),{code:'ENOENT'});},async()=>{}),/missing/);assert.equal(calls,1);
  calls=0;let checks=0;await assert.rejects(renameReportFile('s','d',async()=>{if(++checks===2)throw new ReportSnapshotChanged('source changed');},async()=>{calls++;throw Object.assign(new Error('sharing'),{code:'EPERM'});},async()=>{}),ReportSnapshotChanged);assert.equal(calls,1);
});
import { reviewedKnowledge } from "../lib/card-reviewed-knowledge.ts";
test('reviewed knowledge isolates invalid copies, omits paths and preserves local provenance',()=>{
  const s=identified();const c=s.cards['card-1'];
  const broken=structuredClone(c);broken.input.id='broken';broken.jobs.identity.result!.identity={};s.cards.broken=broken;
  const held=structuredClone(c);held.input.id='held';held.jobs.identity.state='held';s.cards.held=held;
  const before=JSON.stringify(s),r=reviewedKnowledge(s,'pritchard',0,1);
  assert.equal(r.total,1);assert.equal(r.exceptions.length,1);assert.equal(r.records[0].cardId,'card-1');
  assert.equal(r.productionDatabaseApplied,false);assert.equal('path' in r.records[0].originals[0],false);
  r.records[0].identity.player='mutated response';assert.equal(JSON.stringify(s),before);
  assert.equal(reviewedKnowledge(s,'unmatched').total,0);assert.equal(reviewedKnowledge(s,'',1).records.length,0);
});
test('reviewed knowledge rejects changed identity and capture inputs without mutating or hiding independent reviews',()=>{
  for(const change of ['hash','path','identity','sourceHold']){
    const s=identified(),original=s.cards['card-1'];const other=structuredClone(original);other.input.id='other';s.cards.other=other;
    if(change==='hash')original.input.photos[0].sha256='c'.repeat(64);
    if(change==='path')original.input.photos[0].path='different.jpg';
    if(change==='identity')original.input.identity.parallel='different';
    if(change==='sourceHold')original.input.sourceHold='New uncertainty';
    const before=JSON.stringify(s),r=reviewedKnowledge(s);assert.equal(r.total,1,change);assert.equal(r.records[0].cardId,'other');assert.equal(r.exceptions.length,1);assert.equal(JSON.stringify(s),before);
  }
});

test('active duplicate standing authority reaches pricing and preflight without implying new inventory',()=>{
  const s=identified();
  upsertCard(s,{...input(),knownLive:{itemId:'123',url:'https://www.ebay.com/itm/123',observedAt:now,source:'test'}},now);
  const packet=flowPacket(s,['card-1'],now);
  const policy=packet.activeDuplicatePolicy;
  assert.equal(policy.matchedActiveAction,'increase-existing-quantity');
  assert.equal(policy.askPerCardPermission,false);
  assert.equal(policy.createSeparateDraftForConfirmedActiveMatch,false);
  assert.equal(policy.preserveExistingPriceAndSettings,true);
  assert.deepEqual(pricingContext(s,'card-1',now).activeDuplicatePolicy,policy);
  assert.deepEqual(packet.cards[0].activeDuplicatePolicy,policy);
  assert.equal(packet.cards[0].route,'excluded');
  assert.equal(packet.canPublish,false);
  assert.equal(packet.canUpload,false);
  const held=flowPacket(s,['card-1'],now,[],{},{'card-1':{holdReason:'Inspect exact variant'}});
  assert.equal(held.cards[0].sellerHold,'Inspect exact variant');
  assert.match(flowHtml(packet),/Do not ask increase-or-draft/);
});

test('seller default fills owned intake condition and preserves explicit exceptions on reimport',()=>{
 const s=newQueue(),original=input();
 upsertCard(s,{...original,identity:{...original.identity,condition:'Not specified'}},now);
 assert.equal(s.cards['card-1'].input.identity.condition,'Near mint or better');
 upsertCard(s,{...original,identity:{...original.identity,condition:'Excellent'}},now);
 upsertCard(s,{...original,identity:{...original.identity,condition:'Not specified'}},now);
 assert.equal(s.cards['card-1'].input.identity.condition,'Excellent');
 const packet=flowPacket(s,['card-1'],now);
 assert.equal(packet.conditionPolicy.defaultCondition,'Near mint or better');
 assert.equal(packet.conditionPolicy.askRoutineConfirmation,false);
 assert.deepEqual(pricingContext(s,'card-1',now).conditionPolicy,packet.conditionPolicy);
});

test('quantity-update archive binds an existing capture and never increments stock',async()=>{
  const f=await archiveFixture();try{
    const c=f.state.cards['card-1'];const owner=structuredClone(c);owner.input.id='existing';owner.input.sku='existing-sku';owner.input.photos=owner.input.photos.map(p=>({...p,path:p.path+'.existing',sha256:p.side==='front'?'a'.repeat(64):'b'.repeat(64)}));
    (owner.jobs.identity.result!.identity as Identity).language='English';(c.jobs.identity.result!.identity as Identity).language='English'; (owner.jobs.identity.result!.identity as Identity).serial='';(owner.jobs.identity.result!.identity as Identity).printRun=null;(c.jobs.identity.result!.identity as Identity).serial='';(c.jobs.identity.result!.identity as Identity).printRun=null;
    f.state.cards.existing=owner;delete c.input.knownDraft;delete c.exclusion;f.state.verifiedReceipts={};
    const receipt={observationId:randomUUID(),seller:'imaydit58',cardId:'card-1',sku:c.input.sku,frontHash:c.input.photos[0].sha256,backHash:c.input.photos[1].sha256,identityKey:fingerprint((c.jobs.identity.result!.identity as Identity)),liveItemId:'67890',observedAt:now,photosVerified:true,source:'https://www.ebay.com/itm/67890',evidence:'Actual saved one-copy increase evidence',quantityUpdate:{existingCardId:'existing',listingSku:'existing-sku',listingIdentity:(owner.jobs.identity.result!.identity as Identity),before:1,after:2,evidence:'saved-quantity-result.json'}};
    assert.throws(()=>recordVerifiedReceipt(structuredClone(f.state),{...receipt,quantityUpdate:{...receipt.quantityUpdate,existingCardId:'absent'}},now),/existing listing/);
    assert.throws(()=>recordVerifiedReceipt(structuredClone(f.state),{...receipt,quantityUpdate:{...receipt.quantityUpdate,after:3}},now),/existing listing/);
    assert.throws(()=>recordVerifiedReceipt(structuredClone(f.state),{...receipt,quantityUpdate:{...receipt.quantityUpdate,listingIdentity:{...receipt.quantityUpdate.listingIdentity,parallel:'Other'}}},now),/existing listing/);
    const before=JSON.stringify(owner);recordVerifiedReceipt(f.state,receipt,now);assert.equal(JSON.stringify(owner),before);
    const ownerIdentity=structuredClone(owner.jobs.identity.result!);
    refreshJobs(owner,now);owner.jobs.photos.state='done';owner.jobs.identity.state='done';owner.jobs.identity.result=ownerIdentity;
    const originalReceipt={observationId:randomUUID(),seller:'imaydit58',cardId:'existing',sku:owner.input.sku,frontHash:owner.input.photos[0].sha256,backHash:owner.input.photos[1].sha256,identityKey:fingerprint(ownerIdentity.identity),draftId:owner.input.knownDraft,liveItemId:'67890',observedAt:now,photosVerified:true,source:'https://www.ebay.com/itm/67890',evidence:'Original copy independently verified after retained quantity update'};
    const changed=structuredClone(f.state);changed.cards['card-1'].input.photos[0].sha256='c'.repeat(64);
    assert.throws(()=>recordVerifiedReceipt(changed,originalReceipt,now),/Conflicting receipt/);
    const wrongIdentity=structuredClone(f.state);(wrongIdentity.cards['card-1'].jobs.identity.result!.identity as Identity).parallel='Other';
    assert.throws(()=>recordVerifiedReceipt(wrongIdentity,originalReceipt,now),/Conflicting receipt/);
    assert.equal(recordVerifiedReceipt(f.state,originalReceipt,now),true);
    assert.ok(!jobBlockers(f.state,owner,'listing').some(reason=>reason.includes('ownership')));
    const afterOriginal=JSON.stringify(owner);
    await preparePhotoMove(f);await finishPhotoMove(f.state,'card-1',[f.sourceRoot]);await finishPhotoMove(f.state,'card-1',[f.sourceRoot]);assert.equal(f.state.photoArchives?.['card-1'].status,'moved');assert.equal(JSON.stringify(owner),afterOriginal);
  }finally{await fs.rm(f.root,{recursive:true,force:true});}
});


test('disposable draft copy policy is scoped and cannot suppress live archives',async()=>{
  const {archiveCopyOnly}=await import('../lib/card-photo-archive.ts');const s=newQueue();s.draftWriter={owner:'test',configuredAt:now,evidence:'test evidence',scope:['card-1'],archiveMode:'copy-only'};
  assert.equal(archiveCopyOnly(s,{cardId:'card-1'}),true);
  assert.equal(archiveCopyOnly(s,{cardId:'other'}),false);
  assert.equal(archiveCopyOnly(s,{cardId:'card-1',liveItemId:'123'}),false);
  assert.equal(archiveCopyOnly(s,{cardId:'card-1',liveItemId:'123'},true),true);
});
import { recordKnownInventoryObservation } from '../lib/card-orchestrator.ts';
async function soldArchiveFixture(){
 const f=await archiveFixture(),c=f.state.cards['card-1'];
 const r={observationId:randomUUID(),seller:'imaydit58',cardId:'card-1',sku:c.input.sku,identityKey:fingerprint(c.jobs.identity.result!.identity),photoKey:fingerprint(c.input.photos),itemId:'67890',disposition:'sold',observedAt:now,source:'https://www.ebay.com/itm/67890',evidence:'Seller sold page and exact original capture SKU verified'};
 recordKnownInventoryObservation(f.state,r,now);
 return {...f,observation:{seller:'imaydit58',cardId:'card-1',sku:c.input.sku,soldItemId:'67890',observedAt:now,source:r.source}};
}
test('sold archive preserves pricing holds and moves original hashes idempotently',async()=>{
 const f=await soldArchiveFixture();try{
  f.state.cards['card-1'].jobs.pricing.state='held';f.state.cards['card-1'].jobs.pricing.reason='Retained pricing evidence';
  const before=JSON.stringify(f.state.cards);
  await preparePhotoMove(f);await finishPhotoMove(f.state,'card-1',[f.sourceRoot]);await finishPhotoMove(f.state,'card-1',[f.sourceRoot]);
  assert.equal(JSON.stringify(f.state.cards),before);const e=f.state.photoArchives!['card-1'];assert.equal(e.soldItemId,'67890');assert.equal(e.status,'moved');
  for(const p of e.files){assert.equal(createHash('sha256').update(await fs.readFile(p.destination)).digest('hex'),p.sha256);await assert.rejects(fs.stat(p.source));}
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});
test('sold archive rejects changed identity, receipt, holds and corrupted destination before unlink',async()=>{
 for(const mode of ['identity','receipt','seller','condition','source','corrupt']){
  const f=await soldArchiveFixture();try{
   if(mode==='corrupt'){await preparePhotoMove(f);await fs.writeFile(f.state.photoArchives!['card-1'].files[1].destination,'bad');await assert.rejects(finishPhotoMove(f.state,'card-1',[f.sourceRoot]),/hash/);}
   else{
    if(mode==='identity')f.state.cards['card-1'].jobs.identity.result!.identity={...identity,parallel:'changed'};
    if(mode==='receipt')f.state.knownInventoryObservations={};
    if(mode==='condition')f.state.cards['card-1'].jobs.identity.state='held';
    if(mode==='source')f.state.cards['card-1'].input.sourceHold='Hold';
    await assert.rejects(preparePhotoMove({...f,sellerHold:mode==='seller'?'Seller hold':undefined}));
   }
   for(const p of f.state.cards['card-1'].input.photos)assert.equal(createHash('sha256').update(await fs.readFile(p.path)).digest('hex'),p.sha256);
  }finally{await fs.rm(f.root,{recursive:true,force:true});}
 }
});
test('sold observation handoff and bounded recovery archive automatically without duplicate work',async()=>{
 for(const recovery of [false,true]){
  const f=await archiveFixture();try{
   const c=f.state.cards['card-1'],at=new Date().toISOString();
   const observation={observationId:randomUUID(),seller:'imaydit58',cardId:'card-1',sku:c.input.sku,identityKey:fingerprint(c.jobs.identity.result!.identity),photoKey:fingerprint(c.input.photos),itemId:'67890',disposition:'sold',observedAt:at,source:'https://www.ebay.com/itm/67890',evidence:'Seller sold page exact original pair receipt'};
   if(recovery)recordKnownInventoryObservation(f.state,observation,at);
   const dir=path.join(f.root,'artifacts/card-orchestrator');await withQueue(dir,s=>Object.assign(s,f.state));
   const file=path.join(f.root,'sold.json');await fs.writeFile(file,JSON.stringify(observation));
   const script=fileURLToPath(new URL('../scripts/card-orchestrator.ts',import.meta.url));
   const run=()=>JSON.parse(execFileSync(process.execPath,['--experimental-strip-types',script,...(recovery?['recover-archives','--cards','card-1']:['record-known-inventory','--file',file])],{cwd:f.root,encoding:'utf8',stdio:['ignore','pipe','pipe'],env:{...process.env,CARD_INBOX_PATH:f.sourceRoot,CARD_WORKFLOW_REVIEW_ROOT:f.root}}));
   const first=run(),entry=recovery?first[0].archive:first.archive;assert.equal(entry.status,'moved');
   for(const p of entry.files){assert.ok(p.destination.startsWith(path.join(f.sourceRoot,'Sold','67890')));assert.equal(createHash('sha256').update(await fs.readFile(p.destination)).digest('hex'),p.sha256);await assert.rejects(fs.access(p.source));}
   const replay=run();if(recovery)assert.deepEqual(replay,[]);else assert.equal(replay.archive.status,'moved');
   const state=await readQueue(dir);assert.equal(Object.keys(state.cards).length,1);assert.equal(state.cards['card-1'].exclusion!.disposition,'sold');
  }finally{await fs.rm(f.root,{recursive:true,force:true});}
 }
});

test("copy-only draft promotes verified originals to Listed while preserving draft evidence",async()=>{
 const f=await draftArchiveFixture();try{
  const draft=await preparePhotoMove(f),before=JSON.stringify(f.state.cards["card-1"].input);
  const oldManifest=await fs.readFile(draft.manifestPath,"utf8");
  const receipt=Object.values(f.state.verifiedReceipts!)[0];
  recordVerifiedReceipt(f.state,{...receipt,observationId:randomUUID(),liveItemId:"67890",source:"https://www.ebay.com/itm/67890"},now);
  const live=await preparePhotoMove({...f,archiveRoot:path.join(f.sourceRoot,"Listed"),observation:{...f.observation,draftId:undefined,liveItemId:"67890",source:"https://www.ebay.com/itm/67890"}});
  await finishPhotoMove(f.state,"card-1",[f.sourceRoot]);
  assert.equal(live.status,"moved");assert.equal(await fs.readFile(draft.manifestPath,"utf8"),oldManifest);
  for(const file of live.files){await assert.rejects(fs.access(file.source),{code:"ENOENT"});assert.equal(createHash("sha256").update(await fs.readFile(file.destination)).digest("hex"),file.sha256);}
  for(const file of draft.files)await fs.access(file.destination);
  assert.equal(JSON.stringify(f.state.cards["card-1"].input),before);
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});
test("copy-only promotion refuses changed original and preserves old mapping",async()=>{
 const f=await draftArchiveFixture();try{
  const draft=await preparePhotoMove(f),receipt=Object.values(f.state.verifiedReceipts!)[0];
  recordVerifiedReceipt(f.state,{...receipt,observationId:randomUUID(),liveItemId:"67890",source:"https://www.ebay.com/itm/67890"},now);
  await fs.writeFile(draft.files[1].source,"changed");
  await assert.rejects(preparePhotoMove({...f,archiveRoot:path.join(f.sourceRoot,"Listed"),observation:{...f.observation,draftId:undefined,liveItemId:"67890",source:"https://www.ebay.com/itm/67890"}}),/bytes changed/);
  assert.equal(f.state.photoArchives!["card-1"],draft);for(const file of draft.files)await fs.access(file.source);
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});

test('aggregate quantity receipts are atomic, idempotent and archive each distinct original without stock edits',async()=>{
 const f=await archiveFixture();try{
  const base=f.state.cards['card-1'];delete base.input.knownDraft;delete base.exclusion;f.state.verifiedReceipts={};
  const i={...(base.jobs.identity.result!.identity as Identity),serial:'',printRun:null,language:'English'};
  for(let n=0;n<3;n++){
   const c=n===0?base:structuredClone(base);c.input.id='copy-'+n;c.input.sku='sku-'+n;c.input.identity=i;
   c.input.photos=await Promise.all(c.input.photos.map(async p=>{const bytes=Buffer.from(p.side+n),file=path.join(f.sourceRoot,p.side+n+'.jpg');await fs.writeFile(file,bytes);return {...p,path:file,sha256:createHash('sha256').update(bytes).digest('hex')};}));
   refreshJobs(c,now);c.jobs.photos.state='done';c.jobs.identity.state='done';c.jobs.identity.result={identity:i};f.state.cards[c.input.id]=c;
  }
  delete f.state.cards['card-1'];const cards=Object.values(f.state.cards);
  const packet={operationId:randomUUID(),seller:'imaydit58',liveItemId:'67890',listingIdentity:i,before:4,after:7,operationStartedAt:now,reopenedAt:now,observedAt:now,source:'https://www.ebay.com/itm/67890',evidence:'Actual aggregate saved and reopened operation evidence',photosVerified:true,members:cards.map(c=>({cardId:c.input.id,sku:c.input.sku,frontHash:c.input.photos[0].sha256,backHash:c.input.photos[1].sha256,identityKey:fingerprint(i)}))};
  for(const bad of [{...packet,after:8},{...packet,members:[packet.members[0],packet.members[0],packet.members[2]]},{...packet,listingIdentity:{...i,parallel:'Other'}},{...packet,members:packet.members.map((m,n)=>n===2?{...m,backHash:'0'.repeat(64)}:m)}]){
   const copy=structuredClone(f.state),before=JSON.stringify(copy);assert.throws(()=>recordQuantityReceiptGroup(copy,bad,now));assert.equal(JSON.stringify(copy),before);
  }
  const changed=structuredClone(f.state);changed.cards['copy-2'].input.knownDraft='999';assert.throws(()=>recordQuantityReceiptGroup(changed,packet,now));
  const photoClone=structuredClone(f.state);photoClone.cards.unrelated=structuredClone(photoClone.cards['copy-2']);photoClone.cards.unrelated.input.id='unrelated';const before=JSON.stringify(photoClone);assert.throws(()=>recordQuantityReceiptGroup(photoClone,packet,now));assert.equal(JSON.stringify(photoClone),before);
  assert.equal(recordQuantityReceiptGroup(f.state,packet,now),true);assert.equal(recordQuantityReceiptGroup(f.state,packet,now),false);
  assert.throws(()=>recordQuantityReceiptGroup(f.state,{...packet,operationId:randomUUID()},now),/already represented/);
  assert.throws(()=>recordQuantityReceiptGroup(f.state,{...packet,after:8},now),/different evidence/);
  for(const c of cards){
   assert.ok(!jobBlockers(f.state,c,'listing').some(r=>r.includes('ownership')));
   await preparePhotoMove({state:f.state,observation:{cardId:c.input.id,sku:c.input.sku,seller:'imaydit58',liveItemId:'67890',observedAt:now,source:packet.source},sourceRoot:f.sourceRoot,archiveRoot:f.archiveRoot,now});
   await finishPhotoMove(f.state,c.input.id,[f.sourceRoot]);assert.equal(f.state.photoArchives?.[c.input.id].status,'moved');
   for(const file of f.state.photoArchives![c.input.id].files)assert.equal(createHash('sha256').update(await fs.readFile(file.destination)).digest('hex'),file.sha256);
  }
  const invalid=structuredClone(f.state);invalid.cards['copy-2'].input.photos[0].sha256='0'.repeat(64);
  const receipt=Object.values(invalid.verifiedReceipts!)[0];assert.throws(()=>recordVerifiedReceipt(invalid,{...receipt,observationId:randomUUID()},now),/aggregate/);
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});

test('standing draft archive authority supersedes old copy-only writer configuration but honors explicit copy-only calls',async()=>{
 const {archiveCopyOnly}=await import('../lib/card-photo-archive.ts');const s=newQueue();s.draftWriter={owner:'test',configuredAt:now,evidence:'prior test',scope:['card-1'],archiveMode:'copy-only'};
 assert.equal(archiveCopyOnly(s,{cardId:'card-1'}),true);s.draftArchiveAuthority={evidence:'Seller authorizes all verified drafts to move their photos',at:now};
 assert.equal(archiveCopyOnly(s,{cardId:'card-1'}),false);assert.equal(archiveCopyOnly(s,{cardId:'card-1'},true),true);
});

test("archived draft remains priceable while holds and Add exclusion remain enforced",()=>{
 const s=identified(),c=s.cards["card-1"];c.input.knownDraft="12345";
 s.photoArchives={"card-1":{draftId:"12345",captureId:"card-1",manifestPath:"manifest.json",archiveRoot:"Drafted",status:"moved",files:[]}};
 assert.equal(claimJob(s,"worker","pricing","card-1",now,{"card-1":"seller hold"}),null);
 assert.equal(claimJob(s,"worker","listing","card-1",now),null);
 assert.equal(claimJob(s,"worker","pricing","card-1",now)?.job.kind,"pricing");
});

test("Bowman University Sapphire overflow preserves the exact variant",()=>{
 const card={...identity,player:"Meechie Johnson",season:"2024-25",set:"Bowman University Chrome Sapphire Edition",manufacturer:"Topps",cardNumber:"54",sport:"Basketball",parallel:"Blue Sapphire",serial:"",printRun:null,autograph:false};
 const title=listingTitle(card);assert.ok(title.length<=80);assert.match(title,/Bowman U Chrome Sapphire Edition/);assert.match(title,/Meechie Johnson #54 Blue Sapphire/);
 assert.throws(()=>listingTitle({...card,parallel:"Unique long parallel ".repeat(8)}),/needs review/);
});
