import { defaultCardInbox } from "./card-backlog-store.ts";
import { localEvidence } from "./card-backlog-service.ts";
import { readCardPhoto } from "./card-backlog-photo.ts";
import { withWorkflow } from "./card-workflow-store.ts";
import { batchPacket, batchWorkPlan, type TimedBatch } from "./card-batch.ts";
/** Audit just the selected originals. No repeated full-inbox scan per export. */
export async function verifiedBatchPacket(batch:TimedBatch,readyOnly=false){
  const snapshot=await withWorkflow(await localEvidence());
  const plan=batchWorkPlan(batch,snapshot);
  if(readyOnly){
    if(!plan.readyIds.length)throw Error("No ready groups with valid draft prices. Review the batch exceptions and existing receipts.");
    batch={...batch,cardIds:plan.readyIds};
  }
  const packet=batchPacket(batch,snapshot);
  const roots=[defaultCardInbox(),process.env.CARD_SCANNER_PATH||(process.platform==="win32"?"C:\\CardScans":"")].filter(Boolean);
  for(const id of batch.cardIds){
    const card=snapshot.cards.find(c=>c.id===id)!;
    for(const side of ["front","back"] as const){
      let found=false;
      for(const root of roots){try{if(await readCardPhoto(card,side,root)){found=true;break;}}catch{/* Try the other configured source root. */}}
      if(!found)throw Error(`Verified ${side} original unavailable for ${id}`);
    }
  }
  return {...packet,plan};
}
