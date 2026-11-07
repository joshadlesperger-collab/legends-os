import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn,type ChildProcess} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {emptyV2State,digest,type V2Card} from '../lib/card-processing-v2.ts';
import {readV2State,processAlive,v2Dir} from '../lib/card-processing-v2-store.ts';
import {candidateId} from '../lib/card-processing-v2-selection.ts';
import {resolveV2ReadyBatch} from '../lib/card-processing-v2-ready-batches.ts';

const sha=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function exited(child:ChildProcess,timeout=10000){if(child.exitCode!==null||child.signalCode!==null)return;await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Owned fixture process did not exit')),timeout);child.once('exit',()=>{clearTimeout(timer);resolve();});child.once('error',error=>{clearTimeout(timer);reject(error);});});}

test('real hidden identify-sort watchdog recovers a dead sorting worker into the same folders without another identification',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'v2-intake-watchdog-')),folder=path.join(root,'scans'),runId=randomUUID(),intake=path.join(v2Dir(root),'identify-sort'),startedAt=new Date(Date.now()-5000).toISOString(),owned:ChildProcess[]=[];let recoveredPid:number|undefined;
 try{
  await fs.mkdir(folder);await fs.mkdir(intake,{recursive:true});await fs.mkdir(path.join(root,'scripts'));
  await fs.writeFile(path.join(v2Dir(root),'config.json'),JSON.stringify({folder,pairing:'named',categories:[]}));
  const state=emptyV2State(),cards:V2Card[]=[];
  for(let n=0;n<2;n++){
   const photos=[];for(const side of ['front','back']as const){const bytes=Buffer.from(`unchanged original ${n} ${side}`),file=path.join(folder,`Card000${n+1}${side==='front'?'F':'B'}192351.jpg`);await fs.writeFile(file,bytes);photos.push({path:file,hash:sha(bytes),side});}
   const card:V2Card={id:'watch-card-'+n,sku:'watch-card-'+n,captureId:digest('capture-'+n),photos,stage:'identified',identity:{name:'Player '+n,year:'2024-25',manufacturer:'Panini',product:'Prizm Black',number:String(n),categoryId:'261328',language:'English',variant:'Red Wave Prizm',artwork:'Player',sportOrGame:'Basketball',team:'Test',serial:'',graded:false,damage:false,specifics:{}},condition:'Near mint or better',title:'',description:'',descriptionSource:'factual',issues:[],nextAction:'Organize existing identification',createdAt:startedAt,updatedAt:startedAt};cards.push(card);state.cards[card.id]=card;
   state.calls.push({id:'retained-call-'+n,cardId:card.id,key:digest('call-key-'+n),provider:'openai',model:'fixture-retained-result',status:'settled',reservedMicros:1000,actualMicros:200,inputTokens:100,outputTokens:50,at:startedAt});
  }
  state.lastRun={id:runId,pid:process.pid,startedAt,finishedAt:startedAt,status:'finished',selection:{candidateIds:cards.map(c=>candidateId(c.photos)),photoCount:4}};
  await fs.writeFile(path.join(v2Dir(root),'state.json'),JSON.stringify(state));
  const request={selection:{mode:'selected',token:digest('original-selection'),candidateIds:cards.map(c=>candidateId(c.photos))},photos:cards.map(c=>({candidateId:candidateId(c.photos),photos:c.photos.map(({path,hash})=>({path,hash}))}))},requestBytes=JSON.stringify(request),requestFile=path.join(intake,runId+'-request.json');await fs.writeFile(requestFile,requestBytes);
  // This proxy only selects the actual coordinator exports; it has no provider
  // adapter, mocked organizer, browser or synthetic completion path.
  const moduleUrl=pathToFileURL(fileURLToPath(new URL('../lib/card-processing-v2-identify-sort.ts',import.meta.url))).href;
  await fs.writeFile(path.join(root,'scripts/card-processing-v2-identify-sort.ts'),`import {watchV2IdentifySort,executeV2IdentifySort} from ${JSON.stringify(moduleUrl)};\nconst watch=process.argv[2]==='--watch';await(watch?watchV2IdentifySort(process.cwd(),process.argv[3]):executeV2IdentifySort(process.cwd(),process.argv[2]));\n`);
  const predecessor=spawn(process.execPath,['-e','setTimeout(()=>process.exit(23),100)'],{cwd:root,windowsHide:true,stdio:'ignore'});owned.push(predecessor);assert.ok(predecessor.pid);
  const job={id:runId,pid:predecessor.pid!,phase:'sorting',startedAt,updatedAt:startedAt,detail:'Actual predecessor exited during sorting',cardIds:cards.map(c=>c.id),candidateIds:cards.map(c=>candidateId(c.photos)),baselineCallIds:[],batchIds:[],restarts:0};await fs.writeFile(path.join(intake,runId+'.json'),JSON.stringify(job));await fs.writeFile(path.join(intake,'current.json'),JSON.stringify({id:runId}));await exited(predecessor);assert.equal(predecessor.exitCode,23);assert.equal(processAlive(predecessor.pid!),false);
  const watcher=spawn(process.execPath,['--experimental-strip-types',path.join(root,'scripts/card-processing-v2-identify-sort.ts'),'--watch',runId],{cwd:root,windowsHide:true,stdio:'ignore'});owned.push(watcher);assert.ok(watcher.pid);await fs.writeFile(path.join(intake,runId+'-watchdog.json'),JSON.stringify({id:runId,pid:watcher.pid}));
  let final=job;const deadline=Date.now()+20000;
  while(Date.now()<deadline){final=JSON.parse(await fs.readFile(path.join(intake,runId+'.json'),'utf8'));if(final.pid!==predecessor.pid)recoveredPid=final.pid;if(['complete','exception'].includes(final.phase))break;await pause(100);}
  assert.equal(final.phase,'complete','real watcher must complete without a page or chat handoff');assert.equal(final.id,runId);assert.equal(final.restarts,1);assert.equal(final.startedAt,startedAt);assert.notEqual(final.pid,predecessor.pid);assert.equal(final.batchIds.length,1);assert.equal(sha(await fs.readFile(requestFile)),sha(requestBytes));
  const after=await readV2State(root);assert.deepEqual(after.calls,state.calls,'saved identity calls must not be repeated or reset');assert.deepEqual(after.submissions,state.submissions);assert.deepEqual(after.prepared,state.prepared);const manifest=await resolveV2ReadyBatch(root,final.batchIds[0]);assert.equal(manifest.intake.runId,runId);assert.equal(manifest.intake.startedAt,startedAt);assert.deepEqual(manifest.intake.callIds,state.calls.map(c=>c.id));assert.equal(manifest.intake.actualMicros,400);for(const row of manifest.cards)for(const original of row.originalPhotos)await assert.rejects(fs.stat(original.path),/ENOENT/);
  await exited(watcher);const until=Date.now()+5000;while(recoveredPid&&processAlive(recoveredPid)&&Date.now()<until)await pause(50);assert.equal(recoveredPid?processAlive(recoveredPid):true,false);
 }finally{
  for(const child of owned){if(child.exitCode===null&&child.signalCode===null)child.kill();await exited(child).catch(()=>undefined);}
  if(recoveredPid&&processAlive(recoveredPid)){process.kill(recoveredPid);const until=Date.now()+5000;while(processAlive(recoveredPid)&&Date.now()<until)await pause(50);}
  const absolute=path.resolve(root),temporaryBase=path.resolve(os.tmpdir());if(path.dirname(absolute)!==temporaryBase||!path.basename(absolute).startsWith('v2-intake-watchdog-'))throw Error('Fixture cleanup scope changed');await fs.rm(absolute,{recursive:true,force:true});
 }
});
