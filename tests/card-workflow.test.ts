import { CURRENT_CARD_PRICE_POLICY } from "../lib/card-price-policy.ts";
import { reviewBinding } from "../lib/card-workflow.ts";
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash,randomUUID } from "node:crypto";
import { backlogCounts,reconcileBacklog,reconcileScans,type BacklogSnapshot } from "../lib/card-backlog.ts";
import { approvedAskingPrice,canApprovePrice,canSetManualPrice,nextWork,orderedWork,selectableWork,workLane,workflowStage,workflowOverview,stageWork,stageHolds,workAttention,workHandoff,type ReviewAction } from "../lib/card-workflow.ts";
import { readReviews,saveReview,saveReviews,withWorkflow } from "../lib/card-workflow-store.ts";
import { readCardPhoto } from "../lib/card-backlog-photo.ts";
import {blockerCause,blockerPareto,blockerRccaCsv} from "../lib/card-blocker-causes.ts";
const now=new Date().toISOString(),hash=(n:number)=>n.toString(16).padStart(64,"0");
function snapshot():BacklogSnapshot {
  const cards=reconcileBacklog([{kind:"identity",source:"identity",id:"one",sku:"sku",frontHash:hash(1),backHash:hash(2),identityStatus:"identified",identity:{player:"Player",set:"Set",condition:"Excellent"},proposal:{item:3.44,shipping:0,policy:CURRENT_CARD_PRICE_POLICY,evidenceKey:"e".repeat(64),evidenceExpiresAt:"2099-01-01T00:00:00Z",updatedAt:now,source:"pricing",reviewRequired:true}}],now);
  return {version:2,asOf:now,mode:"read-only-local",cards,counts:backlogCounts(cards),scan:reconcileScans(cards,[]),sources:[],warnings:[],marketplace:{complete:false,absenceMeansUnlisted:false,note:"Incomplete"}};
}
async function fixture(fn:(root:string,s:BacklogSnapshot)=>Promise<void>) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"card-workflow-"));try{await fn(root,snapshot());}finally{await fs.rm(root,{recursive:true,force:true});}
}
test("queue groups matching players and variants without merging physical captures",()=>{
  const s=snapshot(),base=s.cards[0];
  s.cards=[{...base,id:"b",title:"2025 Set Zebra",identity:{player:"Zebra",set:"Set",season:"2025"}},
    {...base,id:"a2",title:"2025 Set Alpha 2/99",identity:{player:"Alpha",set:"Set",season:"2025",serial:"2/99"}},
    {...base,id:"a1",title:"2024 Set Alpha 1/99",identity:{player:"Alpha",set:"Set",season:"2024",serial:"1/99"}}];
  assert.deepEqual(orderedWork({...s,workflow:{}}).map(c=>c.id),["a1","a2","b"]);
  assert.equal(s.cards.length,3);
});
async function command(root:string,s:BacklogSnapshot,action:ReviewAction,note="") {
  const view=await withWorkflow(s,root),card=s.cards[0];
  return {requestId:randomUUID(),cardId:card.id,token:view.workflow[card.id].token,action,note};
}
test("price approval persists and advances only the asking-price step",()=>fixture(async(root,s)=>{
  const original=JSON.stringify(s),c=s.cards[0];assert.equal(workLane(c),"listing-checks");
  await saveReview(await command(root,s,"approve-price"),async()=>s,root);
  const reloaded=await withWorkflow(s,root);assert.ok(reloaded.workflow[c.id].approvedAt);assert.equal(workLane(c,reloaded.workflow[c.id]),"listing-checks");
  assert.equal(JSON.stringify(s),original);assert.equal(c.receipts.length,0);assert.equal(c.approvedPrice,null);
}));
test("manual price moves an unpriced card to listing review and preserves exact cents and blockers",()=>fixture(async(root,s)=>{
  const c=s.cards[0];c.proposal=null;c.holds=["pricing: No usable sold evidence","reconcile: Fresh inventory clearance required"];
  const before=JSON.stringify(s),decision={...await command(root,s,"set-price"),price:{item:7.77,shipping:1.49}};
  const view=await saveReview(decision,async()=>s,root),review=view.workflow[c.id];
  assert.equal(approvedAskingPrice(c,review)?.item,7.77);assert.equal(workflowStage(c,review),"listing");
  assert.equal(workflowOverview(view).buckets.price.total,0);assert.equal(workflowOverview(view).buckets.listing.blocked,1);
  assert.equal(workflowOverview(view).milestones.priced,1);assert.equal(JSON.stringify(s),before);
  assert.match(workHandoff(c,review),/seller-entered manual asking price: 7.77/);
  assert.equal((await withWorkflow(s,root)).workflow[c.id].manualPrice?.shipping,1.49);
  c.holds=["pricing: No usable sold evidence"];
  const refreshed=await withWorkflow(s,root);
  assert.equal(workAttention(c,refreshed.workflow[c.id]),"review");
  assert.equal(blockerCause(c,refreshed.workflow[c.id]),null);
}));
test("manual overrides survive research refreshes but invalidate when the physical identity changes",()=>fixture(async(root,s)=>{
  const c=s.cards[0];c.approvedPrice={...c.proposal!,item:4.95};
  await saveReview({...await command(root,s,"set-price"),price:{item:8.88,shipping:0}},async()=>s,root);
  c.proposal={...c.proposal!,item:20.95};c.approvedPrice={...c.approvedPrice!,item:22.49};c.holds=["New research arrived"];
  assert.equal(approvedAskingPrice(c,(await withWorkflow(s,root)).workflow[c.id])?.item,8.88);
  c.identity.serial="2/99";
  assert.equal((await withWorkflow(s,root)).workflow[c.id].manualPrice,undefined);
  assert.equal((await readReviews(root)).events.length,1);
}));

test("approved manual amounts remain auditable after live adoption without permitting live edits",()=>fixture(async(root,s)=>{
  const c=s.cards[0];
  await saveReview({...await command(root,s,"set-price"),price:{item:1.49,shipping:0}},async()=>s,root);
  c.receipts=[{id:'999',disposition:'live',source:'Verified receipt'}];
  assert.equal((await withWorkflow(s,root)).workflow[c.id].manualPrice?.item,1.49);
  assert.equal(canSetManualPrice(c),false);
  await assert.rejects(saveReview({...await command(root,s,'set-price'),price:{item:2,shipping:0}},async()=>s,root),/Existing live/);
  c.identity.serial='1/99';
  assert.equal((await withWorkflow(s,root)).workflow[c.id].manualPrice,undefined);
}));

test("manual prices resolve unlabeled pricing-source holds while preserving other requirements",()=>fixture(async(root,s)=>{
  const pricingHold="No sufficient sold evidence; offer-enabled results excluded",inventoryHold="reconcile: Refresh inventory clearance";
  s.cards=reconcileBacklog([
    {kind:"identity",source:"identity",frontHash:hash(1),backHash:hash(2),identityStatus:"identified",identity:{player:"Player"},holds:[inventoryHold]},
    {kind:"pricing",source:"old-pricing-queue",frontHash:hash(1),backHash:hash(2),holds:[pricingHold]},
  ],now);
  const c=s.cards[0],view=await saveReview({...await command(root,s,"set-price"),price:{item:7.77,shipping:1.49}},async()=>s,root),review=view.workflow[c.id];
  assert.deepEqual(c.pricingHolds,[pricingHold]);assert.ok(c.holds.includes(pricingHold));
  assert.match(workHandoff(c,review),/Refresh inventory clearance/);assert.doesNotMatch(workHandoff(c,review),/offer-enabled/);
  assert.equal(workAttention(c,review),"blocked");
  c.holds=[pricingHold];assert.equal(workAttention(c,review),"review");assert.equal(blockerCause(c,review),null);
}));
test("manual saves are idempotent and require valid amounts and a reviewed original pair",()=>fixture(async(root,s)=>{
  const decision={...await command(root,s,"set-price"),price:{item:2.22,shipping:0}};
  for(const price of [{item:0,shipping:0},{item:-1,shipping:0},{item:1.001,shipping:0},{item:NaN,shipping:0},{item:1,shipping:-1},{item:1,shipping:0.001}])await assert.rejects(saveReview({...decision,price},async()=>s,root),/at least \$1\.49/);
  await saveReview(decision,async()=>s,root);await saveReview({...decision,price:{shipping:0,item:2.22}},async()=>s,root);
  assert.equal((await readReviews(root)).events.length,1);
  await assert.rejects(saveReview({...decision,price:{item:3.33,shipping:0}},async()=>s,root),/another decision/);
  for(const patch of [{identityStatus:"unknown"},{backHashes:[]},{receipts:[{id:"1",disposition:"live",source:"receipt"}]}])assert.equal(canSetManualPrice({...s.cards[0],...patch} as typeof s.cards[0]),false);
  const changed=structuredClone(s);changed.cards[0].backHashes=[hash(9)];
  await assert.rejects(saveReview({...decision,requestId:randomUUID()},async()=>changed,root),/changed/);
}));
test("stale source changes reject approval and invalidate a saved local decision",()=>fixture(async(root,s)=>{
  const decision=await command(root,s,"approve-price"),changed=structuredClone(s);changed.cards[0].proposal!.item=4.49;
  await assert.rejects(saveReview(decision,async()=>changed,root),/changed/);
  await saveReview(decision,async()=>s,root);
  const reloaded=await withWorkflow(changed,root);assert.equal(reloaded.workflow[s.cards[0].id].approvedAt,undefined);assert.equal(reloaded.workflow[s.cards[0].id].history.length,1);
}));
test("retrying one save request is idempotent and cannot change its decision",()=>fixture(async(root,s)=>{
  const decision=await command(root,s,"approve-price");await saveReview(decision,async()=>s,root);
  // JSON key order on a network retry does not change the request identity.
  const reordered=Object.fromEntries(Object.entries(decision).reverse()) as typeof decision;
  await saveReview(reordered,async()=>s,root);assert.equal((await readReviews(root)).events.length,1);
  await assert.rejects(saveReview({...decision,action:"hold",note:"Changed"},async()=>s,root),/another decision/);
}));
test("hold and resume preserve approval while notes do not complete work",()=>fixture(async(root,s)=>{
  const id=s.cards[0].id;await saveReview(await command(root,s,"approve-price"),async()=>s,root);
  const held=await saveReview(await command(root,s,"hold","Need shipping eligibility"),async()=>s,root);assert.equal(workLane(s.cards[0],held.workflow[id]),"blocked");
  const note=await saveReview(await command(root,s,"note","Keep Excellent condition"),async()=>s,root);assert.equal(workLane(s.cards[0],note.workflow[id]),"blocked");
  const resumed=await saveReview(await command(root,s,"resume"),async()=>s,root);assert.equal(workLane(s.cards[0],resumed.workflow[id]),"listing-checks");assert.equal(resumed.cards[0].identity.condition,"Excellent");
}));
test("held cards and existing listings never become the next actionable card",()=>fixture(async(root,s)=>{
  const c=s.cards[0];c.receipts=[{id:"123",disposition:"live",source:"receipt"}];
  let view=await withWorkflow(s,root);assert.equal(workLane(c),"listed");assert.equal(nextWork(view),undefined);assert.equal(canApprovePrice(c),false);
  c.receipts=[];view=await saveReview(await command(root,s,"hold","Needs correction"),async()=>s,root);assert.equal(nextWork(view),undefined);
}));

test("seller holds survive changed source evidence until a current explicit resume",()=>fixture(async(root,s)=>{
  const card=s.cards[0];
  await saveReview(await command(root,s,"approve-price"),async()=>s,root);
  await saveReview(await command(root,s,"hold","Inspect packaging"),async()=>s,root);
  const staleResume=await command(root,s,"resume");
  card.proposal={...card.proposal!,item:9.95};card.holds=["reconcile: Refreshed inventory requirement"];
  card.identity.serial="2/99";card.backHashes=[hash(3)];
  let view=await withWorkflow(s,root);
  assert.equal(view.workflow[card.id].holdReason,"Inspect packaging");
  assert.equal(view.workflow[card.id].approvedAt,undefined);assert.equal(nextWork(view),undefined);
  await assert.rejects(saveReview(staleResume,async()=>s,root),/changed/);
  await saveReview(await command(root,s,"note","Updated evidence"),async()=>s,root);
  assert.equal((await withWorkflow(s,root)).workflow[card.id].holdReason,"Inspect packaging");
  await saveReview(await command(root,s,"resume"),async()=>s,root);
  card.proposal={...card.proposal!,item:8.49};
  view=await withWorkflow(s,root);assert.equal(view.workflow[card.id].holdReason,undefined);
  assert.equal(view.workflow[card.id].history.filter(e=>e.action==="hold").length,1);
}));

test("default progression skips source-blocked cards while explicit blocker review remains available",()=>{
  const s=snapshot(),base=s.cards[0];
  const blocked={...structuredClone(base),id:"blocked",override:base.proposal,approvedPrice:base.proposal,receipts:[{id:"123",disposition:"draft" as const,source:"fixture"}],holds:["reconcile: Inventory unavailable"]};
  const ready={...structuredClone(base),id:"ready"};
  const research={...structuredClone(base),id:"research",proposal:null,holds:["pricing: No usable sold evidence"]};
  const view={...s,cards:[blocked,research,ready],workflow:{}};
  assert.equal(workAttention(blocked),"blocked");assert.equal(workAttention(research),"blocked");
  assert.equal(nextWork(view)?.id,"ready");assert.equal(nextWork(view,["ready"]),undefined);
  assert.equal(selectableWork(blocked),false);assert.equal(selectableWork(blocked,undefined,"blocked"),true);
  assert.deepEqual(stageWork(view,"listing","blocked").map(c=>c.id),["blocked"]);
  assert.equal(workflowOverview(view).buckets.listing.blocked,1);
});

function identityWorkCard() {
  const gap="Exact parallel and release year unresolved",pricing="Independent sold evidence required";
  return reconcileBacklog([
    {kind:"identity",source:"identity",frontHash:hash(1),backHash:hash(2),identity:{player:"Player"},identityStatus:"needs-review",
      holds:[gap],identityRequirements:[gap],identityInputKey:"current-source"},
    {kind:"pricing",source:"pricing",frontHash:hash(1),backHash:hash(2),holds:[pricing]},
  ],now)[0];
}
test("typed identity work is selectable without losing source gaps or approving downstream work",()=>{
  const s=snapshot(),card=identityWorkCard();s.cards=[card];
  assert.equal(workflowStage(card),"identify");assert.equal(workAttention(card),"work");
  assert.equal(nextWork({...s,workflow:{}})?.id,card.id);assert.equal(blockerCause(card),null);
  assert.deepEqual(stageHolds(card),[]);assert.equal(canApprovePrice(card),false);assert.equal(canSetManualPrice(card),false);
  assert.equal(card.holds.length,2);for(const reason of card.holds)assert.ok(workHandoff(card).includes(`Open requirement: ${reason}`));
  for(const patch of [{issues:["One original front has conflicting back hashes"]},{backHashes:[]},{backHashes:[hash(2),hash(3)]},
    {physicalUnits:0,frontHash:null},{issues:["Original front/back files are missing or unavailable"]},
    {holds:[...card.holds,"identity: Worker could not resolve this pair"]},{holds:[...card.holds,"Unclassified source hold"]}]) {
    const blocked={...card,...patch};assert.equal(workAttention(blocked),"blocked");assert.equal(selectableWork(blocked),false);
  }
});
test("identity requirement refresh never resumes a persistent seller hold",()=>fixture(async(root,s)=>{
  s.cards=[identityWorkCard()];const card=s.cards[0];
  await saveReview(await command(root,s,"hold","Wait for seller inspection"),async()=>s,root);
  card.identityRequirements![0].resolved=true;card.identityStatus="identified";
  let view=await withWorkflow(s,root);assert.equal(view.workflow[card.id].holdReason,"Wait for seller inspection");
  assert.equal(nextWork(view),undefined);assert.equal(workAttention(card,view.workflow[card.id]),"blocked");
  // A later source gap still cannot release the seller's hold.
  card.identityRequirements![0].resolved=false;card.identityStatus="needs-review";
  view=await withWorkflow(s,root);assert.equal(nextWork(view),undefined);
  view=await saveReview(await command(root,s,"resume"),async()=>s,root);
  assert.equal(nextWork(view)?.id,card.id);assert.equal(workAttention(card,view.workflow[card.id]),"work");
}));
test("approvals require known identity, an exact pair, valid source date and shipping",()=>{
  const original=snapshot().cards[0];assert.equal(canApprovePrice(original),true);
  for(const update of [{identityStatus:"unknown"},{backHashes:[]},{issues:["Conflicting serial"]},{proposal:{...original.proposal,shipping:null}},{proposal:{...original.proposal,updatedAt:"invalid"}},{proposal:{...original.proposal,updatedAt:"2000-01-01"}},{override:{...original.proposal,item:9.95}}])assert.equal(canApprovePrice({...original,...update} as typeof original),false);
});
test("source overrides and saved approvals route past price review",()=>{
  const c=snapshot().cards[0];c.approvedPrice={...c.proposal!,item:9.95,reviewRequired:false};c.override=c.approvedPrice;
  assert.equal(workLane(c),"listing-checks");assert.equal(canApprovePrice(c),false);
});
test("concurrent saves honor the review lock instead of losing decisions",()=>fixture(async(root,s)=>{
  const decision=await command(root,s,"note","First review");
  let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);
  const first=saveReview(decision,async()=>{entered();await gate;return s;},root);await started;
  await assert.rejects(saveReview({...decision,requestId:randomUUID()},async()=>s,root),/Another review/);release();await first;assert.equal((await readReviews(root)).events.length,1);
}));
test("corrupt review history is retained and blocks writes",()=>fixture(async(root,s)=>{
  const decision=await command(root,s,"note","New review"),dir=path.join(root,"artifacts/card-backlog");await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,"reviews.json"),"invalid");
  await assert.rejects(saveReview(decision,async()=>s,root));assert.equal(await fs.readFile(path.join(dir,"reviews.json"),"utf8"),"invalid");
}));
test("photo endpoint resolver only returns matching bytes inside the inbox",()=>fixture(async(root,s)=>{
  const inbox=path.join(root,"inbox");await fs.mkdir(inbox);const bytes=Buffer.from("retained original"),inside=path.join(inbox,"front.jpg"),outside=path.join(root,"outside.jpg");
  await fs.writeFile(inside,bytes);await fs.writeFile(outside,bytes);const c=s.cards[0];c.frontHash=createHash("sha256").update(bytes).digest("hex");c.originalPaths=[outside];
  assert.equal(await readCardPhoto(c,"front",inbox),null);c.inboxPaths=[inside];assert.deepEqual((await readCardPhoto(c,"front",inbox))?.bytes,bytes);
  await fs.writeFile(inside,"changed bytes");assert.equal(await readCardPhoto(c,"front",inbox),null);
}));

test("pipeline milestones count captures, while stage and status buckets partition all work",()=>fixture(async(root,s)=>{
  const base=s.cards[0];
  s.cards=Array.from({length:8},(_,i)=>({...structuredClone(base),id:`card-${i}`,frontHash:hash(i+10)}));
  for(const i of [0,1]){s.cards[i].identityStatus="unknown";s.cards[i].proposal=null;}
  s.cards[1].holds=["Identity source is incomplete"];
  s.cards[2].proposal=null;
  s.cards[4].approvedPrice=base.proposal;s.cards[4].override=base.proposal;
  s.cards[5].receipts=[{id:"live-1",disposition:"live",source:"saved"}];s.cards[5].issues=["Receipt mapping needs review"];
  s.cards[6].receipts=[{id:"scheduled-1",disposition:"scheduled",source:"saved"}];
  s.cards[7].physicalUnits=0;s.cards[7].frontHash=null;
  const view=await withWorkflow(s,root),overview=workflowOverview(view);
  assert.deepEqual(overview.milestones,{scanned:7,identified:5,priced:4,listed:1});
  assert.deepEqual(Object.values(overview.buckets).map(b=>b.total),[2,1,2,2,1]);
  assert.equal(overview.remaining,5);
  for(const [stage,bucket] of Object.entries(overview.buckets)){
    assert.equal(bucket.total,bucket.review+bucket.work+bucket.blocked+bucket.recorded);
    assert.equal(stageWork(view,stage as ReturnType<typeof workflowStage>).length,bucket.total);
  }
  assert.equal(workAttention(s.cards[1]),"blocked");assert.equal(workAttention(s.cards[2]),"work");
  assert.equal(workAttention(s.cards[3]),"review");assert.equal(workAttention(s.cards[6]),"recorded");
  assert.equal(stageWork(view,"listed","blocked")[0].id,"card-5");
}));

test("holding a card keeps it in its stage and approval moves it without inflating milestones",()=>fixture(async(root,s)=>{
  let view=await saveReview(await command(root,s,"hold","Check shipping"),async()=>s,root);
  assert.equal(workflowStage(s.cards[0],view.workflow[s.cards[0].id]),"price");
  assert.equal(workflowOverview(view).buckets.price.blocked,1);
  await saveReview(await command(root,s,"resume"),async()=>s,root);
  const before=workflowOverview(await withWorkflow(s,root)).milestones;
  view=await saveReview(await command(root,s,"approve-price"),async()=>s,root);
  assert.equal(workflowOverview(view).buckets.listing.review,1);
  assert.deepEqual(workflowOverview(view).milestones,before);
}));

test("cause coding distinguishes identity gaps, source evidence and local system failures without changing evidence",()=>{
  const c=snapshot().cards[0];c.proposal=null;
  c.holds=["identity: Original inspected but full serial numerator is uncertain"];
  assert.equal(blockerCause(c)?.primary,"ID02");
  c.holds=["pricing: Saved sold source serial and independence are unverified"];
  assert.equal(blockerCause(c)?.primary,"PR02");
  c.holds=["reconcile: SellerHub unavailable. Continue independent photo and pricing review."];
  assert.equal(blockerCause(c),null);
  assert.equal(workAttention(c),"work");
  c.approvedPrice={item:3.44,shipping:0,source:"verified",reviewRequired:false};c.override=c.approvedPrice;
  assert.equal(blockerCause(c)?.primary,"INV01");
  c.approvedPrice=null;c.override=null;
  c.holds=["photos: EPERM operation not permitted, rename state.tmp"];
  const original=JSON.stringify(c);assert.equal(blockerCause(c)?.primary,"SYS01");assert.equal(JSON.stringify(c),original);
  c.holds=["A newly discovered dependency has stopped this job"];
  assert.equal(blockerCause(c)?.primary,"OTHER01");
});

test("Pareto assigns one primary cause per blocked capture while retaining secondary causes",()=>{
  const s=snapshot(),c=s.cards[0];c.proposal=null;c.holds=["No usable sold evidence","reconcile: Inventory clearance unavailable"];
  s.cards.push({...structuredClone(c),id:"two",holds:["No supported matching sale"]});
  s.cards.push({...structuredClone(c),id:"three",holds:[]});
  const view={...s,workflow:{}},summary=blockerPareto(s.cards,view.workflow);
  assert.equal(summary.total,2);assert.equal(summary.rows.reduce((n,r)=>n+r.count,0),2);
  assert.equal(summary.rows[summary.rows.length-1].cumulative,1);
  assert.deepEqual(blockerCause(c)?.codes,["PR01"]);
  const csv=blockerRccaCsv(s.cards,view);assert.match(csv,/Confirmed root cause/);assert.match(csv,/Preventive action/);assert.match(csv,/No usable sold evidence/);
  assert.ok(c.holds.includes("reconcile: Inventory clearance unavailable"));
  assert.equal(blockerCause(s.cards[2]),null);
});

test("RCCA export preserves quoted reasons and prevents spreadsheet formula execution",()=>{
  const s=snapshot(),c=s.cards[0];c.title='=HYPERLINK("external")';c.proposal=null;c.holds=['Unknown "new" blocker\nSecond line'];
  const csv=blockerRccaCsv(s.cards,{...s,workflow:{}});
  assert.ok(csv.includes('"\'=HYPERLINK(""external"")"'));assert.ok(csv.includes('Unknown ""new"" blocker\nSecond line'));
});

test("pricing comparable fetch failures do not become missing inventory originals",()=>{
  const c=snapshot().cards[0];c.proposal=null;
  c.holds=["pricing: No usable sold comp; original fetch unavailable; back rotation pending"];
  assert.equal(blockerCause(c)?.primary,"PR01");
  c.holds=["photos: Original front/back files are missing or unavailable in the inbox"];
  assert.equal(blockerCause(c)?.primary,"PHOTO01");
  c.holds=["pricing: Original front/back pair is missing or ambiguous"];
  assert.equal(blockerCause(c)?.primary,"PHOTO01");
});

test("batch approvals are atomic on stale evidence and idempotent on retry",()=>fixture(async(root,s)=>{
 const first=await command(root,s,"approve-price");
 await assert.rejects(saveReviews([first,{...first,requestId:randomUUID(),cardId:"missing"}],async()=>s,root));
 assert.equal((await readReviews(root)).events.length,0);
 let reads=0;await saveReviews([first],async()=>{reads++;return s;},root);
 assert.equal(reads,1);await saveReviews([first],async()=>s,root);
 assert.equal((await readReviews(root)).events.length,1);
}));
