import type { BacklogCard } from "./card-backlog.ts";
const normalized=(v:string|undefined)=>(v??"").trim().toLowerCase().replace(/\s+/g," ");
const core=["player","season","set","manufacturer","cardNumber","parallel","sport"];
function key(card:BacklogCard){return core.every(f=>card.identity[f])?JSON.stringify(core.map(f=>normalized(card.identity[f]))):null;}
/** A read-only quantity proposal. Never infer current available stock from old receipts. */
export function quantityPlan(card:BacklogCard,all:BacklogCard[]) {
  const own=card.receipts,serialized=!!card.identity.serial||!!Number(card.identity.printRun),identityKey=key(card);
  const candidates=serialized||!identityKey?[card]:all.filter(c=>!c.identity.serial&&!Number(c.identity.printRun)&&key(c)===identityKey&&!c.receipts.some(r=>r.disposition==="sold")
    &&!["language","condition","conditionType","artwork"].some(f=>c.identity[f]&&card.identity[f]&&normalized(c.identity[f])!==normalized(card.identity[f])));
  const unique=Array.from(new Map(candidates.map(c=>[c.frontHash??c.id,c])).values());
  const compatible=unique.every(c=>c.identityStatus==="identified"&&!c.issues.length&&["language","condition","conditionType","artwork"].every(f=>!!c.identity[f]&&normalized(c.identity[f])===normalized(card.identity[f])));
  const existing=Array.from(new Set(unique.flatMap(c=>c.receipts.filter(r=>r.disposition!=="sold").map(r=>r.id))));
  const additional=unique.filter(c=>!c.receipts.length).map(c=>c.id);
  const route=own.some(r=>r.disposition==="sold"||r.disposition==="scheduled")?"excluded"
    :own.length?"resume-existing"
    :unique.length>1&&!compatible?"review-possible-duplicates"
    :existing.length?"review-existing-quantity"
    :unique.length>1?"prepare-one-quantity-draft":"prepare-single-draft";
  return {route,memberIds:unique.map(c=>c.id),existingIds:existing,additionalCaptureIds:additional,
    proposedNewQuantity:route==="prepare-one-quantity-draft"?additional.length:route==="prepare-single-draft"?1:null,
    proposedAdditionalQuantity:route==="review-existing-quantity"?additional.length:null,
    requiresMatchReview:unique.length>1&&!compatible,canWrite:false,
    note:route==="review-possible-duplicates"?"Review artwork, language, condition and variant before grouping; do not create competing listings."
      :route==="review-existing-quantity"?"Read current available quantity and reconcile capture receipts before a quantity update. Do not create a new listing."
      :own.length?"Retain the recorded listing; do not count this capture again.":"Distinct original front hashes count once. A copied file or retry adds no stock."};
}
