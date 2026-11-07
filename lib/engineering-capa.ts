import {admitEngineeringTask, type EngineeringQueue} from './engineering-work-queue.ts';
import type { BulkAiSubmission } from './card-bulk-ai.ts';

export type Capa = {
  id:string; title:string; owner:string; dueAt:string; taskIds:string[];
  status:'open'|'monitoring'|'closed';
  incidents:{id:string;at:string;evidence:string}[];
  containment:string;
  rootCause:{status:'unconfirmed'|'confirmed';description:string;evidence:string[]};
  correctiveAction:string; preventiveAction:string;
  implementedAt?:string; implementationEvidence:string[];
  effectiveness:{criterion:string;minimumObservations:number;kind:'live'|'local-regression'};
  sourceCount?:number;
  history:{at:string;event:string;snapshot:unknown}[];
};
export type CapaQueue=EngineeringQueue & {capas?:Capa[]};
/** Historical failed checks are not an inventory of currently editable drafts. */
export function draftFailureContext(source:{cards?:Record<string,{
  exclusion?:{disposition:string;itemId?:string};
  draftLifecycle?:{draftId?:string;state:string;verification?:{evidence?:string;checks:{field:string;status:string}[]}};
}>}) {
  const rows=Object.entries(source.cards??{}).flatMap(([cardId,card])=>{
    const draft=card.draftLifecycle;
    if(!draft?.verification)return [];
    const failed=draft.verification.checks.filter(check=>check.status!=='pass');
    if(!failed.length)return [];
    const terminal=['live','sold'].includes(card.exclusion?.disposition??'');
    return [{cardId,draftId:draft.draftId??null,fields:failed.map(c=>({field:c.field,status:c.status})),
      classification:terminal?'historical-after-inventory-handoff':'requires-current-draft-reconciliation',
      knownInventory:card.exclusion??null,evidence:draft.verification.evidence??null}];
  });
  return {rows,note:'Read-only attribution of retained checks, not fresh seller inventory. Preserve counters and CAPA effectiveness requirements; never recreate drafts or edit live listings to clear historical failures.'};
}
const nonempty=(v:unknown):v is string=>typeof v==='string'&&!!v.trim();
const date=(v:string)=>Number.isFinite(Date.parse(v));

/** Revisions retain the old record. Closure is available only through the evidence gate. */
export function recordCapa(state:CapaQueue,input:Omit<Capa,'history'>,now=new Date().toISOString()) {
  if(!input||![input.id,input.title,input.owner,input.containment,input.correctiveAction,input.preventiveAction,input.rootCause?.description,input.effectiveness?.criterion].every(nonempty)
    ||!date(input.dueAt)||!date(now)||!['open','monitoring'].includes(input.status)
    ||!input.taskIds?.length||input.taskIds.some(id=>!state.tasks.some(t=>t.id===id))
    ||!input.incidents?.length||input.incidents.some(i=>!nonempty(i.id)||!date(i.at)||!nonempty(i.evidence))
    ||new Set(input.incidents.map(i=>i.id)).size!==input.incidents.length
    ||!['unconfirmed','confirmed'].includes(input.rootCause.status)
    ||!Array.isArray(input.rootCause.evidence)||!Array.isArray(input.implementationEvidence)
    ||!['live','local-regression'].includes(input.effectiveness.kind)
    ||!Number.isInteger(input.effectiveness.minimumObservations)||input.effectiveness.minimumObservations<1)throw Error('CAPA requires owner, due date, linked tasks, incidents, cause, actions and measurable effectiveness plan');
  if(input.rootCause.status==='confirmed'&&!input.rootCause.evidence.length)throw Error('Confirmed cause requires evidence');
  if(input.status==='monitoring'&&(!input.implementedAt||!date(input.implementedAt)||Date.parse(input.implementedAt)>Date.parse(now)||!input.implementationEvidence.length))throw Error('Monitoring requires implemented controls and evidence');
  const existing=state.capas?.find(c=>c.id===input.id);
  if(existing&&existing.incidents.some(i=>!input.incidents.some(n=>n.id===i.id&&n.at===i.at&&n.evidence===i.evidence)))throw Error('Prior incidents are immutable');
  if(existing&&existing.sourceCount!==undefined&&(input.sourceCount??-1)<existing.sourceCount)throw Error('Failure counts cannot decrease');
  const recurrence=existing&&input.incidents.some(i=>!existing.incidents.some(old=>old.id===i.id));
  const row:Capa={...structuredClone(input),status:recurrence?'open':input.status,history:[...(existing?.history??[]),{at:now,event:existing?(recurrence?'recurrence':'revised'):'opened',snapshot:existing?structuredClone({...existing,history:undefined}):null}]};
  if(recurrence){delete row.implementedAt;row.implementationEvidence=[];}
  state.capas??=[];const index=state.capas.findIndex(c=>c.id===row.id);if(index<0)state.capas.push(row);else state.capas[index]=row;
  return row;
}

export function checkCapa(state:CapaQueue,id:string,result:{criterion:string;kind:string;observations:{id:string;at:string;passed:boolean;evidence:string}[]},now=new Date().toISOString()) {
  const c=state.capas?.find(c=>c.id===id);if(!c||c.status!=='monitoring'||c.rootCause.status!=='confirmed'||!c.implementedAt)throw Error('Implemented, confirmed CAPA must enter monitoring before closure');
  if(result.criterion!==c.effectiveness.criterion||result.kind!==c.effectiveness.kind||!Array.isArray(result.observations)
    ||(!result.observations.length || (result.observations.length<c.effectiveness.minimumObservations && !result.observations.some(o=>o.passed===false)))||new Set(result.observations.map(o=>o.id)).size!==result.observations.length
    ||result.observations.some(o=>!nonempty(o.id)||!nonempty(o.evidence)||typeof o.passed!=='boolean'||!date(o.at)||Date.parse(o.at)<Date.parse(c.implementedAt!)||Date.parse(o.at)>Date.parse(now)))throw Error('Effectiveness requires distinct post-implementation observations matching the predefined plan');
  const failed=result.observations.some(o=>!o.passed);
  if(!failed&&c.taskIds.some(id=>state.tasks.find(t=>t.id===id)?.status!=='done'))throw Error('Linked actions must be complete; task completion alone is insufficient');
  c.history.push({at:now,event:failed?'effectiveness-failed':'effectiveness-passed',snapshot:structuredClone(result)});
  c.status=failed?'open':'closed';if(failed){delete c.implementedAt;c.implementationEvidence=[];}
  return c;
}

/** Existing failed-check counters are observations, never confirmed causes or proof of prevention. */
export function syncDraftCapas(state:CapaQueue,learning:Record<string,{failures:number;lastAt:string;remedy:string}>,evidence:string,now=new Date().toISOString()) {
  const changed:string[]=[];
  for(const [field,r] of Object.entries(learning)){
    if(!Number.isInteger(r.failures)||r.failures<1||!date(r.lastAt))continue;
    const id=`draft-check-${field}`,old=state.capas?.find(c=>c.id===id);if(old&&(old.sourceCount??0)>=r.failures)continue;
    const taskId=`capa-${id}-${r.failures}`;
    if(!state.tasks.some(t=>t.id===taskId))admitEngineeringTask(state.tasks,{id:taskId,priority:85,status:'ready',completionCriteria:`Investigate ${field}; document confirmed cause and implement prevention, then collect predefined effectiveness evidence without paid calls or external writes.`,dependencies:[],requiredPermissions:['local-read','local-write'],checkpoint:evidence,measurableOutcome:null,failureReason:null,retryPolicy:'Do not repeat unchanged holds; preserve failed evidence and verify prevention on genuinely new observations',links:{cards:[],code:['lib/card-draft-lifecycle.ts'],evidence:[evidence]}});
    recordCapa(state,{id,title:`Saved-draft check failure: ${field}`,owner:old?.owner??'card-orchestrator',dueAt:old?.dueAt??new Date(Date.parse(now)+86400000).toISOString(),taskIds:[...(old?.taskIds??[]),taskId],status:'open',incidents:[...(old?.incidents??[]),{id:`${field}:${r.failures}`,at:r.lastAt,evidence}],containment:old?.containment??'Keep failed check evidence; resume the same draft ID; do not publish or archive an unverified original.',rootCause:old?.rootCause??{status:'unconfirmed',description:'Failed saved-field check observed; investigate the source and persistence path before assigning cause.',evidence:[]},correctiveAction:r.remedy,preventiveAction:old?.preventiveAction??'Confirm cause, add an appropriate guard/regression and update the supported workflow.',implementationEvidence:[],effectiveness:old?.effectiveness??{criterion:`Zero ${field} failures in the next 10 independently saved and reopened eligible drafts after prevention is implemented`,minimumObservations:10,kind:'live'},sourceCount:r.failures},now);
    changed.push(id);
  }
  return changed;
}

export function capaSummary(state:CapaQueue,now=new Date().toISOString()){
  return (state.capas??[]).map(c=>({id:c.id,title:c.title,status:c.status,owner:c.owner,dueAt:c.dueAt,overdue:c.status!=='closed'&&Date.parse(c.dueAt)<Date.parse(now),taskIds:c.taskIds,criterion:c.effectiveness.criterion}));
}

/** Only explicit observed failures enter CAPA; age or a missing ID alone proves nothing. */
export function syncBulkAiCapas(state:CapaQueue,submissions:Record<string,BulkAiSubmission>,evidence:string,now=new Date().toISOString()){
 const id='bulk-ai-stall-recovery',changed:string[]=[];
 for(const b of Object.values(submissions)){
  const failure=[...(b.checkpoints??[])].reverse().find(c=>c.phase==='recovery-failed'||c.phase==='stalled');
  if(!failure)continue;
  const incidentId=`${b.id}:${failure.observationId}`,old=state.capas?.find(c=>c.id===id);
  if(old?.incidents.some(i=>i.id===incidentId))continue;
  const taskId=`capa-bulk-recovery-${failure.observationId}`;
  if(!state.tasks.some(t=>t.id===taskId))admitEngineeringTask(state.tasks,{id:taskId,priority:85,status:'ready',completionCriteria:'Investigate retained bulk failure and same-ID recovery evidence; correct process gaps and define a safe next action. Never infer absent drafts or authorize reupload from a timeout.',dependencies:[],requiredPermissions:['local-read','local-write'],checkpoint:evidence,measurableOutcome:null,failureReason:null,retryPolicy:'Retain prior intent; no repeated recovery without changed evidence; no eBay writes from CAPA synchronization',links:{cards:[...b.cardIds],code:['lib/card-bulk-ai.ts'],evidence:[evidence]}});
  recordCapa(state,{id,title:'Bulk generation stall and bounded recovery',owner:old?.owner??'card-orchestrator',dueAt:old?.dueAt??new Date(Date.parse(now)+86400000).toISOString(),taskIds:[...(old?.taskIds??[]),taskId],status:'open',incidents:[...(old?.incidents??[]),{id:incidentId,at:failure.observedAt,evidence}],containment:'Preserve submission, capture hashes, observed draft IDs and original photos. Hold unresolved captures after one failed recovery; continue independent cards. Never repeat active stock increments.',rootCause:old?.rootCause??{status:'unconfirmed',description:'An evidence-backed bulk stall was observed. Service-side cause is unknown; do not infer that batch size or elapsed time caused it.',evidence:[]},correctiveAction:'Inspect retained phase observations and saved draft inventory; reconcile actual IDs using bulk-ai-observe. No automatic resubmission or guessed negative receipt.',preventiveAction:'Read prior batch lessons, record actual phase timestamps, verify a native-input save/reopen pilot before mass correction, and checkpoint failure into CAPA.',implementationEvidence:[],effectiveness:old?.effectiveness??{criterion:'Three subsequent authorized bulk operations retain actual phase/outcome evidence, preserve every mapped ID, and isolate any failed recovery without duplicate creation or blocking independent cards',minimumObservations:3,kind:'live'}},now);
  changed.push(incidentId);
 }
 return changed;
}
