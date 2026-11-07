import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import type {ResolvedV2Selection} from './card-processing-v2-selection.ts';
import {readV2State,v2Dir} from './card-processing-v2-store.ts';
import {newV2ProcessingBatch,writeV2ProcessingBatch,acknowledgeV2ProcessingBatchSpawn} from './card-processing-v2-processing-batches.ts';
import {startV2BackgroundRun} from './card-processing-v2-background-supervisor.ts';

export function v2ReadyUnionIntake(state:Awaited<ReturnType<typeof readV2State>>,selected:ResolvedV2Selection,ready:Array<{intake:{startedAt:string;callIds:string[]}}>){
 const owners=new Set(selected.captures.flatMap(c=>c.cardId?[c.cardId]:[])),ids=new Set(ready.flatMap(m=>m.intake.callIds)),calls=state.calls.filter(c=>ids.has(c.id)&&owners.has(c.cardId));
 return{startedAt:ready.map(m=>m.intake.startedAt).sort()[0],callIds:calls.map(c=>c.id),actualMicros:calls.reduce((n,c)=>n+(c.status==='settled'?c.actualMicros??0:0),0)};
}
/** A real detached runner, never an instruction for a future chat turn. */
export async function startV2BackgroundBatch(root:string,selected:ResolvedV2Selection,clickedAt:string){
 const jobId=randomUUID(),readyIds=selected.readyBatchIds??(selected.readyBatchId?[selected.readyBatchId]:[]),readyScope=readyIds.length?await(await import('./card-processing-v2-ready-batches.ts')).resolveV2ReadyBatchSet(root,readyIds):undefined,ready=readyScope?.manifests??[];
 const state=readyScope?.state??await readV2State(root);
 const batch={...newV2ProcessingBatch(jobId,selected,state,clickedAt),...(ready.length?{processVersion:selected.readyBatchIds?'v2-ready-union-8':'v2-named-batches-6',intake:v2ReadyUnionIntake(state,selected,ready)}:{})};
 await fs.mkdir(v2Dir(root),{recursive:true});await writeV2ProcessingBatch(root,batch,true);
 const selectionFile=path.join(v2Dir(root),`selection-${jobId}.json`);
 try{
  await fs.writeFile(selectionFile,JSON.stringify({mode:'selected',token:selected.token,candidateIds:selected.candidateIds,...(selected.sourceTransferId?{sourceTransferId:selected.sourceTransferId}:{}),...(selected.readyBatchId?{readyBatchId:selected.readyBatchId}:{}),...(selected.readyBatchIds?{readyBatchIds:selected.readyBatchIds}:{})}),{flag:'wx',flush:true});
  const started=await startV2BackgroundRun(root,jobId,{selectionFile,clickedAt});
  await acknowledgeV2ProcessingBatchSpawn(root,batch,started.pid);
  return{...started,executionMode:'end-to-end' as const,executor:'dedicated-local-browser' as const};
 }catch(error){await writeV2ProcessingBatch(root,{...batch,status:'failed',failure:'Worker could not start; no processing completion is claimed.'});throw error;}
}
