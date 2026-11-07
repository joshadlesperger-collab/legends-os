import type {V2State} from './card-processing-v2.ts';
import type {V2ProcessingBatch} from './card-processing-v2-batch-progress.ts';
import {compareV2BatchTiming} from './card-processing-v2-batch-comparison.ts';
/** Select by original click; a worker restart cannot replace the batch clock. */
export function latestV2BatchTiming(state:V2State,batches:readonly V2ProcessingBatch[],now:string){
 const batch=batches.filter(b=>Number.isFinite(Date.parse(b.clickedAt))).slice().sort((a,b)=>Date.parse(b.clickedAt)-Date.parse(a.clickedAt)||a.jobId.localeCompare(b.jobId))[0];
 if(!batch)return null;
 const report=compareV2BatchTiming(state,batch,now);
 return{batch,report,spans:selectV2BatchTimings(state,batch)};
}
/** Include same-card resume operations without replacing the original clock. */
export function selectV2BatchTimings(state:V2State,batch:V2ProcessingBatch){
 const ids=new Set(batch.captures.flatMap(c=>c.cardId?[c.cardId]:[]));
 // Resolve captures by original hashes, including batches admitted without card IDs.
 for(const card of Object.values(state.cards))if(batch.captures.some(c=>c.photos.length===card.photos.length&&c.photos.every(p=>card.photos.some(q=>p.hash===q.hash))))ids.add(card.id);
 return state.timings.filter(t=>t.cardId?ids.has(t.cardId):t.cardIds?.length?t.cardIds.some(id=>ids.has(id)):t.runId===batch.jobId);
}

export type V2ActivityViewInput={batchId:string;phases:{operationId:string;lane:string;phase:string;owner:string;status:string;startedAt:string;lastHeartbeatAt:string;expiresAt:string;observedThrough:string;lastProgressAt?:string;progressExpiresAt?:string;lastStep?:string;endedAt?:string;productiveWorkClaimed:false}[];coverage?:{operationId:string;phase:string;lane:string;startedAt:string;endedAt:string}[];controller?:null|{owner:string;nextStep:string;dueAt:string;status:string;overdueMs:number};coverageWarnings?:{owner:string;stage:string;reason:string;observedAt:string}[]};
/** Ownership and observed phase intervals never imply productive work. */
export function v2ActivityView(activity:V2ActivityViewInput|undefined,batchId:string,now:string){
 const until=Date.parse(now),empty={configured:false,rows:[],history:[],controller:null,warnings:[]};
 if(!activity||activity.batchId!==batchId)return empty;
 const phases=activity.phases.map(p=>({...p,stalled:p.status==='stalled'||(p.status==='active'&&(Date.parse(p.expiresAt)<=until||(p.progressExpiresAt?Date.parse(p.progressExpiresAt)<=until:false))),ownerElapsedMs:Math.max(0,Math.min(until,p.endedAt?Date.parse(p.endedAt):until)-Date.parse(p.startedAt)),heartbeatAgeMs:Math.max(0,until-Date.parse(p.lastHeartbeatAt))}));
 const union=(ranges:number[][])=>{let end=-Infinity,total=0;for(const [a,b]of ranges.sort((x,y)=>x[0]-y[0])){if(b>a){total+=Math.max(0,b-Math.max(a,end));end=Math.max(end,b);}}return total;};
 const groups=new Map<string,{phase:string;owner:string;intervals:number[][];attempts:number}>();
 for(const p of phases){const key=p.phase+'\0'+p.owner,group=groups.get(key)??{phase:p.phase,owner:p.owner,intervals:[],attempts:0};group.attempts++;for(const interval of activity.coverage??[])if(interval.operationId===p.operationId)group.intervals.push([Date.parse(interval.startedAt),Math.min(until,Date.parse(interval.endedAt))]);groups.set(key,group);}
 const controller=activity.controller?{...activity.controller,overdueMs:['resolved','complete'].includes(activity.controller.status)?0:Math.max(0,until-Date.parse(activity.controller.dueAt)),remainingMs:Math.max(0,Date.parse(activity.controller.dueAt)-until)}:null;
 return{configured:true,rows:phases.filter(p=>p.status==='active'||p.status==='stalled'),history:Array.from(groups.values()).map(g=>({phase:g.phase,owner:g.owner,attempts:g.attempts,observedResponsibilityMs:union(g.intervals)})),controller,warnings:activity.coverageWarnings??[]};
}
