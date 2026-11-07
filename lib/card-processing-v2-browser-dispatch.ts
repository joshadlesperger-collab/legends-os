import {recordV2ActivityCheckpoint} from './card-processing-v2-activity.ts';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { digest } from './card-processing-v2.ts';
import { readV2State, v2Dir } from './card-processing-v2-store.ts';
import { auditV2BrowserJob, readV2BrowserJob } from './card-processing-v2-browser-upload-workflow.ts';
import { planV2BulkCompletion } from './card-processing-v2-bulk-completion.ts';
import { V2_BROWSER_STAGE_BOUNDARIES } from './card-processing-v2-browser-timing.ts';
import {resolveV2OriginalTimingBinding} from './card-processing-v2-session-timing.ts';

const request=z.object({id:z.string().regex(/^[a-f0-9]{64}$/),owner:z.string().min(1).max(100),
 observations:z.array(z.object({cardId:z.string(),evidence:z.object({path:z.string(),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict()}).strict()).max(20).optional()}).strict();
/** Durable, executable handoff for the next ChatGPT internal-browser agent.
 * No CUA runtime is attached here. Returned commands still enforce their own
 * evidence/lease gates; an export or plan never certifies saved fields. */
export async function nextV2BrowserAction(root:string,raw:unknown){
 const p=request.parse(raw),job=await readV2BrowserJob(root,p.id),state=await readV2State(root);
 if(job.lease&&job.lease.owner!==p.owner)throw Error('Browser job belongs to another owner');
 const cards=job.groups.flatMap(g=>g.cardIds.map(id=>state.cards[id]));
 if(cards.some(c=>!c)||new Set(cards.map(c=>c.captureId)).size!==cards.length)throw Error('Exact current capture ownership required');
 const mapping=job.groups.flatMap(g=>g.cardIds.map(cardId=>({cardId,sku:state.cards[cardId].sku,captureId:state.cards[cardId].captureId,draftId:state.cards[cardId].draftId??null,key:g.key??null,groupId:g.groupId})));
 const activeTiming=state.timings.filter(t=>t.source==='external-browser-wall-clock'&&t.status==='running').map(t=>({id:t.id,step:t.step,startedAt:t.startedAt,runId:t.runId}));
 const audit=['imported','archive-pending'].includes(job.stage)&&p.observations?await auditV2BrowserJob(root,job.id,{observations:p.observations}):null;
 const ready=audit?.rows.filter(r=>r.route==='finish-archive-without-editor-writes')??[];
 const command=(name:string,packet:unknown)=>({script:'scripts/card-processing-v2-browser-jobs.ts',command:name,packet});
 let action:string,operation:unknown=null;
 if(activeTiming.length)action='close-or-interrupt-exact-existing-browser-timing-before-next-stage';
 else if(job.stage==='superseded'){action=job.partitionedInto?'resume-partition-child-jobs':'resume-superseding-job';operation=job.partitionedInto?{ids:job.partitionedInto}:{id:job.supersededBy};}
 else if(job.stage==='ready-pricing'){action='complete-nonprice-work-pricing-deferred';}
 else if(!job.lease){action='claim-single-browser-writer';operation=command('claim',{id:job.id,owner:p.owner});}
 else if(job.stage==='awaiting-reconciliation'){action='obtain-fresh-four-scope-clearance-and-begin-exact-intents';operation={afterActualBegin:command('bind',{id:job.id,keys:job.groups.map(g=>g.key??'REQUIRED_SUPPORTED_BEGIN_RESULT')}),canUpload:false};}
 else if(job.stage==='ready-upload'){action='begin-writeahead-then-upload-exact-official-csv-once';operation=command('begin-upload',{id:job.id,lease:job.lease});}
 else if(['upload-requested','uncertain'].includes(job.stage)){action='reconcile-same-upload-only-never-reupload';operation={command:'record-upload',jobId:job.id,requires:'Actual same-job terminal output plus exact saved DraftID/SKU mapping; retain raw evidence before parsing',canUpload:false};}
 else if(ready.length){action='verify-and-archive-independent-passing-cards-now';operation={command:'verify-ready',jobId:job.id,reviewFragments:ready.map(r=>r.review),requires:'Existing supported report envelope, captured archive authority and exact lease; no editor writes'};}
 else if(audit?.correctionBatches.length){action='correct-proven-defects-once-per-compatible-group';operation={batches:audit.correctionBatches,requires:'Fresh visible choices for policy/condition/location; save and reopen only changed exact DraftIDs; then next-action with fresh observations'};}
 else if(job.stage==='archive-pending'&&cards.every(c=>c.nonpriceVerification?.draftId===c.draftId)){action='recover-verified-photo-archives-with-existing-authority';operation={command:'reconcile',jobId:job.id,requires:'Run supported archive operation for pending exact cards; never repeat seller writes'};}
 else {action='capture-actual-saved-evidence-for-missing-or-held-cards';operation={observations:audit?.rows.map(r=>({cardId:r.cardId,draftId:r.draftId,holds:r.holds}))??mapping,requires:'Actual exact-ID DOM/AX plus per-copy visual front/back evidence; a grid count alone is insufficient'};}
 const readbackModule='lib/card-processing-v2-internal-session.mjs';
 const readbackRequests=(await Promise.all(job.groups.map(async group=>{
  const representative=mapping.find(m=>m.groupId===group.groupId&&m.sku===group.payload.sku),members=group.cardIds.map(id=>state.cards[id]);
  if(!representative?.draftId||members.every(c=>!c.issues.length&&c.nonpriceVerification?.draftId===c.draftId))return [];
  const timing=await resolveV2OriginalTimingBinding(root,group.cardIds);
  return [{cardId:representative.cardId,captureId:representative.captureId,sku:representative.sku,draftId:representative.draftId,url:`https://www.ebay.com/lstng?draftId=${representative.draftId}&mode=AddItem`,physicalCardIds:[...group.cardIds],captureIds:[...group.payload.captureIds],acquisitionMode:'adaptive',expandFeatures:Object.hasOwn(group.payload.specifics,'Features'),timing:timing??{version:1,status:'unavailable',reason:'Original accepted processing batch not found; reconcile timing ownership before session'}}];
 }))).flat();
 const supportedCorrections=new Set(['condition','condition-descriptor','payment-policy','return-policy','location']);
 const correctionRequests=(audit?.rows??[]).filter(row=>row.route==='correct-observed-defects-only'&&row.observedAt&&row.draftId&&row.sku&&row.defects.length&&row.defects.every(d=>supportedCorrections.has(d.field))).map(row=>({cardId:row.cardId,draftId:row.draftId!,sku:row.sku!,url:`https://www.ebay.com/lstng?draftId=${row.draftId}&mode=AddItem`,observedAt:row.observedAt!,defects:row.defects.map(d=>({field:d.field,expected:d.expected,evidence:d.evidence})),expandFeatures:Object.hasOwn(job.groups.find(g=>g.cardIds.includes(row.cardId))!.payload.specifics,'Features')}));
 const originalActivity=mapping.length<=20?await resolveV2OriginalTimingBinding(root,mapping.map(m=>m.cardId)):null;
 const activity=originalActivity?{status:'bound' as const,batchId:originalActivity.batchId,owner:p.owner,lane:'browser' as const,phase:action.includes('upload')?'upload':action.includes('correct')?'bulk-edit':action.includes('archive')?'local-finalize':'saved-readback',requiredProtocol:'begin before actual operation; checkpoint actual progress; heartbeat is presence only; end at actual boundary',module:'lib/card-processing-v2-activity-client.mjs'}:{status:'unavailable' as const};
 if(originalActivity)await recordV2ActivityCheckpoint(root,{batchId:originalActivity.batchId,lane:'agent',phase:'agent-handoff',owner:p.owner,cardIds:mapping.map(m=>m.cardId),step:'Exact browser next action retained',nextStep:action});
 const result={version:1,jobId:job.id,jobStage:job.stage,snapshotHash:digest({job,stateCards:cards}),owner:p.owner,action,operation,mapping,activity,
  readback:{version:1,module:readbackModule,export:'runV2InternalReadbackSession',requests:readbackRequests,timing:'Automatic persistent per-step ledger from original batch binding; missing binding fails before browser access. No lastRun substitution.',retainedReceiptReuse:'Already same-ID reviewed cards proceed to supported archive/reconciliation without another browser visit; new holds remain held',experimentalSingleExpandedTreeDefault:false,verificationStillRequired:true},
  correction:{module:'lib/card-processing-v2-internal-completion.mjs',export:'correctV2InternalDraft',commonExport:'applyV2ObservedCommonGroups',requests:correctionRequests,preferredRoute:'Use the exact bulk workspace once per compatible observed group; helper is for changed-row exceptions only',savePolicy:'One save after all proven corrections; wait for ZIP lookup and actual location summary; then one same-ID saved readback. Strict audit and immediate archive still required.',automaticWrites:false},
  commonDefectCompletion:{batches:audit?.correctionBatches??[],instruction:'Use existing bulk-completion grouping once per exact compatible observed defect group. Do not reopen/rewrite passing rows; preserve title/description facts. Price, shipping and quantity are excluded.',observedDefectsOnly:true},runningBrowserTimings:activeTiming,timingBoundaries:V2_BROWSER_STAGE_BOUNDARIES,bulkPlan:planV2BulkCompletion(job),audit,
  controls:{internalBrowserOnly:true,attachedExecutor:false,canPublish:false,priceWrites:false,quantityWrites:false,reuploadAllowed:false,defaultEditorAction:'none',commonEdits:'once per compatible category/condition and freshly observed seller choice',archive:'immediate supported verification/archive of independently passing cards',photoEvidence:'actual per-copy evidence required; no unchecked grid substitution'},
  limitation:'This dispatch persists the next supported operation for an internal-browser agent. It does not attach CUA to Node or perform browser actions.'};
 const bytes=JSON.stringify(result,null,2),relative=`artifacts/card-processing-v2/browser-dispatch/${job.id}-${digest(result)}.json`,file=path.join(root,relative);
 await fs.mkdir(path.join(v2Dir(root),'browser-dispatch'),{recursive:true});try{await fs.writeFile(file,bytes,{flag:'wx',flush:true});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST'||await fs.readFile(file,'utf8')!==bytes)throw e;}
 return {...result,handoff:{path:relative,sha256:createHash('sha256').update(bytes).digest('hex')}};
}
