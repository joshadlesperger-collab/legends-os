import fs from 'node:fs/promises';
import runtimeRoot from './card-processing-v2-runtime-root.cjs';
import {measureV2} from './card-processing-v2-timing.ts';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import type {V2State} from './card-processing-v2.ts';
import {planV2BatchConsolidation,v2BatchConsolidationSchema} from './card-processing-v2-batch-consolidation.ts';
import { readV2State, processAlive, readV2Config } from './card-processing-v2-store.ts';
import { resolveV2Selection, listV2Candidates, v2SelectionSchema, candidateId, type ResolvedV2Selection } from './card-processing-v2-selection.ts';
import {validateV2ClickedAt} from './card-processing-v2-processing-batches.ts';
import { replaceV2Checkpoint } from './card-processing-v2-atomic-replace.ts';

const CREDIT_PAUSE_DETAIL='OpenAI API credit balance exhausted. Identification is paused; completed results, original photos and uncertain usage are preserved. Restore provider credit before explicit recovery.';
const id = z.string().uuid();
const statusSchema = z.object({ id, pid:z.number().int().nonnegative(), phase:z.enum(['starting','identifying','sorting','complete','exception']), startedAt:z.string().datetime(), updatedAt:z.string().datetime(), finishedAt:z.string().datetime().optional(), detail:z.string(), cardIds:z.array(z.string()), candidateIds:z.array(z.string()), baselineCallIds:z.array(z.string()), batchIds:z.array(z.string()), consolidation:v2BatchConsolidationSchema.optional(), organizationExceptions:z.array(z.object({cardId:z.string(),detail:z.string()})).optional(), restarts:z.number().int().min(0).max(3) }).strict();
export type V2IdentifySortJob = z.infer<typeof statusSchema>;
const dir = (root:string)=>path.join(root,'artifacts/card-processing-v2/identify-sort');
const currentFile = (root:string)=>path.join(dir(root),'current.json');
async function save(root:string, job:V2IdentifySortJob) {
  const file=path.join(dir(root),job.id+'.json'), temporary=file+'.'+randomUUID()+'.tmp';
  await fs.writeFile(temporary,JSON.stringify(statusSchema.parse(job)),{flag:'wx',flush:true});
  await replaceV2Checkpoint(temporary,file);
}
async function read(root:string,jobId:string) { return statusSchema.parse(JSON.parse(await fs.readFile(path.join(dir(root),id.parse(jobId)+'.json'),'utf8'))); }
async function lock(root:string) {
  runtimeRoot.assertV2RuntimeRoot(root);
  await fs.mkdir(dir(root),{recursive:true}); const file=path.join(dir(root),'control.lock');
  try { const previous=JSON.parse(await fs.readFile(file,'utf8')); if(!Number.isInteger(previous.pid)||!previous.token||processAlive(previous.pid))throw Error('Identification control is busy');
    const guard=file+'.recovery',guardToken=randomUUID();await fs.writeFile(guard,JSON.stringify({pid:process.pid,token:guardToken}),{flag:'wx',flush:true});
    try{const current=JSON.parse(await fs.readFile(file,'utf8'));if(current.pid!==previous.pid||current.token!==previous.token||processAlive(current.pid))throw Error('Identification control ownership changed');await fs.unlink(file);}finally{const owned=JSON.parse(await fs.readFile(guard,'utf8'));if(owned.token===guardToken)await fs.unlink(guard);}
  } catch(error) { if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error; }
  const token=randomUUID(); await fs.writeFile(file,JSON.stringify({pid:process.pid,token}),{flag:'wx',flush:true});
  return async()=>{const held=JSON.parse(await fs.readFile(file,'utf8'));if(held.token!==token)throw Error('Identification control changed');await fs.unlink(file);};
}
export const acquireV2FlowStart=lock;
async function launch(root:string,job:V2IdentifySortJob) {
  const child=spawn(process.execPath,['--experimental-strip-types',path.join(root,'scripts/card-processing-v2-identify-sort.ts'),job.id],{cwd:root,detached:true,windowsHide:true,stdio:'ignore'});
  if(!child.pid)throw Error('Identification worker could not start'); child.unref();
  job.pid=child.pid;job.updatedAt=new Date().toISOString();await save(root,job);await ensureWatchdog(root,job.id);return{jobId:job.id,pid:child.pid,phase:job.phase};
}
async function ensureWatchdog(root:string,jobId:string) {
  const file=path.join(dir(root),jobId+'-watchdog.json');
  try{const prior=JSON.parse(await fs.readFile(file,'utf8'));if(processAlive(prior.pid))return;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const child=spawn(process.execPath,['--experimental-strip-types',path.join(root,'scripts/card-processing-v2-identify-sort.ts'),'--watch',jobId],{cwd:root,detached:true,windowsHide:true,stdio:'ignore'});
  if(!child.pid)throw Error('Identification recovery watcher could not start');child.unref();const temporary=file+'.'+randomUUID()+'.tmp';await fs.writeFile(temporary,JSON.stringify({id:jobId,pid:child.pid}),{flag:'wx',flush:true});await replaceV2Checkpoint(temporary,file);
}
export async function watchV2IdentifySort(root:string,jobId:string) {
  id.parse(jobId);const file=path.join(dir(root),jobId+'-watchdog.json');let owned=false;
  for(let n=0;n<100;n++){try{const current=JSON.parse(await fs.readFile(file,'utf8'));if(current.pid===process.pid){owned=true;break;}if(current.pid&&processAlive(current.pid))throw Error('Another identification watcher owns this job');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}await new Promise(resolve=>setTimeout(resolve,20));}
  if(!owned)throw Error('Identification watcher was not acknowledged');
  while(true){const job=await read(root,jobId);if(['complete','exception'].includes(job.phase))return;if(!processAlive(job.pid)){if(job.restarts>=3)return;await recoverV2IdentifySort(root);}await new Promise(resolve=>setTimeout(resolve,2000));}
}
export async function startV2IdentifySort(root:string,raw:unknown,clickedAt?:string,deps:{launch?:(job:V2IdentifySortJob)=>Promise<{pid:number}>}={}) {
 runtimeRoot.assertV2RuntimeRoot(root);const runId=randomUUID();return measureV2(root,'identify-sort-admission',()=>startV2IdentifySortLocal(root,raw,clickedAt,deps,runId),{runId});
}
async function startV2IdentifySortLocal(root:string,raw:unknown,clickedAt:string|undefined,deps:{launch?:(job:V2IdentifySortJob)=>Promise<{pid:number}>},jobId:string,unsentParentId?:string) {
  runtimeRoot.assertV2RuntimeRoot(root);if(process.env.VERCEL)throw Error('Identification requires the local scanner host');
  const release=await lock(root);try {
    const existing=await getV2IdentifySortStatus(root);
    let parent:V2IdentifySortJob|undefined,parentRequestBytes:string|undefined;
    if(unsentParentId){
      parent=await read(root,unsentParentId);
      if(existing?.id!==parent.id||parent.phase!=='exception'||parent.detail!==CREDIT_PAUSE_DETAIL||processAlive(parent.pid))throw Error('Exact stopped credit-paused intake is required');
      try{const watcher=JSON.parse(await fs.readFile(path.join(dir(root),parent.id+'-watchdog.json'),'utf8'));if(watcher.id!==parent.id||!Number.isInteger(watcher.pid)||watcher.pid<1||processAlive(watcher.pid))throw Error('Credit-paused watcher must be stopped');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      parentRequestBytes=await fs.readFile(path.join(dir(root),parent.id+'-request.json'),'utf8');
      const request=JSON.parse(parentRequestBytes);
      if(!Array.isArray(request.photos)||request.photos.length!==parent.candidateIds.length||new Set(request.photos.map((p:{candidateId:string})=>p.candidateId)).size!==parent.candidateIds.length||request.photos.some((p:{candidateId:string})=>!parent!.candidateIds.includes(p.candidateId)))throw Error('Paused original scope is invalid');
      const current=await listV2Candidates(root),state=await readV2State(root),called=new Set(state.calls.map(c=>c.cardId));
      const ids=current.candidates.filter(candidate=>{const card=candidate.cardId?state.cards[candidate.cardId]:undefined;return candidate.eligible&&parent!.candidateIds.includes(candidate.id)&&!!card&&!called.has(card.id)&&!card.identity&&!card.draftId&&!card.issues.length;}).map(c=>c.id);
      if(!ids.length)throw Error('No never-attempted original pairs remain in this paused intake');
      raw={mode:'selected',token:current.token,candidateIds:ids};
    }else if(existing&&existing.phase!=='complete')throw Error('Resume the existing identification job before starting another');
    const selection=v2SelectionSchema.parse(raw);if(selection.sourceTransferId||selection.readyBatchId||selection.readyBatchIds)throw Error('Identify new loose scans only; ready batches reuse their saved identities');
    const selected=await resolveV2Selection(root,selection),state=await readV2State(root),config=await readV2Config(root);
    if(parent){const request=JSON.parse(parentRequestBytes!);for(const capture of selected.captures){const card=capture.cardId?state.cards[capture.cardId]:undefined,original=request.photos.find((p:{candidateId:string})=>p.candidateId===capture.candidateId);if(!card||card.identity||card.draftId||card.issues.length||state.calls.some(c=>c.cardId===card.id)||!original||original.photos.length!==2||capture.photos.some(p=>!original.photos.some((o:{hash:string;path:string})=>o.hash===p.hash&&path.resolve(o.path).toLowerCase()===path.resolve(p.path).toLowerCase())))throw Error('Never-attempted remainder changed or does not match its accepted original pair');}}
    const background=await (await import('./card-processing-v2-background-supervisor.ts')).getV2BackgroundStatus(root);
    // The draft runner reacquires the shared worker lease between browser jobs.
    // Even a disjoint upload phase cannot safely overlap a new identification run.
    if(background.busy)throw Error('Let the current draft batch finish before identifying another batch');
    if(parent)await fs.writeFile(path.join(dir(root),jobId+'-parent-reference.json'),JSON.stringify({kind:'never-attempted-intake-remainder',parentJobId:parent.id,parentStartedAt:parent.startedAt,parentPausedAt:parent.finishedAt,parentRequestSha256:createHash('sha256').update(parentRequestBytes!).digest('hex'),childJobId:jobId,candidateIds:selected.candidateIds,createdAt:new Date().toISOString(),priorCallsExcluded:true,priorAccountingUnchanged:true}),{flag:'wx',flush:true});
    if(!config.identification)throw Error('Identification model configuration is unavailable');
    const now=new Date().toISOString(),job:V2IdentifySortJob={id:jobId,pid:0,phase:'starting',startedAt:validateV2ClickedAt(clickedAt,now),updatedAt:now,detail:'Identification and sorting accepted; no draft upload or pricing.',cardIds:[],candidateIds:selected.candidateIds,baselineCallIds:state.calls.map(c=>c.id),batchIds:[],restarts:0};
    await fs.writeFile(path.join(dir(root),jobId+'-request.json'),JSON.stringify({selection:{mode:'selected',token:selected.token,candidateIds:selected.candidateIds},photos:selected.captures.map(c=>({candidateId:c.candidateId,photos:c.photos.map(p=>({path:p.path,hash:p.hash}))}))}),{flag:'wx',flush:true});
    await save(root,job);const pointer=currentFile(root)+'.'+randomUUID()+'.tmp';await fs.writeFile(pointer,JSON.stringify({id:jobId}),{flag:'wx',flush:true});await replaceV2Checkpoint(pointer,currentFile(root));if(deps.launch){const started=await deps.launch(job);job.pid=started.pid;await save(root,job);return{jobId:job.id,pid:job.pid,phase:job.phase};}return await launch(root,job);
  }finally{await release();}
}
/** Explicit new admission for untouched original pairs only; the paused parent is immutable. */
export async function startV2UnsentIntakeRemainder(root:string,pausedJobId:string,deps:{launch?:(job:V2IdentifySortJob)=>Promise<{pid:number}>}={}) {
  runtimeRoot.assertV2RuntimeRoot(root);id.parse(pausedJobId);const runId=randomUUID();
  return measureV2(root,'identify-sort-unsent-remainder-admission',()=>startV2IdentifySortLocal(root,undefined,undefined,deps,runId,pausedJobId),{runId});
}
export async function peekV2IdentifySort(root:string){let current;try{current=JSON.parse(await fs.readFile(currentFile(root),'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}const job=await read(root,current.id),busy=!['complete','exception'].includes(job.phase)&&processAlive(job.pid);return{...job,busy,interrupted:!['complete','exception'].includes(job.phase)&&!busy};}
/** Terminal checkpoint only after the exact worker and recovery watcher have stopped.
 * Never terminates processes, settles unknown calls, removes photos or changes prices. */
export async function pauseV2IdentifySort(root:string,jobId:string,reason:'provider-credit-exhausted') {
  runtimeRoot.assertV2RuntimeRoot(root);id.parse(jobId);
  if(reason!=='provider-credit-exhausted')throw Error('A supported safe pause reason is required');
  const release=await lock(root);
  try {
    const current=JSON.parse(await fs.readFile(currentFile(root),'utf8'));
    if(current.id!==jobId)throw Error('Pause must target the exact current identification job');
    const job=await read(root,jobId);
    if(job.phase==='complete')throw Error('Completed identification cannot be paused');
    if(processAlive(job.pid))throw Error('Stop the exact identification worker before recording its pause');
    try {
      const watcher=JSON.parse(await fs.readFile(path.join(dir(root),jobId+'-watchdog.json'),'utf8'));
      if(watcher.id!==jobId||!Number.isInteger(watcher.pid)||watcher.pid<1)throw Error('Identification watcher ownership is invalid');
      if(processAlive(watcher.pid))throw Error('Stop the exact identification recovery watcher before recording its pause');
    }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    const now=new Date().toISOString();
    const paused:V2IdentifySortJob={...job,phase:'exception',updatedAt:now,finishedAt:job.finishedAt??now,detail:CREDIT_PAUSE_DETAIL};
    await save(root,paused);
    return {jobId:job.id,phase:paused.phase,paused:true,providerCalls:0,photoWrites:0,usageReconciled:false,startedAt:job.startedAt,finishedAt:paused.finishedAt};
  }finally{await release();}
}
export async function getV2IdentifySortStatus(root:string,retainedState?:V2State) {
  const job=await peekV2IdentifySort(root);if(!job)return null;
  const state=retainedState??await readV2State(root),members=Object.values(state.cards).filter(c=>job.candidateIds.includes(candidateId(c.photos))),calls=state.calls.filter(c=>!job.baselineCallIds.includes(c.id)&&members.some(card=>card.id===c.cardId));
  const busy=!['complete','exception'].includes(job.phase)&&processAlive(job.pid),actualMicros=calls.reduce((sum,c)=>sum+(c.status==='settled'?c.actualMicros??0:0),0);
  return{...job,busy,interrupted:!['complete','exception'].includes(job.phase)&&!busy,total:job.candidateIds.length,identified:members.filter(c=>!!c.identity).length,exceptions:new Set([...members.filter(c=>c.issues.length).map(c=>c.id),...(job.organizationExceptions??[]).map(c=>c.cardId)]).size,actualMicros,pendingCost:calls.some(c=>c.status!=='settled'),elapsedMs:Math.max(0,Date.parse(job.finishedAt??new Date().toISOString())-Date.parse(job.startedAt))};
}
export async function executeV2IdentifySort(root:string,jobId:string,deps:{identify?:(selected:ResolvedV2Selection)=>Promise<void>}={}) {
  let job=await read(root,jobId);for(let n=0;job.pid===0&&n<100;n++){await new Promise(resolve=>setTimeout(resolve,20));job=await read(root,jobId);}
  if(job.pid!==process.pid||['complete','exception'].includes(job.phase))throw Error('Exact identification worker ownership required');
  let saves=Promise.resolve();
  const progress=(phase:V2IdentifySortJob['phase'],detail:string)=>{job={...job,phase,detail,updatedAt:new Date().toISOString()};const snapshot=structuredClone(job);saves=saves.then(()=>save(root,snapshot));return saves;};
  const heartbeat=setInterval(()=>{void progress(job.phase,job.detail).catch(()=>undefined);},10000);
  try {
    const request=JSON.parse(await fs.readFile(path.join(dir(root),job.id+'-request.json'),'utf8'));
    if(job.phase!=='sorting'){
      if(!Array.isArray(request.photos)||request.photos.length!==job.candidateIds.length||request.photos.some((p:{candidateId:string})=>!job.candidateIds.includes(p.candidateId)))throw Error('Accepted identification membership changed');
      for(const pair of request.photos)for(const photo of pair.photos){const stat=await fs.lstat(photo.path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>35000000||path.resolve(await fs.realpath(photo.path)).toLowerCase()!==path.resolve(photo.path).toLowerCase()||createHash('sha256').update(await fs.readFile(photo.path)).digest('hex')!==photo.hash)throw Error('Accepted identification original is missing or changed');}
      const current=await listV2Candidates(root),ids=current.candidates.filter(c=>c.eligible&&job.candidateIds.includes(c.id)).map(c=>c.id);
      if(ids.length){const selected=await resolveV2Selection(root,{mode:'selected',token:current.token,candidateIds:ids});
        for(const capture of selected.captures){const original=request.photos.find((p:{candidateId:string})=>p.candidateId===capture.candidateId);if(!original||capture.photos.some(p=>!original.photos.some((o:{hash:string;path:string})=>o.hash===p.hash&&path.resolve(o.path).toLowerCase()===path.resolve(p.path).toLowerCase())))throw Error('Accepted identification originals changed');}
        await progress('identifying','Identifying each original pair once; saved identities are reused.');
        if(deps.identify)await deps.identify(selected);else{const {runV2}=await import('./card-processing-v2-worker.ts');await runV2(root,job.id,{selection:selected,identifyOnly:true});}
      }
    }
    const state=await readV2State(root);job.cardIds=Object.values(state.cards).filter(c=>job.candidateIds.includes(candidateId(c.photos))).map(c=>c.id);
    await progress('sorting','Organizing identified cards into named batches; original filenames are preserved.');
    const {organizeV2ReadyCards,recoverV2ReadyBatchMoves,inspectV2ReadyOrganizationScope}=await import('./card-processing-v2-ready-batches.ts');
    await recoverV2ReadyBatchMoves(root);
    const refreshed=await readV2State(root),readyIds=job.cardIds.filter(cardId=>{const c=refreshed.cards[cardId];return c?.identity&&!c.issues.length&&!c.draftId;});
    const scope=await inspectV2ReadyOrganizationScope(root,readyIds);job.organizationExceptions=scope.exceptions;
    job.consolidation=await measureV2(root,'batch-consolidation',async()=>planV2BatchConsolidation(refreshed,scope.eligible),{runId:job.id});
    const batches=scope.eligible.length?await organizeV2ReadyCards(root,{runId:job.id,cardIds:scope.eligible}):[];
    job.batchIds=batches.map(b=>b.id);job.finishedAt=new Date().toISOString();await progress('complete','Identification and sorting finished. Select a named batch to create drafts.');
  }catch(error){const failedPhase=job.phase,frames=error instanceof Error?(error.stack??'').split('\n').slice(1).flatMap(line=>{const found=/(?:[\\/])((?:lib|scripts)[\\/]card-processing-v2-[\w.-]+):(\d+):(\d+)/.exec(line);return found?[{file:found[1],line:Number(found[2]),column:Number(found[3])}]:[];}).slice(0,8):[];await fs.writeFile(path.join(dir(root),job.id+'-exception-'+randomUUID()+'.json'),JSON.stringify({kind:'identify-sort-exception',phase:failedPhase,at:new Date().toISOString(),frames,rawProviderDetailsRetained:false}),{flag:'wx',flush:true});job.finishedAt=new Date().toISOString();await progress('exception','Identification or sorting stopped at its saved checkpoint. Photos and prior identification results are preserved.');throw Error('Identify and sort needs checkpoint recovery');}
  finally{clearInterval(heartbeat);await saves.catch(()=>undefined);}
}
export async function recoverV2IdentifySort(root:string) {
  const release=await lock(root);try{const current=await getV2IdentifySortStatus(root);if(!current?.interrupted||current.restarts>=3)return{recovered:false};const job=await read(root,current.id);job.restarts++;job.pid=0;job.updatedAt=new Date().toISOString();await save(root,job);return{recovered:true,...await launch(root,job)};}finally{await release();}
}

export async function resumeV2IdentifySort(root:string,jobId:string) {
 const release=await lock(root);try{const current=await getV2IdentifySortStatus(root);if(!current||current.id!==id.parse(jobId)||current.busy||current.phase==='complete')throw Error('Exact unfinished identification job required');const job=await read(root,jobId);job.phase=job.cardIds.length?'sorting':'identifying';job.pid=0;job.restarts=0;delete job.finishedAt;job.detail='Resuming the same identification and folder-move checkpoints.';await save(root,job);return await launch(root,job);}finally{await release();}
}
