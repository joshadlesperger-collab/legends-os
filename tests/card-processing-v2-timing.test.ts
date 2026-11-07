import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { measureV2, recoverV2Timings, withV2TimingContext } from "../lib/card-processing-v2-timing.ts";
import { summarizeV2Timings } from "../lib/card-processing-v2-timing-summary.ts";
import { readV2State, withV2State } from "../lib/card-processing-v2-store.ts";
import type { V2Timing } from "../lib/card-processing-v2.ts";
const at=(seconds:number)=>new Date(Date.UTC(2026,10,3,0,0,seconds)).toISOString();
function span(id:string,start:number,end:number,extra:Partial<V2Timing>={}):V2Timing{return {id,step:"identify",cardId:"card",pid:1,startedAt:at(start),endedAt:at(end),durationMs:(end-start)*1000,status:"completed",...extra};}
test("summary unions overlapping work and clips its window without inventing historic activity",()=>{
  const result=summarizeV2Timings([span("a",1,5),span("b",3,8),span("c",9,12),span("foreign",0,10,{cardId:"other"})],{cardId:"card",createdAt:at(0),now:at(10)});
  assert.equal(result.elapsedMs,10000);assert.equal(result.measuredActiveMs,8000);assert.equal(result.unmeasuredOrWaitingMs,2000);assert.equal(result.steps.identify.totalMs,12000);assert.equal(result.coverage,"partial");
  assert.deepEqual(summarizeV2Timings([],{createdAt:at(0),now:at(10)}).coverage,"unmeasured");
});
test("failed spans count actual time while running/interrupted spans remain unknown",()=>{
  const result=summarizeV2Timings([span("failed",1,3,{status:"failed"}),span("live",3,8,{status:"running",durationMs:undefined,endedAt:undefined}),span("dead",3,9,{status:"interrupted",durationMs:undefined})],{createdAt:at(0),now:at(10)});
  assert.equal(result.measuredActiveMs,2000);assert.equal(result.running,1);assert.equal(result.interrupted,1);assert.equal(result.steps.identify.failed,1);
});
test("measurement starts durably before work, retains success/failure and does not swallow errors",async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"v2-timing-"));try{
    const value=await measureV2(root,"photo-host",async()=>{const state=await readV2State(root);assert.equal(state.timings[0].status,"running");return 42;},{cardId:"card",runId:"run"});assert.equal(value,42);
    await assert.rejects(measureV2(root,"identify",()=>{throw Error("secret provider text");}),/secret provider text/);const state=await readV2State(root);assert.equal(state.timings[0].status,"completed");assert.equal(state.timings[1].status,"failed");assert.ok(state.timings.every(t=>t.durationMs!==undefined&&t.durationMs>=0));assert.ok(!JSON.stringify(state).includes("secret provider text"));
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
test("recovery marks only dead processes interrupted without guessing duration",async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"v2-timing-"));try{
    await withV2State(s=>{s.timings.push(span("dead",0,1,{pid:2147483647,status:"running",endedAt:undefined,durationMs:undefined}),span("live",0,1,{pid:process.pid,status:"running",endedAt:undefined,durationMs:undefined}));},root);
    assert.equal(await recoverV2Timings(root),1);const state=await readV2State(root);assert.equal(state.timings[0].status,"interrupted");assert.equal(state.timings[0].durationMs,undefined);assert.equal(state.timings[1].status,"running");assert.equal(await recoverV2Timings(root),0);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
test("nested operations inherit async context with explicit overrides and shared membership",async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"v2-timing-"));try{
    await withV2TimingContext({runId:"run",cardId:"outer"},()=>measureV2(root,"outer",async()=>{await measureV2(root,"inner",()=>42,{cardId:"inner"});await measureV2(root,"shared",()=>42,{cardIds:["a","b"]});}));
    const spans=(await readV2State(root)).timings;assert.ok(spans.every(s=>s.runId==="run"));assert.equal(spans[1].cardId,"inner");assert.deepEqual(spans[2].cardIds,["a","b"]);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test("scoped dead-timer recovery leaves unrelated history and live timers untouched",async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"v2-timing-scope-"));try{
  await withV2State(s=>{s.timings.push(...["selected","historical"].map(runId=>span(runId,0,1,{runId,pid:2147483647,status:"running",endedAt:undefined,durationMs:undefined})));},root);
  assert.equal(await recoverV2Timings(root,{runId:"selected",pid:2147483647}),1);
  const rows=(await readV2State(root)).timings;assert.equal(rows.find(t=>t.runId==="selected")?.status,"interrupted");assert.equal(rows.find(t=>t.runId==="selected")?.durationMs,undefined);assert.equal(rows.find(t=>t.runId==="historical")?.status,"running");
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test("step totals ignore unrelated time windows and shared durations are explicit without division",()=>{
  const result=summarizeV2Timings([span("before",0,1),span("after",12,14),span("shared",4,6,{cardId:undefined,cardIds:["card","other"]})],{cardId:"card",createdAt:at(3),now:at(10)});
  assert.equal(result.steps.identify.count,1);assert.equal(result.steps.identify.totalMs,2000);assert.equal(result.shared,1);assert.equal(result.measuredActiveMs,2000);
});
test("nested browser processing waits are distinct from work and overlapping intervals count once",()=>{
  const result=summarizeV2Timings([span("wait",1,9,{step:"browser-processing-wait",source:"external-browser-wall-clock"}),span("nestedwait",2,8,{step:"browser-processing-wait",source:"external-browser-wall-clock"}),span("edit",3,5,{step:"browser-draft-edit",source:"external-browser-wall-clock"}),span("local",4,6,{step:"draft-import-receipt"})],{cardId:"card",createdAt:at(0),now:at(10)});
  assert.equal(result.measuredCoveredMs,8000);assert.equal(result.measuredWorkMs,3000);assert.equal(result.measuredWaitingMs,5000);assert.equal(result.measuredActiveMs,3000);assert.equal(result.measuredBrowserMs,8000);assert.equal(result.unmeasuredOrWaitingMs,2000);assert.equal(result.measuredWorkMs+result.measuredWaitingMs,result.measuredCoveredMs);
  const interrupted=summarizeV2Timings([span("unknown",1,9,{step:"browser-processing-wait",status:"interrupted",durationMs:undefined})],{createdAt:at(0),now:at(10)});assert.equal(interrupted.measuredWaitingMs,0);assert.equal(interrupted.coverage,"unmeasured");
});

test('orchestration parents cannot hide photo pacing waits or inflate measured coverage',()=>{
  const result=summarizeV2Timings([span('parent',0,10,{step:'draft-preparation'}),span('wait',1,5,{step:'photo-upload-pacing-wait'}),span('upload',5,8,{step:'photo-upload'})],{createdAt:at(0),now:at(10)});
  assert.equal(result.measuredWorkMs,3000);assert.equal(result.measuredWaitingMs,4000);
  assert.equal(result.measuredCoveredMs,7000);assert.equal(result.unmeasuredOrWaitingMs,3000);
  assert.equal(result.orchestrationEnvelopeMs,10000);assert.equal(result.steps['draft-preparation'].totalMs,10000);
});

test('seller handoff and explicit agent gaps partition elapsed without attributing historical silence',()=>{
 const result=summarizeV2Timings([span('seller',1,7,{step:'browser-seller-review-wait'}),span('agent',6,9,{step:'browser-agent-gap'}),span('service',2,4,{step:'browser-processing-wait'}),span('work',3,5,{step:'photo-upload'})],{createdAt:at(0),now:at(10)});
 assert.equal(result.measuredWorkMs,2000);assert.equal(result.measuredWaitingMs,1000);assert.equal(result.measuredSellerReviewMs,3000);assert.equal(result.measuredAgentGapMs,2000);assert.equal(result.unmeasuredOrWaitingMs,2000);
 assert.equal(result.measuredWorkMs+result.measuredWaitingMs+result.measuredSellerReviewMs+result.measuredAgentGapMs+result.unmeasuredOrWaitingMs,result.elapsedMs);
 const historical=summarizeV2Timings([],{createdAt:at(0),now:at(10)});assert.equal(historical.measuredSellerReviewMs,0);assert.equal(historical.measuredAgentGapMs,0);assert.equal(historical.unmeasuredOrWaitingMs,10000);
});

test('failed browser stall is recovery wall time while successful overlapping work stays exclusive',()=>{
 const spans=[span('stall',1,9,{step:'browser-evidence-capture',source:'external-browser-wall-clock',status:'failed'}),span('local',3,5,{step:'saved-draft-review'}),span('wait',5,6,{step:'browser-processing-wait',source:'external-browser-wall-clock'})];
 const result=summarizeV2Timings(spans,{createdAt:at(0),now:at(10)});
 assert.equal(result.elapsedMs,10000);assert.equal(result.measuredWorkMs,2000);assert.equal(result.measuredWaitingMs,1000);assert.equal(result.measuredFailedBrowserMs,5000);assert.equal(result.measuredRecoveryMs,5000);assert.equal(result.measuredAgentGapMs,0);assert.equal(result.measuredCoveredMs,8000);assert.equal(result.unmeasuredOrWaitingMs,2000);
 assert.equal(result.measuredWorkMs+result.measuredWaitingMs+result.measuredSellerReviewMs+result.measuredAgentGapMs+result.measuredFailedBrowserMs+result.unmeasuredOrWaitingMs,result.elapsedMs);
});
test('failed parent retains failed residual beside real child work; interrupted browser duration stays unknown',()=>{
 const parent=span('parent',0,10,{step:'browser-evidence-capture',source:'external-browser-wall-clock',status:'failed'}),child=span('child',2,4,{step:'browser-substep:parent:ax-read',source:'external-browser-wall-clock'});
 const result=summarizeV2Timings([parent,child],{createdAt:at(0),now:at(10)});assert.equal(result.measuredWorkMs,2000);assert.equal(result.measuredFailedBrowserMs,8000);assert.equal(result.browserEnvelopeMs,10000);
 parent.status='interrupted';delete parent.durationMs;const unknown=summarizeV2Timings([parent,child],{createdAt:at(0),now:at(10)});assert.equal(unknown.measuredWorkMs,2000);assert.equal(unknown.measuredFailedBrowserMs,0);assert.equal(unknown.unmeasuredOrWaitingMs,8000);assert.equal(unknown.interrupted,1);
 const failedChild={...child,status:'failed' as const};const failed=summarizeV2Timings([parent,failedChild],{createdAt:at(0),now:at(10)});assert.equal(failed.measuredWorkMs,0);assert.equal(failed.measuredFailedBrowserMs,2000);assert.equal(failed.unmeasuredOrWaitingMs,8000);
});

test('local finalization is distinct from browser time and unmapped interval boundaries remain explicit',()=>{
 const result=summarizeV2Timings([span('parent',0,10,{step:'browser-evidence-capture',source:'external-browser-wall-clock'}),span('browser',1,3,{step:'browser-substep:parent:ax-read',source:'external-browser-wall-clock'}),span('finalize',4,8,{step:'browser-substep:parent:local-finalize'}),span('archive',5,7,{step:'photo-archive'})],{createdAt:at(0),now:at(10)});
 assert.equal(result.measuredWorkMs,6000);assert.equal(result.measuredBrowserMs,2000);assert.equal(result.measuredLocalFinalizeMs,4000);assert.equal(result.unmeasuredOrWaitingMs,4000);assert.deepEqual(result.unmappedIntervals.map(x=>x.durationMs),[2000,1000,1000]);assert.equal(result.unmappedIntervalCount,3);
});
test('bounded gap presentation retains largest late silence and reconciles omitted duration',()=>{const spans:any[]=Array.from({length:110},(_,n)=>({id:`s${n}`,step:'photo-upload',pid:1,status:'completed',startedAt:new Date(n*2000+1000).toISOString(),endedAt:new Date(n*2000+2000).toISOString(),durationMs:1000}));const summary=summarizeV2Timings(spans,{createdAt:new Date(0).toISOString(),now:new Date(400000).toISOString()});assert.equal(summary.unmappedIntervals.length,100);assert.equal(summary.unmappedIntervals[0].durationMs,180000);assert.equal(summary.unmappedIntervals[0].startedAt,new Date(220000).toISOString());assert.equal(summary.unmappedPresentation.omittedCount,11);assert.equal(summary.unmappedPresentation.omittedDurationMs,11000);assert.equal(summary.unmappedPresentation.listedDurationMs+summary.unmappedPresentation.omittedDurationMs,summary.unmeasuredOrWaitingMs);assert.equal(summary.unmappedPresentation.totalDurationMs,summary.unmeasuredOrWaitingMs);});
