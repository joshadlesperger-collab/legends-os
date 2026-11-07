import { hasCompleteIdentity, identityReviewIsCurrent, reviewedIdentity, type QueueState } from "./card-orchestrator.ts";

/** Current copy reviews, distinct from manufacturer checklist knowledge and legacy imports. */
export function reviewedKnowledge(state:QueueState,query="",offset=0,limit=50) {
  const needle=query.trim().normalize("NFC").toLowerCase();
  const start=Number.isSafeInteger(offset)&&offset>=0?offset:0;
  const size=Number.isSafeInteger(limit)&&limit>0?Math.min(limit,100):50;
  const records=[];const exceptions=[];
  for(const [id,card] of Object.entries(state.cards)) {
    if(card.jobs.identity.state!=="done")continue;
    const identity=reviewedIdentity(card);
    const photos=card.input.photos;
    if(!identity||!hasCompleteIdentity(identity)||!identityReviewIsCurrent(card)
      ||["front","back"].some(side=>photos.filter(p=>p.side===side&&/^[a-f0-9]{64}$/i.test(p.sha256)).length!==1)
      ||typeof card.jobs.identity.result?.evidence!=="string"||!card.jobs.identity.result.evidence.trim()) {
      exceptions.push({cardId:id,reason:"Completed review lacks valid identity, photo binding or evidence"});continue;
    }
    if(needle&&!Object.values(identity).filter(v=>typeof v==="string").join(" ").normalize("NFC").toLowerCase().includes(needle))continue;
    records.push({cardId:id,identity,evidence:card.jobs.identity.result.evidence,
      originals:photos.map(({side,sha256})=>({side,sha256})),reviewInputKey:card.jobs.identity.inputKey});
  }
  records.sort((a,b)=>a.cardId.localeCompare(b.cardId));
  return {source:"local-completed-identity-reviews",queueRevision:state.revision,total:records.length,offset:start,
    records:records.slice(start,start+size).map(record=>({...record,identity:structuredClone(record.identity)})),exceptions,productionDatabaseApplied:false,
    limitations:["Copy-specific local reviews; not manufacturer checklist verification or pricing approval","Legacy evidence remains separate and unchanged"]};
}
