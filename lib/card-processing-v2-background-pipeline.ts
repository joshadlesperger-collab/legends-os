import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {readV2State,withV2ConfigReads} from './card-processing-v2-store.ts';
import {listV2ProcessingBatches,writeV2ProcessingBatch} from './card-processing-v2-processing-batches.ts';
import {v2BatchProgress} from './card-processing-v2-batch-progress.ts';
import {listV2BrowserJobs,readV2BrowserJob,claimV2BrowserJob,claimV2BackgroundBrowserJob,bindV2BrowserJobIntents,beginV2BrowserUpload,recordV2BrowserUpload,reconcileV2BrowserJob,partitionV2PreparedBrowserJob} from './card-processing-v2-browser-upload-workflow.ts';
import {beginV2Draft,readV2SellerDuplicateRiskAuthority,v2SellerDuplicateRiskReconciliationSchema,type V2DraftReconciliation} from './card-processing-v2-draft-lifecycle.ts';
import {finalizeV2ObservedTarget} from './card-processing-v2-target-finalizer.ts';
import {finalizeV2ObservedBatch} from './card-processing-v2-batch-finalizer.ts';
import{V2PartialSavedBatchReadError}from'./card-processing-v2-partial-batch-read.ts';
import type {V2FullTemplateDraftOptions} from './card-processing-v2-transport.ts';
import {measureV2} from './card-processing-v2-timing.ts';
import {buildV2BackgroundReconciliations} from './card-processing-v2-background-reconciliation.ts';
import {readV2BackgroundPolicies} from './card-processing-v2-background-policies.ts';
import type {createV2BackgroundBrowser,V2BackgroundEvidence} from './card-processing-v2-background-browser.ts';
import type {V2BackgroundPhase} from './card-processing-v2-background-supervisor.ts';
import {v2BackgroundFailure} from './card-processing-v2-background-failures.ts';

type Browser=Awaited<ReturnType<typeof createV2BackgroundBrowser>>;
type Scope=keyof typeof scopeUrls;
type InventorySnapshot={scope:Scope;seller:'imaydit58';observedAt:string;complete:boolean;rows:Array<{id:string;sku:string;title:string;text:string;skuAliases?:string[]}>;evidence:V2BackgroundEvidence};
const AUTHORITY='v2-background-browser-authority-20261105';
const DUPLICATE_RISK_AUTHORITY='v2-seller-accepts-duplicates-20261105';
// Established seller-owned policy reference; one GetItem read, never inventory enumeration.
const POLICY_REFERENCE_ITEM='128037182614';
const sha=(bytes:string|Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const scopeUrls={active:'https://www.ebay.com/sh/lst/active',drafts:'https://www.ebay.com/sh/lst/drafts',scheduled:'https://www.ebay.com/sh/lst/scheduled',sold:'https://www.ebay.com/sh/ord/?filter=status%3AALL_ORDERS%2Ctimerange%3ACURRENTYEAR'} as const;
export async function retainV2BackgroundEvidence(root:string,batchId:string,kind:string,body:unknown):Promise<V2BackgroundEvidence>{
 const relative=`artifacts/card-processing-v2/background/evidence/${batchId}-${kind}-${randomUUID()}.json`,bytes=JSON.stringify(body);await fs.mkdir(path.dirname(path.join(root,relative)),{recursive:true});await fs.writeFile(path.join(root,relative),bytes,{flag:'wx',flush:true});return{path:relative,sha256:sha(bytes)};
}

/** This function actually consumes the preparation output in the same persistent
 * process. It never asks a chat to resume, and never repeats an uncertain upload. */
async function executeV2BackgroundBatchLocal(root:string,batchId:string,browser:Browser,options:{prepare:()=>Promise<unknown>;identify?:()=>Promise<unknown>;matchDrafts?:typeof import('./card-processing-v2-draft-match-handoff.ts').executeV2DraftMatchHandoff;accessToken:()=>Promise<string>;progress:(phase:V2BackgroundPhase,detail:string)=>Promise<unknown>;readPolicies?:typeof readV2BackgroundPolicies;captureInventoryScope?:(scope:Scope,url:string)=>Promise<InventorySnapshot>;inventoryMode?:'legacy-absence';claimJob?:typeof claimV2BrowserJob;finalizeBatch?:typeof finalizeV2ObservedBatch;finalizeBulk?:(root:string,input:unknown)=>Promise<{exceptions:Array<{cardId?:string;detail:string}>}>;templateOptions?:(categoryId:string,policies:Awaited<ReturnType<typeof readV2BackgroundPolicies>>)=>Promise<V2FullTemplateDraftOptions|undefined>}){
 const batch=(await listV2ProcessingBatches(root)).find(b=>b.jobId===batchId);if(!batch)throw Error('An exact accepted batch is required');
 const owner=`background-${batchId}`,capturePairs=new Set(batch.captures.map(c=>c.photos.map(p=>p.hash).sort().join(':')));
 const inScope=(photos:Array<{hash:string}>)=>capturePairs.has(photos.map(p=>p.hash).sort().join(':'));
 let currentPhase:V2BackgroundPhase='preparing';
 const phase=async<T>(name:V2BackgroundPhase,detail:string,fn:()=>Promise<T>)=>{currentPhase=name;await options.progress(name,detail);return ["uploading","verifying"].includes(name)?fn():measureV2(root,`background-${name}`,fn,{runId:batchId});};
 if(v2BatchProgress(await readV2State(root),batch).complete)return{complete:true,alreadyComplete:true};
 const riskInstruction=options.inventoryMode==='legacy-absence'?undefined:await readV2SellerDuplicateRiskAuthority(root,DUPLICATE_RISK_AUTHORITY);
 const queue=JSON.parse(await fs.readFile(path.join(root,'artifacts/engineering-mission/work-queue.json'),'utf8'));
 const matchAuthority=queue.instructions?.find((i:{id:string;policyRefs?:string[]})=>i.id==='v2-draft-match-button-authority-20261106'&&i.policyRefs?.includes('v2-draft-match-button'));
 const draftMatchExceptions:Array<{cardId?:string;detail:string}>=[];
 let state=await readV2State(root);
 const readSources=async(all:boolean)=>{
  const snapshots=[];
  for(const scope of (all?Object.keys(scopeUrls):['active']) as Array<keyof typeof scopeUrls>){
   const captureScope:(scope:Scope,url:string)=>Promise<InventorySnapshot>=options.captureInventoryScope??browser.captureInventoryScope;
   const actual=await phase<InventorySnapshot>('reconciliation',`Reading actual ${scope} inventory once for this batch`,()=>captureScope(scope,scopeUrls[scope]));
   if(!actual.complete)throw Error('Actual inventory pagination is incomplete; no paid preparation may begin');
   const body={scope:actual.scope,seller:actual.seller,observedAt:actual.observedAt,complete:actual.complete,rows:actual.rows.map(row=>({id:row.id,sku:row.sku,title:row.title,text:row.text,...('skuAliases' in row&&row.skuAliases?.length?{skuAliases:row.skuAliases}:{})}))};
   snapshots.push({...body,evidence:await retainV2BackgroundEvidence(root,batchId,`inventory-${scope}`,body)});
  }
  const active=snapshots.find(s=>s.scope==='active')?.rows[0];if(!active)throw Error('An actual seller-owned active item is required for established defaults');
  const policies=await phase('reconciliation','Reading established seller policies and location; prices excluded',async()=>(options.readPolicies??readV2BackgroundPolicies)(root,active.id,await options.accessToken()));
  return{snapshots,policies};
 };
 let initialCards=Object.values(state.cards).filter(c=>inScope(c.photos));
 if(riskInstruction&&matchAuthority){
  if(initialCards.length!==batch.captures.length||initialCards.some(c=>!c.identity&&!c.issues.length)){
   if(!options.identify)throw Error('Pre-identification must finish before the one draft match snapshot');
   await phase('preparing','Identifying selected originals once before draft matching',options.identify);
   state=await readV2State(root);initialCards=Object.values(state.cards).filter(c=>inScope(c.photos));
  }
  const match=options.matchDrafts??(await import('./card-processing-v2-draft-match-handoff.ts')).executeV2DraftMatchHandoff;
  const result=await phase('reconciliation','Matching unpublished drafts once; active and sold inventory are excluded',()=>match(root,{batchId,cardIds:initialCards.map(c=>c.id),authorityId:matchAuthority.id},browser));
  draftMatchExceptions.push(...result.exceptions);
  state=await readV2State(root);initialCards=Object.values(state.cards).filter(c=>inScope(c.photos));
  const mergedProgress=v2BatchProgress(state,batch);
  if(mergedProgress.complete){const outcome={batchId,complete:true,ready:mergedProgress.completedCount,selected:mergedProgress.totalCount,actualMicros:mergedProgress.actualMicros,elapsedMs:mergedProgress.elapsedMs,exceptions:draftMatchExceptions,canPublish:false,priceWrites:0};await retainV2BackgroundEvidence(root,batchId,'outcome',outcome);return outcome;}
 }
 const needsNewInputs=initialCards.length<batch.captures.length||initialCards.some(c=>!Object.values(state.submissions).some(sub=>sub.payload.captureIds.includes(c.captureId)));
 let sources=!riskInstruction&&needsNewInputs?await readSources(true):undefined;
 const directPolicies=riskInstruction?await phase('reconciliation','Reading seller defaults once; account-wide duplicate searches skipped per seller',async()=> (options.readPolicies??readV2BackgroundPolicies)(root,POLICY_REFERENCE_ITEM,await options.accessToken())):undefined;
 const needsPreparation=initialCards.length!==batch.captures.length||initialCards.some(c=>!c.draftId&&!c.issues.length&&(c.stage!=='prepared'||!c.identity||!c.groupId||!state.prepared[c.groupId]||c.description!==state.prepared[c.groupId]?.description));
 if(needsPreparation)await phase('preparing','Identifying once and preparing the exact selected cards',options.prepare);
 else await options.progress('preparing','Reusing retained prepared cards; no repeated identification or preparation');
 await writeV2ProcessingBatch(root,{...batch,status:'running',pid:process.pid});
 state=await readV2State(root);
 const selectedCards=Object.values(state.cards).filter(c=>inScope(c.photos));
 const jobs=(await listV2BrowserJobs(root)).filter(j=>j.stage!=='superseded'&&j.groups.some(g=>g.cardIds.some(id=>selectedCards.some(c=>c.id===id))));
 if(jobs.some(j=>j.groups.some(g=>g.cardIds.some(id=>!selectedCards.some(c=>c.id===id)))))throw Error('A browser job crosses the selected photo boundary');
 const exceptions:Array<{jobId?:string;cardId?:string;detail:string}>=[...draftMatchExceptions,...selectedCards.filter(c=>c.issues.length).map(c=>({cardId:c.id,detail:c.issues.map(i=>i.code).join(', ')}))];
 const needsIntents=jobs.filter(j=>j.stage==='awaiting-reconciliation');
 let reconciliations:{cleared:Array<{groupId:string;reconciliation:V2DraftReconciliation}>}|undefined;
 if(!riskInstruction&&jobs.some(j=>j.stage!=='ready-pricing')&&!sources)sources=await readSources(needsIntents.length>0);
 const policies=directPolicies??sources?.policies;
 if(riskInstruction&&policies){
  const cleared=[];for(const group of needsIntents.flatMap(j=>j.groups)){
   const body={seller:'imaydit58' as const,observedAt:new Date().toISOString(),source:'seller-accepted-duplicate-risk' as const,instructionId:riskInstruction.id,captures:group.cardIds.map(id=>({captureId:state.cards[id].captureId,sku:state.cards[id].sku,disposition:'duplicate-risk-accepted' as const})),expectedPolicies:policies.policies};
   const evidence=await retainV2BackgroundEvidence(root,batchId,'seller-accepted-duplicate-risk',body);
   cleared.push({groupId:group.groupId,reconciliation:v2SellerDuplicateRiskReconciliationSchema.parse({...body,evidence})});
  }reconciliations={cleared};
 }
 if(needsIntents.length&&sources)reconciliations=await phase('reconciliation','Binding prepared cards to the exact accepted originals and inventory evidence',()=>buildV2BackgroundReconciliations(root,{batchId,groups:needsIntents.flatMap(j=>j.groups),snapshots:sources!.snapshots,policies:sources!.policies.policies,policyEvidence:sources!.policies.evidence}));
 const instruction=queue.instructions?.find((i:{id:string})=>i.id===AUTHORITY);if(!instruction)throw Error('Captured background/archive authority is missing');
 const archiveEvidence=await retainV2BackgroundEvidence(root,batchId,'archive-authority',{instruction});
 const bulkAuthority=queue.instructions?.find((i:{id:string;policyRefs?:string[]})=>i.id==='v2-bulk-results-authority-20261106'&&i.policyRefs?.includes('v2-bulk-results-completion'));
 const workJobs=[];
 for(const job of jobs){
  if(job.stage==='awaiting-reconciliation'&&!job.lease){
   const good=job.groups.filter(g=>reconciliations?.cleared.some(c=>c.groupId===g.groupId)).map(g=>g.groupId),held=job.groups.filter(g=>!good.includes(g.groupId)).map(g=>g.groupId);
   if(good.length&&held.length){
    try{const children=await partitionV2PreparedBrowserJob(root,job.id,{partitions:[good,held],reason:'Separate actual inventory candidates from independently cleared groups before any intent or upload'});workJobs.push(...children.filter(c=>c.groups.every(g=>good.includes(g.groupId))));exceptions.push({jobId:job.id,detail:'Candidate inventory matches isolated; independent cleared groups continue.'});continue;}
    catch{exceptions.push({jobId:job.id,detail:'Existing bound preparation cannot be partitioned; preserve exact intents for recovery.'});continue;}
   }
  }
  workJobs.push(job);
 }
 for(const original of workJobs){
  try{
   let job=await readV2BrowserJob(root,original.id);
   if(job.stage==='ready-pricing')continue;
   if(job.lease&&job.lease.owner!==owner)throw Error('Existing browser job belongs to another writer; no takeover performed');
   if(job.stage==='awaiting-reconciliation'){
    currentPhase='reconciliation';await options.progress('reconciliation','Binding the next exact prepared draft job; completed jobs remain untouched');
    const keys=[];
    for(const group of job.groups){
     const cleared=reconciliations?.cleared.find(c=>c.groupId===group.groupId);
     if(!cleared)throw Error('Inventory match or incomplete source prevents new draft creation for this group');
     state=await readV2State(root);
     const existing=Object.values(state.submissions).filter(s=>s.groupId===group.groupId||s.payload.captureIds.some(id=>group.payload.captureIds.includes(id)));
     if(existing.length>1)throw Error('Ambiguous retained intents require reconciliation');
     const key=existing[0]?.key??await beginV2Draft(root,group.groupId,group.payload,cleared.reconciliation,{background:{instructionId:AUTHORITY,batchId,expiresAt:new Date(Date.now()+55*60000).toISOString(),captureIds:group.payload.captureIds}});
     keys.push(key);
    }
    const categories=Array.from(new Set(job.groups.map(g=>g.payload.categoryId)));if(riskInstruction&&categories.length!==1)throw Error('New batches must group by category before template export');
    // Actual eBay report 11346670516 rejected Draft in the fx_category_template
    // family (BAF.Error.5). Use the proven native draft envelope; shared defaults
    // are applied once in the native batch editor. Explicit test contracts remain
    // injectable, but a category-download receipt is not draft-import acceptance.
    const templateOptions=riskInstruction&&policies&&options.templateOptions?await options.templateOptions(categories[0],policies):undefined;
    job=await bindV2BrowserJobIntents(root,job.id,keys,templateOptions);
   }
   job=options.claimJob?await options.claimJob(root,job.id,owner):await claimV2BackgroundBrowserJob(root,job.id,batchId);
   if(job.stage==='ready-upload'){
    const handoff=await beginV2BrowserUpload(root,job.id,job.lease);
    const receipt=await phase('uploading',`Uploading exact draft file for ${job.groups.length} draft groups`,()=>browser.uploadDraftCsv(handoff));
    const result=await recordV2BrowserUpload(root,job.id,job.lease,receipt);job=result.job;
   }else if(job.stage==='upload-requested'||job.stage==='uncertain'){
    if(!job.csvPath)throw Error('Uncertain upload lacks its original file binding');
    const receipt=await phase('uploading','Reconciling the same previous upload; no file resubmission',()=>browser.resumeUploadResult(path.basename(job.csvPath!),job.id));
    job=(await recordV2BrowserUpload(root,job.id,job.lease,receipt)).job;
   }
   if(!['imported','archive-pending'].includes(job.stage))throw Error('Actual draft import results are unresolved');
   state=await readV2State(root);
   if(bulkAuthority){
    // Official exact-row results + one post-save table replace hidden-field
    // reopening. This mode never claims an individual saved-field inspection.
    if(!policies)throw Error('Established seller defaults required for bulk completion');
    const targets=job.groups.map(g=>({draftId:state.cards[g.cardIds[0]].draftId!,sku:g.payload.sku}));
    const categoryId=job.groups[0].payload.categoryId;
    if(!['261328','183454','183050'].includes(categoryId)||job.groups.some(g=>g.payload.categoryId!==categoryId))throw Error('Exact supported category required for shared batch save');
    const savePath=path.join(root,'artifacts/card-processing-v2/background/evidence',`${batchId}-${job.id}-bulk-shared-save-checkpoint.json`);
    let sharedSave:V2BackgroundEvidence|undefined;
    try{const saved=JSON.parse(await fs.readFile(savePath,'utf8'));if(saved.batchId!==batchId||saved.jobId!==job.id||saved.groupsHash!==sha(JSON.stringify(job.groups)))throw Error('Bulk shared-save checkpoint ownership differs');sharedSave=saved.evidence;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    if(!sharedSave){
     const result=await phase('verifying','Applying required defaults once to the exact bulk batch; prices preserved',()=>browser.prepareImportedDraftBatch({targets,policies:policies!.defaults,categoryId:categoryId as '261328'|'183454'|'183050'}));
     sharedSave=result.evidence;
     const body={batchId,jobId:job.id,groupsHash:sha(JSON.stringify(job.groups)),evidence:sharedSave};
     await fs.writeFile(savePath,JSON.stringify(body),{flag:'wx',flush:true});
    }
    const gridPath=path.join(root,'artifacts/card-processing-v2/background/evidence',`${batchId}-${job.id}-bulk-grid-checkpoint.json`);
    let gridEvidence:V2BackgroundEvidence|undefined;
    try{const retained=JSON.parse(await fs.readFile(gridPath,'utf8'));if(retained.batchId!==batchId||retained.jobId!==job.id||retained.groupsHash!==sha(JSON.stringify(job.groups)))throw Error('Bulk grid checkpoint ownership differs');gridEvidence=retained.evidence;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    if(!gridEvidence){const grid=await phase<{evidence:V2BackgroundEvidence}>('verifying',targets.length===1?'Confirming the saved single draft in the drafts table; no editor reopening':'Checking one post-save bulk result table; no listing or row-field inspection',()=>targets.length===1?browser.readSavedSingleDraftRow({target:targets[0]}):browser.readSavedDraftGrid({targets}));gridEvidence=grid.evidence;await fs.writeFile(gridPath,JSON.stringify({batchId,jobId:job.id,groupsHash:sha(JSON.stringify(job.groups)),evidence:gridEvidence}),{flag:'wx',flush:true});}
    const finalizeV2BulkResults=options.finalizeBulk??(await import('./card-processing-v2-bulk-result-finalizer.ts')).finalizeV2BulkResults;
    const result=await phase('archiving','Recording exact bulk results and moving all original photos',()=>finalizeV2BulkResults(root,{batchId,jobId:job.id,lease:job.lease,grid:gridEvidence!,sharedSave:sharedSave!,defaults:policies!.defaults,authorityId:bulkAuthority.id,archiveAuthority:{instructionId:AUTHORITY,evidence:archiveEvidence}}));
    exceptions.push(...result.exceptions.map(e=>({jobId:job.id,...e})));
    continue;
   }
   const groups=job.groups.filter(g=>!g.cardIds.every(id=>{const c=state.cards[id];return c?.nonpriceVerification?.draftId===c?.draftId&&c?.draftArchive?.status==='moved';}));
   // Only successful/typed-partial readbacks reach this checkpoint. A generic
   // protected-value difference never creates a reusable positive collection.
   const checkpointPath=path.join(root,'artifacts/card-processing-v2/background/evidence',`${batchId}-${job.id}-saved-row-checkpoint.json`);
   const currentTargets=groups.map(g=>({draftId:state.cards[g.cardIds[0]].draftId!,sku:g.payload.sku}));
   let retainedRows:{observations:Array<{draftId:string;sku:string;evidence:V2BackgroundEvidence}>}|undefined;
   try{const st=await fs.lstat(checkpointPath);if(!st.isFile()||st.isSymbolicLink()||st.size>262144)throw Error('Invalid saved row checkpoint');const saved=JSON.parse(await fs.readFile(checkpointPath,'utf8'));
    if(saved.kind!=='retained-actual-saved-batch-rows'||saved.batchId!==batchId||saved.jobId!==job.id||saved.groupsHash!==sha(JSON.stringify(job.groups))||Date.now()-Date.parse(saved.collectedAt)<0)throw Error('Saved row checkpoint ownership differs');
    if(Date.now()-Date.parse(saved.collectedAt)<=50*60000&&Array.isArray(saved.observations)&&saved.observations.length<=20){const matching=saved.observations.filter((o:{draftId:string;sku:string})=>currentTargets.some(t=>t.draftId===o.draftId&&t.sku===o.sku));retainedRows={observations:matching};}
   }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
   if(groups.length&&policies&&!retainedRows){
    const targets=groups.map(g=>({draftId:state.cards[g.cardIds[0]].draftId!,sku:g.payload.sku}));
    if(job.csvContract||riskInstruction&&targets.length>1){
     const categoryId=job.csvContract?.categoryId??groups[0].payload.categoryId;
     if(categoryId!=='261328'&&categoryId!=='183454'&&categoryId!=='183050')throw Error('Exact supported category required for native batch setup');
     if(groups.some(g=>g.payload.categoryId!==categoryId))throw Error('Native batch setup cannot mix categories');
     await phase('verifying','Applying shared defaults once to the selected draft batch; pricing and shipping preserved',()=>browser.prepareImportedDraftBatch({targets,policies:policies!.defaults,categoryId}));
    }else await phase('verifying','Applying required shared defaults on first save; pricing and shipping preserved',()=>browser.prepareImportedDrafts({targets,policies:policies!.defaults}));
   }
   const missingTargets=currentTargets.filter(t=>!retainedRows?.observations.some(o=>o.draftId===t.draftId&&o.sku===t.sku));
   const freshRows=job.groups.length>1&&missingTargets.length?await phase('verifying','Reading only missing saved rows in one native batch workspace; passing rows reused',async()=>{try{return await browser.readSavedDraftBatch({targets:missingTargets});}catch(error){if(!(error instanceof V2PartialSavedBatchReadError))throw error;await retainV2BackgroundEvidence(root,batchId,'partial-saved-batch-read',{jobId:job.id,errorEvidence:error.errorEvidence,completedObservationEvidence:error.observations.map(o=>o.evidence),sellerWrites:0,listingNavigations:0});return{observations:error.observations};}}):undefined;
   const batchObserved=retainedRows||freshRows?{observations:[...(retainedRows?.observations??[]),...(freshRows?.observations??[])]}:undefined;
   if(batchObserved){
    if(freshRows){const body={kind:'retained-actual-saved-batch-rows',batchId,jobId:job.id,groupsHash:sha(JSON.stringify(job.groups)),collectedAt:new Date().toISOString(),targets:currentTargets,observations:batchObserved.observations.map(o=>({draftId:o.draftId,sku:o.sku,evidence:o.evidence})),sellerWrites:0};
     // Old expired sources remain immutable evidence; the pointer is replaced
     // only after a new actual read, never on an inferred successful retry.
     await retainV2BackgroundEvidence(root,batchId,'saved-row-collection',body);const temporary=checkpointPath+'.'+randomUUID()+'.tmp';await fs.writeFile(temporary,JSON.stringify(body),{flag:'wx',flush:true});await(await import('./card-processing-v2-atomic-replace.ts')).replaceV2Checkpoint(temporary,checkpointPath);
    }
    const targets=groups.map(group=>{const card=group.cardIds.map(id=>state.cards[id]).find(c=>c.sku===group.payload.sku);if(!card?.draftId)throw Error('Exact representative draft mapping is missing');return{cardId:card.id,captureId:card.captureId,sku:card.sku,draftId:card.draftId,physicalCardIds:group.cardIds};});
    const result=await phase('archiving',`Verifying ${groups.length} saved rows together and moving their original photos`,()=>(options.finalizeBatch??finalizeV2ObservedBatch)(root,{batchId,jobId:job.id,lease:job.lease,targets,observations:batchObserved.observations.map(o=>({draftId:o.draftId,sku:o.sku,evidence:o.evidence})),reviewAuthority:AUTHORITY,archiveAuthority:{instructionId:AUTHORITY,evidence:archiveEvidence}}));
    exceptions.push(...result.exceptions.map(e=>({jobId:job.id,...e})));
   }else for(const group of groups){
    try{
     state=await readV2State(root);const card=group.cardIds.map(id=>state.cards[id]).find(c=>c.sku===group.payload.sku);if(!card?.draftId)throw Error('Exact representative draft mapping is missing');
     const actual=await phase('verifying',`Reading saved singleton fields for ${card.sku}`,()=>browser.readSavedDraft(card.draftId!,Object.hasOwn(group.payload.specifics,'Features')));
     if(!actual)throw Error('Exact saved batch row observation missing; no per-listing fallback');
     await phase('archiving',`Verifying saved draft and moving ${group.cardIds.length*2} original photos`,()=>finalizeV2ObservedTarget(root,{batchId,jobId:job.id,lease:job.lease,cardId:card.id,captureId:card.captureId,sku:card.sku,draftId:card.draftId,observation:actual.evidence,reviewAuthority:AUTHORITY,archiveAuthority:{instructionId:AUTHORITY,evidence:archiveEvidence},physicalCardIds:group.cardIds}));
    }catch(error){const failure=v2BackgroundFailure(error,currentPhase);await retainV2BackgroundEvidence(root,batchId,'card-exception',{...failure,jobId:job.id,cardId:group.cardIds[0]});exceptions.push({jobId:job.id,cardId:group.cardIds[0],detail:`${failure.code}: ${failure.detail}`});}
   }
   if(!batchObserved)await reconcileV2BrowserJob(root,job.id);
  }catch(error){const failure=v2BackgroundFailure(error,currentPhase);await retainV2BackgroundEvidence(root,batchId,'job-exception',{...failure,jobId:original.id,...(currentPhase==='reconciliation'&&error instanceof Error?{localCause:{name:error.name,message:error.message.slice(0,1000)}}:{})});exceptions.push({jobId:original.id,detail:`${failure.code}: ${failure.detail}`});}
 }
 const progress=v2BatchProgress(await readV2State(root),batch);
 const outcome={batchId,complete:progress.complete,ready:progress.completedCount,selected:progress.totalCount,actualMicros:progress.actualMicros,elapsedMs:progress.elapsedMs,exceptions,canPublish:false,priceWrites:0};
 await retainV2BackgroundEvidence(root,batchId,'outcome',outcome);return outcome;
}
export async function executeV2BackgroundBatch(...args:Parameters<typeof executeV2BackgroundBatchLocal>){return withV2ConfigReads(()=>executeV2BackgroundBatchLocal(...args));}
