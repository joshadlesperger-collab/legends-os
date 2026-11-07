import { claimJob, completeJob, fingerprint, jobBlockers, reviewedIdentity, type QueueState } from "./card-orchestrator.ts";
import { pricingContext } from "./card-orchestrator-flow.ts";
export function reusablePricing(state:QueueState,id:string,now=new Date().toISOString(),holds:Record<string,string>={}) {
  const c=state.cards[id];if(!c)throw Error("Card missing");
  const context=pricingContext(state,id,now);
  const blocked=c.jobs.pricing.state!=="todo"||!!c.input.override||!!c.input.sourceHold||jobBlockers(state,c,"pricing",holds[id]).length>0;
  const options=blocked?[]:context.reusableEvidence.filter(e=>{
    const source=state.cards[e.cardId],a=reviewedIdentity(c)!,b=reviewedIdentity(source)!;
    return !holds[e.cardId]&&!source.input.sourceHold&&!["language","artwork","conditionType"].some(k=>a[k as keyof typeof a]!==b[k as keyof typeof b]);
  }).map(e=>({sourceId:e.cardId,sourceIdentity:reviewedIdentity(state.cards[e.cardId]),basis:e.basis,
    token:fingerprint([id,c.input.photos,reviewedIdentity(c),c.jobs.pricing,e.cardId,e]),
    comps:e.comps as {saleId:string;sourceUrl:string;itemPrice:number;soldDate:string}[],evidence:e.evidence}));
  return {cardId:id,options,completed:context.completedPricing,reason:blocked?"Retain completed work, overrides or holds; no automatic research reset.":options.length?"Review this copy's identity, language, condition and own-acquisition exclusions before reuse.":"No current validated matching evidence; research only the remaining gap."};
}
/** Uses the same lease and target-specific comp validation as fresh research. No approval copied. */
export function reusePricing(state:QueueState,id:string,sourceId:string,token:string,confirmed:boolean,now=new Date().toISOString(),holds:Record<string,string>={}) {
  if(!confirmed)throw Error("Confirm this copy's matching identity and original photos first");
  const option=reusablePricing(state,id,now,holds).options.find(o=>o.sourceId===sourceId&&o.token===token);
  if(!option)throw Error("Evidence or target changed; refresh matching evidence");
  const context=pricingContext(state,id,now),source=context.reusableEvidence.find(e=>e.cardId===sourceId)!;
  const claim=claimJob(state,"app-evidence-reuse","pricing",id,now,holds);
  if(!claim)throw Error("Pricing is held or claimed elsewhere");
  completeJob(state,id,"pricing",claim.job.lease!.token,{outcome:"done",data:{comps:source.comps,basis:source.basis??"exact",
    tracked:false,envelopeEligible:false,evidence:`Reused validated evidence from ${sourceId}; operator confirmed this copy's identity, language, condition and original pair. Shipping remains unverified.`,
    ...(source.exactSearchEvidence?{exactSearchEvidence:source.exactSearchEvidence}:{})}},now,holds);
  return {cardId:id,priceApprovalRequired:true,canPublish:false};
}
