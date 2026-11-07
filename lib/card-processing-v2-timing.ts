import {noteV2ActivityProgress} from './card-processing-v2-activity.ts';
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { AsyncLocalStorage } from "node:async_hooks";
import { timingSchema } from "./card-processing-v2.ts";
import { processAlive,readV2State } from "./card-processing-v2-store.ts";
import fs from 'node:fs/promises';
import path from 'node:path';
import {appendV2TimingEvent} from './card-processing-v2-timing-journal.ts';

export type V2TimingContext = { cardId?: string; cardIds?: string[]; runId?: string };
const contextStorage=new AsyncLocalStorage<V2TimingContext>();
function mergedContext(context:V2TimingContext){const merged={...contextStorage.getStore(),...context};if(context.cardIds&&!context.cardId)delete merged.cardId;if(context.cardId&&!context.cardIds)delete merged.cardIds;return merged;}
export function withV2TimingContext<T>(context: V2TimingContext, fn: () => T): T {return contextStorage.run(mergedContext(context),fn);}
/** Includes durable-start checkpoint overhead; final checkpoint overhead is outside the measured boundary. No provider error text is retained. */
export async function measureV2<T>(root: string, step: string, fn: () => Promise<T> | T, context: V2TimingContext = {}): Promise<T> {
  await noteV2ActivityProgress(`Starting ${step}`);
  const inherited=mergedContext(context);
  const started=performance.now();
  const span=timingSchema.parse({id:randomUUID(),step,...inherited,pid:process.pid,startedAt:new Date().toISOString(),status:"running"});
  await appendV2TimingEvent(root,span.id+':start',[span]);
  let status: "completed"|"failed"="failed";
  try {const result=await withV2TimingContext(inherited,fn);status="completed";return result;}
  finally {const durationMs=Math.max(0,performance.now()-started),endedAt=new Date().toISOString(),completed={...span,durationMs,endedAt,status};
    try{await appendV2TimingEvent(root,span.id+':end',[completed]);await noteV2ActivityProgress(`${status}: ${step}`);}
    catch{try{const dir=path.join(root,'artifacts/card-processing-v2/timing-journal');await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,'coverage-warning-'+randomUUID()+'.json'),JSON.stringify({span:completed,domainResultPreserved:true,automaticReplayAllowed:false,reason:'timing-final-checkpoint-failed'}),{flag:'wx',flush:true});}catch{/* Preserve the domain result even when all telemetry storage is unavailable. */}process.stderr.write('Timing final checkpoint unavailable; preserve the operation result and reconcile retained timing evidence, never replay it.\n');}
  }
}
/** Interrupted work is known to have started, but its final active duration is unknown. */
export async function recoverV2Timings(root: string, scope: {runId?:string;pid?:number} = {}) {
  const state=await readV2State(root),dead=state.timings.filter(span=>(!scope.runId||span.runId===scope.runId)&&(scope.pid===undefined||span.pid===scope.pid)&&span.status==='running'&&span.source!=='external-browser-wall-clock'&&span.step!=='background-recovery-wait'&&!processAlive(span.pid));
  for(const span of dead){const interrupted={...span,status:'interrupted' as const,endedAt:new Date().toISOString()};delete interrupted.durationMs;await appendV2TimingEvent(root,span.id+':interrupted',[interrupted]);}return dead.length;
}
/** Actual supervisor callbacks bound this wall-clock wait. It is never CPU or
 * productive browser work, and remains open across process death until resume. */
export async function recordV2RecoveryWait(root:string,p:{id:string;runId:string;requestId:string;startedAt:string;endedAt?:string;reason:string;pid:number}){
 if(!/^[a-f0-9-]{36}$/.test(p.id)||p.endedAt&&Date.parse(p.endedAt)<Date.parse(p.startedAt))throw Error('Valid bounded recovery wait boundary required');
 const span=timingSchema.parse({id:p.id,runId:p.runId,step:'background-recovery-wait',pid:p.pid,startedAt:p.startedAt,...(p.endedAt?{endedAt:p.endedAt,durationMs:Math.max(0,Date.parse(p.endedAt)-Date.parse(p.startedAt)),status:'completed'}:{status:'running'})});
 const dir=path.join(root,'artifacts/card-processing-v2/background/recovery-waits');await fs.mkdir(dir,{recursive:true});
 const fence={kind:'observed-background-recovery-wait-boundary',requestId:p.requestId,runId:p.runId,reason:p.reason,startedAt:p.startedAt,...(p.endedAt?{endedAt:p.endedAt}:{}),classification:'wall-clock recovery wait; no productive work claimed',span};
 await fs.writeFile(path.join(dir,p.id+(p.endedAt?'-end':'-start')+'.json'),JSON.stringify(fence),{flag:'wx',flush:true}).catch(error=>{if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;});
 await appendV2TimingEvent(root,p.id+(p.endedAt?':end':':start'),[span]);
}
export { summarizeV2Timings } from "./card-processing-v2-timing-summary.ts";
