import fs from "node:fs/promises";
import path from "node:path";
import {createHash,randomUUID} from "node:crypto";
import {z} from "zod";
import {digest,timingSchema} from "./card-processing-v2.ts";
import {readV2State,withV2State,v2Dir} from "./card-processing-v2-store.ts";
import {processingBatchSchema} from "./card-processing-v2-processing-batches.ts";

export const V2_BROWSER_TIMING_STEPS=["browser-reconciliation","browser-upload","browser-processing-wait","browser-bulk-edit","browser-save-drafts","browser-draft-edit","browser-save-reopen","browser-evidence-capture","browser-result-download","browser-seller-review-wait","browser-agent-gap"] as const;
export const V2_BROWSER_STAGE_BOUNDARIES={
 "browser-seller-review-wait":{start:"Only when an actual scoped seller decision is requested; retain the handoff evidence",end:"Actual seller response received or request cancelled; do not infer from idle time"},
 "browser-agent-gap":{start:"When the agent explicitly pauses between supported operations",end:"Immediately before the next actual operation; unobserved gaps remain unknown"},
 "browser-upload":{start:'Immediately before Choose file/upload of the already checkpointed exact CSV',end:'Actual upload accepted/job row first visible; stop before waiting for processing'},
 "browser-processing-wait":{start:'Accepted job first observed queued/processing',end:'Same job observed terminal; includes waiting only, not mapping/repair/readback'},
 "browser-reconciliation":{start:'Immediately before fresh seller inventory reads or exact terminal-result mapping',end:'Actual scope or exact DraftID/SKU observations retained; stop before field edits'},
 "browser-bulk-edit":{start:'Before editing a proven common defect using freshly observed controls',end:'Changed exact-ID group save acknowledged; stop before later readback'},
 "browser-save-reopen":{start:'Before reopening the same saved changed IDs',end:'Actual readback retained; no blanket save of unchanged cards'},
 "browser-evidence-capture":{start:'Before actual per-copy DOM/AX/visual photo capture',end:'Exact evidence retained; stop before local verification/archive'}
} as const;
const uuid=z.string().uuid(),hash=z.string().regex(/^[a-f0-9]{64}$/),context=z.object({batchId:uuid,step:z.enum(V2_BROWSER_TIMING_STEPS),cardIds:z.array(z.string().min(1).max(300)).min(1).max(20).optional()}).strict();
const evidenceRef=z.object({path:z.string().min(1),sha256:hash}).strict();
const leaseSchema=context.extend({spanId:uuid,tokenHash:hash,expiresAt:z.string().datetime(),startedAt:z.string().datetime(),handoffEvidence:evidenceRef.optional()}).strict();
const sha=(text:string)=>createHash("sha256").update(text).digest("hex");
const dir=(root:string)=>path.join(v2Dir(root),"browser-timing-leases");
function recent(at:string,now:string){const age=Date.parse(now)-Date.parse(at);if(age<0||age>300000)throw Error("Actual recent browser action timestamp required");}
async function readBounded(file:string){const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>262144)throw Error("Invalid browser timing checkpoint");return JSON.parse(await fs.readFile(file,"utf8"));}
/** Begin before the real browser operation. External wall time is distinct from local receipt-validation work. */
export async function beginV2BrowserTiming(root:string,raw:unknown){
  const packet=context.extend({startedAt:z.string().datetime().optional(),handoffEvidence:evidenceRef.optional()}).parse(raw),now=new Date().toISOString(),startedAt=packet.startedAt??now;recent(startedAt,now);
  if(packet.step==='browser-seller-review-wait') {
    if(!packet.handoffEvidence)throw Error('Actual seller handoff evidence required; idle time is not seller review');
    const ref=packet.handoffEvidence;
    if(path.isAbsolute(ref.path)||ref.path.split(/[\\/]/).includes('..'))throw Error('Handoff evidence must stay under artifacts');
    const base=await fs.realpath(path.join(root,'artifacts')),file=await fs.realpath(path.resolve(root,ref.path)),relative=path.relative(base,file);
    if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw Error('Handoff evidence must stay under artifacts');
    const handoff=z.object({kind:z.literal('seller-decision-request'),batchId:uuid,observedAt:z.string().datetime(),question:z.string().trim().min(1),cardId:z.string().optional()}).passthrough().parse(await readBounded(file));
    recent(handoff.observedAt,now);
    if(handoff.batchId!==packet.batchId||Date.parse(handoff.observedAt)>Date.parse(startedAt)||handoff.cardId&&packet.cardIds&&!packet.cardIds.includes(handoff.cardId))throw Error('Handoff must match the actual selected timing scope');
    if(sha(await fs.readFile(file,'utf8'))!==ref.sha256)throw Error('Handoff evidence changed');
  }
  const batch=processingBatchSchema.parse(await readBounded(path.join(v2Dir(root),"processing-batches",`${packet.batchId}.json`)));
  if(Date.parse(startedAt)<Date.parse(batch.clickedAt)||batch.status==="failed")throw Error("Browser timing must belong to an accepted batch");
  const state=await readV2State(root),cardIds=packet.cardIds?[...packet.cardIds].sort():undefined;
  if(state.lastRun?.id!==packet.batchId&&!state.timings.some(t=>t.runId===packet.batchId&&t.step==="scan-intake"&&t.source!=="external-browser-wall-clock"))throw Error("Wait for this batch selection validation before browser timing");
  if(cardIds&&(new Set(cardIds).size!==cardIds.length||cardIds.some(id=>{const card=state.cards[id];return !card||!batch.captures.some(c=>(!c.cardId||c.cardId===id)&&digest(c.photos.map(p=>p.hash).sort())===digest(card.photos.map(p=>p.hash).sort()));})))throw Error("Browser timing card is outside the exact selected batch");
  const spanId=randomUUID(),token=randomUUID(),lease=leaseSchema.parse({batchId:packet.batchId,step:packet.step,...(cardIds?{cardIds}:{}),...(packet.handoffEvidence?{handoffEvidence:packet.handoffEvidence}:{}),spanId,tokenHash:sha(token),startedAt,expiresAt:new Date(Date.parse(now)+86400000).toISOString()});
  await fs.mkdir(dir(root),{recursive:true});if((await fs.lstat(dir(root))).isSymbolicLink())throw Error("Invalid browser timing lease directory");
  const handle=await fs.open(path.join(dir(root),`${spanId}.json`),"wx");try{await handle.writeFile(JSON.stringify(lease));await handle.sync();}finally{await handle.close();}
  try{await withV2State(s=>{if(s.timings.some(t=>t.source==="external-browser-wall-clock"&&t.status==="running"))throw Error("A browser operation is already being timed; close or interrupt it before another stage");s.timings.push(timingSchema.parse({id:spanId,step:packet.step,runId:packet.batchId,...(cardIds?{cardIds}:{}),source:"external-browser-wall-clock",pid:process.pid,startedAt,status:"running"}));},root);}catch(error){await fs.unlink(path.join(dir(root),`${spanId}.json`));throw error;}
  return {spanId,token,batchId:packet.batchId,step:packet.step,startedAt,expiresAt:lease.expiresAt};
}
export async function endV2BrowserTiming(root:string,raw:unknown){
  const packet=z.object({spanId:uuid,token:uuid,status:z.enum(["completed","failed","interrupted"]),endedAt:z.string().datetime().optional()}).strict().parse(raw),lease=leaseSchema.parse(await readBounded(path.join(dir(root),`${packet.spanId}.json`))),now=new Date().toISOString(),endedAt=packet.endedAt??now;recent(endedAt,now);
  if(sha(packet.token)!==lease.tokenHash||Date.parse(endedAt)<Date.parse(lease.startedAt))throw Error("Exact browser timing owner and ordered timestamps required");
  if(packet.status!=="interrupted"&&Date.parse(now)>Date.parse(lease.expiresAt))throw Error("Expired browser timing must be reconciled as interrupted");
  return withV2State(s=>{const span=s.timings.find(t=>t.id===packet.spanId);if(!span||span.status!=="running"||span.source!=="external-browser-wall-clock"||span.runId!==lease.batchId||span.step!==lease.step||span.startedAt!==lease.startedAt||digest(span.cardIds??[])!==digest(lease.cardIds??[]))throw Error("Exact unfinished browser timing checkpoint required");const children=s.timings.filter(t=>t.step.startsWith(`browser-substep:${span.id}:`));if(children.some(t=>t.status==='running'||t.endedAt&&Date.parse(t.endedAt)>Date.parse(endedAt)))throw Error('Close or reconcile child substeps before ending their coarse parent');span.status=packet.status;span.endedAt=endedAt;if(packet.status==="interrupted")delete span.durationMs;else span.durationMs=Date.parse(endedAt)-Date.parse(span.startedAt);return {spanId:span.id,status:span.status,durationMs:span.durationMs,source:span.source};},root);
}
export async function recoverV2BrowserTimings(root:string){const now=new Date().toISOString();return withV2State(s=>{let recovered=0;for(const t of s.timings)if(t.source==="external-browser-wall-clock"&&t.status==="running"&&Date.parse(now)-Date.parse(t.startedAt)>86400000){t.status="interrupted";t.endedAt=now;delete t.durationMs;recovered++;}return recovered;},root);}
