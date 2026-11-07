/** Independent process: observes only a local attempt lease, never browser/UI. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
export async function watchV2ReadbackLease(directory,attemptId,deadline){
 if(!path.isAbsolute(directory)||!attemptId||!Number.isFinite(deadline))throw Error('Bounded durable lease required');
 const lock=path.join(directory,'readback-session.lock');
 for(;;){let current;try{current=JSON.parse(await fs.readFile(lock,'utf8'));}catch(error){if(error.code==='ENOENT')return;throw error;}
  if(current.attemptId!==attemptId)return;
  if(Date.now()>=deadline){const record={kind:'browser-session-stalled',attemptId,draftIds:current.draftIds,startedAt:current.startedAt,deadlineAt:new Date(deadline).toISOString(),detectedAt:new Date().toISOString(),status:'recovery-required',nativeCancellationConfirmed:false,nextAction:'Reconcile exact saved IDs and unfinished receipt/archive; isolate old operation before one read-only retry. Never replay upload/identification.'};try{await fs.writeFile(path.join(directory,`stalled-${attemptId}.json`),JSON.stringify(record,null,2),{flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;}return;}
  await new Promise(resolve=>setTimeout(resolve,Math.min(1000,Math.max(1,deadline-Date.now()))));
 }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){watchV2ReadbackLease(process.argv[2],process.argv[3],Number(process.argv[4])).catch(()=>{process.exitCode=1;});}
