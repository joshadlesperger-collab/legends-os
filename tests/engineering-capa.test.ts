import test from 'node:test';
import assert from 'node:assert/strict';
import {recordCapa,checkCapa,syncDraftCapas,syncBulkAiCapas,capaSummary,type Capa,type CapaQueue} from '../lib/engineering-capa.ts';
import type { BulkAiSubmission } from '../lib/card-bulk-ai.ts';
const now='2026-10-25T18:00:00.000Z';
const state=():CapaQueue=>({version:1,tasks:[{id:'fix',priority:10,status:'done',completionCriteria:'fix tested',dependencies:[],requiredPermissions:['local-read'],checkpoint:'proof',measurableOutcome:{passed:true},failureReason:null,retryPolicy:'new evidence only',links:{cards:[],code:[],evidence:['proof']}}]});
const packet=():Omit<Capa,'history'>=>({id:'gap',title:'Persistence gap',owner:'orchestrator',dueAt:'2026-10-26T18:00:00.000Z',taskIds:['fix'],status:'monitoring',incidents:[{id:'original',at:'2026-10-24T18:00:00.000Z',evidence:'failure.json'}],containment:'Hold failed item',rootCause:{status:'confirmed',description:'Source-bound persistence failure',evidence:['cause.json']},correctiveAction:'Repair same ID',preventiveAction:'Verify saved fields',implementedAt:'2026-10-25T17:00:00.000Z',implementationEvidence:['test.log'],effectiveness:{criterion:'Two subsequent saved checks pass',minimumObservations:2,kind:'live'}});
const check=()=>({criterion:packet().effectiveness.criterion,kind:'live',observations:[{id:'a',at:'2026-10-25T17:10:00.000Z',passed:true,evidence:'a.json'},{id:'b',at:'2026-10-25T17:20:00.000Z',passed:true,evidence:'b.json'}]});
test('completed task cannot bypass separate effectiveness closure; mocks, short samples, duplicates and old evidence fail',()=>{
 const s=state();recordCapa(s,packet(),now);
 for(const r of [{...check(),kind:'local-regression'},{...check(),observations:check().observations.slice(0,1)},{...check(),observations:[check().observations[0],check().observations[0]]},{...check(),observations:check().observations.map(o=>({...o,at:'2026-10-24T18:00:00.000Z'}))}])assert.throws(()=>checkCapa(s,'gap',r,now));
 assert.equal(s.capas![0].status,'monitoring');assert.equal(checkCapa(s,'gap',check(),now).status,'closed');
});
test('recurrence reopens a closed CAPA without deleting original evidence or closure history',()=>{
 const s=state();recordCapa(s,packet(),now);checkCapa(s,'gap',check(),now);
 const p=packet();p.incidents.push({id:'recurrence',at:now,evidence:'again.json'});recordCapa(s,p,now);
 assert.equal(s.capas![0].status,'open');assert.equal(s.capas![0].incidents.length,2);assert.equal(s.capas![0].implementedAt,undefined);assert.ok(s.capas![0].history.some(h=>h.event==='effectiveness-passed'));
 assert.throws(()=>recordCapa(s,packet(),now),/immutable/);
});
test('failed effectiveness reopens CAPA; unfinished linked actions prevent successful closure',()=>{
 const s=state();recordCapa(s,packet(),now);s.tasks[0].status='blocked';assert.throws(()=>checkCapa(s,'gap',check(),now),/Linked actions/);
 const r=check();r.observations=[{...r.observations[0],passed:false}];assert.equal(checkCapa(s,'gap',r,now).status,'open');
});
test('failure ingestion is idempotent and admits new action only on changed failure evidence',()=>{
 const s=state(),learning={sku:{failures:1,lastAt:now,remedy:'Repair saved SKU'}};
 assert.deepEqual(syncDraftCapas(s,learning,'snapshot.json',now),['draft-check-sku']);assert.deepEqual(syncDraftCapas(s,learning,'snapshot.json',now),[]);assert.equal(s.tasks.length,2);
 learning.sku.failures=2;syncDraftCapas(s,learning,'snapshot2.json',now);assert.equal(s.tasks.length,3);assert.equal(s.capas![0].incidents.length,2);assert.equal(s.capas![0].rootCause.status,'unconfirmed');
 assert.equal(capaSummary(s,'2026-10-28T18:00:00.000Z')[0].overdue,true);
});
test('missing ownership, unknown task, confirmed cause without evidence and direct closure are rejected',()=>{
 for(const p of [{...packet(),owner:''},{...packet(),taskIds:['unknown']},{...packet(),status:'closed'},{...packet(),rootCause:{status:'confirmed',description:'guess',evidence:[]}}])assert.throws(()=>recordCapa(state(),p as Omit<Capa,'history'>,now));
});

test('bulk incidents enter normal CAPA once; missing IDs alone do not imply failure or a retry',()=>{
 const s=state(),b:BulkAiSubmission={id:'batch',cardIds:['c1'],startedAt:now,evidence:'intent.json',originals:{c1:'hash'},results:{}};
 assert.deepEqual(syncBulkAiCapas(s,{batch:b},'snapshot.json',now),[]);
 b.checkpoints=[{observationId:'observation',phase:'recovery-failed',observedAt:now,recordedAt:now,evidence:'failure.txt',evidenceHash:'a'.repeat(64),reason:'Recovery returned empty upload screen'}];
 assert.deepEqual(syncBulkAiCapas(s,{batch:b},'snapshot.json',now),['batch:observation']);
 assert.deepEqual(syncBulkAiCapas(s,{batch:b},'another-snapshot.json',now),[]);
 assert.equal(s.tasks.length,2);assert.equal(s.capas![0].rootCause.status,'unconfirmed');assert.equal(s.capas![0].effectiveness.kind,'live');
 b.results.c1={draftId:'12345',evidence:'later positive ID',observedAt:now};
 syncBulkAiCapas(s,{batch:b},'resolved.json',now);
 assert.equal(s.capas![0].status,'open','mapping a draft is containment, not CAPA effectiveness');
});
