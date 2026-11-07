import type { V2Timing } from "./card-processing-v2.ts";
function unionMs(intervals: [number,number][]) {
  intervals.sort((a,b)=>a[0]-b[0]);let total=0,start=0,end=0,initialized=false;
  for(const interval of intervals){if(!initialized){[start,end]=interval;initialized=true;}else if(interval[0]<=end)end=Math.max(end,interval[1]);else{total+=end-start;[start,end]=interval;}}
  return total+(initialized?end-start:0);
}
export function summarizeV2Timings(spans: readonly V2Timing[], options: { cardId?: string; runId?: string; createdAt: string; now?: string }) {
  const from=Date.parse(options.createdAt),until=Date.parse(options.now??new Date().toISOString());
  if(!Number.isFinite(from)||!Number.isFinite(until)||until<from)throw Error("Valid timing summary window required");
  const selected=spans.filter(s=>(!options.cardId||s.cardId===options.cardId||s.cardIds?.includes(options.cardId))&&(!options.runId||s.runId===options.runId)&&Date.parse(s.startedAt)<=until&&(!s.endedAt||Date.parse(s.endedAt)>from));
  const detailedParents=new Set(spans.flatMap(s=>/^browser-substep:([^:]+):/.exec(s.step)?.[1]??[]));
  const intervals:[number,number][]=[],workIntervals:[number,number][]=[],waitIntervals:[number,number][]=[],sellerReviewIntervals:[number,number][]=[],gapIntervals:[number,number][]=[],localIntervals:[number,number][]=[],localFinalizeIntervals:[number,number][]=[],browserIntervals:[number,number][]=[],browserEnvelopes:[number,number][]=[],envelopes:[number,number][]=[],steps:Record<string,{count:number;totalMs:number;maxMs:number;failed:number;interrupted:number;running:number;shared:number;attribution:'envelope'|'operation'}>={};
  for(const span of selected){
    const item=steps[span.step]??={count:0,totalMs:0,maxMs:0,failed:0,interrupted:0,running:0,shared:0,attribution:detailedParents.has(span.id)||['identification','draft-preparation'].includes(span.step)?'envelope':'operation'};item.count++;if((span.cardIds?.length??0)>1)item.shared++;
    if(span.status==="failed")item.failed++;if(span.status==="interrupted")item.interrupted++;if(span.status==="running")item.running++;
    if((span.status==="completed"||span.status==="failed")&&span.durationMs!==undefined&&span.endedAt){
      item.totalMs+=span.durationMs;item.maxMs=Math.max(item.maxMs,span.durationMs);
      const start=Math.max(from,Date.parse(span.startedAt)),end=Math.min(until,Date.parse(span.endedAt));if(Number.isFinite(start)&&Number.isFinite(end)&&end>start){
        // Broad local orchestration envelopes contain queueing/checkpoint gaps.
        // Only their concrete child operations establish measured work or waits.
        if(["identification","draft-preparation"].includes(span.step)){envelopes.push([start,end]);continue;}
        // A failed browser attempt is retained elapsed, never productive work.
        // Successful children/local operations can still prove work inside it;
        // the remaining union belongs to failed/recovery wall time.
        const localStep=/:(?:local-finalize|local-checkpoint|local-validation|evidence-retain)$/.test(span.step);
        if(localStep)localIntervals.push([start,end]);if(span.step.endsWith(':local-finalize'))localFinalizeIntervals.push([start,end]);
        if(span.source==='external-browser-wall-clock'&&span.status==='failed'&&!localStep){
          if(detailedParents.has(span.id))browserEnvelopes.push([start,end]);
          intervals.push([start,end]);browserIntervals.push([start,end]);continue;
        }
        if(detailedParents.has(span.id)){browserEnvelopes.push([start,end]);continue;}
        intervals.push([start,end]);const sellerReview=span.step.endsWith('seller-review-wait'),wait=!sellerReview&&(span.step.endsWith('-wait')||span.step.endsWith(':remote-processing')),gap=span.step.endsWith('agent-gap');if(sellerReview)sellerReviewIntervals.push([start,end]);else if(wait)waitIntervals.push([start,end]);else if(gap)gapIntervals.push([start,end]);else workIntervals.push([start,end]);if(span.source==="external-browser-wall-clock"&&!localStep)browserIntervals.push([start,end]);}
    }
  }
  const elapsedMs=until-from,measuredCoveredMs=unionMs(intervals),measuredWorkMs=unionMs(workIntervals),measuredLocalSessionMs=unionMs(localIntervals),measuredLocalFinalizeMs=unionMs(localFinalizeIntervals),measuredBrowserMs=Math.max(0,unionMs([...browserIntervals,...localIntervals])-measuredLocalSessionMs);
  const unmappedIntervals:{startedAt:string;endedAt:string;durationMs:number}[]=[];let cursor=from;for(const [start,end]of [...intervals].sort((a,b)=>a[0]-b[0])){if(start>cursor)unmappedIntervals.push({startedAt:new Date(cursor).toISOString(),endedAt:new Date(start).toISOString(),durationMs:start-cursor});cursor=Math.max(cursor,end);}if(cursor<until)unmappedIntervals.push({startedAt:new Date(cursor).toISOString(),endedAt:new Date(until).toISOString(),durationMs:until-cursor});
  const listedUnmapped=unmappedIntervals.slice().sort((a,b)=>b.durationMs-a.durationMs||a.startedAt.localeCompare(b.startedAt)).slice(0,100),listedUnmappedMs=listedUnmapped.reduce((n,i)=>n+i.durationMs,0),totalUnmappedMs=unmappedIntervals.reduce((n,i)=>n+i.durationMs,0);
  // Work takes priority wherever it overlaps a processing wait. Work + exclusive wait equals covered wall time.
  const workAndWaitMs=unionMs([...workIntervals,...waitIntervals]),measuredWaitingMs=Math.max(0,workAndWaitMs-measuredWorkMs),workWaitAndSellerMs=unionMs([...workIntervals,...waitIntervals,...sellerReviewIntervals]),measuredSellerReviewMs=Math.max(0,workWaitAndSellerMs-workAndWaitMs),knownOperationsAndGapsMs=unionMs([...workIntervals,...waitIntervals,...sellerReviewIntervals,...gapIntervals]),measuredAgentGapMs=Math.max(0,knownOperationsAndGapsMs-workWaitAndSellerMs),measuredFailedBrowserMs=Math.max(0,measuredCoveredMs-knownOperationsAndGapsMs),measuredActiveMs=measuredWorkMs;
  return {elapsedMs,measuredActiveMs,measuredWorkMs,measuredWaitingMs,measuredSellerReviewMs,measuredAgentGapMs,measuredFailedBrowserMs,measuredRecoveryMs:measuredFailedBrowserMs,measuredCoveredMs,measuredBrowserMs,measuredLocalSessionMs,measuredLocalFinalizeMs,unmappedIntervals:listedUnmapped,unmappedIntervalCount:unmappedIntervals.length,unmappedPresentation:{order:"largest-first" as const,limit:100,listedCount:listedUnmapped.length,listedDurationMs:listedUnmappedMs,omittedCount:unmappedIntervals.length-listedUnmapped.length,omittedDurationMs:Math.max(0,totalUnmappedMs-listedUnmappedMs),totalDurationMs:totalUnmappedMs},browserEnvelopeMs:unionMs(browserEnvelopes),orchestrationEnvelopeMs:unionMs(envelopes),unmeasuredOrWaitingMs:Math.max(0,elapsedMs-measuredCoveredMs),coverage:intervals.length?"partial" as const:"unmeasured" as const,unmeasuredHistory:true as const,running:selected.filter(s=>s.status==="running").length,interrupted:selected.filter(s=>s.status==="interrupted").length,shared:selected.filter(s=>(s.cardIds?.length??0)>1).length,steps};
}

export type V2TimingSummary = ReturnType<typeof summarizeV2Timings>;
