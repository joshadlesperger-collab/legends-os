import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import sharp from 'sharp';import {createHash} from 'node:crypto';
import {v2BatchBudget,inspectV2Readiness,prepareV2NextBatchContext,activateV2PreparedContext} from '../lib/card-processing-v2-readiness.ts';
import {emptyV2State,digest} from '../lib/card-processing-v2.ts';
import {v2Dir,readV2State,withV2State,startV2Worker,type V2Config} from '../lib/card-processing-v2-store.ts';
import {initializeV2} from '../lib/card-processing-v2-worker.ts';
import {listV2Candidates,resolveV2Selection,type ResolvedV2Selection} from '../lib/card-processing-v2-selection.ts';
const settings={model:'test-only',authority:'fixture',expiresAt:new Date(Date.now()+3600000).toISOString(),pricingSource:'https://example.com/unit',inputUsdPerMillion:2,outputUsdPerMillion:10,maxInputTokens:30000,maxOutputTokens:4000,maxRequestBytes:1000000,capMicros:200000};
const conf:V2Config={folder:'unused',pairing:'named',inputVersion:'fixture',batchLimit:10,categories:[],identification:settings};
const selection:ResolvedV2Selection={token:'a'.repeat(64),candidateIds:['b'.repeat(64),'c'.repeat(64),'d'.repeat(64)],activationRequired:false,captures:[1,2,3].map(i=>({candidateId:String(i).repeat(64),photos:[{path:'f',hash:String(i).repeat(64),side:'front'},{path:'b',hash:String(i+3).repeat(64),side:'back'}]}))};
test('whole selection worst-case is fenced before spending; existing cumulative cap is unchanged',()=>{
 const s=emptyV2State(),b=v2BatchBudget(s,conf,selection);assert.equal(b.batchUpperBoundMicros,300000);assert.equal(b.shortfallMicros,100000);assert.equal(b.ready,false);assert.equal(settings.capMicros,200000);
 s.knowledge[digest(selection.captures[0].photos.map(p=>p.hash))]={identity:{} as never,verifiedAt:new Date().toISOString()} as never;
 assert.equal(v2BatchBudget(s,conf,selection).ready,true,'exact verified pair reuse consumes no new paid reservation');
 s.calls.push({id:'uncertain',status:'uncertain',actualMicros:null,reservedMicros:1000} as never);assert.equal(v2BatchBudget(s,conf,selection).ready,false);
});
async function fixture(fn:(root:string,sel:unknown)=>Promise<void>){const root=await fs.mkdtemp(path.join(os.tmpdir(),'v2-readiness-'));try{
 const folder=path.join(root,'scans');await fs.mkdir(folder);await fs.mkdir(v2Dir(root),{recursive:true});await fs.writeFile(path.join(v2Dir(root),'config.json'),JSON.stringify({...conf,folder}));await initializeV2(root);
 for(const [name,color] of [['one-front.png','red'],['one-back.png','blue']] as const){const file=path.join(folder,name);await fs.writeFile(file,await sharp({create:{width:40,height:60,channels:3,background:color}}).png().toBuffer());const old=new Date(Date.now()-5000);await fs.utimes(file,old,old);}
 const c=await listV2Candidates(root);await fn(root,{mode:'all',token:c.token});
 }finally{await fs.rm(root,{recursive:true,force:true});}}
test('readiness is read-only, seller is checked once, failure is sanitized and no cards/calls are admitted',()=>fixture(async(root,sel)=>{
 let reads=0;const before=await fs.readFile(path.join(v2Dir(root),'state.json'),'utf8');
 const good=await inspectV2Readiness(root,sel,{providerConfigured:true,verifySeller:async()=>{reads++;return 'private-token-never-retained';}});
 assert.equal(good.report.ready,true);assert.equal(good.report.selectedCards,1);assert.equal(good.report.selectedPhotos,2);assert.equal(reads,1);assert.equal(good.report.seller,'verified');assert.equal(good.report.photoUploadAccess,'not-tested-until-upload');assert.doesNotMatch(JSON.stringify(good.report),/private-token/);
 const bad=await inspectV2Readiness(root,sel,{providerConfigured:true,verifySeller:async()=>{throw Error('private-secret');}});assert.equal(bad.report.ready,false);assert.doesNotMatch(JSON.stringify(bad.report),/private-secret/);assert.equal(await fs.readFile(path.join(v2Dir(root),'state.json'),'utf8'),before);
}));
test('button start stops an underfunded batch before creating batch metadata or spawning worker',()=>fixture(async(root,sel)=>{
 const p=path.join(v2Dir(root),'config.json'),c=JSON.parse(await fs.readFile(p,'utf8'));c.identification.capMicros=1;await fs.writeFile(p,JSON.stringify(c));
 const fresh={mode:'all',token:(await listV2Candidates(root)).token};await assert.rejects(startV2Worker(root,fresh),/Batch readiness/);
 await assert.rejects(fs.stat(path.join(v2Dir(root),'processing-batches')),{code:'ENOENT'});assert.equal((await readV2State(root)).calls.length,0);
}));
test('prepared context reuses reviewed facts only on exact originals, with no admission until actual processing',()=>fixture(async(root,sel)=>{
 const instruction={id:'context-authority',text:'Reuse reviewed reference for these exact selected photos',taskIds:[],policyRefs:['v2-identification-context']};
 await fs.mkdir(path.join(root,'artifacts/engineering-mission'),{recursive:true});await fs.writeFile(path.join(root,'artifacts/engineering-mission/work-queue.json'),JSON.stringify({instructions:[instruction]}));
 async function evidence(name:string,data:unknown){const bytes=JSON.stringify(data),file='artifacts/'+name+'.json';await fs.writeFile(path.join(root,file),bytes);return{path:file,sha256:createHash('sha256').update(bytes).digest('hex')};}
 const p={selection:sel,authority:{instructionId:instruction.id,evidence:await evidence('authority',{instruction})},source:{kind:'verified-reference',evidence:await evidence('reference',{url:'https://example.com/checklist',facts:'2024-25 Panini Prizm Black Basketball Prizms 225'}),sourceUrl:'https://example.com/checklist',reviewer:'fixture',observedAt:new Date().toISOString()},facts:{year:'2024-25',manufacturer:'Panini',product:'Prizm Black',parallelDefinitions:[{name:'Basketball Prizms',printRun:225}]},expiresAt:new Date(Date.now()+3600000).toISOString()};
 assert.equal((await prepareV2NextBatchContext(root,p)).registered,0);assert.equal((await readV2State(root)).calls.length,0);assert.equal(Object.keys((await readV2State(root)).cards).length,0);
 const inspected=await inspectV2Readiness(root,sel,{providerConfigured:true});assert.equal(inspected.report.contextPairs,1);assert.equal(inspected.report.ready,true);
 assert.equal((await activateV2PreparedContext(root,await resolveV2Selection(root,sel))).registered,1);
 await fs.appendFile(path.join(root,'artifacts/reference.json'),' ');assert.equal((await inspectV2Readiness(root,sel,{providerConfigured:true})).report.ready,false);
}));

test('button readiness catches a corrupt selected media pair before seller access, admission or provider calls',()=>fixture(async(root,sel)=>{
 const folder=(JSON.parse(await fs.readFile(path.join(v2Dir(root),'config.json'),'utf8'))).folder;await fs.writeFile(path.join(folder,'two-front.png'),await sharp({create:{width:40,height:60,channels:3,background:'green'}}).png().toBuffer());await fs.writeFile(path.join(folder,'two-back.png'),'bad image');for(const n of ['two-front.png','two-back.png']){const old=new Date(Date.now()-5000);await fs.utimes(path.join(folder,n),old,old);}const selected={mode:'all',token:(await listV2Candidates(root)).token},before=await fs.readFile(path.join(v2Dir(root),'state.json'),'utf8');let seller=0;
 const result=await inspectV2Readiness(root,selected,{providerConfigured:true,verifySeller:async()=>{seller++;}});assert.equal(result.report.ready,false);assert.equal(result.report.media?.checkedPhotos,4);assert.equal(result.report.media?.ready,false);assert.equal(seller,0);assert.equal(result.report.providerCalls,0);assert.equal(await fs.readFile(path.join(v2Dir(root),'state.json'),'utf8'),before);
}));


test('readiness reserves bounded unknown cost without fabricating settlement and rejects insufficient aggregate cap',()=>{
 const s=emptyV2State(),b={authority:'fixture',pricingSource:'https://example.com/unit',inputUsdPerMillion:2,outputUsdPerMillion:10,maxInputTokens:30000,maxOutputTokens:4000};
 s.calls.push({id:'prior',cardId:'prior-card',key:'f'.repeat(64),provider:'openai',model:'fixture',status:'uncertain',actualMicros:null,reservedMicros:100000,at:new Date().toISOString(),bound:b});
 const config={...conf,identification:{...settings,capMicros:400000}};
 const r=v2BatchBudget(s,config,selection);assert.equal(r.ready,true);assert.equal(r.pendingUsage,true);assert.equal(r.committedMicros,100000);assert.equal(r.boundedPendingReservationMicros,100000);assert.equal(s.calls[0].actualMicros,null);
 assert.equal(v2BatchBudget(s,{...config,identification:{...config.identification,capMicros:399999}},selection).ready,false);
 s.calls[0].reservedMicros=99999;assert.equal(v2BatchBudget(s,config,selection).ready,false);
});

test('already identified exact pairs do not require stale pre-identification context again',()=>fixture(async(root,raw)=>{const selected=await resolveV2Selection(root,raw);await fs.writeFile(path.join(v2Dir(root),'next-batch-context.json'),JSON.stringify({version:1,candidateIds:selected.candidateIds,packet:{expired:true}}));const before=await inspectV2Readiness(root,raw,{providerConfigured:true});assert.ok(before.report.blockers.some(s=>s.includes('context')));const i:import('../lib/card-processing-v2.ts').V2Identity={name:'Evan Mobley',year:'2024-25',manufacturer:'Panini',product:'Prizm Basketball',number:'1',categoryId:'261328',language:'English',variant:'Base',artwork:'Basketball player',sportOrGame:'Basketball',team:'Cleveland Cavaliers',serial:'',graded:false,damage:false,specifics:{}};const photos=selected.captures[0].photos;await withV2State(s=>{s.cards['known']={id:'known',sku:'known',captureId:digest(photos.map(p=>p.hash)),photos,identity:i,identification:{identity:i,pairMatches:true,frontImageIndex:'0',upright:true,warnings:[]},condition:'Near mint or better',stage:'identified',title:'',description:'',descriptionSource:'factual',issues:[],nextAction:'Prepare',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};},root);const picker=await listV2Candidates(root),request={mode:'selected',token:picker.token,candidateIds:selected.candidateIds},checked=await inspectV2Readiness(root,request,{providerConfigured:false});assert.equal(checked.report.budget.requiredCalls,0);assert.equal(checked.report.blockers.some(s=>s.includes('context')),false);assert.deepEqual(await activateV2PreparedContext(root,await resolveV2Selection(root,request)),{registered:0});}));
