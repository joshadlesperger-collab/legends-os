/** Durable card-stage checkpoint rules. Storage adapter must persist returned records atomically. */
export type CardStage = "scanned" | "identified" | "priced" | "bulk-upload" | "verified-drafts";
export type CardStatus = "queued" | "processing" | "held" | "complete";
export type CardCheckpoint = {
  cardId: string;
  stage: CardStage;
  status: CardStatus;
  version: number;
  evidenceRef?: string;
  draftId?: string;
  verifiedAt?: string;
  holdReason?: string;
  updatedAt: string;
};
const stages: CardStage[] = ["scanned","identified","priced","bulk-upload","verified-drafts"];
export type CardEvent = { cardId: string; eventId: string; stage: CardStage; status: CardStatus; at: string; evidenceRef?: string; draftId?: string; verifiedAt?: string; holdReason?: string };
export type CardHistory = { checkpoint: CardCheckpoint; appliedEventIds: string[] };
export function applyCardEvent(current: CardHistory | undefined, event: CardEvent): CardHistory {
  if (!event.cardId || !event.eventId || !Number.isFinite(Date.parse(event.at))) throw new Error("Invalid event identity or time");
  if (current?.checkpoint.cardId !== undefined && current.checkpoint.cardId !== event.cardId) throw new Error("Card mismatch");
  if (current?.appliedEventIds.includes(event.eventId)) return current;
  const previous = current?.checkpoint;
  if (previous && stages.indexOf(event.stage) < stages.indexOf(previous.stage)) throw new Error("Cannot rewind a completed stage");
  if (previous && stages.indexOf(event.stage) > stages.indexOf(previous.stage) + 1) throw new Error("Cannot skip a stage");
  if (event.status === "held" && !event.holdReason) throw new Error("Held card needs a reason");
  if (event.stage === "verified-drafts" && event.status === "complete" && (!event.draftId || !event.verifiedAt)) throw new Error("Verified draft needs provider receipt");
  if (previous?.draftId && event.draftId && previous.draftId !== event.draftId) throw new Error("Conflicting draft receipt");
  return { checkpoint: {cardId:event.cardId,stage:event.stage,status:event.status,version:(previous?.version ?? 0)+1,evidenceRef:event.evidenceRef ?? previous?.evidenceRef,draftId:event.draftId ?? previous?.draftId,verifiedAt:event.verifiedAt ?? previous?.verifiedAt,holdReason:event.status==="held"?event.holdReason:undefined,updatedAt:event.at}, appliedEventIds:[...(current?.appliedEventIds??[]),event.eventId] };
}
export function replayCardEvents(events: CardEvent[]): CardHistory | undefined {
  return events.reduce<CardHistory | undefined>((state,event)=>applyCardEvent(state,event),undefined);
}
