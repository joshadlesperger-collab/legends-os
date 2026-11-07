import {z} from 'zod';
import {fingerprint,hasCompleteIdentity,reviewedIdentity,recordVerifiedReceipt,type QueueState} from './card-orchestrator.ts';

/** Local reconciliation only. The live receipt must independently attest the exact originals. */
export function reconcileActiveSerial(s:QueueState,raw:unknown,now=new Date().toISOString(),holds:Record<string,string>={}) {
  const v=z.object({cardId:z.string(),snapshot:z.string(),serial:z.string(),receipt:z.unknown(),evidence:z.string().min(20)}).strict().parse(raw);
  const c=s.cards[v.cardId],identity=c&&reviewedIdentity(c);
  if(!c||!identity||fingerprint(c)!==v.snapshot||holds[v.cardId]||c.input.sourceHold
    ||Object.values(c.jobs).some(j=>j.state==='leased')||s.draftWriter?.lease
    ||s.photoArchives?.[v.cardId]||Object.values(s.verifiedReceipts??{}).some(r=>r.cardId===v.cardId)
    ||Object.values(s.draftCreationGroups??{}).some(g=>g.members.includes(v.cardId)))throw Error('Changed, held, leased, grouped or already receipted capture');
  const corrected={...identity,serial:v.serial};
  if(!identity.serial||identity.serial===v.serial||!hasCompleteIdentity(corrected))throw Error('Valid changed numbered serial required');
  const receipt=z.object({cardId:z.literal(v.cardId),liveItemId:z.string().regex(/^\d+$/),observedAt:z.iso.datetime(),source:z.string(),identityKey:z.literal(fingerprint(corrected))}).passthrough().parse(v.receipt);
  const elapsed=Date.parse(now)-Date.parse(receipt.observedAt);
  if(!Number.isFinite(elapsed)||elapsed<0||elapsed>3600000||receipt.source!==`https://www.ebay.com/itm/${receipt.liveItemId}`)throw Error('Fresh exact live observation required');
  const candidate=structuredClone(s),copy=candidate.cards[v.cardId];
  copy.identityReviewHistory??=[];
  copy.identityReviewHistory.push({at:now,evidence:v.evidence,snapshot:v.snapshot,jobs:structuredClone(c.jobs),
    ...(c.draftLifecycle?{draftLifecycle:structuredClone(c.draftLifecycle)}:{}),
    ...(c.pricingEvidence?{pricingEvidence:structuredClone(c.pricingEvidence)}:{}),
    ...(c.pricingDeferral?{pricingDeferral:structuredClone(c.pricingDeferral)}:{})});
  copy.jobs.identity.result={...copy.jobs.identity.result,identity:corrected};
  delete copy.pricingEvidence; delete copy.pricingDeferral;
  // Receipt validation checks original hashes, seller, existing draft and conflicting ownership.
  recordVerifiedReceipt(candidate,v.receipt,now);
  if(copy.draftLifecycle)copy.draftLifecycle={binding:copy.draftLifecycle.binding,draftId:copy.draftLifecycle.draftId,
    state:'live',liveItemId:receipt.liveItemId,url:receipt.source,observedAt:receipt.observedAt,evidence:v.evidence};
  copy.updatedAt=now;
  candidate.events.push({at:now,cardId:v.cardId,kind:'identity',event:'active-serial-reconciled',detail:v.evidence});
  Object.assign(s,candidate);
  return {cardId:v.cardId,serial:v.serial,liveItemId:receipt.liveItemId,externalWrites:0};
}
