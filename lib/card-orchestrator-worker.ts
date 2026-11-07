import { completeJob, JobCompletionConflict, type claimJob, type QueueState } from "./card-orchestrator.ts";

export type AutomaticClaim = NonNullable<ReturnType<typeof claimJob>>;
type AutomaticResult = {outcome:"done"|"held";data?:unknown;reason?:string};
type Completion = {outcome:"done"|"held"|"skipped";reason?:string};
const reasonFor = (error:unknown) => (error instanceof Error ? error.message : String(error)).slice(0,2000) || "Worker failed";

/** Call under the queue lock. Only an owned, current job may record a failure. */
export function completeAutomaticJob(state:QueueState,claim:AutomaticClaim,result:AutomaticResult,now:string,holds:Record<string,string>={}):Completion {
  const finish=(value:AutomaticResult)=>completeJob(state,claim.card.id,claim.job.kind,claim.job.lease!.token,value,now,holds);
  try { finish(result);return {outcome:result.outcome}; }
  catch(error) {
    if(error instanceof JobCompletionConflict)return {outcome:"skipped",reason:reasonFor(error)};
    // Validation errors are local failures. Storage errors occur outside this callback
    // and must propagate, since their commit outcome may be unknown.
    const reason=reasonFor(error);
    finish({outcome:"held",reason});
    return {outcome:"held",reason};
  }
}

export async function runAutomaticBatch(kind:"photos"|"listing",limit:number,worker:{
  claim:(excludeIds:readonly string[])=>Promise<AutomaticClaim|null>;
  prepare:(claim:AutomaticClaim)=>Promise<unknown>;
  complete:(claim:AutomaticClaim,result:AutomaticResult)=>Promise<Completion>;
}) {
  let completed=0,held=0;
  const attempted:string[]=[],skipped:{cardId:string;reason:string}[]=[];
  for(let n=0;n<limit;n++) {
    const claim=await worker.claim(attempted);if(!claim)break;
    attempted.push(claim.card.id);
    let result:AutomaticResult;
    try { result={outcome:"done",data:await worker.prepare(claim)}; }
    catch(error) { result={outcome:"held",reason:reasonFor(error)}; }
    const completion=await worker.complete(claim,result);
    if(completion.outcome==="skipped")skipped.push({cardId:claim.card.id,reason:completion.reason!});
    else if(completion.outcome==="held")held++;
    else completed++;
  }
  return {kind,completed,held,skipped};
}
