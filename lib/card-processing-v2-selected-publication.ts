import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {readV2PriceCheckReport,type V2PriceCheckReport} from './card-processing-v2-price-check-report.ts';

export const V2_NATIVE_PUBLISHER_VERSION='native-saved-draft-v1';
export const V2_PUBLISHER_HEARTBEAT_MS=45_000;
const seller='imaydit58',id=z.string().regex(/^\d{6,25}$/),cents=z.number().int().min(149).max(100_000_000);
export const selectedPublicationRequestSchema=z.object({action:z.literal('publish-selected'),requestId:z.string().uuid(),
 reportId:z.string().min(1).max(200),rows:z.array(z.object({draftId:id,manualItemCents:cents.optional()}).strict()).min(1).max(500),
 reviewAcknowledged:z.literal(true)}).strict().superRefine((v,ctx)=>{if(new Set(v.rows.map(r=>r.draftId)).size!==v.rows.length)ctx.addIssue({code:z.ZodIssueCode.custom,message:'Select each draft once'});});
export type V2NativePublicationTarget={draftId:string;sku:string;title:string;quantity:number;itemCents:number;shippingCents:number;manualItemCents?:number};
type Model={findUnique:(args:any)=>Promise<any>;findFirst:(args:any)=>Promise<any>;findMany:(args:any)=>Promise<any[]>;create:(args:any)=>Promise<any>;update:(args:any)=>Promise<any>;updateMany:(args:any)=>Promise<{count:number}>;upsert:(args:any)=>Promise<any>};
export type V2PublicationDatabase={v2DraftPublicationJob:Model;v2DraftPublicationItem:Model;v2DraftPublisherHeartbeat:Model;$transaction:<T>(fn:(tx:V2PublicationDatabase)=>Promise<T>)=>Promise<T>};
type Dependencies={database?:V2PublicationDatabase;report?:()=>Promise<V2PriceCheckReport>;now?:()=>Date};
async function database(deps:Dependencies){if(deps.database)return deps.database;const{prisma}=await import('./prisma.ts');return prisma as unknown as V2PublicationDatabase;}
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export class V2PublicationError extends Error{readonly code:string;readonly status:number;constructor(code:string,status:number,message:string){super(message);this.code=code;this.status=status;}}
function error(code:string,message:string,status=409):never{throw new V2PublicationError(code,status,message);}
function publicJob(job:any){return{id:String(job.id),reportId:String(job.reportId),status:String(job.status),phase:String(job.phase),
 total:Array.isArray(job.selection)?job.selection.length:0,createdAt:new Date(job.createdAt).toISOString(),updatedAt:new Date(job.updatedAt).toISOString(),
 result:job.result??null};}
function readyWorker(row:any,at:Date){if(!row||row.seller!==seller||row.version!==V2_NATIVE_PUBLISHER_VERSION||!['READY','BUSY'].includes(row.status))return false;
 const age=at.getTime()-new Date(row.seenAt).getTime(),sellerAge=at.getTime()-new Date(row.sellerObservedAt??0).getTime();
 return age>=0&&age<=V2_PUBLISHER_HEARTBEAT_MS&&sellerAge>=0&&sellerAge<=120_000;}

/** No browser connection, capability, or job is invented from the frozen report. */
export async function getV2SelectedPublicationStatus(operatorId:string,jobId?:string,deps:Dependencies={}){
 try{const db=await database(deps),at=deps.now?.()??new Date();
  const worker=await db.v2DraftPublisherHeartbeat.findFirst({where:{operatorId,seller,status:{in:['READY','BUSY']}},orderBy:{seenAt:'desc'}}),transportReady=readyWorker(worker,at);
  let job;if(jobId){z.string().uuid().parse(jobId);job=await db.v2DraftPublicationJob.findFirst({where:{id:jobId,operatorId,seller}});if(!job)error('JOB_NOT_FOUND','The selected publication request was not found.',404);}
  else job=await db.v2DraftPublicationJob.findFirst({where:{operatorId,seller,status:{in:['QUEUED','RUNNING','REVIEW_REQUIRED','ARCHIVE_REVIEW']}},orderBy:{createdAt:'desc'}});
  return{transportReady,reason:transportReady?'The separate eBay publisher is connected. Only explicitly reviewed selections can be submitted.':'The separate eBay publisher is not connected. No publication request will be queued.',
   ...(worker&&transportReady?{worker:{status:worker.status,lastSeenAt:new Date(worker.seenAt).toISOString(),seller,version:V2_NATIVE_PUBLISHER_VERSION}}:{}),...(job?{requestId:job.id,status:job.status,message:job.status==='COMPLETE'?'Selected drafts were published and live acknowledgements retained.':job.status==='REVIEW_REQUIRED'?'Publication needs reconciliation; do not submit this selection again.':'Publication is retained and awaits actual runner results.',job:publicJob(job)}:{})};
 }catch(e){if(e instanceof V2PublicationError)throw e;return{transportReady:false,reason:'The publication connection is unavailable. Its database setup and signed-in local publisher must be ready before publishing.'};}
}

/** Removes only exact report IDs positively published by this operator's native
 * jobs. It is one bounded database read, never an eBay inventory scan. */
export async function projectV2UnpublishedPriceReport(report:V2PriceCheckReport,operatorId:string,deps:Dependencies={}):Promise<V2PriceCheckReport>{
 let published:Array<{draftId:string}>;
 try{const db=await database(deps);if(!db.v2DraftPublicationItem?.findMany)return report;
  published=await db.v2DraftPublicationItem.findMany({where:{seller,status:'PUBLISHED',draftId:{in:report.rows.map(row=>row.draftId)},job:{operatorId}},select:{draftId:true}});
 }catch(e){if(['P2021','P2022'].includes(String((e as {code?:string}).code)))return report;throw e;}
 const removed=new Set(published.map(r=>r.draftId));if(!removed.size)return report;
 const rows=report.rows.filter(row=>!removed.has(row.draftId));
 const prior=report.unpublishedMembership,excludedDraftIds=Array.from(new Set([...(prior?.excludedDraftIds??[]),...report.rows.filter(row=>removed.has(row.draftId)).map(row=>row.draftId)]));
 return{...report,rows,totalDrafts:rows.length,completedDrafts:rows.length,unpublishedMembership:{observedAt:prior?.observedAt??report.snapshotObservedAt,source:'ebay-seller-hub-drafts',sourceDraftCount:prior?.sourceDraftCount??report.totalDrafts,excludedDraftIds}};
}

/** Persists a selected intent only. No eBay, pricing, card-processing or photo writers are imported. */
export async function enqueueV2SelectedPublication(operatorId:string,raw:unknown,deps:Dependencies={}){
 const input=selectedPublicationRequestSchema.parse(raw),db=await database(deps),at=deps.now?.()??new Date(),rows=input.rows.slice().sort((a,b)=>a.draftId.localeCompare(b.draftId));
 const requestKey=operatorId+':'+input.requestId,scopeHash=digest({operatorId,seller,reportId:input.reportId,rows,reviewAcknowledged:true});
 const prior=await db.v2DraftPublicationJob.findUnique({where:{requestKey}});if(prior){if(prior.operatorId!==operatorId||prior.scopeHash!==scopeHash)error('REQUEST_CHANGED','This request identifier is already bound to another selection.');return{accepted:true,reused:true,requestId:prior.id,status:prior.status,message:'The exact existing request was retained; no duplicate request was created.',job:publicJob(prior)};}
 const worker=await db.v2DraftPublisherHeartbeat.findFirst({where:{operatorId,seller,status:{in:['READY','BUSY']}},orderBy:{seenAt:'desc'}});
 if(!readyWorker(worker,at))error('PUBLISHER_DISCONNECTED','Connect the separate signed-in eBay publisher before publishing. No request was queued.');
 const report=await(deps.report??(()=>readV2PriceCheckReport()))();if(report.reportId!==input.reportId)error('REPORT_CHANGED','The saved report changed. Review the selection again.');
 const targets:V2NativePublicationTarget[]=rows.map(selected=>{
  const row=report.rows.find(r=>r.draftId===selected.draftId);
  if(!row)error('DRAFT_NOT_IN_REPORT','A selected draft is no longer in this unpublished report.');
  if(!row.sku||!/^V2-[a-f0-9]{24}$/.test(row.sku)||!row.title||!Number.isSafeInteger(row.quantity)||!row.quantity||row.quantity<1)error('DRAFT_BINDING_MISSING','A selected draft is missing its exact saved identity or quantity. Refresh the report before publishing.');
  if(row.currentItemCents===null||row.shippingCents===null||!Number.isSafeInteger(row.currentItemCents)||!Number.isSafeInteger(row.shippingCents))error('PRICE_OBSERVATION_MISSING','A selected draft has an unknown original item price or shipping. Refresh its saved values first.');
  if((selected.manualItemCents??row.currentItemCents)<149)error('ITEM_PRICE_BELOW_FLOOR','Each selected item price must be at least $1.49.');
  return{draftId:row.draftId,sku:row.sku,title:row.title,quantity:row.quantity,itemCents:row.currentItemCents,shippingCents:row.shippingCents,...(selected.manualItemCents===undefined?{}:{manualItemCents:selected.manualItemCents})};
 });
 try{const job=await db.$transaction(async tx=>{
   const conflicts=await tx.v2DraftPublicationItem.findMany({where:{seller,draftId:{in:targets.map(t=>t.draftId)}},select:{draftId:true,jobId:true}});
   if(conflicts.length)error('DRAFT_ALREADY_REQUESTED','A selected draft already belongs to a publication request. Review that request instead of submitting it again.');
   return tx.v2DraftPublicationJob.create({data:{id:input.requestId,operatorId,seller,requestKey,scopeHash,reportId:input.reportId,selection:targets,status:'QUEUED',phase:'queued',createdAt:at,updatedAt:at,
    items:{create:targets.map(t=>({id:input.requestId+':'+t.draftId,seller,draftId:t.draftId,status:'QUEUED'}))}}});
  });return{accepted:true,reused:false,requestId:job.id,status:job.status,message:'Selected publication queued; completion requires actual live results from the runner.',job:publicJob(job)};
 }catch(e){if(e instanceof V2PublicationError)throw e;const existing=await db.v2DraftPublicationJob.findUnique({where:{requestKey}});if(existing?.operatorId===operatorId&&existing.scopeHash===scopeHash)return{accepted:true,reused:true,requestId:existing.id,status:existing.status,message:'The exact existing request was retained; no duplicate request was created.',job:publicJob(existing)};error('DRAFT_REQUEST_CONFLICT','Another request claimed this draft selection. Refresh request status; do not resubmit blindly.');}
}

const leaseFields={workerId:z.string().uuid(),jobId:z.string().uuid(),leaseToken:z.string().uuid()};
const observation=z.object({draftId:id,itemId:z.string().regex(/^\d{9,15}$/),sku:z.string().regex(/^V2-[a-f0-9]{24}$/),title:z.string().min(1).max(200),quantity:z.number().int().positive(),itemCents:z.number().int().nonnegative(),shippingCents:z.number().int().nonnegative()}).strict();
const proof=z.object({path:z.string().min(1).max(1000),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export const publicationWorkerRequestSchema=z.discriminatedUnion('action',[
 z.object({action:z.literal('heartbeat'),workerId:z.string().uuid(),seller:z.literal('imaydit58'),version:z.literal(V2_NATIVE_PUBLISHER_VERSION),status:z.enum(['READY','BUSY','LOGIN_REQUIRED','ERROR']),sellerObservedAt:z.string().datetime().optional()}).strict(),
 z.object({action:z.literal('claim'),workerId:z.string().uuid()}).strict(),
 z.object({action:z.literal('checkpoint'),...leaseFields,phase:z.enum(['preparing','before-price-edit','before-final-submit','verifying','published-group']),draftIds:z.array(id).max(500).optional(),observations:z.array(observation).max(500).optional(),evidence:proof.optional()}).strict(),
 z.object({action:z.literal('complete'),...leaseFields,published:z.array(observation).max(500),exceptions:z.array(z.object({draftId:id,reason:z.string().min(1).max(500)}).strict()).max(500),archives:z.array(z.object({draftId:id,status:z.enum(['moved','held','not-local'])}).strict()).max(500).optional(),evidence:proof.optional()}).strict(),
 z.object({action:z.literal('stop'),...leaseFields,reason:z.string().min(1).max(500),remoteOutcomeUncertain:z.boolean()}).strict(),
]);
async function ownedJob(db:V2PublicationDatabase,operatorId:string,input:z.infer<typeof publicationWorkerRequestSchema>&{jobId:string;workerId:string;leaseToken:string},at:Date){
 const job=await db.v2DraftPublicationJob.findFirst({where:{id:input.jobId,operatorId,seller}});
 if(!job||job.status!=='RUNNING'||job.workerId!==input.workerId||job.leaseToken!==input.leaseToken||!job.leaseExpiresAt||new Date(job.leaseExpiresAt).getTime()<at.getTime())error('LEASE_CHANGED','The publication lease is no longer owned; no remote action may continue.');return job;
}
export async function handleV2PublicationWorker(operatorId:string,raw:unknown,deps:Dependencies={}){
 const input=publicationWorkerRequestSchema.parse(raw),db=await database(deps),at=deps.now?.()??new Date();
 if(input.action==='heartbeat'){
  if(input.status==='READY'&&(!input.sellerObservedAt||Math.abs(at.getTime()-Date.parse(input.sellerObservedAt))>120_000))error('SELLER_OBSERVATION_STALE','A fresh actual seller observation is required.');
  const old=await db.v2DraftPublisherHeartbeat.findUnique({where:{workerId:input.workerId}});if(old&&old.operatorId!==operatorId)error('WORKER_OWNER_CHANGED','Publisher ownership differs.',403);
  await db.v2DraftPublisherHeartbeat.upsert({where:{workerId:input.workerId},create:{workerId:input.workerId,operatorId,seller,version:input.version,status:input.status,sellerObservedAt:input.sellerObservedAt?new Date(input.sellerObservedAt):null,seenAt:at},update:{status:input.status,sellerObservedAt:input.sellerObservedAt?new Date(input.sellerObservedAt):null,seenAt:at}});
  return{accepted:true,heartbeatExpiresAt:new Date(at.getTime()+V2_PUBLISHER_HEARTBEAT_MS).toISOString()};
 }
 if(input.action==='claim')return db.$transaction(async tx=>{
  const heartbeat=await tx.v2DraftPublisherHeartbeat.findUnique({where:{workerId:input.workerId}});if(heartbeat?.operatorId!==operatorId||!readyWorker(heartbeat,at)||heartbeat.status!=='READY')error('PUBLISHER_NOT_READY','Publisher must have a fresh signed-in ready heartbeat.');
  // An expired writer is ambiguous, never automatically requeued for a second submit.
  await tx.v2DraftPublicationJob.updateMany({where:{operatorId,seller,status:'RUNNING',leaseExpiresAt:{lt:at}},data:{status:'REVIEW_REQUIRED',phase:'lease-expired',updatedAt:at}});
  const job=await tx.v2DraftPublicationJob.findFirst({where:{operatorId,seller,status:'QUEUED'},orderBy:{createdAt:'asc'}});if(!job)return{job:null};
  const leaseToken=randomUUID(),leaseExpiresAt=new Date(at.getTime()+120_000),claimed=await tx.v2DraftPublicationJob.updateMany({where:{id:job.id,status:'QUEUED'},data:{status:'RUNNING',phase:'preparing',workerId:input.workerId,leaseToken,leaseExpiresAt,updatedAt:at}});
  if(claimed.count!==1)return{job:null};return{job:{id:job.id,reportId:job.reportId,targets:job.selection,leaseToken,leaseExpiresAt:leaseExpiresAt.toISOString()}};
 });
 const job=await ownedJob(db,operatorId,input,at),targets=job.selection as V2NativePublicationTarget[];
 const ownedWhere={id:job.id,status:'RUNNING',workerId:input.workerId,leaseToken:input.leaseToken,leaseExpiresAt:{gte:at}};
 const checkLive=(row:z.infer<typeof observation>)=>{const t=targets.find(t=>t.draftId===row.draftId);if(!t||t.sku!==row.sku||t.title!==row.title||t.quantity!==row.quantity||row.itemCents!==(t.manualItemCents??t.itemCents)||row.shippingCents!==t.shippingCents)error('LIVE_RESULT_CHANGED','The live result differs from its reviewed identity, price, shipping or quantity.');};
 if(input.action==='checkpoint'){
  const ids=input.draftIds??[];if(new Set(ids).size!==ids.length||ids.some(id=>!targets.some(t=>t.draftId===id)))error('CHECKPOINT_SCOPE_CHANGED','Checkpoint must remain inside the selected draft scope.');
  if(['before-final-submit','before-price-edit'].includes(input.phase)&&!ids.length)error('SUBMIT_SCOPE_REQUIRED','Exact group draft IDs are required before a remote write.');
  const progress=job.progress&&typeof job.progress==='object'?job.progress:{};
  const attempted=new Set<string>(Array.isArray(progress.attemptedDraftIds)?progress.attemptedDraftIds:[]);
  if(input.phase==='before-final-submit'&&ids.some(id=>attempted.has(id)))error('SUBMISSION_ALREADY_ATTEMPTED','This exact draft group already has a submit checkpoint. Reconcile instead of submitting again.');
  if(input.phase==='before-final-submit')ids.forEach(id=>attempted.add(id));
  await db.$transaction(async tx=>{
   const updated=await tx.v2DraftPublicationJob.updateMany({where:ownedWhere,data:{phase:input.phase,leaseExpiresAt:new Date(at.getTime()+120_000),updatedAt:at,
    ...(['before-final-submit','before-price-edit'].includes(input.phase)&&!job.publicationAttemptedAt?{publicationAttemptedAt:at}:{}),progress:{...progress,attemptedDraftIds:Array.from(attempted),lastCheckpoint:{phase:input.phase,at:at.toISOString(),draftIds:ids,...(input.evidence?{evidence:input.evidence}:{})}}}});
   if(updated.count!==1)error('LEASE_CHANGED','The publication lease changed before checkpoint.');
   if(input.phase==='before-price-edit'||input.phase==='before-final-submit'){
    const changed=await tx.v2DraftPublicationItem.updateMany({where:{jobId:job.id,draftId:{in:ids},status:input.phase==='before-price-edit'?'QUEUED':{in:['QUEUED','PRICE_EDITING']}},data:{status:input.phase==='before-price-edit'?'PRICE_EDITING':'SUBMISSION_ATTEMPTED'}});
    if(changed.count!==ids.length)error('SUBMISSION_ALREADY_ATTEMPTED','An exact draft already has a write checkpoint. Reconcile instead of replaying.');
   }
   if(input.phase==='published-group'){
    const observed=input.observations??[];if(!ids.length||observed.length!==ids.length||new Set(observed.map(r=>r.draftId)).size!==ids.length||new Set(observed.map(r=>r.itemId)).size!==ids.length||observed.some(r=>!ids.includes(r.draftId)))error('LIVE_SCOPE_CHANGED','An acknowledged group needs one exact live result per draft.');
    for(const row of observed){checkLive(row);const changed=await tx.v2DraftPublicationItem.updateMany({where:{jobId:job.id,draftId:row.draftId,status:'SUBMISSION_ATTEMPTED'},data:{status:'PUBLISHED',liveItemId:row.itemId,result:row}});if(changed.count!==1)error('LIVE_CHECKPOINT_CHANGED','Live acknowledgement already exists or lacks a submit checkpoint.');}
   }
  });return{accepted:true};
 }
 if(input.action==='stop'){
  const status=job.publicationAttemptedAt||input.remoteOutcomeUncertain?'REVIEW_REQUIRED':'STOPPED';
  const stopped=await db.v2DraftPublicationJob.updateMany({where:ownedWhere,data:{status,phase:'stopped',result:{reason:input.reason,remoteOutcomeUncertain:input.remoteOutcomeUncertain},completedAt:at,updatedAt:at}});if(stopped.count!==1)error('LEASE_CHANGED','The lease changed before the stop checkpoint.');return{accepted:true,status};
 }
 const ids=[...input.published.map(r=>r.draftId),...input.exceptions.map(r=>r.draftId)];if(ids.length!==targets.length||new Set(ids).size!==targets.length||targets.some(t=>!ids.includes(t.draftId)))error('COMPLETION_SCOPE_CHANGED','Every selected draft needs one actual result or exception.');
 if(new Set(input.published.map(r=>r.itemId)).size!==input.published.length)error('LIVE_ID_REPEATED','A live item cannot satisfy two selected drafts.');
 for(const row of input.published)checkLive(row);
 const archives=input.archives??[],publishedIds=new Set(input.published.map(r=>r.draftId));
 if(new Set(archives.map(a=>a.draftId)).size!==archives.length||archives.some(a=>!publishedIds.has(a.draftId)))error('ARCHIVE_SCOPE_CHANGED','Archive results must cover published drafts once without extra IDs.');
 const status=input.exceptions.length?'REVIEW_REQUIRED':archives.length!==input.published.length||archives.some(a=>a.status!=='moved')?'ARCHIVE_REVIEW':'COMPLETE';
 await db.$transaction(async tx=>{
  const finished=await tx.v2DraftPublicationJob.updateMany({where:ownedWhere,data:{status,phase:'complete',completedAt:at,updatedAt:at,result:{published:input.published,exceptions:input.exceptions,archives:input.archives??[],...(input.evidence?{evidence:input.evidence}:{})}}});if(finished.count!==1)error('LEASE_CHANGED','The publication lease changed before completion.');
  const existing=await tx.v2DraftPublicationItem.findMany({where:{jobId:job.id,draftId:{in:input.published.map(r=>r.draftId)}}});
  if(input.published.some(r=>!existing.some(i=>i.draftId===r.draftId&&['SUBMISSION_ATTEMPTED','PUBLISHED'].includes(i.status)&&(!i.liveItemId||i.liveItemId===r.itemId))))error('SUBMIT_PROOF_MISSING','Live results require retained single-submit checkpoints.');
  for(const row of input.published)await tx.v2DraftPublicationItem.update({where:{seller_draftId:{seller,draftId:row.draftId}},data:{status:'PUBLISHED',liveItemId:row.itemId,result:row}});
  for(const row of input.exceptions)await tx.v2DraftPublicationItem.update({where:{seller_draftId:{seller,draftId:row.draftId}},data:{status:'EXCEPTION',result:row}});
 });
 return{accepted:true,status};
}

