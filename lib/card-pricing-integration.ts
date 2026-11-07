import { compareCardPrice, CANDIDATE_POLICY } from "./card-pricing-candidate.ts";
import { fingerprint, type CardRecord, type QueueState } from "./card-orchestrator.ts";
import { assignState, type BacklogCard, type BacklogPrice } from "./card-backlog.ts";

/** Pure projection onto a fresh backlog; never rewrites queue evidence or approvals. */
export function applyCurrentPricing(cards:BacklogCard[],queue:QueueState|undefined,now:string) {
 const byFront=new Map<string,CardRecord[]>();
 for(const record of Object.values(queue?.cards??{})) {
  const front=record.input.photos.find(p=>p.side==="front")?.sha256.toLowerCase();
  if(front)byFront.set(front,[...(byFront.get(front)??[]),record]);
 }
 for(const card of cards) {
  // Explicit seller overrides remain separate. Never silently relabel old calculated approvals.
  card.approvedPrice=card.override;
  const matches=byFront.get(card.frontHash??"")??[];
  const record=matches.length===1?matches[0]:undefined;
  card.proposal=null;
  if(!record)continue;
  const backs=record.input.photos.filter(p=>p.side==="back").map(p=>p.sha256.toLowerCase());
  if(backs.length!==1||card.backHashes.length!==1||backs[0]!==card.backHashes[0])continue;
  const result=compareCardPrice(record,now);
  if(!result.candidate) {
   const reason=`pricing: Current policy needs evidence review: ${result.blockers.join("; ")}`;
   if(!card.holds.includes(reason))card.holds.push(reason);
   continue;
  }
  const p=result.candidate;
  const comps=record.jobs.pricing.result!.comps as {soldDate:string}[];
  const expires=Math.min(...comps.map(c=>Date.parse(`${c.soldDate}T00:00:00Z`)+91*86400000));
  const proposal:BacklogPrice={item:p.item,shipping:p.shipping,source:"Current policy from retained validated evidence",
   policy:CANDIDATE_POLICY,updatedAt:new Date(Math.max(...comps.map(c=>Date.parse(`${c.soldDate}T00:00:00Z`)))).toISOString(),reviewRequired:true,
   evidenceKey:fingerprint([CANDIDATE_POLICY,record.input.photos,result.identity,result.evidence,result.adjustments,p]),
   evidenceExpiresAt:new Date(expires).toISOString(),reviewNotes:result.blockers,
   targetBuyerTotal:p.targetBuyerTotal};
  card.proposal=proposal;
  // Historical prices remain in card.prices. New approval must bind to this proposal.
  card.nextOwner="seller-review";card.nextAction="Review current buyer-total price and retained evidence";
 }
 for(const card of cards)assignState(card);
 return cards;
}

