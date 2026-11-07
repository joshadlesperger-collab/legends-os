import test from 'node:test';
import assert from 'node:assert/strict';
import {newQueue,upsertCard,type CardInput} from '../lib/card-orchestrator.ts';
import {configureDraftWriter,claimDraftWriter,draftNext,beginDraftWrite,draftBinding} from '../lib/card-draft-lifecycle.ts';
import {beginBulkAi,observeBulkAi,checkpointBulkAi,bulkAiStatus} from '../lib/card-bulk-ai.ts';
import {randomUUID} from 'node:crypto';
const now='2026-10-25T19:00:00.000Z';
function fixture(){
 const s=newQueue();
 for(let i=1;i<=2;i++){
  const c:CardInput={id:`c${i}`,sku:`s${i}`,source:'scanner-intake:test',candidates:[],identity:{player:'',season:'',set:'',manufacturer:'',cardNumber:'',sport:'Basketball',team:'',parallel:'',serial:'',printRun:null,condition:'Near mint or better',autograph:null,patch:false},photos:[{side:'front',path:`f${i}`,sha256:String(i).repeat(64)},{side:'back',path:`b${i}`,sha256:String(i+2).repeat(64)}]};
  upsertCard(s,c,now);s.cards[c.id].jobs.photos.state='done';
 }
 configureDraftWriter(s,'test',['c1','c2'],'Test fixture authorization',now,{allowCreate:true,authority:'Explicit draft-only bulk AI fixture authority'});
 return {s,token:claimDraftWriter(s,'test',undefined,now).lease!.token};
}
test('bulk AI permits unknown identity but fences capture resubmission and preserves front/back order',()=>{
 const {s,token}=fixture(),b=beginBulkAi(s,['c1','c2'],'test',token,'Reviewed original pairs and seller access',now);
 assert.deepEqual(b.uploadOrder.map(p=>p.side),['front','back','front','back']);
 assert.throws(()=>beginBulkAi(s,['c1'],'test',token,'Reviewed original pairs and seller access',now),/Prior upload/);
 assert.equal(b.canPublish,false);
});
test('bulk AI rejects missing photo review and stale writer',()=>{
 const {s,token}=fixture();s.cards.c1.jobs.photos.state='todo';
 assert.throws(()=>beginBulkAi(s,['c1'],'test',token,'Reviewed original pairs and seller access',now),/photo verification/);
 assert.throws(()=>beginBulkAi(s,['c2'],'test',token,'Reviewed original pairs and seller access','2026-10-25T20:00:00.000Z'),/expired/);
});
test('bulk observation requires pair matching, unique IDs and retains partial success for recovery',()=>{
 const {s,token}=fixture(),b=beginBulkAi(s,['c1','c2'],'test',token,'Reviewed original pairs and seller access',now);
 const row={cardId:'c1',draftId:'123456',url:'https://www.ebay.com/sl/list?draft_id=123456',photosMatched:true,evidence:'Actual generated saved draft photo pair inspected'};
 assert.throws(()=>observeBulkAi(s,b.id,[{...row,photosMatched:false}],'test',token,now),/mapping/);
 const out=observeBulkAi(s,b.id,[row],'test',token,now);
 assert.equal(out.confirmedDrafts,1);assert.deepEqual(out.unresolved,['c2']);assert.equal(out.readyToPublish,0);
 assert.equal(s.cards.c1.draftLifecycle?.draftId,'123456');
 assert.throws(()=>observeBulkAi(s,b.id,[{...row,cardId:'c2'}],'test',token,now),/Duplicate/);
 assert.throws(()=>observeBulkAi(s,b.id,[{...row,draftId:'987654'}],'test',token,now),/retained/);
});


test('bulk AI carries standing condition authority without claiming inspection',()=>{
 const {s,token}=fixture(),b=beginBulkAi(s,['c1'],'test',token,'Reviewed original pairs and seller access',now);
 assert.equal(b.conditionPolicy.defaultCondition,'Near mint or better');
 assert.equal(b.conditionPolicy.askRoutineConfirmation,false);
 assert.match(b.conditionPolicy.instruction,/not proof of inspection/);
});

test('observed stalled generation permits one recovery, preserves partial IDs, and never permits reupload',()=>{
 const {s,token}=fixture(),b=beginBulkAi(s,['c1','c2'],'test',token,'Reviewed original pairs and seller access',now);
 const checkpoint=(phase:string)=>checkpointBulkAi(s,b.id,{observationId:randomUUID(),phase,observedAt:now,evidence:'retained-workspace.txt',reason:'Observed workspace failed to progress'},'a'.repeat(64),'test',token,now);
 assert.equal(bulkAiStatus(s,b.id).recovery.state,'awaiting-observation');
 assert.equal(checkpoint('stalled').recovery.state,'reconcile-stall');
 assert.throws(()=>checkpoint('recovery-failed'),/transition/);
 checkpoint('recovery-started');assert.equal(checkpoint('recovery-failed').recovery.state,'held');
 assert.throws(()=>checkpoint('recovery-started'),/transition/);
 const row={cardId:'c1',draftId:'123456',url:'https://www.ebay.com/sl/list?draft_id=123456',photosMatched:true,evidence:'Actual saved front and back images inspected'};
 let result=observeBulkAi(s,b.id,[row],'test',token,now);
 assert.equal(result.recovery.state,'held');assert.deepEqual(result.unresolved,['c2']);
 assert.throws(()=>beginBulkAi(s,['c2'],'test',token,'Reviewed original pairs and seller access',now),/Prior upload/);
 result=observeBulkAi(s,b.id,[{...row,cardId:'c2',draftId:'654321',url:'https://www.ebay.com/sl/list?draft_id=654321'}],'test',token,now);
 assert.equal(result.recovery.state,'mapped');assert.equal(result.recovery.canResubmit,false);assert.equal(result.submission.checkpoints?.length,3);
});

test('recovery checkpoint retries are idempotent but changed evidence, stale writers and invented times fail',()=>{
 const {s,token}=fixture(),b=beginBulkAi(s,['c1'],'test',token,'Reviewed original pairs and seller access',now);
 const p={observationId:randomUUID(),phase:'stalled',observedAt:now,evidence:'retained-workspace.txt',reason:'Actual stalled loading screen observed'};
 checkpointBulkAi(s,b.id,p,'a'.repeat(64),'test',token,now);
 checkpointBulkAi(s,b.id,p,'a'.repeat(64),'test',token,now);
 assert.equal(s.bulkAiSubmissions![b.id].checkpoints?.length,1);
 assert.throws(()=>checkpointBulkAi(s,b.id,p,'b'.repeat(64),'test',token,now),/different evidence/);
 assert.throws(()=>checkpointBulkAi(s,b.id,{...p,observedAt:'2026-10-26T19:00:00.000Z'},'a'.repeat(64),'test',token,now),/timestamp/);
 assert.throws(()=>checkpointBulkAi(s,b.id,p,'a'.repeat(64),'foreign',token,now),/writer|owner/i);
});

test('elapsed time alone does not create a failure; changed originals cannot acquire recovery evidence',()=>{
 const {s,token}=fixture(),b=beginBulkAi(s,['c1'],'test',token,'Reviewed original pairs and seller access',now);
 assert.equal(bulkAiStatus(s,b.id).recovery.state,'awaiting-observation');
 s.cards.c1.input.photos[0].sha256='f'.repeat(64);
 assert.throws(()=>checkpointBulkAi(s,b.id,{observationId:randomUUID(),phase:'stalled',observedAt:now,evidence:'retained-workspace.txt',reason:'Actual stalled loading screen observed'},'a'.repeat(64),'test',token,now),/binding changed/);
});

test('retained failure can be recorded retrospectively without invented recovery start timestamps',()=>{
 const {s,token}=fixture(),b=beginBulkAi(s,['c1'],'test',token,'Reviewed original pairs and seller access',now);
 const result=checkpointBulkAi(s,b.id,{observationId:randomUUID(),phase:'recovery-failed',retrospective:true,observedAt:now,evidence:'retained-failure.txt',reason:'Earlier recovery returned an empty upload screen; start was not timed'},'a'.repeat(64),'test',token,now);
 assert.equal(result.recovery.state,'held');assert.equal(result.submission.checkpoints?.length,1);
 assert.equal(result.submission.checkpoints?.[0].phase,'recovery-failed');
});

test('an unresolved bulk intent also fences the alternate single-card creation path',()=>{
 const {s,token}=fixture();beginBulkAi(s,['c1'],'test',token,'Reviewed original pairs and seller access',now);
 const context={approved:false,draftAuthorized:true,price:{item:2.49,shipping:0}};
 assert.equal(draftNext(s,'c1',context,now).action,'reconcile-bulk-outcome');
 assert.equal(draftNext(s,'c1',context,now).canCreate,false);
 assert.throws(()=>beginDraftWrite(s,'c1','test',token,context,now),/reconcile-bulk-outcome/);
 assert.notEqual(draftNext(s,'c2',context,now).action,'reconcile-bulk-outcome');
});

test('bulk AI refuses reviewed matching copies before any submission intent',()=>{
 const {s,token}=fixture();const identity={player:'Yophery Rodriguez',season:'2025',set:'Bowman Chrome',manufacturer:'Topps',cardNumber:'BCP-36',sport:'Baseball',team:'Brewers',parallel:'Base',serial:'',printRun:null,condition:'Near mint or better',autograph:false,patch:false,language:'English'};
 for(const c of Object.values(s.cards)){c.jobs.identity.state='done';c.jobs.identity.result={identity};s.draftWriter!.creationAuthority!.bindings[c.input.id]=draftBinding(c);}
 assert.throws(()=>beginBulkAi(s,['c1','c2'],'test',token,'Reviewed matching originals with explicit draft authority',now),/quantity draft/);
 assert.equal(s.bulkAiSubmissions,undefined);
 s.cards.c2.input.knownDraft='555';assert.throws(()=>beginBulkAi(s,['c1'],'test',token,'Reviewed matching originals with explicit draft authority',now),/existing listing/);
 assert.equal(s.bulkAiSubmissions,undefined);
});
