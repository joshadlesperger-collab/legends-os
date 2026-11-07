import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {startV2IdentifySort,executeV2IdentifySort,getV2IdentifySortStatus} from '../lib/card-processing-v2-identify-sort.ts';
import {readV2State,withV2State,v2Dir} from '../lib/card-processing-v2-store.ts';
import {listV2Candidates} from '../lib/card-processing-v2-selection.ts';
import {listV2ReadyBatches} from '../lib/card-processing-v2-ready-batches.ts';
import {digest,type V2Card} from '../lib/card-processing-v2.ts';

async function fixture(run:(f:any)=>Promise<void>){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'v2-identify-sort-')),folder=path.join(root,'scans');
 try{await fs.mkdir(folder);await fs.mkdir(v2Dir(root),{recursive:true});await fs.writeFile(path.join(v2Dir(root),'config.json'),JSON.stringify({folder,pairing:'named',categories:[],identification:{model:'synthetic-model',authority:'synthetic',expiresAt:new Date(Date.now()+86400000).toISOString(),pricingSource:'https://example.com/bounds',inputUsdPerMillion:1,outputUsdPerMillion:2,maxInputTokens:10000,maxOutputTokens:1000,maxRequestBytes:1000000,capMicros:1000000}}));
 await withV2State(s=>{s.baseline={initializedAt:new Date(Date.now()-10000).toISOString(),paths:[],hashes:[],fileCount:0};},root);
 for(let n=1;n<=2;n++)for(const side of ['front','back']){const file=path.join(folder,`${n}-${side}.jpg`);await fs.writeFile(file,Buffer.from(`original ${n} ${side}`));const age=new Date(Date.now()-10000);await fs.utimes(file,age,age);}
 const snapshot=await listV2Candidates(root),raw={mode:'all',token:snapshot.token};await run({root,folder,raw});
 }finally{await fs.rm(root,{recursive:true,force:true});}
}
async function seed(root:string,jobId:string,selection:any,holdLast=false){
 const now=new Date().toISOString();await withV2State(s=>{selection.captures.forEach((capture:any,n:number)=>{const id='fixture-'+n,identity={name:'Player '+n,year:'2024-25',manufacturer:'Panini',product:'Prizm Black',number:String(n),categoryId:'261328' as const,language:'English',variant:'Red Wave Prizm',artwork:'Portrait',sportOrGame:'Basketball',team:'Test',serial:'',graded:false,damage:false,specifics:{}};
 const held=holdLast&&n===selection.captures.length-1;
 s.cards[id]={id,sku:id,captureId:digest('capture-'+n),photos:capture.photos,stage:held?'exception':'identified',...(held?{}:{identity}),condition:'Near mint or better',title:'',description:'',descriptionSource:'factual',issues:held?[{code:'IDENTITY_REVIEW',owner:'Identity review',detail:'Synthetic uncertain identity'}]:[],nextAction:held?'Retained exception':'Organize',createdAt:now,updatedAt:now} as V2Card;
 if(!held)s.calls.push({id:'call-'+n,cardId:id,key:digest('key-'+n),provider:'openai',model:'synthetic-model',status:'settled',reservedMicros:20000,actualMicros:12000,inputTokens:100,outputTokens:20,at:now});
 });s.lastRun={id:jobId,pid:process.pid,startedAt:now,finishedAt:now,status:'finished',selection:{candidateIds:selection.candidateIds,photoCount:selection.captures.length*2}};},root);
}
test('site job owns intake, retains one identity result, creates named folders and includes identification cost',()=>fixture(async f=>{
 let launches=0,identifications=0;const started=await startV2IdentifySort(f.root,f.raw,undefined,{launch:async()=>{launches++;return{pid:process.pid};}});
 await assert.rejects(startV2IdentifySort(f.root,f.raw,undefined,{launch:async()=>{launches++;return{pid:process.pid};}}),/existing identification/);assert.equal(launches,1);
 await executeV2IdentifySort(f.root,started.jobId,{identify:async selected=>{identifications++;await seed(f.root,started.jobId,selected);}});
 const status=await getV2IdentifySortStatus(f.root),batches=await listV2ReadyBatches(f.root),state=await readV2State(f.root);assert.equal(status?.phase,'complete');assert.equal(status?.identified,2);assert.equal(status?.actualMicros,24000);assert.equal(status?.busy,false);assert.equal(identifications,1);assert.equal(batches.length,1);assert.equal(batches[0].cards.length,2);assert.equal(batches[0].intake.actualMicros,24000);assert.equal(state.calls.length,2);assert.equal(Object.keys(state.prepared).length,0);assert.equal(Object.keys(state.submissions).length,0);
 for(const row of batches[0].cards)for(const p of row.photos){assert.equal(createHash('sha256').update(await fs.readFile(p.path)).digest('hex'),p.hash);assert.equal(path.basename(p.path),path.basename(row.originalPhotos.find(o=>o.hash===p.hash)!.path));}
 await assert.rejects(executeV2IdentifySort(f.root,started.jobId,{identify:async()=>{identifications++;}}),/ownership/);assert.equal(identifications,1);
}));
test('a genuine identity exception stays separate while identified cards reach a named batch',()=>fixture(async f=>{
 const started=await startV2IdentifySort(f.root,f.raw,undefined,{launch:async()=>({pid:process.pid})});await executeV2IdentifySort(f.root,started.jobId,{identify:async selected=>seed(f.root,started.jobId,selected,true)});
 const status=await getV2IdentifySortStatus(f.root),batches=await listV2ReadyBatches(f.root),state=await readV2State(f.root);assert.equal(status?.phase,'complete');assert.equal(status?.exceptions,1);assert.equal(batches[0].cards.length,1);for(const p of state.cards['fixture-1'].photos)await fs.stat(p.path);
}));

test('pre-ID retains duplicate quantity plan before named batch selection without pricing or upload',()=>fixture(async f=>{
 const started=await startV2IdentifySort(f.root,f.raw,undefined,{launch:async()=>({pid:process.pid})});
 await executeV2IdentifySort(f.root,started.jobId,{identify:async selected=>{
  await seed(f.root,started.jobId,selected);
  await withV2State(s=>{s.cards['fixture-1'].identity=structuredClone(s.cards['fixture-0'].identity);},f.root);
 }});
 const job=JSON.parse(await fs.readFile(path.join(f.root,'artifacts/card-processing-v2/identify-sort',started.jobId+'.json'),'utf8'));
 assert.equal(job.consolidation.scope,'selected-batch-only');assert.equal(job.consolidation.physicalCards,2);
 assert.equal(job.consolidation.draftGroups,1);assert.equal(job.consolidation.groups[0].quantity,2);
 const state=await readV2State(f.root);assert.equal(state.calls.length,2);assert.equal(Object.keys(state.prepared).length,0);assert.equal(Object.keys(state.submissions).length,0);
 for(const c of Object.values(state.cards))for(const p of c.photos)assert.equal(createHash('sha256').update(await fs.readFile(p.path)).digest('hex'),p.hash);
}));
test('changed accepted photos stop before identification rather than disappearing as successful work',()=>fixture(async f=>{
 const started=await startV2IdentifySort(f.root,f.raw,undefined,{launch:async()=>({pid:process.pid})});await fs.appendFile(path.join(f.folder,'1-front.jpg'),'changed');let identified=0;await assert.rejects(executeV2IdentifySort(f.root,started.jobId,{identify:async()=>{identified++;}}),/checkpoint recovery/);assert.equal(identified,0);assert.equal((await getV2IdentifySortStatus(f.root))?.phase,'exception');assert.equal((await readV2State(f.root)).calls.length,0);
}));
