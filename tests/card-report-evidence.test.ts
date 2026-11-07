import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {newQueue,upsertCard,fingerprint,type Identity} from '../lib/card-orchestrator.ts';
import {configureDraftWriter,draftNext,observeDraft,draftBinding} from '../lib/card-draft-lifecycle.ts';
import {recordCardReportEvidence,reportDraftBlockers,type ReportEvidenceQueue} from '../lib/card-report-evidence.ts';
const now='2026-11-03T03:00:00.000Z',sha=(v:string)=>createHash('sha256').update(v).digest('hex');
const identity:Identity={player:'Player',season:'2024-25',set:'Prizm Black',manufacturer:'Panini',cardNumber:'1',sport:'Basketball',team:'Team',parallel:'White Prizm',serial:'001/175',printRun:175,condition:'Near mint or better',autograph:false,patch:false};
function fixture(){
  const state=newQueue() as ReportEvidenceQueue;
  upsertCard(state,{id:'one',sku:'capture-1',identity,photos:[{side:'front',path:'front.jpg',sha256:'a'.repeat(64)},{side:'back',path:'back.jpg',sha256:'b'.repeat(64)}],candidates:[],source:'scanner-intake:test'},now);
  state.cards.one.jobs.photos.state='done';state.cards.one.jobs.identity.state='done';state.cards.one.jobs.identity.result={identity};
  state.cards.one.jobs.listing.state='done';state.cards.one.jobs.reconcile.state='done';state.cards.one.jobs.reconcile.result={disposition:'clear',checkedAt:now,scopes:['active','drafts','scheduled','sold']};
  configureDraftWriter(state,'writer',['one'],'Original writer cutover observed',now,{allowCreate:true,authority:'Seller authorized this exact original card for draft-only creation'});
  const report={schemaVersion:1,sourceRevision:state.revision,generatedAt:now,provenance:['state','active','orders'].map(kind=>({kind,file:kind+'.csv',sha256:sha(kind),modifiedAt:'2026-11-02T20:00:00.000Z',exportDateFromFilename:kind==='state'?null:'2026-11-02'})),records:[{cardId:'one',sku:'capture-1',identity,disposition:'active-match',conflicts:[],activeMatches:[{itemId:'128123456789',sku:'capture-1',title:'Player 001/175',quantity:2,basis:'exact-sku'}],orderItemIds:['128123456789']}]};
  return {state,report,proof:{reportSha256:sha(JSON.stringify(report)),currentStateSha256:sha('state')}};
}
test('report intake retains historical times/bindings without touching card work or granting receipt/archive authority',()=>{
  const {state,report,proof}=fixture(),before=structuredClone(state.cards),receipts=state.verifiedReceipts;
  const result=recordCardReportEvidence(state,{...report,buyerName:'PRIVATE'},proof,now),entry=state.reportEvidence![result.id];
  assert.equal(result.recorded,true);assert.deepEqual(state.cards,before);assert.equal(state.verifiedReceipts,receipts);
  assert.equal(entry.sources[1].modifiedAt,'2026-11-02T20:00:00.000Z');assert.equal(entry.findings[0].photoKey,fingerprint(state.cards.one.input.photos));
  assert.equal(entry.freshLiveObservation,false);assert.equal(entry.grantsDraftClearance,false);assert.equal(entry.grantsArchiveAuthority,false);
  assert.equal(entry.findings[0].activeMatches[0].quantity,2);assert.equal(entry.findings[0].disposition,'active-match');
  assert.ok(!JSON.stringify(entry).includes('PRIVATE'));assert.equal(state.photoArchives,undefined);
  const snapshot=JSON.stringify(state);assert.equal(recordCardReportEvidence(state,report,proof,now).recorded,false);assert.equal(JSON.stringify(state),snapshot);
});
test('changed state or identity and forged SKU matches reject atomically',()=>{
  for(const mutate of [(f:ReturnType<typeof fixture>)=>{f.state.revision++;},(f:ReturnType<typeof fixture>)=>{f.report.records[0].identity={...identity,serial:'002/175'};},(f:ReturnType<typeof fixture>)=>{f.report.records[0].activeMatches[0].sku='different';}]){
    const f=fixture();mutate(f);const before=JSON.stringify(f.state);assert.throws(()=>recordCardReportEvidence(f.state,f.report,f.proof,now));assert.equal(JSON.stringify(f.state),before);
  }
});
test('positive historical matches block only new create; existing draft repair and old queues retain behavior',()=>{
  const {state,report,proof}=fixture(),context={approved:true,price:{item:2.95,shipping:0}},guards=()=>[];
  assert.equal(draftNext(state,'one',context,now,guards).action,'create-draft-for-review');
  recordCardReportEvidence(state,report,proof,now);
  assert.equal(draftNext(state,'one',context,now,guards).action,'reconcile-report-match');
  observeDraft(state,{observationId:randomUUID(),seller:'imaydit58',cardId:'one',sku:'capture-1',binding:draftBinding(state.cards.one),draftId:'5283690940321',state:'saved',url:'https://www.ebay.com/sl/list?draft_id=5283690940321',observedAt:now,evidence:'Actual same-ID saved draft observed'},now);
  assert.equal(draftNext(state,'one',context,now,guards).action,'inspect-saved-draft');
});
test('negative report does not supply clearance and changed photo bindings do not inherit positive blockers',()=>{
  const {state,report,proof}=fixture();report.records[0].disposition='not-found-in-reports';report.records[0].activeMatches=[];report.records[0].orderItemIds=[];
  recordCardReportEvidence(state,report,proof,now);assert.deepEqual(reportDraftBlockers(state,'one'),[]);
  assert.equal(state.reportEvidence![proof.reportSha256].grantsDraftClearance,false);
  const f=fixture();recordCardReportEvidence(f.state,f.report,f.proof,now);f.state.cards.one.input.photos[0].sha256='c'.repeat(64);
  assert.deepEqual(reportDraftBlockers(f.state,'one'),[]);
});
test('CLI defaults to validation without queue writes; explicit intake persists once and replay is byte-stable',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'report-evidence-'));
  try {
    const f=fixture(),stateBytes=JSON.stringify(f.state,null,2);await fs.writeFile(path.join(directory,'state.json'),stateBytes);
    const active=path.join(directory,'active.csv'),orders=path.join(directory,'orders.csv'),reportFile=path.join(directory,'report.json');
    await fs.writeFile(active,'active source');await fs.writeFile(orders,'orders source');
    for(const p of f.report.provenance)p.sha256=p.kind==='state'?sha(stateBytes):sha(p.kind+' source');
    await fs.writeFile(reportFile,JSON.stringify(f.report));
    const script=fileURLToPath(new URL('../scripts/import-card-report-evidence.ts',import.meta.url));
    const args=['--experimental-strip-types',script,'--report',reportFile,'--active',active,'--orders',orders,'--queue',directory];
    const run=(apply=false)=>JSON.parse(execFileSync(process.execPath,[...args,...(apply?['--apply']:[])],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));
    assert.equal(run().mode,'validation-only');assert.equal(await fs.readFile(path.join(directory,'state.json'),'utf8'),stateBytes);
    assert.equal(run(true).recorded,true);const after=await fs.readFile(path.join(directory,'state.json'),'utf8');
    assert.equal(run(true).recorded,false);assert.equal(await fs.readFile(path.join(directory,'state.json'),'utf8'),after);
    assert.deepEqual(JSON.parse(after).cards,JSON.parse(stateBytes).cards);assert.equal(JSON.parse(after).revision,f.state.revision+1);
  }finally{await fs.rm(directory,{recursive:true,force:true});}
});
