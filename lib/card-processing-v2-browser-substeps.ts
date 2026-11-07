import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {digest,timingSchema} from './card-processing-v2.ts';
import {readV2State,withV2State,v2Dir} from './card-processing-v2-store.ts';
import {processingBatchSchema} from './card-processing-v2-processing-batches.ts';
import {summarizeV2Timings} from './card-processing-v2-timing-summary.ts';

export const V2_BROWSER_SUBSTEPS=['navigation','dom-read','ax-read','feature-expand','upload-ack','remote-processing','selection','save','local-validation','evidence-retain','agent-gap','editor-ready','local-finalize','local-checkpoint'] as const;
const uuid=z.string().uuid(),hash=z.string().regex(/^[a-f0-9]{64}$/),owner=z.string().trim().min(1).max(100);
const leaseSchema=z.object({version:z.literal(1),spanId:uuid,parentSpanId:uuid,batchId:uuid,owner,tokenHash:hash,step:z.enum(V2_BROWSER_SUBSTEPS),cardIds:z.array(z.string().min(1)).min(1).max(20).optional(),startedAt:z.string().datetime(),expiresAt:z.string().datetime()}).strict();
const sha=(s:string|Uint8Array)=>createHash('sha256').update(s).digest('hex'),directory=(root:string)=>path.join(v2Dir(root),'browser-substep-leases');
const prefix=(parent:string)=>`browser-substep:${parent}:`;
async function read(file:string){const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>262144)throw Error('Invalid bounded timing checkpoint');return JSON.parse(await fs.readFile(file,'utf8'));}
function recent(at:string){const age=Date.now()-Date.parse(at);if(!Number.isFinite(age)||age<0||age>300000)throw Error('Actual recent substep timestamp required');}
async function mkdir(root:string){await fs.mkdir(directory(root),{recursive:true});if((await fs.lstat(directory(root))).isSymbolicLink())throw Error('Invalid timing directory');}
/** Short-lived CLI processes do not own browser lifetimes: parent token plus
 * persisted owner fence each actual substep, independent of their Node PID. */
export async function beginV2BrowserSubstep(root:string,raw:unknown){
 const p=z.object({batchId:uuid,parentSpanId:uuid,parentToken:uuid,owner,step:z.enum(V2_BROWSER_SUBSTEPS),cardIds:z.array(z.string()).min(1).max(20).optional(),startedAt:z.string().datetime().optional()}).strict().parse(raw),startedAt=p.startedAt??new Date().toISOString();recent(startedAt);
 const parentLease=await read(path.join(v2Dir(root),'browser-timing-leases',`${p.parentSpanId}.json`));
 if(parentLease.batchId!==p.batchId||parentLease.spanId!==p.parentSpanId||parentLease.tokenHash!==sha(p.parentToken)||Date.parse(parentLease.expiresAt)<=Date.now())throw Error('Exact current parent browser timing token required');
 const batch=processingBatchSchema.parse(await read(path.join(v2Dir(root),'processing-batches',`${p.batchId}.json`)));if(batch.status==='failed')throw Error('Accepted batch required');
 const cardIds=p.cardIds?[...p.cardIds].sort():parentLease.cardIds as string[]|undefined;
 if(cardIds&&(new Set(cardIds).size!==cardIds.length||parentLease.cardIds&&cardIds.some(id=>!parentLease.cardIds.includes(id))))throw Error('Substep cards must stay within parent scope');
 await mkdir(root);const token=randomUUID(),spanId=randomUUID(),lease=leaseSchema.parse({version:1,spanId,parentSpanId:p.parentSpanId,batchId:p.batchId,owner:p.owner,step:p.step,...(cardIds?{cardIds}:{}),tokenHash:sha(token),startedAt,expiresAt:parentLease.expiresAt});
 await withV2State(async s=>{
  const parent=s.timings.find(t=>t.id===p.parentSpanId);if(!parent||parent.status!=='running'||parent.source!=='external-browser-wall-clock'||parent.runId!==p.batchId||parent.step.startsWith('browser-substep:')||Date.parse(startedAt)<Date.parse(parent.startedAt))throw Error('Actual running coarse parent required');
  if(s.timings.some(t=>t.status==='running'&&t.step.startsWith('browser-substep:')))throw Error('Another browser substep is active; close or interrupt before advancing');
  const siblings=s.timings.filter(t=>t.step.startsWith('browser-substep:'));if(siblings.some(t=>t.endedAt&&Date.parse(t.endedAt)>Date.parse(startedAt)))throw Error('Substeps cannot overlap retrospectively');
  if(cardIds?.some(id=>{const card=s.cards[id];return !card||!batch.captures.some(c=>(!c.cardId||c.cardId===id)&&digest(c.photos.map(p=>p.hash).sort())===digest(card.photos.map(p=>p.hash).sort()));}))throw Error('Exact selected batch/card originals required');
  const bindingFile=path.join(directory(root),`${p.parentSpanId}.owner.json`),binding={parentSpanId:p.parentSpanId,batchId:p.batchId,owner:p.owner};
  try{const old=await read(bindingFile);if(digest(old)!==digest(binding))throw Error('Parent substep owner changed');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;await fs.writeFile(bindingFile,JSON.stringify(binding),{flag:'wx',flush:true});}
  await fs.writeFile(path.join(directory(root),`${spanId}.json`),JSON.stringify(lease),{flag:'wx',flush:true});
  s.timings.push(timingSchema.parse({id:spanId,step:prefix(p.parentSpanId)+p.step,runId:p.batchId,...(cardIds?{cardIds}:{}),pid:process.pid,...(['local-finalize','local-checkpoint','local-validation','evidence-retain'].includes(p.step)?{}:{source:'external-browser-wall-clock'}),startedAt,status:'running'}));
 },root);
 return{spanId,token,parentSpanId:p.parentSpanId,batchId:p.batchId,owner:p.owner,step:p.step,startedAt,expiresAt:lease.expiresAt};
}
export async function endV2BrowserSubstep(root:string,raw:unknown){
 const p=z.object({spanId:uuid,token:uuid,owner,status:z.enum(['completed','failed','interrupted']),endedAt:z.string().datetime().optional()}).strict().parse(raw),lease=leaseSchema.parse(await read(path.join(directory(root),`${p.spanId}.json`))),endedAt=p.endedAt??new Date().toISOString();recent(endedAt);
 if(lease.owner!==p.owner||lease.tokenHash!==sha(p.token)||Date.parse(endedAt)<Date.parse(lease.startedAt)||p.status!=='interrupted'&&Date.parse(lease.expiresAt)<Date.now())throw Error('Exact substep owner/token and ordered timestamps required');
 const batch=processingBatchSchema.parse(await read(path.join(v2Dir(root),'processing-batches',`${lease.batchId}.json`)));
 return withV2State(s=>{const span=s.timings.find(t=>t.id===p.spanId),parent=s.timings.find(t=>t.id===lease.parentSpanId);if(!span||span.status!=='running'||span.step!==prefix(lease.parentSpanId)+lease.step||span.runId!==lease.batchId||span.startedAt!==lease.startedAt||digest(span.cardIds??[])!==digest(lease.cardIds??[]))throw Error('Exact unfinished substep checkpoint required');if(p.status!=='interrupted'&&(!parent||parent.status!=='running'))throw Error('Parent ended; reconcile substep as interrupted, never guessed duration');if(p.status!=='interrupted'&&lease.cardIds?.some(id=>!s.cards[id]||!batch.captures.some(c=>(!c.cardId||c.cardId===id)&&digest(c.photos.map(p=>p.hash).sort())===digest(s.cards[id].photos.map(p=>p.hash).sort()))))throw Error('Card binding changed; reconcile timing as interrupted');span.status=p.status;span.endedAt=endedAt;if(p.status==='interrupted')delete span.durationMs;else span.durationMs=Date.parse(endedAt)-Date.parse(span.startedAt);return{spanId:span.id,status:span.status,durationMs:span.durationMs};},root);
}
/** Recovery records unknown duration; a dead CLI PID is expected and is not a
 * browser failure. Expiry or a non-running parent is the recovery boundary. */
export async function recoverV2BrowserSubsteps(root:string){return withV2State(s=>{let recovered=0;for(const span of s.timings.filter(t=>t.step.startsWith('browser-substep:')&&t.status==='running')){const parentId=span.step.split(':')[1],parent=s.timings.find(t=>t.id===parentId);if(!parent||parent.status!=='running'||Date.now()-Date.parse(span.startedAt)>86400000){span.status='interrupted';span.endedAt=new Date().toISOString();delete span.durationMs;recovered++;}}return{recovered,durations:'unknown-not-zero'};},root);}
/** One bounded import after an actual IAB trace avoids CLI roundtrips per UI
 * action. Hash provenance is not a saved-field verification or permission. */
export async function importV2BrowserSubstepTrace(root:string,raw:unknown){
 const p=z.object({batchId:uuid,parentSpanId:uuid,parentToken:uuid,owner,cardId:z.string().min(1),evidence:z.object({path:z.string(),sha256:hash}).strict()}).strict().parse(raw);
 if(path.isAbsolute(p.evidence.path)||p.evidence.path.split(/[\\/]/).includes('..'))throw Error('Trace evidence must stay under artifacts');
 const file=await fs.realpath(path.resolve(root,p.evidence.path)),base=await fs.realpath(path.join(root,'artifacts')),relative=path.relative(base,file);if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw Error('Trace evidence must stay under artifacts');
 const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>2_000_000)throw Error('Invalid bounded trace evidence');const bytes=await fs.readFile(file);if(sha(bytes)!==p.evidence.sha256)throw Error('Trace evidence hash mismatch');
 const trace=z.object({observation:z.object({draftId:z.string().regex(/^\d+$/),url:z.string().url(),observedAt:z.string().datetime(),dom:z.object({fields:z.array(z.object({name:z.string().optional(),value:z.string().optional()}).passthrough())}).passthrough()}).passthrough().optional(),draftId:z.string().regex(/^\d+$/).optional(),reason:z.literal('Observation interrupted; no completion or save claimed').optional(),trace:z.array(z.object({step:z.string(),startedAt:z.string().datetime(),endedAt:z.string().datetime(),durationMs:z.number().finite().nonnegative(),status:z.enum(['completed','failed'])}).strict()).min(1).max(100)}).passthrough().refine(t=>t.observation?t.trace.every(s=>s.status==='completed'):!!t.draftId&&!!t.reason&&t.trace.at(-1)?.status==='failed'&&t.trace.slice(0,-1).every(s=>s.status==='completed'),'Actual complete observation or retained failed operation required').parse(JSON.parse(bytes.toString('utf8')));
 const mapping:Record<string,typeof V2_BROWSER_SUBSTEPS[number]>={'browser-navigation-check':'navigation','browser-navigation':'navigation','browser-control-read':'dom-read','browser-feature-expand':'feature-expand','browser-ax-read':'ax-read','browser-dom-read':'dom-read','browser-evidence-retain':'evidence-retain','browser-observation-check':'local-validation'};
 for(let n=0;n<trace.trace.length;n++){const t=trace.trace[n];if(!mapping[t.step]||Date.parse(t.endedAt)<Date.parse(t.startedAt)||Math.abs(Date.parse(t.endedAt)-Date.parse(t.startedAt)-t.durationMs)>25||n>0&&Date.parse(t.startedAt)<Date.parse(trace.trace[n-1].endedAt))throw Error('Actual ordered nonoverlapping wall/monotonic trace required');}
 recent(trace.trace[trace.trace.length-1].endedAt);const parentLease=await read(path.join(v2Dir(root),'browser-timing-leases',`${p.parentSpanId}.json`));if(parentLease.batchId!==p.batchId||parentLease.tokenHash!==sha(p.parentToken)||Date.parse(parentLease.expiresAt)<Date.now()||parentLease.cardIds&&!parentLease.cardIds.includes(p.cardId))throw Error('Exact current parent timing scope/token required');
 const batch=processingBatchSchema.parse(await read(path.join(v2Dir(root),'processing-batches',`${p.batchId}.json`)));await mkdir(root);
 return withV2State(async s=>{const parent=s.timings.find(t=>t.id===p.parentSpanId),card=s.cards[p.cardId],o=trace.observation,u=o?new URL(o.url):null,observedId=u?(u.searchParams.get('draftId')||u.searchParams.get('draft_id')):trace.draftId;
  if(!parent||parent.status!=='running'||parent.runId!==p.batchId||parent.source!=='external-browser-wall-clock'||parent.step.startsWith('browser-substep:')||Date.parse(trace.trace[0].startedAt)<Date.parse(parent.startedAt)||!card||card.draftId!==observedId||o&&(u?.origin!=='https://www.ebay.com'||o.draftId!==card.draftId||o.dom.fields.filter(f=>f.name==='customLabel').length!==1||o.dom.fields.find(f=>f.name==='customLabel')?.value!==card.sku)||!batch.captures.some(c=>(!c.cardId||c.cardId===card.id)&&digest(c.photos.map(p=>p.hash).sort())===digest(card.photos.map(p=>p.hash).sort())))throw Error('Actual trace must bind current exact parent/batch/card/DraftID/SKU');
  const receipt=path.join(directory(root),`import-${p.evidence.sha256}.json`),binding={parentSpanId:p.parentSpanId,batchId:p.batchId,owner:p.owner,cardId:p.cardId,evidence:p.evidence};
  try{const old=await read(receipt);if(digest(old.binding)!==digest(binding)||!old.ids.every((id:string)=>s.timings.some(t=>t.id===id)))throw Error('Prior trace ownership or commit is unresolved');return{imported:0,replayed:true,spanIds:old.ids};}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  const first=Date.parse(trace.trace[0].startedAt),last=Date.parse(trace.trace[trace.trace.length-1].endedAt);if(s.timings.some(t=>t.step.startsWith('browser-substep:')&&(t.status==='running'||t.endedAt&&Date.parse(t.startedAt)<last&&Date.parse(t.endedAt)>first)))throw Error('Imported trace overlaps existing or unfinished substeps');
  const ownerFile=path.join(directory(root),`${p.parentSpanId}.owner.json`),ownerBinding={parentSpanId:p.parentSpanId,batchId:p.batchId,owner:p.owner};try{if(digest(await read(ownerFile))!==digest(ownerBinding))throw Error('Parent substep owner changed');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;await fs.writeFile(ownerFile,JSON.stringify(ownerBinding),{flag:'wx',flush:true});}
  const spans=trace.trace.map(t=>timingSchema.parse({id:randomUUID(),step:prefix(p.parentSpanId)+mapping[t.step],runId:p.batchId,cardIds:[p.cardId],pid:process.pid,source:'external-browser-wall-clock',startedAt:t.startedAt,endedAt:t.endedAt,durationMs:t.durationMs,status:t.status}));
  await fs.writeFile(receipt,JSON.stringify({binding,ids:spans.map(t=>t.id)}),{flag:'wx',flush:true});s.timings.push(...spans);return{imported:spans.length,replayed:false,spanIds:spans.map(t=>t.id)};
 },root);
}
export async function reportV2BrowserSubsteps(root:string,raw:unknown){
 const p=z.object({batchId:uuid,cardId:z.string().optional(),now:z.string().datetime().optional()}).strict().parse(raw),batch=processingBatchSchema.parse(await read(path.join(v2Dir(root),'processing-batches',`${p.batchId}.json`))),state=await readV2State(root);
 if(p.cardId&&(!state.cards[p.cardId]||!batch.captures.some(c=>(!c.cardId||c.cardId===p.cardId)&&digest(c.photos.map(x=>x.hash).sort())===digest(state.cards[p.cardId!].photos.map(x=>x.hash).sort()))))throw Error('Report card is outside exact batch');
 const summary=summarizeV2Timings(state.timings,{runId:p.batchId,cardId:p.cardId,createdAt:batch.clickedAt,now:p.now}),substeps:Record<string,{count:number;measuredMs:number;failed:number;interrupted:number;running:number}>={};
 for(const [key,item]of Object.entries(summary.steps)){const name=/^browser-substep:[^:]+:(.+)$/.exec(key)?.[1];if(!name)continue;const row=substeps[name]??={count:0,measuredMs:0,failed:0,interrupted:0,running:0};row.count+=item.count;row.measuredMs+=item.totalMs;row.failed+=item.failed;row.interrupted+=item.interrupted;row.running+=item.running;}
 return{batchId:p.batchId,...summary,substeps,falseHoldCount:null,falseHoldMeasurement:'Not measured by a timer; requires independently validated comparison receipts',readOnly:true,canPublish:false};
}
