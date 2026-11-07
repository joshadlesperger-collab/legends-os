import {fingerprint, type QueueState, type queueSummary} from "./card-orchestrator.ts";
import type {EngineeringTask} from "./engineering-work-queue.ts";

const priorities={photos:80,identity:75,pricing:65,listing:85,reconcile:60};
/** Select from a freshly reviewed queue, never from stale persisted status counts. */
export function pipelineWorkPlan(state:QueueState, summary:ReturnType<typeof queueSummary>, existing:EngineeringTask[], limit=10) {
  if(!Number.isInteger(limit)||limit<1||limit>50)throw Error("Bounded plan requires limit 1..50");
  const known=new Set(existing.map(task=>task.id));
  const candidates=summary.cards.flatMap(row=>row.jobs.flatMap(job=>{
    const card=state.cards[row.id];
    if(state.photoArchives?.[row.id] || !(job.recoverable || (job.state==="todo"&&!job.blockers.length)))return [];
    const inputVersion=fingerprint([card.jobs[job.kind].inputKey,job.kind==="reconcile"?card.jobs.reconcile.recovery??null:null]);
    const id=`card-${job.kind}-${row.id}-${inputVersion.slice(0,20)}`;
    if(known.has(id))return [];
    const needsSellerAccess=job.kind==="pricing"||job.kind==="reconcile";
    const commands=job.kind==="photos"?[`cards:orchestrate -- audit-photos --card ${row.id} --limit 1`]
      :job.kind==="listing"?[`cards:orchestrate -- prepare --card ${row.id} --limit 1`]
      :[...(job.kind==="pricing"?[`cards:orchestrate -- pricing-context --card ${row.id}`]:[]),`cards:orchestrate -- claim --kind ${job.kind} --card ${row.id}`];
    return [{id,cardId:row.id,kind:job.kind,inputVersion,priority:priorities[job.kind],needsSellerAccess,
      player:row.player,commands,recoverable:job.recoverable}];
  })).sort((a,b)=>b.priority-a.priority||a.id.localeCompare(b.id));
  return {asOf:summary.asOf,queueRevision:state.revision,execution:summary.execution,
    candidates:candidates.slice(0,limit),remainingUnadmitted:candidates.length,
    note:"Review jobs require an agent and supported evidence. Claim revalidates eligibility; this plan grants no external writes or paid calls."};
}

export function pipelineEngineeringTask(candidate:ReturnType<typeof pipelineWorkPlan>["candidates"][number],evidence:string):EngineeringTask {
  return {id:candidate.id,priority:candidate.priority,status:"ready",inputVersion:candidate.inputVersion,
    completionCriteria:`Complete ${candidate.kind} for ${candidate.cardId} via supported card claim/complete protocol and retain actual result; otherwise checkpoint exact blocker. Recheck current job binding before acting. Commands: npm run ${candidate.commands.join("; npm run ")}`,
    dependencies:candidate.needsSellerAccess?["seller-read-access"]:[],requiredPermissions:["local-read","local-write"],
    checkpoint:"",measurableOutcome:null,failureReason:null,retryPolicy:"No unchanged retry; new evidence requires explicit resume. Existing card holds and seller decisions remain authoritative.",
    links:{cards:[candidate.cardId],code:["scripts/card-orchestrator.ts"],evidence:[evidence]}};
}
