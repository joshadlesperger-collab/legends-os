import { CURRENT_CARD_PRICE_POLICY, cardOfferSettings } from "../lib/card-price-policy.ts";
import { calculateCardPrice } from "../lib/card-orchestrator-policy.ts";
import { reviewBinding } from "../lib/card-workflow.ts";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { batchTiming,transitionBatch,batchPacket,batchWorkPlan,type TimedBatch } from "../lib/card-batch.ts";
import { readBatch,saveBatch } from "../lib/card-batch-store.ts";
import { reconcileBacklog,backlogCounts,reconcileScans } from "../lib/card-backlog.ts";
import type { WorkflowSnapshot } from "../lib/card-workflow.ts";
const start="2026-10-23T02:00:00.000Z";
test("floor offers are disabled by both pricing and packets; enabled thresholds remain valid",()=>{
  const floor=calculateCardPrice(1.49);
  assert.equal(floor.item,1.49);
  assert.equal(floor.offersEnabled,false);
  assert.equal(floor.minimumOffer,undefined);
  assert.equal(floor.autoAccept,undefined);
  assert.deepEqual(cardOfferSettings(1.50),{offersEnabled:true,minimumOffer:1.49,autoAccept:1.49});
  assert.deepEqual(cardOfferSettings(2.49),{offersEnabled:true,minimumOffer:2,autoAccept:2.25});
  for(let cents=150;cents<=2500;cents++){
    const p=cardOfferSettings(cents/100);
    assert.ok(p.offersEnabled&&p.minimumOffer!>=1.49&&p.minimumOffer!<=p.autoAccept!&&p.autoAccept!<cents/100);
  }
  for(const item of [NaN,Infinity,1.48,1.491])assert.throws(()=>cardOfferSettings(item));
});
test("stage switching separates work, approval waits, pauses and resumed work",()=>{
  let b:TimedBatch={id:"batch",createdAt:start,cardIds:Array.from({length:10},(_,i)=>String(i)),revision:1,intervals:[]};
  b=transitionBatch(b,"research",start);b=transitionBatch(b,"approval-wait","2026-10-23T02:01:00Z");
  b=transitionBatch(b,null,"2026-10-23T02:03:00Z");b=transitionBatch(b,"research","2026-10-23T02:10:00Z");b=transitionBatch(b,null,"2026-10-23T02:10:30Z");
  assert.equal(batchTiming(b).workSeconds,90);assert.equal(batchTiming(b).approvalWaitSeconds,120);assert.equal(batchTiming(b).workSecondsPerCard,9);
});
test("batch persistence rejects stale updates and another batch identity",async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"batch-time-"));try{
    const b=(await saveBatch({revision:0,cardIds:Array.from({length:10},(_,i)=>String(i))},root))!;
    await saveBatch({revision:b.revision,batchId:b.id,stage:"photos"},root);
    await assert.rejects(saveBatch({revision:b.revision,batchId:b.id,stage:"research"},root));
    const current=(await readBatch(root))!;assert.equal(current.intervals.length,1);
    await assert.rejects(saveBatch({revision:current.revision,batchId:"wrong",stage:null},root));
    await assert.rejects(saveBatch({revision:current.revision,batchId:b.id,finish:true},root));
    const paused=(await saveBatch({revision:current.revision,batchId:b.id,stage:null},root))!;
    await saveBatch({revision:paused.revision,batchId:b.id,finish:true},root);assert.equal(await readBatch(root),null);
    assert.equal(JSON.parse(await fs.readFile(path.join(root,`artifacts/card-batches/${b.id}.json`),"utf8")).id,b.id);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
test("draft packet accepts validated prices for review in draft but refuses holds and publication",()=>{
  const cards=reconcileBacklog([{kind:"identity",source:"test",id:"one",sku:"one",frontHash:"a".repeat(64),backHash:"b".repeat(64),identityStatus:"identified",identity:{player:"Player",sport:"Basketball",set:"Prizm",cardNumber:"1",parallel:"Base",condition:"Near mint or better"},proposal:{item:3.98,shipping:0,source:"test",policy:CURRENT_CARD_PRICE_POLICY,evidenceKey:"e".repeat(64),evidenceExpiresAt:"2099-01-01T00:00:00Z",reviewRequired:true}}],start);
  const s:WorkflowSnapshot={version:2,asOf:start,mode:"read-only-local",cards,counts:backlogCounts(cards),scan:reconcileScans(cards,[]),sources:[],warnings:[],marketplace:{complete:false,absenceMeansUnlisted:false,note:""},workflow:{}};
  const b:TimedBatch={id:"batch",createdAt:start,revision:1,cardIds:[cards[0].id],intervals:[]};
  const unreviewed=batchPacket(b,s);assert.equal(unreviewed.cards[0].priceApproved,false);assert.equal(unreviewed.cards[0].priceReviewStage,"ebay-draft");
  s.workflow[cards[0].id]={token:"test",approvedBinding:reviewBinding(cards[0]),approvedAt:start,history:[]};
  const packet=batchPacket(b,s);assert.equal(packet.canPublish,false);assert.equal(packet.canUpload,false);assert.equal(packet.cards[0].minimumOffer,3.19);assert.equal(packet.cards[0].autoAccept,3.59);
  s.workflow[cards[0].id].holdReason="Seller hold";assert.throws(()=>batchPacket(b,s));
});

test("service waits are separate from work, and recovery/archive are timed",()=>{
 let b:TimedBatch={id:"b",createdAt:start,revision:1,cardIds:["one"],intervals:[]};
 b=transitionBatch(b,"service-wait",start);b=transitionBatch(b,"recovery","2026-10-23T02:01:00Z");
 b=transitionBatch(b,"archive","2026-10-23T02:01:10Z");b=transitionBatch(b,null,"2026-10-23T02:01:20Z");
 const timing=batchTiming(b,Date.parse("2026-10-23T02:01:20Z"));
 assert.equal(timing.serviceWaitSeconds,60);assert.equal(timing.workSeconds,20);assert.equal(timing.elapsedSeconds,80);
});
test("ready plan retains blocked capture instead of blocking independent approved work",()=>{
 const cards=reconcileBacklog([{kind:"identity",source:"test",id:"one",sku:"one",frontHash:"a".repeat(64),backHash:"b".repeat(64),identityStatus:"identified",identity:{player:"Player",sport:"Basketball",set:"Prizm",cardNumber:"1",parallel:"Base",condition:"Near mint or better"},proposal:{item:3.98,shipping:0,source:"test",policy:CURRENT_CARD_PRICE_POLICY,evidenceKey:"e".repeat(64),evidenceExpiresAt:"2099-01-01T00:00:00Z",reviewRequired:true}}],start);
 const s:WorkflowSnapshot={version:2,asOf:start,mode:"read-only-local",cards,counts:backlogCounts(cards),scan:reconcileScans(cards,[]),sources:[],warnings:[],marketplace:{complete:false,absenceMeansUnlisted:false,note:""},workflow:{}};
 s.workflow[cards[0].id]={token:"test",approvedBinding:reviewBinding(cards[0]),approvedAt:start,history:[]};
 const b:TimedBatch={id:"batch",createdAt:start,revision:1,cardIds:[cards[0].id,"missing"],intervals:[]};
 const plan=batchWorkPlan(b,s);assert.deepEqual(plan.readyIds,[cards[0].id]);assert.equal(plan.exceptions.length,1);assert.equal(plan.canPublish,false);
 s.workflow[cards[0].id].holdReason="Seller hold";assert.equal(batchWorkPlan(b,s).readyIds.length,0);
});
