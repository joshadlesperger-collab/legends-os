import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { applyCardEvent, type CardEvent, type CardHistory } from "@/lib/card-checkpoints";

/** Database transaction is the authority; never infer provider verification from this record. */
export async function saveCardCheckpoint(accountId: string, event: CardEvent) {
  if (!accountId) throw new Error("Account is required");
  return prisma.$transaction(async tx => {
    const job = await tx.cardProcessingJob.findUnique({where:{accountId_cardId:{accountId,cardId:event.cardId}},include:{events:{orderBy:[{occurredAt:"asc"},{id:"asc"}]}}});
    if (job?.events.some(e=>e.eventId===event.eventId)) return job;
    const prior: CardHistory | undefined = job ? {
      checkpoint:{cardId:job.cardId,stage:job.stage as CardEvent["stage"],status:job.status as CardEvent["status"],version:job.version,evidenceRef:job.evidenceRef??undefined,draftId:job.draftId??undefined,verifiedAt:job.verifiedAt?.toISOString(),holdReason:job.holdReason??undefined,updatedAt:job.updatedAt.toISOString()},
      appliedEventIds:job.events.map(e=>e.eventId)
    } : undefined;
    const next=applyCardEvent(prior,event).checkpoint;
    const data={stage:next.stage,status:next.status,version:next.version,evidenceRef:next.evidenceRef??null,draftId:next.draftId??null,verifiedAt:next.verifiedAt?new Date(next.verifiedAt):null,holdReason:next.holdReason??null};
    const saved=job ? await tx.cardProcessingJob.update({where:{id:job.id},data}) : await tx.cardProcessingJob.create({data:{accountId,cardId:event.cardId,...data}});
    await tx.cardProcessingEvent.create({data:{jobId:saved.id,eventId:event.eventId,stage:event.stage,status:event.status,occurredAt:new Date(event.at),evidenceRef:event.evidenceRef??null,draftId:event.draftId??null,verifiedAt:event.verifiedAt?new Date(event.verifiedAt):null,holdReason:event.holdReason??null}});
    return saved;
  },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
}
export async function loadCardCheckpoint(accountId:string,cardId:string) {
  if (!accountId || !cardId) throw new Error("Account and card are required");
  return prisma.cardProcessingJob.findUnique({where:{accountId_cardId:{accountId,cardId}},include:{events:{orderBy:[{occurredAt:"asc"},{id:"asc"}]}}});
}
