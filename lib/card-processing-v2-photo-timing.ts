import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {appendV2TimingEvent} from './card-processing-v2-timing-journal.ts';
import type {V2Timing} from './card-processing-v2.ts';

export type V2PhotoSegment={step:string;startedAt:string;endedAt:string;durationMs:number;status:'completed'|'failed'};
export type V2PhotoTimingObserver=(segment:V2PhotoSegment)=>void;
/** In-memory only while the operation is in flight. Failure means this callback
 * threw, not proof that an external request had no remote effect. No error body,
 * credentials, image bytes, URL query parameters or provider text are recorded. */
export async function observeV2PhotoStep<T>(observer:V2PhotoTimingObserver|undefined,step:string,action:()=>Promise<T>):Promise<T>{
 if(!observer)return action();
 const started=performance.now(),startedAt=new Date().toISOString();let status:'completed'|'failed'='failed';
 try{const result=await action();status='completed';return result;}
 finally{const segment={step,startedAt,endedAt:new Date().toISOString(),durationMs:Math.max(0,performance.now()-started),status};try{observer(segment);}catch{/* Diagnostics never overwrite a domain result or trigger request replay. */}}
}
/** One durable journal event after the photo callback/state checkpoint settles,
 * rather than two journal writes for every inner phase. Existing outer operation
 * spans remain authoritative; these are nested diagnostic segments, not additive.
 */
export async function appendV2PhotoSegments(root:string,segments:V2PhotoSegment[],context:{cardId:string;runId?:string},append=appendV2TimingEvent){
 if(!segments.length)return{appended:false};
 if(segments.length>12||!context.cardId||segments.some(s=>!/^photo-(?:verified-original-read|connection-read|orientation-encode|eps-request|media-state-commit|media-ack-recovery|upload-attempt-fence)$/.test(s.step)))throw Error('Bounded photo timing segments required');
 const id='photo-inner-'+randomUUID(),spans:V2Timing[]=segments.map((s,n)=>({id:id+'-'+n,pid:process.pid,...context,...s}));
 await append(root,id,spans);return{appended:true};
}
