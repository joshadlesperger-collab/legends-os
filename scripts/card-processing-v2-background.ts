import env from '@next/env';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createV2BackgroundBrowser} from '../lib/card-processing-v2-background-browser.ts';
import {enterV2BackgroundProcess,updateV2BackgroundStatus,recoverV2BackgroundRun,ensureV2BackgroundWatchdog} from '../lib/card-processing-v2-background-supervisor.ts';
import {executeV2BackgroundBatch,retainV2BackgroundEvidence} from '../lib/card-processing-v2-background-pipeline.ts';
import {v2SellerAccess} from '../lib/card-processing-v2-connection.ts';
import {runV2} from '../lib/card-processing-v2-worker.ts';
import {resolveV2Selection} from '../lib/card-processing-v2-selection.ts';
import {v2PhotoHost} from '../lib/card-processing-v2-media.ts';
import {fetchV2Categories} from '../lib/card-processing-v2-category.ts';
import {inspectV2Readiness,activateV2PreparedContext,V2ReadinessError} from '../lib/card-processing-v2-readiness.ts';
import {readV2BackgroundAuthority} from '../lib/card-processing-v2-draft-lifecycle.ts';
import {resolveV2BackgroundRemainingSelection} from '../lib/card-processing-v2-background-selection.ts';
import {measureV2,recoverV2Timings} from '../lib/card-processing-v2-timing.ts';
import {v2BackgroundFailure,v2BackgroundSchemaDiagnostic} from '../lib/card-processing-v2-background-failures.ts';
import {listV2ProcessingBatches,writeV2ProcessingBatch} from '../lib/card-processing-v2-processing-batches.ts';
import {captureV2BackgroundApiInventory} from '../lib/card-processing-v2-background-api-inventory.ts';

env.loadEnvConfig(process.cwd());
async function main(){
 const root=process.cwd(),[command,batchArgument,runFile]=process.argv.slice(2);
 if(command==='recover'){await recoverV2BackgroundRun(root);await ensureV2BackgroundWatchdog(root);return;}
 if(!['connect','run'].includes(command))throw Error('Use a supported background connect, run or recover request');
 const {request,lease}=await enterV2BackgroundProcess(root,command==='run'?runFile:batchArgument);
 if(request.kind!==command||command==='run'&&request.batchId!==batchArgument)throw Error('Background process request mismatch');
 const heartbeat=setInterval(()=>{void updateV2BackgroundStatus(root,lease,{}).catch(()=>undefined);},5000);
 let browser:Awaited<ReturnType<typeof createV2BackgroundBrowser>>|undefined;
 let currentPhase='connecting',signInWindowOpened=false;
 const progress=async(phase:Parameters<typeof updateV2BackgroundStatus>[2]['phase'],detail:string)=>{currentPhase=phase??currentPhase;return updateV2BackgroundStatus(root,lease,{phase,detail,progress:true});};
 const create=async(headless:boolean)=>createV2BackgroundBrowser({root,profileDir:path.join(root,'artifacts/card-processing-v2/background/profile'),evidenceDir:path.join(root,'artifacts/card-processing-v2/background/evidence'),headless:false,minimized:headless,measure:(step,operation)=>request.batchId?measureV2(root,step,operation,{runId:request.batchId}):operation(),checkpoint:async step=>{await updateV2BackgroundStatus(root,lease,{detail:step,progress:true});},acceptDisplayedAgreements:async()=>{await readV2BackgroundAuthority(root,'v2-background-browser-authority-20261105');return true;}});
 try{
  if(request.batchId)await recoverV2Timings(root,{runId:request.batchId});
  await progress('connecting','Opening the separate Legends OS browser session');browser=await create(command!=='connect');
  let status:{ready:boolean;reason?:string}=await browser.status();
  if(!status.ready){
   if(command!=='connect'){await browser.close();browser=await create(false);signInWindowOpened=true;status=await browser.status();}
   await updateV2BackgroundStatus(root,lease,{phase:'login-required',detail:status.reason==='VERIFICATION_REQUIRED'?'eBay requires verification in the separate Legends OS window. Complete that check there; the runner will not bypass it.':'Sign in to imaydit58 in the separate Legends OS window. Your regular browser, mouse and keyboard remain yours.',authenticated:false,progress:true});
   // Native sign-in is a user handoff; credentials are never read or entered.
   const until=Date.now()+15*60000;
   const waitForLogin=async()=>{while(!status.ready&&Date.now()<until){await new Promise(resolve=>setTimeout(resolve,3000));status=await browser!.observeSignIn();}};
   if(request.batchId)await measureV2(root,'background-login-wait',waitForLogin,{runId:request.batchId});else await waitForLogin();
   if(!status.ready)throw Error('Dedicated eBay sign-in is still required; no paid identification or upload started');
  }
  await updateV2BackgroundStatus(root,lease,{phase:'ready',detail:'Dedicated eBay connection verified for imaydit58',authenticated:true,seller:'imaydit58',progress:true});
  if(command==='connect'){await browser.close();browser=undefined;await updateV2BackgroundStatus(root,lease,{phase:'ready',detail:'Connected. Process New Cards runs in the background without a chat handoff.',terminal:true,progress:true});return;}
  // Normal runs already have a minimized, authenticated, hydrated session.
  // Retain it instead of discarding readiness and starting a cold browser.
  if(signInWindowOpened){await browser.close();browser=await create(true);if(!(await browser.status()).ready)throw Error('Dedicated seller session needs sign-in recovery');}
  const sellerAccess=v2SellerAccess();
  const connectedBrowser=browser;
  const result=await executeV2BackgroundBatch(root,request.batchId!,browser,{accessToken:sellerAccess,identify:async()=>{
   const remaining=await resolveV2BackgroundRemainingSelection(root,request.batchId!,request.selectionFile!);if(!remaining)return;
   const readiness=await inspectV2Readiness(root,remaining.raw,{verifySeller:sellerAccess});if(!readiness.report.ready)throw new V2ReadinessError(readiness.report);
   await activateV2PreparedContext(root,remaining.selected);
   return runV2(root,request.batchId,{selection:remaining.selected,identifyOnly:true});
  },captureInventoryScope:async(scope,url)=>scope==='active'||scope==='sold'?captureV2BackgroundApiInventory(root,scope,await sellerAccess(),{checkpoint:async step=>{await progress('reconciliation',step);}}):connectedBrowser.captureInventoryScope(scope,url),progress:async(phase,detail)=>progress(phase,detail),prepare:async()=>{
   const remaining=await resolveV2BackgroundRemainingSelection(root,request.batchId!,request.selectionFile!);if(!remaining)return;
   const {raw,selected}=remaining;
   const readiness=await inspectV2Readiness(root,raw,{verifySeller:sellerAccess});if(!readiness.report.ready)throw new V2ReadinessError(readiness.report);
   await activateV2PreparedContext(root,selected);
   return runV2(root,request.batchId,{selection:selected,hostPhoto:v2PhotoHost(sellerAccess),categoryRequirements:async ids=>fetchV2Categories(await sellerAccess(),ids)});
  }});
  await browser.close();browser=undefined;
  await updateV2BackgroundStatus(root,lease,{phase:result.complete?'complete':'exception',detail:result.complete?'Ready for pricing: drafts verified and original photos moved.':`Some cards require recovery; ${'ready' in result?result.ready:0} ready. Completed drafts and photos preserved.`,terminal:true,progress:true});
 }catch(error){
  const failure=v2BackgroundFailure(error,currentPhase),schemaDiagnostic=v2BackgroundSchemaDiagnostic(error);await retainV2BackgroundEvidence(root,request.batchId??request.requestId,'runner-exception',{...failure,...(schemaDiagnostic?{schemaDiagnostic}:{})});
  await updateV2BackgroundStatus(root,lease,{phase:['SIGN_IN_REQUIRED','VERIFICATION_REQUIRED'].includes(failure.code)?'login-required':'exception',detail:`${failure.code}: ${failure.detail}`,terminal:true,progress:true});
  process.exitCode=1;
 }finally{clearInterval(heartbeat);await browser?.close().catch(()=>undefined);if(request.batchId){const batch=(await listV2ProcessingBatches(root)).find(b=>b.jobId===request.batchId);if(batch)await writeV2ProcessingBatch(root,{...batch,status:'stopped'});}}
}
main().catch(()=>{console.error('Background runner could not start; check the retained request and safe status. No automatic upload replay.');process.exitCode=1;});
