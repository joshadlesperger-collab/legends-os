import {v2BulkResultReceiptBound,v2MergedReceiptBound} from './card-processing-v2-archive-status.ts';
import{v2DirectActiveReceiptBound}from'./card-processing-v2-archive-status.ts';
import type { V2State } from "./card-processing-v2.ts";
import type { V2ProcessingBatch } from "./card-processing-v2-processing-batches.ts";
export type { V2ProcessingBatch } from "./card-processing-v2-processing-batches.ts";
const samePair=(a:{hash:string;side:string}[],b:{hash:string;side:string}[],sides=true)=>a.length===2&&b.length===2&&a.every(p=>b.some(q=>q.hash===p.hash&&(!sides||q.side===p.side)));
function callCost(calls:V2State["calls"]){
 const unknown=calls.filter(c=>c.status!=="settled"||!Number.isSafeInteger(c.actualMicros));
 const knownMicros=calls.reduce((n,c)=>n+(c.status==="settled"&&Number.isSafeInteger(c.actualMicros)?c.actualMicros!:0),0);
 return{calls:calls.length,settledCalls:calls.length-unknown.length,reservedCalls:calls.filter(c=>c.status==="reserved").length,uncertainCalls:calls.filter(c=>c.status==="uncertain").length,unknownCostCalls:unknown.length,knownActualUsd:knownMicros/1e6,actualUsd:unknown.length?null:knownMicros/1e6,unknownReservationUsd:unknown.some(c=>!Number.isSafeInteger(c.reservedMicros))?null:unknown.reduce((n,c)=>n+c.reservedMicros,0)/1e6};
}
export function v2BatchProgress(state:V2State,batch:V2ProcessingBatch,now=new Date().toISOString()){
  const baseline=new Set(batch.baselineCallIds),start=Date.parse(batch.clickedAt),current=Date.parse(now);
  if(!Number.isFinite(start)||!Number.isFinite(current))throw Error("Valid batch timing window required");
  const rows=batch.captures.map(capture=>{
    const matches=Object.values(state.cards).filter(c=>samePair(c.photos,capture.photos,false)&&(!capture.cardId||capture.cardId===c.id)),card=matches.length===1?matches[0]:undefined;
    const calls=card?state.calls.filter(c=>c.cardId===card.id):[],session=calls.filter(c=>!baseline.has(c.id)),prior=calls.filter(c=>baseline.has(c.id));
    const cost=callCost(session),priorCost=callCost(prior),awaitingIdentification=!card||(!card.identity&&calls.length===0);
    const archive=card?.draftArchive,owned=card?Object.values(state.submissions).filter(s=>s.draftId===card.draftId&&s.payload.captureIds.includes(card.captureId)&&s.groupId===card.groupId&&["submitted","verified"].includes(s.status)):[];
    const inventory=card?.inventoryArchive;
    const inventoryComplete=Boolean(card&&inventory?.status==="moved"&&inventory.captureId===card.captureId&&inventory.draftId===card.draftId&&inventory.sku===card.sku&&samePair(inventory.files,card.photos));
    const receipt=card&&(inventoryComplete||((card.nonpriceVerification?.draftId===card.draftId&&card.nonpriceVerification?.scope==="non-price-fields")||card.verification||v2BulkResultReceiptBound(card)));
    const draftComplete=Boolean(card&&card.draftId&&card.identity&&!card.identity.damage&&!card.identity.graded&&receipt&&owned.length===1&&(owned[0].payload.captureIds.length!==1||samePair(owned[0].payload.photos.map((p,n)=>({...p,side:card.photos[n].side})),card.photos))&&(inventoryComplete||(archive?.status==="moved"&&archive.captureId===card.captureId&&archive.draftId===card.draftId&&samePair(archive.files,card.photos)))&&card.issues.length===0);
    const directComplete=Boolean(card&&card.issues.length===0&&v2DirectActiveReceiptBound(card)&&card.activeQuantityReceipt?.batchId===batch.jobId&&inventoryComplete&&inventory?.disposition==='listed'&&inventory.photoProvenance==='direct-active-quantity-capture; exact-originals-reviewed'&&inventory.activeQuantityOperationId===card.activeQuantityReceipt?.operationId&&inventory.itemId===card.activeQuantityReceipt?.itemId&&!Object.values(state.submissions).some(s=>s.payload.captureIds.includes(card.captureId)));
    const mergedComplete=Boolean(card&&v2MergedReceiptBound(card)),complete=draftComplete||directComplete||mergedComplete;
    const identityRetained=Boolean(card?.identity),draftCreated=Boolean(card?.draftId&&(owned.length===1||mergedComplete));
    const payload=card?.groupId?state.prepared[card.groupId]:undefined;
    const prepared=Boolean(card&&(card.stage==='prepared'||payload?.captureIds.includes(card.captureId)||draftCreated||draftComplete));
    const photosMoved=Boolean(mergedComplete||inventoryComplete||(card?.draftId&&archive?.status==='moved'&&archive.captureId===card.captureId&&archive.draftId===card.draftId&&samePair(archive.files,card.photos)));
    const archivedAt=complete?(mergedComplete?card!.draftMergeReceipt!.observedAt:directComplete?inventory!.updatedAt:archive?.status==="moved"?archive.updatedAt:inventory!.updatedAt):undefined;
    const verifiedAt=!directComplete&&card?(v2BulkResultReceiptBound(card)?card.bulkResultVerification?.observedAt:card.nonpriceVerification&&card.nonpriceVerification.draftId===card.draftId?card.nonpriceVerification.observedAt:undefined):undefined;
    const endedAt=archivedAt&&verifiedAt&&Date.parse(verifiedAt)>Date.parse(archivedAt)?verifiedAt:archivedAt,end=endedAt?Date.parse(endedAt):current;
    const currentRun=batch.status==="running"&&state.lastRun?.id===batch.jobId&&state.lastRun.status==="running";
    const activeIdentification=Boolean(card&&currentRun&&(state.timings.some(t=>t.runId===batch.jobId&&t.status==="running"&&["identification","openai-identification"].includes(t.step)&&(t.cardId===card.id||t.cardIds?.includes(card.id)))||session.some(c=>c.status==="reserved"&&Date.parse(c.at)>=Date.parse(state.lastRun!.startedAt))));
    const status=complete?(inventoryComplete?(inventory!.disposition==="sold"?"Sold; photos moved":"Listed; photos moved"):"Draft saved; photos moved"):batch.status==="failed"?"Could not start":card?.issues.length?"Needs review":card?.draftId?"Draft awaiting verification or photo archive":card?.identity?(currentRun?"Preparing draft":"Ready for draft creation"):activeIdentification?"Identifying card":"Waiting for identification";
    return {identityRetained,prepared,draftCreated,photosMoved,candidateId:capture.candidateId,cardId:card?.id,label:card?.title||card?.sku||"Selected card",stage:card?.stage??"waiting",status,detail:card?.nextAction??(batch.status==="stopped"?"Local preparation ended; draft creation and verification may still be pending.":"Waiting for the selected original pair checkpoint."),draftId:card?.draftId,complete,endedAt,elapsedMs:Math.max(0,end-start),actualMicros:session.reduce((n,c)=>n+(c.status==="settled"?c.actualMicros??0:0),0),pendingCost:awaitingIdentification||cost.unknownCostCalls>0,cost:{...cost,awaitingIdentification,actualUsd:awaitingIdentification?null:cost.actualUsd},priorCost,priorActualMicros:prior.reduce((n,c)=>n+(c.status==="settled"?c.actualMicros??0:0),0),pricing:"deferred-preserved" as const};
  });
  const complete=rows.length>0&&rows.every(r=>r.complete),endedAt=complete?rows.map(r=>r.endedAt!).sort().at(-1):undefined;
  const waitingForUploaderCount=rows.filter(r=>!r.complete&&r.stage==='prepared'&&!r.draftId).length;
  const browserActive=state.timings.some(t=>t.runId===batch.jobId&&t.source==='external-browser-wall-clock'&&t.status==='running');
  const awaitingUploader=!complete&&waitingForUploaderCount>0&&batch.status==='stopped'&&!browserActive;
  const intakeCallIds=new Set(batch.intake?.callIds??[]),intakeCalls=state.calls.filter(c=>intakeCallIds.has(c.id)),intakeActualMicros=intakeCalls.reduce((n,c)=>n+(c.status==='settled'?c.actualMicros??0:0),0),fullCycleStartedAt=batch.intake?.startedAt??batch.clickedAt;
  const elapsedMs=Math.max(0,(endedAt?Date.parse(endedAt):current)-start),completedCount=rows.filter(r=>r.complete).length;
  const executionStartedAt=Date.parse(batch.acceptedAt)>=start?batch.acceptedAt:batch.clickedAt,executionElapsedMs=Math.max(0,(endedAt?Date.parse(endedAt):current)-Date.parse(executionStartedAt));
  const completedDraftCount=new Set(rows.filter(r=>r.complete&&r.draftId).map(r=>r.draftId)).size;
  const completedCardsPerHour=completedCount>0&&elapsedMs>0?completedCount*3_600_000/elapsedMs:null;
  const secondsPerCompletedCard=completedCount>0&&elapsedMs>0?elapsedMs/1000/completedCount:null;
  const milestones={identified:rows.filter(r=>r.identityRetained).length,prepared:rows.filter(r=>r.prepared).length,draftCreated:rows.filter(r=>r.draftCreated).length,photosMoved:rows.filter(r=>r.photosMoved).length};
  return {executionStartedAt,executionElapsedMs,milestones,completedCardsPerHour,secondsPerCompletedCard,targetCardsPerHour:120,targetSecondsPerCard:30,completedDraftCount,jobId:batch.jobId,clickedAt:batch.clickedAt,intakeActualMicros,fullCycleStartedAt,fullCycleElapsedMs:Math.max(0,(endedAt?Date.parse(endedAt):current)-Date.parse(fullCycleStartedAt)),totalAttributedMicros:intakeActualMicros+rows.reduce((n,r)=>n+r.actualMicros,0),complete,endedAt,completedCount,totalCount:rows.length,waitingForUploaderCount,awaitingUploader,elapsedMs,actualMicros:rows.reduce((n,r)=>n+r.actualMicros,0),pendingCost:rows.some(r=>r.pendingCost),rows};
}
export type V2BatchProgress=ReturnType<typeof v2BatchProgress>;

