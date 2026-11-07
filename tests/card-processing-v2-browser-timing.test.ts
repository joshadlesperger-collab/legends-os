import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {digest,type V2Card} from "../lib/card-processing-v2.ts";
import {readV2State,withV2State} from "../lib/card-processing-v2-store.ts";
import {newV2ProcessingBatch,writeV2ProcessingBatch} from "../lib/card-processing-v2-processing-batches.ts";
import {beginV2BrowserTiming,endV2BrowserTiming,recoverV2BrowserTimings} from "../lib/card-processing-v2-browser-timing.ts";
import {recoverV2Timings} from "../lib/card-processing-v2-timing.ts";
import {summarizeV2Timings} from "../lib/card-processing-v2-timing-summary.ts";
async function fixture(run:(root:string,batchId:string)=>Promise<void>){const root=await fs.mkdtemp(path.join(os.tmpdir(),"v2-external-timing-"));try{const at=new Date(Date.now()-2000).toISOString(),card:V2Card={id:"card",sku:"card",captureId:digest("capture"),photos:[{path:"front",hash:digest("front"),side:"front"},{path:"back",hash:digest("back"),side:"back"}],stage:"waiting",condition:"Near mint or better",title:"",description:"",descriptionSource:"factual",issues:[],nextAction:"Identify",createdAt:at,updatedAt:at};await withV2State(s=>{s.cards.card=card;},root);const batchId=randomUUID(),batch=newV2ProcessingBatch(batchId,{captures:[{candidateId:digest("pair"),cardId:"card",photos:card.photos}]} as any,await readV2State(root),at);await writeV2ProcessingBatch(root,batch,true);await withV2State(s=>{s.lastRun={id:batchId,pid:process.pid,startedAt:at,status:"finished"};},root);await run(root,batchId);}finally{await fs.rm(root,{recursive:true,force:true});}}
test("actual external browser span binds selected card and batch and feeds existing summary",()=>fixture(async(root,batchId)=>{const before=await readV2State(root),startedAt=new Date(Date.now()-1000).toISOString(),lease=await beginV2BrowserTiming(root,{batchId,step:"browser-save-reopen",cardIds:["card"],startedAt});assert.equal((await readV2State(root)).timings[0].status,"running");const end=await endV2BrowserTiming(root,{spanId:lease.spanId,token:lease.token,status:"completed"}),after=await readV2State(root);assert.deepEqual(after.cards,before.cards);assert.deepEqual(after.calls,before.calls);assert.ok(end.durationMs!>=1000);assert.equal(after.timings[0].runId,batchId);assert.equal(after.timings[0].source,"external-browser-wall-clock");assert.ok(summarizeV2Timings(after.timings,{cardId:"card",runId:batchId,createdAt:before.cards.card.createdAt}).measuredActiveMs>=1000);await assert.rejects(endV2BrowserTiming(root,{spanId:lease.spanId,token:lease.token,status:"completed"}),/unfinished/);}));
test("foreign card, duplicate running operation, invalid owner and invented future timestamps are rejected",()=>fixture(async(root,batchId)=>{await assert.rejects(beginV2BrowserTiming(root,{batchId,step:"browser-upload",cardIds:["foreign"]}),/selected/);await assert.rejects(beginV2BrowserTiming(root,{batchId,step:"browser-upload",startedAt:new Date(Date.now()+60000).toISOString()}),/recent/);const lease=await beginV2BrowserTiming(root,{batchId,step:"browser-upload",cardIds:["card"]});await assert.rejects(beginV2BrowserTiming(root,{batchId,step:"browser-upload",cardIds:["card"]}),/already/);await assert.rejects(endV2BrowserTiming(root,{spanId:lease.spanId,token:randomUUID(),status:"completed"}),/owner/);assert.equal((await readV2State(root)).timings[0].status,"running");}));
test("failed external action retains elapsed; interrupted action never fabricates a final duration",()=>fixture(async(root,batchId)=>{for(const status of ["failed","interrupted"] as const){const lease=await beginV2BrowserTiming(root,{batchId,step:"browser-draft-edit",cardIds:["card"]});const end=await endV2BrowserTiming(root,{spanId:lease.spanId,token:lease.token,status});assert.equal(end.status,status);assert.equal(end.durationMs===undefined,status==="interrupted");}}));
test("external lease survives short-lived CLI PID and expiry recovery marks unknown duration",()=>fixture(async(root,batchId)=>{await beginV2BrowserTiming(root,{batchId,step:"browser-processing-wait"});await withV2State(s=>{s.timings[0].pid=2147483647;},root);assert.equal(await recoverV2Timings(root),0);assert.equal((await readV2State(root)).timings[0].status,"running");await withV2State(s=>{s.timings[0].startedAt=new Date(Date.now()-25*3600000).toISOString();},root);assert.equal(await recoverV2BrowserTimings(root),1);const span=(await readV2State(root)).timings[0];assert.equal(span.status,"interrupted");assert.equal(span.durationMs,undefined);}));
test("pre-validation external timing cannot change state revision and stale a pending worker selection",()=>fixture(async(root,batchId)=>{await withV2State(s=>{delete s.lastRun;},root);const before=await readV2State(root);await assert.rejects(beginV2BrowserTiming(root,{batchId,step:"browser-reconciliation"}),/selection validation/);assert.deepEqual(await readV2State(root),before);}));

test('upload, processing and reconciliation are exclusive stages with explicit ordered boundaries',()=>fixture(async(root,batchId)=>{
 const upload=await beginV2BrowserTiming(root,{batchId,step:'browser-upload'});
 await assert.rejects(beginV2BrowserTiming(root,{batchId,step:'browser-processing-wait'}),/already/);
 assert.equal((await fs.readdir(path.join(root,'artifacts/card-processing-v2/browser-timing-leases'))).length,1);
 await endV2BrowserTiming(root,{spanId:upload.spanId,token:upload.token,status:'completed'});
 const processing=await beginV2BrowserTiming(root,{batchId,step:'browser-processing-wait'});await endV2BrowserTiming(root,{spanId:processing.spanId,token:processing.token,status:'completed'});
 const reconciliation=await beginV2BrowserTiming(root,{batchId,step:'browser-reconciliation'});await endV2BrowserTiming(root,{spanId:reconciliation.spanId,token:reconciliation.token,status:'completed'});
 assert.deepEqual((await readV2State(root)).timings.map(t=>t.step),['browser-upload','browser-processing-wait','browser-reconciliation']);
}));

test('seller review requires actual retained handoff evidence and uses the same exclusive timing lease',()=>fixture(async(root,batchId)=>{
 await assert.rejects(beginV2BrowserTiming(root,{batchId,step:'browser-seller-review-wait'}),/handoff evidence/);
 const filename=path.join(root,'artifacts','seller-handoff.json'),body=JSON.stringify({kind:'seller-decision-request',batchId,cardId:'card',observedAt:new Date().toISOString(),question:'Resolve observed condition exception'});await fs.writeFile(filename,body);
 const {createHash}=await import('node:crypto'),handoffEvidence={path:'artifacts/seller-handoff.json',sha256:createHash('sha256').update(body).digest('hex')};
 await assert.rejects(beginV2BrowserTiming(root,{batchId,step:'browser-seller-review-wait',handoffEvidence:{...handoffEvidence,sha256:'f'.repeat(64)}}),/changed/);
 const lease=await beginV2BrowserTiming(root,{batchId,step:'browser-seller-review-wait',cardIds:['card'],handoffEvidence});
 await assert.rejects(beginV2BrowserTiming(root,{batchId,step:'browser-agent-gap'}),/already/);
 await endV2BrowserTiming(root,{spanId:lease.spanId,token:lease.token,status:'completed'});
 const gap=await beginV2BrowserTiming(root,{batchId,step:'browser-agent-gap'});await endV2BrowserTiming(root,{spanId:gap.spanId,token:gap.token,status:'completed'});
 assert.deepEqual((await readV2State(root)).timings.map(t=>t.step),['browser-seller-review-wait','browser-agent-gap']);
}));
