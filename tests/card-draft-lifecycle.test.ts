import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { newQueue, upsertCard, claimJob, completeJob, existingReceipt, createJobBlockerLookup, refreshJobs, type Identity } from "../lib/card-orchestrator.ts";
import { readQueue, withQueue } from "../lib/card-orchestrator-store.ts";
import { configureDraftWriter, claimDraftWriter, draftBinding, draftNext, observeDraft, beginDraftWrite, beginDraftGroup, observeDraftGroup, verifyDraft, holdDraft, recoverDraft } from "../lib/card-draft-lifecycle.ts";
import {recordVerifiedReceipt,validDraftGroup,fingerprint} from "../lib/card-orchestrator.ts";
import {deferDraftPricing,verifyUnpricedDraft} from "../lib/card-draft-lifecycle.ts";
test("pricing timeout fences late completion and preserves evidence for an unpriced draft",()=>{
  const {s}=fixture();const claim=claimJob(s,"researcher","pricing","one",now)!;
  assert.ok(claim);
  assert.equal(claimJob(s,"researcher","pricing","one","2026-10-24T23:00:30.000Z"),null);
  assert.equal(s.cards.one.jobs.pricing.state,"held");
  assert.equal(s.cards.one.pricingDeferral?.elapsedMs,30000);
  assert.throws(()=>completeJob(s,"one","pricing",claim.job.lease!.token,{outcome:"done",data:{}},"2026-10-24T23:00:31.000Z"),/Lease expired/);
});

test("30-second deferral permits an incomplete draft without declaring a priced verification",()=>{
  const {s,token}=fixture();
  assert.throws(()=>deferDraftPricing(s,"one",now,"Research evidence",later),/30-second/);
  deferDraftPricing(s,"one","2026-10-24T22:59:00.000Z","Research evidence retained",now);
  const blank={approved:false,price:null};
  assert.equal(draftNext(s,"one",blank,now).action,"inspect-saved-draft");
  beginDraftWrite(s,"one","writer",token,blank,now);
  const {capture}=verification();capture.ax=capture.ax.replace("Item price, Value: 1.49","Item price, Value: ");
  const verified=verifyUnpricedDraft(s,"one",capture,blank,"Saved unpriced snapshot",later);
  assert.equal(verified.photoIdentityVerified,true);
  assert.equal(verified.identityKey,fingerprint(s.cards.one.jobs.identity.result!.identity));
  assert.deepEqual(verified.expected.originalHashes,s.cards.one.input.photos.map(p=>p.sha256.toLowerCase()));
  assert.equal(verified.canPublish,false);
  assert.equal(draftNext(s,"one",blank,later).action,"unpriced-draft-awaiting-seller-review");
  assert.equal(s.cards.one.draftLifecycle?.verification,undefined);
  assert.equal(draftNext(s,"one",{...blank,sellerHold:"Identity concern"},later).action,"seller-hold");
});

test("unpriced verification rejects a guessed zero-dollar placeholder",()=>{
  const {s,token}=fixture();const blank={approved:false,price:null};
  deferDraftPricing(s,"one","2026-10-24T22:59:00.000Z","Research evidence retained",now);
  beginDraftWrite(s,"one","writer",token,blank,now);
  const {capture}=verification();capture.ax=capture.ax.replace("Item price, Value: 1.49","Item price, Value: 0");
  assert.throws(()=>verifyUnpricedDraft(s,"one",capture,blank,"Saved unpriced snapshot",later),/not verified/);
});

const now="2026-10-24T23:00:00.000Z",later="2026-10-24T23:00:20.000Z";
const identity:Identity={player:"Player",season:"2025",set:"Prizm",manufacturer:"Panini",cardNumber:"1",sport:"Basketball",team:"Team",parallel:"Base",serial:"",printRun:null,condition:"Near mint or better",autograph:false,patch:false};
const context={approved:true,price:{item:1.49,shipping:0}};
function groupFixture(){
 const s=newQueue();
 for(const [id,front,back] of [["one","a","b"],["two","d","e"]]){
  const reviewed={...identity,language:"English"};
  upsertCard(s,{id,sku:`capture-${id}`,identity:reviewed,photos:[{side:"front",path:`${id}-front.jpg`,sha256:front.repeat(64)},{side:"back",path:`${id}-back.jpg`,sha256:back.repeat(64)}],source:"scanner-intake:test",candidates:[]},now);
  for(const kind of ["photos","identity"] as const){const claim=claimJob(s,"reviewer",kind,id,now)!;completeJob(s,id,kind,claim.job.lease!.token,{outcome:"done",data:kind==="photos"?{hashes:s.cards[id].input.photos.map(({side,sha256})=>({side,sha256})),evidence:"originals read"}:{identity:reviewed,pairMatches:true,frontFirst:true,serialInspected:true,evidence:"Both original photos visually reviewed"}},now);}
  s.cards[id].jobs.reconcile.state="done";s.cards[id].jobs.reconcile.result={disposition:"clear",checkedAt:now,scopes:["active","drafts","scheduled","sold"]};s.cards[id].jobs.listing.state="done";
 }
 configureDraftWriter(s,"writer",["one","two"],"Legacy writer schedules paused",now,{allowCreate:true,authority:"Seller authorized both distinct copies in one matching quantity draft"});
 return {s,token:claimDraftWriter(s,"writer",undefined,now).lease!.token,contexts:{one:context,two:context}};
}
function fixture(){
  const s=newQueue();upsertCard(s,{id:"one",sku:"capture-one",identity,photos:[{side:"front",path:"front.jpg",sha256:"a".repeat(64)},{side:"back",path:"back.jpg",sha256:"b".repeat(64)}],source:"scanner-intake:test",candidates:[]},now);
  for(const kind of ["photos","identity"] as const){const claim=claimJob(s,"reviewer",kind,"one",now)!;completeJob(s,"one",kind,claim.job.lease!.token,{outcome:"done",data:kind==="photos"?{hashes:s.cards.one.input.photos.map(({side,sha256})=>({side,sha256})),evidence:"originals read"}:{identity,pairMatches:true,frontFirst:true,serialInspected:true,evidence:"reviewed original pair"}},now);}
  configureDraftWriter(s,"writer",["one"],"Both competing listing schedules paused",now);
  const observation={observationId:randomUUID(),seller:"imaydit58",cardId:"one",sku:"capture-one",binding:draftBinding(s.cards.one),draftId:"123456789012",state:"saved",url:"https://www.ebay.com/sl/list?draft_id=123456789012",observedAt:now,evidence:"Seller Hub rendered exact SKU and draft ID"};
  observeDraft(s,observation,now);const lease=claimDraftWriter(s,"writer",undefined,now);
  return {s,observation,token:lease.lease!.token};
}
function verification(){
  const expected={draftId:"123456789012",sku:"capture-one",title:"Card",quantity:1,item:1.49,shipping:0,offersEnabled:false,condition:"Near mint or better",specifics:{},policies:{shipping:"111111111111",payment:"222222222222",returns:"333333333333"},originalHashes:["a".repeat(64),"b".repeat(64)],general:false,priority:false};
  const url="https://www.ebay.com/lstng?draftId=123456789012";
  const ax=`Browser tab: 1, URL: "${url}".
1 text field (settable) Item title, Value: Card, ID: title
2 text field (settable) Custom label (SKU), Value: capture-one, ID: sku
3 text field (settable) Item price, Value: 1.49, ID: item
4 text field (settable) Quantity, Value: 1, ID: qty
5 switch (settable) Description: Allow offers, Value: 0
6 switch (settable) Description: Toggle General, Value: 0
7 switch (settable) Description: Toggle Priority, Value: 0
8 combo box (settable) Shipping policy, Value: Free (111111111111)
9 combo box (settable) Payment policy, Value: Managed (222222222222)
10 text Return policy : No returns (333333333333)
11 pop up button Format Buy It Now,
12 pop up button Condition type Ungraded: Not graded
13 pop up button Card Condition Near mint or better: Pack fresh
14 text 2 out of 25 photos or videos uploaded`;
  const capture={url,savedAt:"2026-10-24T23:00:01.000Z",reopenedAt:"2026-10-24T23:00:10.000Z",capturedAt:"2026-10-24T23:00:15.000Z",ax,
    shipping:{amount:0,policyId:expected.policies.shipping,evidence:"Policy inspected"},issues:{inspected:true as const,errors:[] as string[],evidence:"Issue summary inspected"},
    visual:{draftId:expected.draftId,originalHashes:expected.originalHashes,screenshotSha256:"c".repeat(64),frontMain:true as const,backSecond:true as const,upright:true as const,identityMatches:true as const,reviewedAt:"2026-10-24T23:00:16.000Z",evidence:"Saved photos compared with originals"}};
  return {expected,capture};
}
test("same observation is idempotent; conflicting ID cannot replace the receipt",()=>{const f=fixture();assert.equal(observeDraft(f.s,f.observation,now),false);assert.throws(()=>observeDraft(f.s,{...f.observation,observationId:randomUUID(),draftId:"9"},now));assert.equal(existingReceipt(f.s.cards.one)?.itemId,"123456789012");});
test("absence never clears ID or authorizes another Add",()=>{const f=fixture();observeDraft(f.s,{...f.observation,observationId:randomUUID(),state:"absent"},now);assert.equal(draftNext(f.s,"one",context,now).action,"reconcile-draft-status");assert.throws(()=>beginDraftWrite(f.s,"one","writer",f.token,context,now));assert.ok(existingReceipt(f.s.cards.one));});
test("competing writers and stale tokens are fenced",()=>{const f=fixture();assert.throws(()=>claimDraftWriter(f.s,"other",undefined,now));assert.throws(()=>claimDraftWriter(f.s,"writer",undefined,now));assert.equal(claimDraftWriter(f.s,"writer",f.token,now).lease?.token,f.token);const replacement=claimDraftWriter(f.s,"writer",undefined,"2026-10-24T23:16:00.000Z");assert.notEqual(replacement.lease?.token,f.token);assert.throws(()=>beginDraftWrite(f.s,"one","writer",f.token,context,"2026-10-24T23:16:00.000Z"));});
test("missing draft prices and seller holds survive reconciliation",()=>{const f=fixture();assert.equal(draftNext(f.s,"one",{approved:false,price:null},now).action,"resolve-pricing-evidence");assert.throws(()=>beginDraftWrite(f.s,"one","writer",f.token,{approved:false,price:null},now));assert.equal(draftNext(f.s,"one",{...context,sellerHold:"Do not proceed"},now).action,"seller-hold");});

test("authorized draft price verifies without prior approval and later review does not redo the draft",()=>{
 const f=fixture(),v=verification(),draftContext={approved:false,draftAuthorized:true,price:context.price};
 beginDraftWrite(f.s,"one","writer",f.token,draftContext,now);
 const verified=verifyDraft(f.s,"one",v.expected,v.capture,draftContext,"Saved draft awaiting seller price review",later);
 assert.equal(verified.allChecksPassed,true);
 assert.equal(draftNext(f.s,"one",context,later).verificationCurrent,true);
 assert.equal(draftNext(f.s,"one",draftContext,later).canPublish,false);
 assert.throws(()=>verifyDraft(f.s,"one",v.expected,v.capture,{...draftContext,price:{item:2.49,shipping:0}},"Changed price",later));
});
test("unfinished intent survives a fresh process and resolves only through saved evidence",async()=>{
  const f=fixture(),root=await fs.mkdtemp(path.join(os.tmpdir(),"draft-restart-"));
  try {
    await withQueue(root,s=>Object.assign(s,f.s));
    const engine=new URL("../lib/card-draft-lifecycle.ts",import.meta.url).href,store=new URL("../lib/card-orchestrator-store.ts",import.meta.url).href;
    execFileSync(process.execPath,["--experimental-strip-types","--input-type=module","-e",`import {withQueue} from ${JSON.stringify(store)};import {beginDraftWrite} from ${JSON.stringify(engine)};await withQueue(${JSON.stringify(root)},s=>beginDraftWrite(s,'one','writer',${JSON.stringify(f.token)},${JSON.stringify(context)},${JSON.stringify(now)}));`],{stdio:"pipe"});
    const output=execFileSync(process.execPath,["--experimental-strip-types","--input-type=module","-e",`import {readQueue} from ${JSON.stringify(store)};import {draftNext} from ${JSON.stringify(engine)};console.log(JSON.stringify(draftNext(await readQueue(${JSON.stringify(root)}),'one',${JSON.stringify(context)},${JSON.stringify(later)})));`],{encoding:"utf8",stdio:["ignore","pipe","pipe"]});
    const next=JSON.parse(output);assert.equal(next.action,"reconcile-write-outcome");assert.equal(next.draftId,"123456789012");assert.equal(next.canCreate,false);
    const v=verification();await withQueue(root,s=>verifyDraft(s,"one",v.expected,v.capture,context,"reopened evidence",later));
    const after=await readQueue(root);assert.equal(after.cards.one.draftLifecycle?.operation,undefined);assert.equal(draftNext(after,"one",context,later).action,"verify-and-archive-originals");assert.equal(after.cards.one.draftLifecycle?.verification?.allChecksPassed,true);
  } finally {await fs.rm(root,{recursive:true,force:true});}
});
test("verification failures drive exact repair and count only new evidence",()=>{const f=fixture(),v=verification();v.capture.issues.errors=["Missing return policy"];verifyDraft(f.s,"one",v.expected,v.capture,context,"failed evidence",later);assert.equal(draftNext(f.s,"one",context,later).action,"repair-saved-draft");assert.equal(f.s.draftLearning?.["issues.errors"].failures,1);verifyDraft(f.s,"one",v.expected,v.capture,context,"same evidence",later);assert.equal(f.s.draftLearning?.["issues.errors"].failures,1);v.capture.issues.errors=[];verifyDraft(f.s,"one",v.expected,v.capture,context,"repaired evidence",later);assert.equal(f.s.draftLearning?.["issues.errors"].verifiedRecoveries,1);});
test("changed approved price or physical pair invalidates old verification",()=>{const f=fixture(),v=verification();verifyDraft(f.s,"one",v.expected,v.capture,context,"saved evidence",later);assert.equal(draftNext(f.s,"one",{approved:true,price:{item:2.49,shipping:0}},later).action,"inspect-saved-draft");f.s.cards.one.input.photos[0].sha256="d".repeat(64);assert.equal(draftNext(f.s,"one",context,later).action,"reconcile-changed-capture");assert.throws(()=>verifyDraft(f.s,"one",v.expected,v.capture,context,"stale pair",later));});
test("same failure cannot loop without new evidence; no scope expansion",()=>{const f=fixture();holdDraft(f.s,"one","writer",f.token,"Browser access was denied","access denied screenshot",now);assert.equal(draftNext(f.s,"one",context,now).action,"held-until-new-evidence");assert.throws(()=>recoverDraft(f.s,"one","access denied screenshot",later));recoverDraft(f.s,"one","Successful saved-ID access screenshot",later);assert.equal(draftNext(f.s,"one",context,later).action,"inspect-saved-draft");f.s.draftWriter!.scope=[];assert.throws(()=>beginDraftWrite(f.s,"one","writer",f.token,context,later));});
test("source sync preserves lifecycle, intent and draft ID",()=>{const f=fixture();beginDraftWrite(f.s,"one","writer",f.token,context,now);const {knownDraft,...source}=f.s.cards.one.input;upsertCard(f.s,source,later);assert.equal(f.s.cards.one.input.knownDraft,knownDraft);assert.equal(draftNext(f.s,"one",context,later).action,"reconcile-write-outcome");});
test("verification cannot increase stock or accept an unapproved price",()=>{const f=fixture(),v=verification();assert.throws(()=>verifyDraft(f.s,"one",{...v.expected,quantity:2},v.capture,context,"wrong stock",later));assert.throws(()=>verifyDraft(f.s,"one",{...v.expected,item:3.49},v.capture,context,"wrong price",later));assert.equal(f.s.cards.one.draftLifecycle?.verification,undefined);});
test("verification replay does not append events or relearn the same failure",()=>{const f=fixture(),v=verification();verifyDraft(f.s,"one",v.expected,v.capture,context,"first verification",later);const before=JSON.stringify(f.s);verifyDraft(f.s,"one",v.expected,v.capture,context,"same captured result",later);assert.equal(JSON.stringify(f.s),before);});
test("live reconciliation preserves draft lineage and excludes subsequent edits",()=>{const f=fixture();observeDraft(f.s,{...f.observation,observationId:randomUUID(),state:"live",liveItemId:"987654321"},now);assert.equal(existingReceipt(f.s.cards.one)?.disposition,"live");assert.equal(f.s.cards.one.input.knownDraft,"123456789012");assert.equal(draftNext(f.s,"one",context,now).action,"excluded-existing-inventory");assert.throws(()=>beginDraftWrite(f.s,"one","writer",f.token,context,now));});

test("completed drafts stay complete across an overnight restart; changes still invalidate them",()=>{
  const f=fixture(),v=verification();verifyDraft(f.s,"one",v.expected,v.capture,context,"saved evidence",later);
  f.s.photoArchives={one:{draftId:v.expected.draftId,captureId:"one",manifestPath:"manifest.json",archiveRoot:"Drafted",status:"moved",files:[]}};
  const tomorrow="2026-10-25T23:00:00.000Z";
  assert.equal(draftNext(structuredClone(f.s),"one",context,tomorrow).action,"draft-complete-awaiting-publication-handoff");
  assert.equal(draftNext(f.s,"one",{approved:true,price:{item:2.49,shipping:0}},tomorrow).action,"reconcile-saved-id");
  assert.equal(draftNext(f.s,"one",{...context,sellerHold:"Seller paused this copy"},tomorrow).action,"seller-hold");
  observeDraft(f.s,{...f.observation,observationId:randomUUID(),state:"absent",observedAt:tomorrow},tomorrow);
  assert.equal(draftNext(f.s,"one",context,tomorrow).action,"reconcile-draft-status");
});

test("a repair intent retains the failed evidence and learns only a verified recovery",()=>{
  const f=fixture(),v=verification();v.capture.issues.errors=["Missing return policy"];
  verifyDraft(f.s,"one",v.expected,v.capture,context,"failed saved audit",later);
  beginDraftWrite(f.s,"one","writer",f.token,context,"2026-10-24T23:00:21.000Z");
  assert.equal(draftNext(f.s,"one",context,later).verificationCurrent,false);
  assert.equal(f.s.draftLearning?.["issues.errors"].verifiedRecoveries,0);
  v.capture.issues.errors=[];v.capture.savedAt="2026-10-24T23:00:22.000Z";v.capture.reopenedAt="2026-10-24T23:00:23.000Z";v.capture.capturedAt="2026-10-24T23:00:24.000Z";v.capture.visual.reviewedAt="2026-10-24T23:00:25.000Z";
  verifyDraft(f.s,"one",v.expected,v.capture,context,"repaired saved audit","2026-10-24T23:00:26.000Z");
  assert.equal(f.s.draftLearning?.["issues.errors"].verifiedRecoveries,1);
  assert.equal(f.s.cards.one.draftLifecycle?.operation,undefined);
});

test("new creation uses review-in-draft authority and still requires scope and fresh four-scope clearance",()=>{
  const context={approved:false,draftAuthorized:true,price:{item:1.49,shipping:0}};
  const f=fixture();delete f.s.cards.one.input.knownDraft;delete f.s.cards.one.draftLifecycle;delete f.s.draftWriter!.lease;
  assert.equal(draftNext(f.s,"one",context,now).canCreate,false);
  assert.throws(()=>configureDraftWriter(f.s,"writer",["one"],"Legacy schedules paused",now,{allowCreate:true}));
  configureDraftWriter(f.s,"writer",["one"],"Legacy schedules paused",now,{allowCreate:true,authority:"Seller explicitly requested the next ten cards through verified drafts"});
  assert.equal(draftNext(f.s,"one",context,now).action,"reconcile-before-create");
  const c=f.s.cards.one;c.jobs.reconcile.state="done";c.jobs.reconcile.result={disposition:"clear",checkedAt:now,scopes:["active","drafts","scheduled","sold"]};c.jobs.listing.state="done";
  assert.equal(draftNext(f.s,"one",{approved:false,price:null},now).canCreate,false);
  assert.equal(draftNext(f.s,"one",context,"2026-10-25T01:00:00.000Z").canCreate,false);
  assert.equal(draftNext(f.s,"one",context,now).canCreate,true);
  const token=claimDraftWriter(f.s,"writer",undefined,now).lease!.token;
  beginDraftWrite(f.s,"one","writer",token,context,now);
  const restarted=structuredClone(f.s);assert.equal(draftNext(restarted,"one",context,later).action,"reconcile-write-outcome");
  assert.equal(draftNext(restarted,"one",context,later).canCreate,false);
  assert.throws(()=>beginDraftWrite(restarted,"one","writer",token,context,later));
  observeDraft(restarted,{...f.observation,observationId:randomUUID(),observedAt:later},later);
  assert.equal(restarted.cards.one.draftLifecycle?.operation?.draftId,undefined);
  assert.equal(restarted.cards.one.draftLifecycle?.draftId,"123456789012");
  assert.equal(draftNext(restarted,"one",context,later).canCreate,false);
});

test("report draft lookup preserves ownership conflicts and seller holds",()=>{
  for(const variant of ["clean","duplicate-photo","receipt-conflict","seller-hold"]){
    const {s}=fixture();
    if(variant==="duplicate-photo"||variant==="receipt-conflict"){
      const other=structuredClone(s.cards.one);other.input.id="two";other.input.sku="capture-two";
      if(variant==="receipt-conflict")other.input.photos=other.input.photos.map((p,i)=>({...p,sha256:(i?"d":"c").repeat(64)}));
      s.cards.two=other;
    }
    for(const card of Object.values(s.cards))refreshJobs(card,now);
    const ctx=variant==="seller-hold"?{...context,sellerHold:"Inspect original condition"}:context;
    const original=structuredClone(s),ordinary=draftNext(s,"one",ctx,now),indexed=draftNext(s,"one",ctx,now,createJobBlockerLookup(s));
    assert.deepEqual(indexed,ordinary,variant);assert.deepEqual(s,original);
    if(variant!=="clean")assert.ok(indexed.blockers.length>0,variant);
  }
});

test("completed scanner identity review resolves its intake note without clearing source holds",()=>{
  const {s}=fixture(),c=s.cards.one;
  delete c.input.knownDraft;delete c.draftLifecycle;delete s.draftWriter!.lease;
  c.input.identityIssue="Pending visual identity review";
  refreshJobs(c,now);
  const pending=draftNext(s,"one",context,now);
  assert.equal(pending.action,"resolve-source-or-ownership");
  const claim=claimJob(s,"reviewer","identity","one",now)!;
  completeJob(s,"one","identity",claim.job.lease!.token,{outcome:"done",data:{identity,pairMatches:true,frontFirst:true,serialInspected:true,evidence:"Both original scanner captures reviewed"}},now);
  configureDraftWriter(s,"writer",["one"],"Legacy listing writers paused",now,{allowCreate:true,authority:"Seller requested this exact scanner capture as a saved draft"});
  c.jobs.reconcile.state="done";c.jobs.reconcile.result={disposition:"clear",checkedAt:now,scopes:["active","drafts","scheduled","sold"]};c.jobs.listing.state="done";
  assert.equal(draftNext(s,"one",context,now).action,"create-draft-for-review");
  assert.equal(c.input.identityIssue,"Pending visual identity review");
  c.input.sourceHold="Source pairing conflict remains";
  assert.equal(draftNext(s,"one",context,now).action,"resolve-source-or-ownership");
  delete c.input.sourceHold;c.jobs.identity.state="todo";
  assert.equal(draftNext(s,"one",context,now).canCreate,false);
});

test("quantity creation is atomic, fenced, restartable and never fabricates receipts",()=>{
 const f=groupFixture();
 const before=structuredClone(f.s);
 assert.throws(()=>beginDraftGroup(f.s,"pair",["one","two"],"writer","wrong",f.contexts,"Reviewed matching original pairs",now));assert.deepEqual(f.s,before);
 f.contexts.two={...context,price:{item:1.95,shipping:0}};
 assert.throws(()=>beginDraftGroup(f.s,"pair",["one","two"],"writer",f.token,f.contexts,"Reviewed matching original pairs",now));assert.deepEqual(f.s,before);
 f.contexts.two=context;
 const intent=beginDraftGroup(f.s,"pair",["one","two"],"writer",f.token,f.contexts,"Reviewed matching original pairs",now);
 assert.equal(intent.quantity,2);assert.equal(intent.photoOrder.length,4);assert.equal(f.s.verifiedReceipts,undefined);
 assert.ok(f.s.cards.one.draftLifecycle?.operation);assert.ok(f.s.cards.two.draftLifecycle?.operation);
 const restarted=structuredClone(f.s);
 assert.throws(()=>beginDraftGroup(restarted,"pair",["one","two"],"writer",f.token,f.contexts,"Never recreate an existing intent",later));
 const observation={draftId:"123456789012",url:"https://www.ebay.com/lstng?draftId=123456789012",observedAt:now,evidence:"Actual browser-generated quantity draft ID"};
 observeDraftGroup(restarted,"pair",observation,"writer",f.token,now);
 assert.equal(restarted.cards.two.input.knownDraft,observation.draftId);assert.equal(validDraftGroup(restarted,observation.draftId,["one","two"]),true);
 assert.equal(restarted.cards.one.input.savedReceipts,undefined);assert.equal(restarted.verifiedReceipts,undefined);
 assert.throws(()=>observeDraftGroup(restarted,"pair",{...observation,draftId:"99"},"writer",f.token,now));
 const v=verification();v.expected.quantity=2;v.capture.ax=v.capture.ax.replace('Quantity, Value: 1','Quantity, Value: 2').replace('2 out of 25','4 out of 25');
 const first={...v.expected,photoLayout:{count:4,frontPosition:1,backPosition:2}};
 const firstCapture={...v.capture,visual:{...v.capture.visual,frontPosition:1,backPosition:2}};
 assert.equal(verifyDraft(restarted,"one",first,firstCapture,context,"First copy saved photo slots",later).allChecksPassed,true);
 const receipt={observationId:randomUUID(),seller:"imaydit58",cardId:"one",sku:"capture-one",frontHash:"a".repeat(64),backHash:"b".repeat(64),identityKey:fingerprint(restarted.cards.one.jobs.identity.result!.identity),draftId:observation.draftId,observedAt:later,photosVerified:true,source:"test snapshot",evidence:"Reviewed original slots"};
 assert.throws(()=>recordVerifiedReceipt(restarted,receipt,later));
 const second={...first,originalHashes:["d".repeat(64),"e".repeat(64)],photoLayout:{count:4,frontPosition:3,backPosition:4}};
 const secondCapture={...v.capture,visual:{...v.capture.visual,originalHashes:second.originalHashes,frontMain:false,backSecond:false,frontPosition:3,backPosition:4}};
 assert.throws(()=>verifyDraft(restarted,"two",{...second,photoLayout:first.photoLayout},secondCapture,context,"Wrong copy photo slots",later));
 assert.equal(verifyDraft(restarted,"two",second,secondCapture,context,"Second copy saved photo slots",later).allChecksPassed,true);
 assert.equal(recordVerifiedReceipt(restarted,receipt,later),true);
 restarted.cards.two.input.photos[0].sha256="f".repeat(64);
 assert.equal(validDraftGroup(restarted,observation.draftId,["one","two"]),false);
 assert.throws(()=>verifyDraft(restarted,"one",first,firstCapture,context,"Changed second capture",later));
});

test("quantity intent refuses held, mismatched, stale or duplicate copies without partial state",()=>{
 for(const change of ["hold","identity","stale","duplicate"]){const f=groupFixture();
  if(change==="hold")f.s.cards.two.input.sourceHold="Pair conflict";
  if(change==="identity")(f.s.cards.two.jobs.identity.result!.identity as Identity).parallel="Refractor";
  if(change==="stale")f.s.cards.two.jobs.reconcile.result!.checkedAt="2026-10-23T00:00:00.000Z";
  if(change==="duplicate")f.s.cards.two.input.photos[0].sha256="a".repeat(64);
  const before=structuredClone(f.s);
  assert.throws(()=>beginDraftGroup(f.s,"pair",["one","two"],"writer",f.token,f.contexts,"Both actual copies reviewed",now));assert.deepEqual(f.s,before);
 }
});

test('issue recovery distinguishes missing audit evidence from observed errors despite stale learning',()=>{
 const f=fixture(),v=verification();
 const missing={...v.capture,issues:undefined};
 verifyDraft(f.s,'one',v.expected,missing,context,'missing audit evidence',later);
 f.s.draftLearning!['issues.errors'].remedy='Inspect and correct saved issues.errors';
 const retained=JSON.stringify(f.s.draftLearning);
 const next=draftNext(f.s,'one',context,later);
 assert.match(next.repairFields.find(x=>x.field==='issues.errors')!.remedy,/missing, not proof/);
 assert.equal(JSON.stringify(f.s.draftLearning),retained);
 v.capture.issues.errors=['Missing return policy'];
 verifyDraft(f.s,'one',v.expected,v.capture,context,'actual error',later);
 assert.match(draftNext(f.s,'one',context,later).repairFields.find(x=>x.field==='issues.errors')!.remedy,/Correct only confirmed/);
});

test('explicit seller request defers pricing without pretending research elapsed',()=>{
 const {s}=fixture();
 const result=deferDraftPricing(s,'one',now,'Seller requested blank drafts for an independent pricing test',now,true);
 assert.equal(result.elapsedMs,0);assert.equal(result.reason,'seller-request');
 assert.equal(s.cards.one.jobs.pricing.state,'todo');
});
test('unpriced quantity groups verify each original slot before receipt ownership is accepted',()=>{
 const f=groupFixture(),blank={approved:false,price:null};
 for(const id of ['one','two'])deferDraftPricing(f.s,id,now,'Seller requested blank-price test drafts',now,true);
 const intent=beginDraftGroup(f.s,'blank-pair',['one','two'],'writer',f.token,{one:blank,two:blank},'Two exact inspected originals; seller requested no price',now);
 assert.equal(intent.price,null);
 observeDraftGroup(f.s,'blank-pair',{draftId:'123456789012',url:'https://www.ebay.com/lstng?draftId=123456789012',observedAt:now,evidence:'Actual observed grouped draft'},'writer',f.token,now);
 const v=verification();v.capture.ax=v.capture.ax.replace('Item price, Value: 1.49','Item price, Value: ').replace('Quantity, Value: 1','Quantity, Value: 2').replace('2 out of 25','4 out of 25');
 const first={...v.capture,visual:{...v.capture.visual,frontPosition:1,backPosition:2}};
 assert.equal(verifyUnpricedDraft(f.s,'one',first,blank,'First original pair saved and reopened',later).photoIdentityVerified,true);
 const second={...v.capture,visual:{...v.capture.visual,originalHashes:['d'.repeat(64),'e'.repeat(64)],frontMain:false,backSecond:false,frontPosition:3,backPosition:4}};
 assert.throws(()=>verifyUnpricedDraft(f.s,'two',{...second,visual:{...second.visual,frontPosition:1,backPosition:2}},blank,'Incorrect original slots',later),/slots/);
 assert.equal(verifyUnpricedDraft(f.s,'two',second,blank,'Second original pair saved and reopened',later).photoIdentityVerified,true);
 assert.equal(recordVerifiedReceipt(f.s,{observationId:randomUUID(),seller:'imaydit58',cardId:'one',sku:'capture-one',frontHash:'a'.repeat(64),backHash:'b'.repeat(64),identityKey:fingerprint(f.s.cards.one.jobs.identity.result!.identity),draftId:'123456789012',observedAt:later,photosVerified:true,source:'test snapshot',evidence:'Both capture slots verified'},later),true);
});

test('representative unpriced group uploads one pair and binds duplicate receipt to it',()=>{const f=groupFixture(),blank={approved:false,price:null};for(const id of ['one','two'])deferDraftPricing(f.s,id,now,'Seller allows one representative pair for duplicates',now,true);const intent=beginDraftGroup(f.s,'representative-pair',['one','two'],'writer',f.token,{one:blank,two:blank},'Seller permits representative photos for identical copies',now,true);assert.equal(intent.photoOrder.length,2);observeDraftGroup(f.s,'representative-pair',{draftId:'123456789012',url:'https://www.ebay.com/lstng?draftId=123456789012',observedAt:now,evidence:'Observed grouped representative draft'},'writer',f.token,now);const v=verification();v.capture.ax=v.capture.ax.replace('Item price, Value: 1.49','Item price, Value: ').replace('Quantity, Value: 1','Quantity, Value: 2');const capture={...v.capture,visual:{...v.capture.visual,frontPosition:1,backPosition:2}};for(const id of ['one','two'])assert.equal(verifyUnpricedDraft(f.s,id,capture,blank,'Representative saved pair and all local originals checked',later).representativePhotoCardId,'one');const receipt={observationId:randomUUID(),seller:'imaydit58',cardId:'two',sku:f.s.cards.two.input.sku,frontHash:'d'.repeat(64),backHash:'e'.repeat(64),identityKey:fingerprint(f.s.cards.two.jobs.identity.result!.identity),draftId:'123456789012',observedAt:later,photosVerified:true,source:'test representative snapshot',evidence:'Duplicate locally inspected and represented in saved quantity'};assert.throws(()=>recordVerifiedReceipt(f.s,receipt,later),/representative/);assert.equal(recordVerifiedReceipt(f.s,{...receipt,representativePhotoCardId:'one'},later),true);});
