import test from "node:test";
import assert from "node:assert/strict";
import {pipelineWorkPlan,pipelineEngineeringTask} from "../lib/engineering-pipeline.ts";
import {newQueue,upsertCard,queueSummary,claimJob,completeJob,type CardInput,type JobKind,type Identity} from "../lib/card-orchestrator.ts";
const now="2026-10-25T14:00:00.000Z";
const identity:Identity={player:"Player",season:"2025",set:"Set",manufacturer:"Maker",cardNumber:"1",sport:"Basketball",team:"Team",parallel:"Base",serial:"",printRun:null,condition:"Near mint or better",autograph:false,patch:false};
function fixture(){const state=newQueue();const input:CardInput={id:"card-1",sku:"sku-1",source:"test",identity,photos:[{side:"front",path:"front.jpg",sha256:"a".repeat(64)},{side:"back",path:"back.jpg",sha256:"b".repeat(64)}],candidates:[]};upsertCard(state,input,now);return state;}
test('fresh pipeline plan is bounded and excludes seller holds, existing tasks and unchanged failures',()=>{
 const state=fixture(),summary=queueSummary(state,now),plan=pipelineWorkPlan(state,summary,[],1);
 assert.equal(plan.candidates.length,1);assert.equal(plan.candidates[0].kind,'photos');
 const task=pipelineEngineeringTask(plan.candidates[0],'plan.json');task.status='blocked';
 assert.equal(pipelineWorkPlan(state,summary,[task],10).candidates.length,0);
 assert.equal(pipelineWorkPlan(state,queueSummary(state,now,{'card-1':'seller hold'}),[],10).candidates.length,0);
 assert.throws(()=>pipelineWorkPlan(state,summary,[],51),/Bounded/);
});
test('review work gets explicit access dependency while independent local preparation stays runnable',()=>{
 const state=fixture();
 const finish=(kind:JobKind,data:unknown)=>{const claim=claimJob(state,'test',kind,'card-1',now)!;completeJob(state,'card-1',kind,claim.job.lease!.token,{outcome:'done',data},now);};
 finish('photos',{hashes:state.cards['card-1'].input.photos.map(({side,sha256})=>({side,sha256})),evidence:'originals inspected'});
 finish('identity',{identity,pairMatches:true,frontFirst:true,serialInspected:true,evidence:'both originals inspected'});
 const plan=pipelineWorkPlan(state,queueSummary(state,now),[],10);
 const pricing=plan.candidates.find(c=>c.kind==='pricing')!;assert.ok(pricing);
 assert.deepEqual(pipelineEngineeringTask(pricing,'proof.json').dependencies,['seller-read-access']);
 const listing=plan.candidates.find(c=>c.kind==='listing')!;assert.ok(listing);
 assert.deepEqual(pipelineEngineeringTask(listing,'proof.json').dependencies,[]);
});
