import { MINIMUM_CARD_ITEM, cardOfferSettings } from "./card-price-policy.ts";
import { approvedAskingPrice, draftAskingPrice, cardListingTitle, workHolds, type WorkflowSnapshot } from "./card-workflow.ts";
import { draftFields } from "./card-draft-fields.ts";
import { quantityPlan } from "./card-quantity-plan.ts";

export const BATCH_STAGES = ["photos", "identity", "research", "approval-wait", "inventory-shipping", "ebay-entry", "verification", "archive", "service-wait", "recovery", "upload", "generation", "correction", "save", "engineering"] as const;
export type BatchStage = typeof BATCH_STAGES[number];
export type TimedBatch = { id:string; cardIds:string[]; createdAt:string; finishedAt?:string; revision:number; intervals:{stage:BatchStage; start:string; end?:string}[] };
export function transitionBatch(batch:TimedBatch,stage:BatchStage|null,now:string):TimedBatch {
  const intervals=batch.intervals.map(i=>({...i})),last=intervals.at(-1);
  if(last&&!last.end){
    if(Date.parse(now)<Date.parse(last.start))throw new Error("Clock moved backward; timing unchanged.");
    if(last.stage===stage)return batch;
    last.end=now;
  }
  if(stage)intervals.push({stage,start:now});
  return {...batch,revision:batch.revision+1,intervals};
}
export function batchTiming(batch:TimedBatch,now=Date.now()) {
  const seconds=Object.fromEntries(BATCH_STAGES.map(s=>[s,0])) as Record<BatchStage,number>;
  for(const i of batch.intervals)seconds[i.stage]+=Math.max(0,(i.end?Date.parse(i.end):now)-Date.parse(i.start))/1000;
  const workSeconds=Object.entries(seconds).filter(([s])=>!["approval-wait","service-wait","engineering","generation"].includes(s)).reduce((n,[,v])=>n+v,0);
  const elapsedSeconds=Math.max(0,(batch.finishedAt?Date.parse(batch.finishedAt):now)-Date.parse(batch.createdAt))/1000;
  return {seconds,workSeconds,elapsedSeconds,serviceWaitSeconds:seconds["service-wait"],approvalWaitSeconds:seconds["approval-wait"],workSecondsPerCard:workSeconds/Math.max(1,batch.cardIds.length),elapsedSecondsPerCard:elapsedSeconds/Math.max(1,batch.cardIds.length),targetSecondsPerCard:{min:30,max:60}};
}

/** Partition without resetting holds or splitting a quantity group. Every ready
 * group still passes the exact same approval and packet gates as a full batch. */
export function batchWorkPlan(batch:TimedBatch,snapshot:WorkflowSnapshot) {
  const selected=new Set(batch.cardIds),seen=new Set<string>(),readyIds:string[]=[],exceptions:{cardIds:string[];reason:string}[]=[],existingIds:string[]=[];
  for(const id of batch.cardIds){
    if(seen.has(id))continue;
    const card=snapshot.cards.find(c=>c.id===id);
    if(!card){seen.add(id);exceptions.push({cardIds:[id],reason:"Current capture evidence unavailable"});continue;}
    const quantity=quantityPlan(card,snapshot.cards);
    const members=quantity.route==="prepare-one-quantity-draft"?quantity.memberIds:[id];
    members.forEach(member=>seen.add(member));
    if(card.receipts.length||quantity.route==="review-existing-quantity"){existingIds.push(...members.filter(member=>selected.has(member)));continue;}
    if(members.some(member=>!selected.has(member))){exceptions.push({cardIds:members.filter(member=>selected.has(member)),reason:"Select all matching copies before preparing this quantity group"});continue;}
    try{batchPacket({...batch,cardIds:members},snapshot);readyIds.push(...members);}
    catch(error){exceptions.push({cardIds:members,reason:error instanceof Error?error.message:"Review required"});}
  }
  return {batchId:batch.id,readyIds,existingIds,exceptions,canPublish:false as const};
}
/** A local preparation packet, never an import file or authority to write to eBay. */
export function batchPacket(batch:TimedBatch,snapshot:WorkflowSnapshot) {
  const cards=batch.cardIds.map(id=>{
    const card=snapshot.cards.find(c=>c.id===id);if(!card)throw new Error("Batch card missing from current evidence.");
    const review=snapshot.workflow[id],price=draftAskingPrice(card,review);
    if(!price||!Number.isFinite(price.item)||price.item<MINIMUM_CARD_ITEM||price.shipping===null||!Number.isFinite(price.shipping)||price.shipping<0||review?.holdReason||card.issues.length||card.identityStatus!=="identified")throw new Error("Every card needs a current validated or seller-set draft price and resolved identity/conflicts before packet export.");
    const fields=draftFields(card.identity),quantity=quantityPlan(card,snapshot.cards);
    const blockingHolds=workHolds(card,review);
    if(blockingHolds.length||fields.missing.length||!card.frontHash||card.backHashes.length!==1||!card.skus[0]||["excluded","review-possible-duplicates"].includes(quantity.route))throw new Error(`Draft packet blocked for ${cardListingTitle(card)}: ${[...blockingHolds,...fields.missing,quantity.requiresMatchReview?quantity.note:""] .filter(Boolean).join("; ")||"Photo, SKU or receipt review required"}`);
    return {id,aliases:card.aliases,sku:card.skus[0],...fields,specifics:fields.specifics,identity:card.identity,
      originals:{frontHash:card.frontHash,backHashes:card.backHashes,paths:card.originalPaths},
      pricingPolicy:price===card.override?"seller-manual-price-v1":price.policy,pricingEvidenceKey:price.evidenceKey,pricingEvidenceExpiresAt:price.evidenceExpiresAt,
      priceApproved:!!approvedAskingPrice(card,review),priceReviewStage:"ebay-draft" as const,
      quantity:quantity.proposedNewQuantity,quantityPlan:quantity,item:price.item,shipping:price.shipping,...cardOfferSettings(price.item),
      format:"Fixed price",duration:"Good Til Cancelled",promotion:{desiredGeneralPercent:3,priority:false,status:"Verify explicitly; never activate a default rate"},
      shippingService:price.shipping===6.29?"Ground service — verify policy":"eBay Standard Envelope — verify packaged eligibility and policy",
      receipts:card.receipts,route:card.receipts.length?"resume-or-reconcile-existing":"fresh-inventory-check-required",
      requirements:[...card.holds,"Fresh orchestrator preflight and four-scope inventory check","Verify packaged shipping eligibility and exact policy","Use upright derived photos; original front first, back second","Save as draft, wait for Seller Hub, reopen once and verify all saved fields","Unknown save outcome: reconcile receipt; never retry creation blindly","General promotion restriction retained; no default-rate activation"]};
  });
  const selected=new Set(batch.cardIds);
  for(const c of cards.filter(c=>c.quantityPlan.route==="review-existing-quantity")){
    if(c.quantityPlan.additionalCaptureIds.some(id=>!selected.has(id)))throw new Error("Matching copies exist outside this batch; review and approve every additional copy before quantity export.");
    if(cards.some(other=>c.quantityPlan.additionalCaptureIds.includes(other.id)&&(other.item!==c.item||other.shipping!==c.shipping)))throw new Error("Matching copies have different approved prices; reconcile before quantity review.");
  }
  const groups=cards.filter(c=>c.quantityPlan.route==="prepare-one-quantity-draft");
  for(const c of groups){
    if(c.quantityPlan.memberIds.some(id=>!selected.has(id)))throw new Error("Matching copies exist outside this batch; review the full quantity group before export.");
    if(cards.some(other=>c.quantityPlan.memberIds.includes(other.id)&&(other.item!==c.item||other.shipping!==c.shipping)))throw new Error("Matching copies have different approved prices; reconcile before grouping.");
  }
  const listings=cards.filter(c=>c.quantityPlan.route!=="prepare-one-quantity-draft"||c.id===[...c.quantityPlan.memberIds].sort()[0]).map(c=>({...c,
    description:c.quantity&&c.quantity>1?`${c.description} ${c.quantity} matching copies available; photos represent the reviewed group.`:c.description,
    captureIds:c.quantityPlan.route==="prepare-one-quantity-draft"?c.quantityPlan.memberIds:[c.id]}));
  return {batchId:batch.id,generatedAt:snapshot.asOf,mode:"draft-preparation-only",canUpload:false,canPublish:false,cards,listings,timing:batchTiming(batch)};
}
