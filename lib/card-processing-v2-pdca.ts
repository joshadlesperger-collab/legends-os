import type { V2State } from './card-processing-v2.ts';
import type { V2ProcessingBatch } from './card-processing-v2-processing-batches.ts';
import { v2BatchProgress } from './card-processing-v2-batch-progress.ts';
export type PdcaRef={path:string;sha256:string};
export type PdcaQuality={draftFirstSavePassed:number|null;softwareFalseHoldCards:number|null;interventions:number|null;evidence:PdcaRef|null};
export type PdcaCompletion={endedAt:string;totalCards:number;drafts:number;fullCycleMs:number;versions:string[];recordedUsd:number;knownCalls:number;unknownCostCalls:number;unknownReservationUsd:number|null;missingCostEvidenceCards:number;totalUsdPerCard:number|null;evidence:PdcaRef};
export type PdcaRun={id:string;label:string;startedAt:string;classification:'mixed-recovery'|'stable-clean'|'unknown';role:'pending-reference'|'observed-reference'|'proven-baseline'|'candidate'|'unclassified';comparabilityKey:string|null;scope:V2ProcessingBatch['captures'];baselineCallIds:string[];source:PdcaRef;quality:PdcaQuality;completion?:PdcaCompletion};
export type PdcaOpportunity={id:string;label:string;constraint:string;hypothesis:string;status:'observed-opportunity'|'candidate'|'retained'|'reverted';successMetrics:string[];evidence:PdcaRef};
export type V2PdcaRegister={version:1;policyVersion:string;updatedAt:string;automaticHistoryFrom?:string;runs:PdcaRun[];opportunities:PdcaOpportunity[]};
const settlement='OpenAI result and actual token usage retained; no pricing generated';
/** Existing records only: no provider requests, card inspection or operational writes. */
export function scoreV2PdcaRun(state:V2State,run:PdcaRun,batches:V2ProcessingBatch[]=[],now=new Date().toISOString()){
 const scopeIds=new Set(run.scope.map(c=>c.candidateId));
 if(scopeIds.size!==run.scope.length)throw Error('PDCA physical scope must be unique');
 // Preserve all same-hash owners (including ambiguity), but avoid rescanning the
 // entire historical inventory for every selected physical card.
 const pair=(photos:{hash:string}[])=>photos.map(p=>p.hash).sort().join(':');
 const selectedPairs=new Set(run.scope.map(c=>pair(c.photos))),cards=Object.fromEntries(Object.entries(state.cards).filter(([,c])=>selectedPairs.has(pair(c.photos)))),selectedCardIds=new Set(Object.keys(cards)),captureIds=new Set(Object.values(cards).map(c=>c.captureId));
 state={...state,cards,calls:state.calls.filter(c=>selectedCardIds.has(c.cardId)),submissions:Object.fromEntries(Object.entries(state.submissions).filter(([,s])=>s.payload.captureIds.some(id=>captureIds.has(id)))),events:state.events.filter(e=>!!e.cardId&&selectedCardIds.has(e.cardId)),timings:state.timings.filter(t=>t.runId===run.id||!!t.cardId&&selectedCardIds.has(t.cardId)||t.cardIds?.some(id=>selectedCardIds.has(id)))};
 const synthetic:V2ProcessingBatch={jobId:run.id,clickedAt:run.startedAt,acceptedAt:run.startedAt,status:'stopped',captures:run.scope,baselineCallIds:run.baselineCallIds};
 const progress=v2BatchProgress(state,synthetic,now),cardIds=new Set(progress.rows.flatMap(r=>r.cardId?[r.cardId]:[])),baseline=new Set(run.baselineCallIds);
 const calls=Array.from(new Map(state.calls.filter(c=>cardIds.has(c.cardId)&&!baseline.has(c.id)).map(c=>[c.id,c])).values());
 const known=calls.filter(c=>c.status==='settled'&&Number.isSafeInteger(c.actualMicros)),unknown=calls.filter(c=>c.status!=='settled'||!Number.isSafeInteger(c.actualMicros));
 const knownUsd=known.reduce((n,c)=>n+c.actualMicros!,0)/1e6;
 const eventsByCard=new Map<string,V2State['events']>();for(const e of state.events){if(e.cardId&&cardIds.has(e.cardId)){const events=eventsByCard.get(e.cardId)??[];events.push(e);eventsByCard.set(e.cardId,events);}}
 let passed=0,failed=0,unobserved=0,providerFailures=0;
 for(const row of progress.rows){
  if(!row.cardId){unobserved++;continue;}
  const allCalls=state.calls.filter(c=>c.cardId===row.cardId).sort((a,b)=>a.at.localeCompare(b.at)),first=allCalls[0],events=eventsByCard.get(row.cardId)??[];
  if(!first){if(events.some(e=>e.stage==='identified'&&e.detail==='Reused exact verified front/back identity evidence'))passed++;else unobserved++;continue;}
  const index=events.findIndex(e=>e.stage==='identification-evidence'&&e.detail.endsWith('/'+first.id+'.json'));
  const outcome=index<0?undefined:events.slice(index+1).find(e=>e.detail===settlement);
  if(outcome?.stage==='identified')passed++;
  else if(outcome?.stage==='exception')failed++;
  else if(events.some(e=>e.at>=first.at&&(!allCalls[1]||e.at<allCalls[1].at)&&e.stage==='exception'&&e.detail==='Provider failure retained without raw response or credentials')){failed++;providerFailures++;}
  else unobserved++;
 }
 const related=batches.filter(b=>b.captures.some(c=>scopeIds.has(c.candidateId))),versions=Array.from(new Set(related.flatMap(b=>b.processVersion?[b.processVersion]:[])));
 const observedReviewEvents=state.events.filter(e=>!!e.cardId&&cardIds.has(e.cardId)&&e.stage==='identity-reviewed'&&e.at>=run.startedAt).length;
 const missingCostEvidenceCards=progress.rows.filter(row=>!row.cardId||!calls.some(c=>c.cardId===row.cardId)&&!(eventsByCard.get(row.cardId)??[]).some(e=>e.stage==='identified'&&e.detail==='Reused exact verified front/back identity evidence')).length;
 const q=run.quality,qualityBound=!!q.evidence,validCount=(n:number|null)=>qualityBound&&n!==null&&Number.isSafeInteger(n)&&n>=0?n:null;
 const firstSave=validCount(q.draftFirstSavePassed),falseHolds=validCount(q.softwareFalseHoldCards),interventions=validCount(q.interventions),count=run.scope.length;
 const frozen=run.completion;if(frozen&&(frozen.totalCards!==count||Date.parse(frozen.endedAt)-Date.parse(run.startedAt)!==frozen.fullCycleMs))throw Error('Frozen completion scope or original clock differs');
 const fullCycleMs=frozen?.fullCycleMs??progress.fullCycleElapsedMs,complete=!!frozen||progress.complete,completedCards=frozen?count:progress.completedCount,recordedUsd=frozen?.recordedUsd??knownUsd;
 const cost={recordedUsd,knownUsdPerCard:(frozen?.knownCalls??known.length)>0&&count>0?recordedUsd/count:null,knownCalls:frozen?.knownCalls??known.length,unknownCostCalls:frozen?.unknownCostCalls??unknown.length,unknownReservationUsd:frozen?frozen.unknownReservationUsd:unknown.every(c=>Number.isSafeInteger(c.reservedMicros))?unknown.reduce((n,c)=>n+c.reservedMicros,0)/1e6:null,unidentifiedCards:frozen?0:progress.rows.filter(r=>!r.identityRetained).length,missingCostEvidenceCards:frozen?.missingCostEvidenceCards??missingCostEvidenceCards,totalUsdPerCard:frozen?frozen.totalUsdPerCard:complete&&unknown.length===0&&missingCostEvidenceCards===0&&count>0?knownUsd/count:null,externalCharges:'Unavailable: subscriptions, harness and other provider/account charges are not allocated here.'};
 return {id:run.id,label:run.label,physicalScopeKey:Array.from(scopeIds).sort().join(':'),classification:run.classification,requestedRole:run.role,baselineStatus:!complete?'pending-completion':run.role==='proven-baseline'&&run.classification==='stable-clean'?'proven-baseline':run.classification==='mixed-recovery'?'completed-recovery-reference':'completed-unclassified',comparabilityKey:run.comparabilityKey,versions:frozen?.versions??versions,completionReference:frozen?.evidence??null,
  totalCards:count,completedCards,drafts:frozen?.drafts??progress.completedDraftCount,complete,startedAt:run.startedAt,endedAt:frozen?.endedAt??progress.endedAt??null,fullCycleMs,cardsPerHour:completedCards>0&&fullCycleMs>0?completedCards*3600000/fullCycleMs:null,secondsPerCompletedCard:completedCards>0&&fullCycleMs>0?fullCycleMs/1000/completedCards:null,
  identification:{passed,failed,unobserved,providerFailures,firstPassPercent:count>0&&unobserved===0?100*passed/count:null,meaning:'Usable first identification checkpoint, including exact verified reuse. Provider failures are separate from factual defects. Missing outcome events stay unknown.'},
  quality:{draftFirstSavePercent:complete&&firstSave!==null&&firstSave<=count&&count>0?100*firstSave/count:null,softwareFalseHoldCards:falseHolds!==null&&falseHolds<=count?falseHolds:null,interventionsPer100:interventions!==null&&count>0?interventions*100/count:null,interventionCount:interventions,observedIdentityReviews:observedReviewEvents,evidence:q.evidence,meaning:'Explicit classified evidence required. Identity review events are a recorded lower bound, not a count of factual mistakes, software false holds or all interventions.'},
  cost,source:run.source};
}
export type V2PdcaScore=ReturnType<typeof scoreV2PdcaRun>;
/** A comparative label is descriptive; this function cannot change the running process. */
export function compareV2PdcaScores(baseline:V2PdcaScore,current:V2PdcaScore){
 if(!baseline.complete||!current.complete)return{status:'pending-completion' as const,secondsPerCardChangePercent:null,decision:'Finish and archive both exact physical scopes before evaluating a change.'};
 if(!baseline.comparabilityKey||baseline.comparabilityKey!==current.comparabilityKey||baseline.classification!=='stable-clean'||current.classification!=='stable-clean')return{status:'not-comparable' as const,secondsPerCardChangePercent:null,decision:'Recovery reference or unmatched mix/version: no clean throughput improvement claim.'};
 const a=baseline.secondsPerCompletedCard,b=current.secondsPerCompletedCard,change=a!==null&&b!==null&&a>0?(b-a)*100/a:null;
 if(change!==null&&change>0)return{status:'regression-review' as const,secondsPerCardChangePercent:change,decision:'Review the implicated change for reversion; preserve completed work and uncertain outcomes.'};
 const qualityKnown=[baseline.identification.firstPassPercent,current.identification.firstPassPercent,baseline.quality.draftFirstSavePercent,current.quality.draftFirstSavePercent,baseline.quality.softwareFalseHoldCards,current.quality.softwareFalseHoldCards,baseline.quality.interventionsPer100,current.quality.interventionsPer100,baseline.cost.totalUsdPerCard,current.cost.totalUsdPerCard].every(x=>x!==null);
 return{status:qualityKnown?'completed-comparison' as const:'effectiveness-pending' as const,secondsPerCardChangePercent:change,decision:qualityKnown?'Compare the stated hypothesis and quality/cost limits before retaining the candidate. No automatic switch.':'Quality/cost classification is incomplete; retain the stable workflow while effectiveness remains pending.'};
}
export function runFromV2ProcessingBatch(batch:V2ProcessingBatch):PdcaRun{return{id:batch.jobId,label:'Execution group '+batch.jobId.slice(0,8),startedAt:batch.intake?.startedAt??batch.clickedAt,classification:'unknown',role:'unclassified',comparabilityKey:null,scope:batch.captures,baselineCallIds:batch.baselineCallIds.filter(id=>!batch.intake?.callIds.includes(id)),source:{path:'artifacts/card-processing-v2/processing-batches/'+batch.jobId+'.json',sha256:''},quality:{draftFirstSavePassed:null,softwareFalseHoldCards:null,interventions:null,evidence:null}};}

/** Immutable completed whole-run reference; caller persists it and records its SHA in the register. */
export function makeV2PdcaCompletionReference(score:V2PdcaScore,completionEvidence:PdcaRef){if(!score.complete||!score.endedAt||score.completedCards!==score.totalCards||score.totalCards<1)throw Error('All original captures must complete before freezing a reference');return{kind:'pdca-completed-run-reference' as const,version:1 as const,runId:score.id,scopeSha256:score.source.sha256,startedAt:score.startedAt,endedAt:score.endedAt,totalCards:score.totalCards,completedCards:score.completedCards,drafts:score.drafts,fullCycleMs:score.fullCycleMs,versions:score.versions,recordedUsd:score.cost.recordedUsd,knownCalls:score.cost.knownCalls,unknownCostCalls:score.cost.unknownCostCalls,unknownReservationUsd:score.cost.unknownReservationUsd,missingCostEvidenceCards:score.cost.missingCostEvidenceCards,totalUsdPerCard:score.cost.totalUsdPerCard,completionEvidence};}
export function v2PdcaRunChart(scores:V2PdcaScore[]){const seen=new Set<string>();return scores.filter(score=>score.requestedRole!=='unclassified'&&score.complete&&score.totalCards>0&&score.endedAt).sort((a,b)=>a.startedAt.localeCompare(b.startedAt)).filter(score=>{const key=score.physicalScopeKey;if(seen.has(key))return false;seen.add(key);return true;}).map(score=>({id:score.id,label:score.label,startedAt:score.startedAt,endedAt:score.endedAt!,cards:score.totalCards,secondsPerCard:score.fullCycleMs/1000/score.totalCards,costPerCard:score.cost.totalUsdPerCard,recordedCostPerCard:score.cost.knownUsdPerCard,unknownCostCalls:score.cost.unknownCostCalls,classification:score.classification,versions:score.versions}));}

export function v2PdcaChartMaximum(values:(number|null)[],target:number,includeTarget:boolean){return Math.max(includeTarget?target:.001,...values.filter((n):n is number=>n!==null&&Number.isFinite(n)&&n>=0))*1.2;}

/** Registered whole parents take precedence; recent accepted selections are a read-only fallback. */
export function collectV2PdcaChartScores(state:V2State,runs:PdcaRun[],batches:V2ProcessingBatch[],registeredScores?:V2PdcaScore[],now=new Date().toISOString(),automaticHistoryFrom?:string){
 const covered=new Set(runs.flatMap(run=>run.scope.map(c=>c.candidateId))),seen=new Set<string>(),fallback:V2PdcaScore[]=[];
 const ordered=batches.filter(batch=>!automaticHistoryFrom||Date.parse(batch.acceptedAt)>=Date.parse(automaticHistoryFrom)).sort((a,b)=>(a.intake?.startedAt??a.clickedAt).localeCompare(b.intake?.startedAt??b.clickedAt)||a.acceptedAt.localeCompare(b.acceptedAt));
 for(const batch of ordered){const ids=batch.captures.map(c=>c.candidateId),key=ids.slice().sort().join(':');if(!ids.length||seen.has(key)||ids.some(id=>covered.has(id)))continue;seen.add(key);ids.forEach(id=>covered.add(id));const run=runFromV2ProcessingBatch(batch);run.label='Accepted selection '+batch.jobId.slice(0,8);run.role='observed-reference';const score=scoreV2PdcaRun(state,run,batches,now);if(score.complete)fallback.push(score);}
 return[...(registeredScores??runs.map(run=>scoreV2PdcaRun(state,run,batches,now))),...fallback];
}
