import type {V2Timing} from './card-processing-v2.ts';
import type {V2ActivitySnapshot} from './card-processing-v2-activity.ts';

type Interval=[number,number];
const merged=(input:Interval[])=>{const out:Interval[]=[];for(const [start,end]of input.filter(([a,b])=>b>a).sort((a,b)=>a[0]-b[0])){const last=out.at(-1);if(last&&start<=last[1])last[1]=Math.max(last[1],end);else out.push([start,end]);}return out;};
const duration=(input:Interval[])=>input.reduce((n,[a,b])=>n+b-a,0);
function intersect(a:Interval[],b:Interval[]){const out:Interval[]=[];let i=0,j=0;while(i<a.length&&j<b.length){const start=Math.max(a[i][0],b[j][0]),end=Math.min(a[i][1],b[j][1]);if(end>start)out.push([start,end]);if(a[i][1]<b[j][1])i++;else j++;}return out;}
function subtract(a:Interval[],b:Interval[]){const out:Interval[]=[];let j=0;for(const [start,end]of a){let cursor=start;while(j<b.length&&b[j][1]<=cursor)j++;for(let n=j;n<b.length&&b[n][0]<end;n++){if(b[n][0]>cursor)out.push([cursor,Math.min(end,b[n][0])]);cursor=Math.max(cursor,b[n][1]);if(cursor>=end)break;}if(cursor<end)out.push([cursor,end]);}return out;}

/** Complete elapsed CLASSIFICATION, not a claim that every second was measured
 * work. Owner envelopes remain separate; expired/silent tails never become work.
 * The endpoint must be the original batch's actual final archive when complete. */
export function summarizeV2ElapsedAccounting(input:{clickedAt:string;endedAt?:string;now?:string;timings:readonly V2Timing[];activity?:V2ActivitySnapshot|null}){
 const start=Date.parse(input.clickedAt),end=Date.parse(input.endedAt??input.now??new Date().toISOString());if(!Number.isFinite(start)||!Number.isFinite(end)||end<start)throw Error('Valid original elapsed window required');
 const clip=(a:unknown,b:unknown):Interval[]=>{if(typeof a!=='string'||typeof b!=='string')return[];const x=Math.max(start,Date.parse(a)),y=Math.min(end,Date.parse(b));return Number.isFinite(x)&&Number.isFinite(y)&&y>x?[[x,y]]:[];};
 const detailedParents=new Set(input.timings.flatMap(t=>/^browser-substep:([^:]+):/.exec(t.step)?.[1]??[])),work:Interval[]=[],wait:Interval[]=[],failed:Interval[]=[];
 for(const t of input.timings){if(!['completed','failed'].includes(t.status)||!t.endedAt||t.durationMs===undefined||['identification','draft-preparation'].includes(t.step)||detailedParents.has(t.id))continue;const interval=clip(t.startedAt,t.endedAt);if(t.status==='failed')failed.push(...interval);else if(/(?:-wait|:remote-processing|agent-gap)$/.test(t.step))wait.push(...interval);else work.push(...interval);}
 const overhead=merged((input.activity?.instrumentation?.intervals??[]).flatMap(p=>clip(p.startedAt,p.endedAt))),actual=merged([...work,...wait,...failed,...overhead]),owner=merged((input.activity?.coverage??[]).flatMap(p=>clip(p.startedAt,p.endedAt))),stalled=merged((input.activity?.unknownTails??[]).flatMap(p=>clip(p.startedAt,p.endedAt)));
 let remainder:Interval[]=end>start?[[start,end]]:[];
 const rows:Array<{key:string;label:string;durationMs:number;meaning:string;productiveWorkClaimed:false}>=[],intervalRows:Array<{key:string;startedAt:string;endedAt:string;durationMs:number}>=[];
 const take=(key:string,label:string,values:Interval[],meaning:string)=>{const intervals=intersect(remainder,merged(values));remainder=subtract(remainder,merged(values));rows.push({key,label,durationMs:duration(intervals),meaning,productiveWorkClaimed:false});for(const [a,b]of intervals)intervalRows.push({key,startedAt:new Date(a).toISOString(),endedAt:new Date(b).toISOString(),durationMs:b-a});};
 take('measured-operations','Measured operations',work,'Actual successful operation intervals; overlapping child timers are counted once.');
 take('measured-wait','Recorded waiting',wait,'Explicitly recorded service, seller or controller waiting; overlaps with operations excluded.');
 take('failed-attempt','Failed attempt wall time',failed,'Actual failed attempt elapsed; never asserted productive work.');
 take('timing-overhead','Timing / checkpoint overhead',overhead,'Actual retained timing ownership, checkpoint, heartbeat and close IO; separately measured overhead, not business processing or inferred work.');
 take('observed-owner-only','Observed owner / orchestration',owner,'Observed phase ownership outside operation timers; includes adapter, checkpoint and local orchestration time. Presence does not establish productive work.');
 take('stalled-unobserved','Owner stalled / unobserved',stalled,'Expired heartbeat or progress intervals; cause is not inferred and no operation replay is authorized.');
 take('unowned-controller','Controller / dispatch gap',remainder,'No retained operation or current observed owner covers this interval. Model generation, dispatch and scheduling cannot be separated here.');
 const elapsedMs=end-start,measuredCoveredMs=duration(actual),observedOwnerOnlyMs=rows.find(r=>r.key==='observed-owner-only')!.durationMs,stalledUnobservedMs=rows.find(r=>r.key==='stalled-unobserved')!.durationMs,unownedControllerMs=rows.find(r=>r.key==='unowned-controller')!.durationMs,accountedMs=rows.reduce((n,r)=>n+r.durationMs,0);if(accountedMs!==elapsedMs)throw Error('Elapsed accounting failed reconciliation');
 const gaps=intervalRows.filter(r=>['stalled-unobserved','unowned-controller'].includes(r.key)).sort((a,b)=>b.durationMs-a.durationMs||a.startedAt.localeCompare(b.startedAt)),largestFirst=gaps.slice(0,100),listedDurationMs=largestFirst.reduce((n,r)=>n+r.durationMs,0),totalDurationMs=gaps.reduce((n,r)=>n+r.durationMs,0);
 const ownerPhases=Array.from(new Set((input.activity?.coverage??[]).map(p=>p.phase))).map(phase=>({phase,observedMs:duration(merged((input.activity?.coverage??[]).filter(p=>p.phase===phase).flatMap(p=>clip(p.startedAt,p.endedAt)))),productiveWorkClaimed:false as const}));
 return{elapsedMs,measuredCoveredMs,timingOverheadMs:rows.find(r=>r.key==='timing-overhead')!.durationMs,observedOwnerOnlyMs,stalledUnobservedMs,unownedControllerMs,accountedMs,measurementCoverage:measuredCoveredMs===elapsedMs?'complete' as const:'partial' as const,rows,ownerPhases,ownerPhaseTotalsNotAdditive:true as const,gaps:{totalCount:gaps.length,totalDurationMs,largestFirst,listedCount:largestFirst.length,listedDurationMs,omittedCount:gaps.length-largestFirst.length,omittedDurationMs:totalDurationMs-listedDurationMs},productiveWorkClaimed:false as const};
}
export type V2ElapsedAccounting=ReturnType<typeof summarizeV2ElapsedAccounting>;
