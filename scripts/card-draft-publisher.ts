import env from '@next/env';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {chromium,type BrowserContext} from 'playwright-core';
import runtimeRoot from '../lib/card-processing-v2-runtime-root.cjs';
import {createV2PublicationBridgeClient} from '../lib/card-processing-v2-publication-bridge-client.ts';
import {createV2NativePublisher,V2NativePublishUncertainError,type V2NativePublishProof,type V2NativePublishedRow} from '../lib/card-processing-v2-native-publisher.ts';
import {getV2BackgroundStatus} from '../lib/card-processing-v2-background-supervisor.ts';
import {readV2State} from '../lib/card-processing-v2-store.ts';
import {archiveV2ListedPhotos} from '../lib/card-processing-v2-listed-archive.ts';

env.loadEnvConfig(process.cwd());
const root=process.cwd(),sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
function relativeProof(proof:V2NativePublishProof){const relative=path.relative(root,proof.path).replaceAll('\\','/');if(!relative.startsWith('artifacts/')||relative.split('/').includes('..'))throw Error('Publisher evidence escaped local artifacts');return{path:relative,sha256:proof.sha256};}
async function archive(rows:V2NativePublishedRow[],proof:V2NativePublishProof){
 const state=await readV2State(root),authorityPath='artifacts/card-processing-v2-scan-archive48-20261105/request.json';
 const authorityBytes=await fs.readFile(path.join(root,authorityPath));
 const authority={instructionId:'v2-scan-archive48-20261105',evidence:{path:authorityPath,sha256:sha(authorityBytes)}};
 const results:Array<{draftId:string;status:'moved'|'held'|'not-local'}>=[];
 for(const row of rows){const cards=Object.values(state.cards).filter(c=>c.draftId===row.draftId&&c.sku===row.sku);
  if(!cards.length){results.push({draftId:row.draftId,status:'not-local'});continue;}
  let held=false;for(let i=0;i<cards.length;i+=25){const observed=await archiveV2ListedPhotos(root,{cardIds:cards.slice(i,i+25).map(c=>c.id),authority,observation:relativeProof(proof),disposition:'listed'});if(observed.some(r=>r.status!=='moved'))held=true;}
  results.push({draftId:row.draftId,status:held?'held':'moved'});
 }return results;
}
async function main(){
 runtimeRoot.assertV2RuntimeRoot(root);
 const args=process.argv.slice(2),enabled=args.includes('--allow-publish');
 if(!enabled)throw Error('Start only after migration/deployment approval using --allow-publish; no worker was attached');
 const site='https://legends-os-beta.vercel.app',bridge=createV2PublicationBridgeClient(site,process.env.OPERATOR_PASSWORD??''),workerId=bridge.workerId;
 const profile=path.join(root,'artifacts/card-processing-v2/background/profile'),evidenceDir=path.join(root,'artifacts/card-processing-v2/publication/evidence');
 for(const directory of[profile,evidenceDir]){await fs.mkdir(directory,{recursive:true});if((await fs.lstat(directory)).isSymbolicLink())throw Error('Publisher directories must remain ordinary local directories');}
 let stopping=false,context:BrowserContext|undefined,sellerObservedAt:string|undefined,lastCheck=0;
 process.on('SIGINT',()=>{stopping=true;});process.on('SIGTERM',()=>{stopping=true;});
 const open=async()=>{if((await getV2BackgroundStatus(root)).busy)throw Error('The card workflow owns the dedicated browser');context=await chromium.launchPersistentContext(profile,{headless:false,channel:'msedge',args:['--start-minimized'],viewport:{width:1365,height:1000},timeout:30000});const page=context.pages()[0]??await context.newPage();page.setDefaultTimeout(15000);return page;};
 try{while(!stopping){
  if(Date.now()-lastCheck>60_000){try{const page=await open(),publisher=createV2NativePublisher({page,evidenceDir,checkpoint:async()=>{throw Error('No job owns this connection check');},acceptDisplayedAgreements:async()=>false});sellerObservedAt=(await publisher.observeSellerSession()).observedAt;lastCheck=Date.now();}catch{sellerObservedAt=undefined;}finally{await context?.close().catch(()=>undefined);context=undefined;}}
  if(!sellerObservedAt){await bridge.heartbeat(workerId,'LOGIN_REQUIRED');await sleep(10000);continue;}
  await bridge.heartbeat(workerId,'READY',sellerObservedAt);const claimed=await bridge.claim(workerId);if(!claimed.job){await sleep(10000);continue;}
  const job=claimed.job,lease={workerId,jobId:job.id,leaseToken:job.leaseToken};let writeCheckpoint=false;
  const live=new Map<string,V2NativePublishedRow>(),archives=new Map<string,'moved'|'held'|'not-local'>();
  const timer=setInterval(()=>{void bridge.heartbeat(workerId,'BUSY',sellerObservedAt).then(()=>bridge.send({action:'checkpoint',...lease,phase:'verifying'})).catch(()=>undefined);},15000);
  try{const page=await open(),publisher=createV2NativePublisher({page,evidenceDir,
   checkpoint:async(phase,details)=>{if(stopping)throw Error('Publisher is stopping before a new remote action');
    if(phase==='before-price-edit'||phase==='before-final-submit'){
     const draftIds=phase==='before-price-edit'?[String(details.draftId)]:details.draftIds as string[];
     const proof=details.agreement as V2NativePublishProof|undefined;
     await bridge.send({action:'checkpoint',...lease,phase,draftIds,...(proof?{evidence:relativeProof(proof)}:{})});writeCheckpoint=true;
    }else if(phase==='active-verified'){
     const rows=details.rows as V2NativePublishedRow[],proof=details.evidence as V2NativePublishProof;
     const observations=rows.map(({raw:_,...row})=>row);
     await bridge.send({action:'checkpoint',...lease,phase:'published-group',draftIds:rows.map(r=>r.draftId),observations,evidence:relativeProof(proof)});
     rows.forEach(row=>live.set(row.draftId,row));
     try{for(const result of await archive(rows,proof))archives.set(result.draftId,result.status);}catch{rows.forEach(row=>archives.set(row.draftId,'held'));}
    }else await bridge.send({action:'checkpoint',...lease,phase:'verifying',draftIds:details.draftIds as string[]});},
   // Exact operator review authorizes only this queued group and explicit manual prices.
   acceptDisplayedAgreements:async()=>!stopping&&job.targets.length>0});
   await publisher.publish({requestId:job.id,targets:job.targets});
   await bridge.send({action:'complete',...lease,published:Array.from(live.values()).map(({raw:_,...row})=>row),exceptions:[],archives:Array.from(archives).map(([draftId,status])=>({draftId,status}))});
  }catch(error){
   if(live.size){await bridge.send({action:'complete',...lease,published:Array.from(live.values()).map(({raw:_,...row})=>row),exceptions:job.targets.filter(t=>!live.has(t.draftId)).map(t=>({draftId:t.draftId,reason:'Native result requires reconciliation; do not submit a replacement.'})),archives:Array.from(archives).map(([draftId,status])=>({draftId,status}))}).catch(()=>undefined);}
   else await bridge.send({action:'stop',...lease,reason:'Native publisher stopped. Retained evidence must be reconciled before another request.',remoteOutcomeUncertain:writeCheckpoint||error instanceof V2NativePublishUncertainError}).catch(()=>undefined);
  }finally{clearInterval(timer);await context?.close().catch(()=>undefined);context=undefined;lastCheck=0;}
 }}finally{await context?.close().catch(()=>undefined);await bridge.heartbeat(workerId,'ERROR').catch(()=>undefined);}
}
main().catch(()=>{console.error('Selected-draft publisher stopped. Review the retained request and connection status; no automatic replay.');process.exitCode=1;});

