import type {BacklogCard} from "./card-backlog.ts";
import {cardListingTitle,workAttention,stageHolds,workflowStage,type CardReview,type WorkflowSnapshot} from "./card-workflow.ts";

export const CAUSE_VERSION="2";
export const BLOCKER_CAUSES=[
  {code:"MAP01",label:"Capture or receipt conflict",owner:"Reconciliation",correction:"Verify original hashes, SKU and receipt mapping for each physical copy.",prevention:"Validate unique capture-to-receipt bindings during import."},
  {code:"PHOTO01",label:"Original photo / pairing review",owner:"Photo review",correction:"Inspect retained originals and resolve pairing or orientation.",prevention:"Require a verified original pair before downstream preparation."},
  {code:"SYS01",label:"Local processing or file access failure",owner:"Engineering",correction:"Resolve the recorded file-access failure, then resume through the supported claim/complete flow.",prevention:"Check write access and lock health before running local queue jobs."},
  {code:"ID02",label:"Parallel or serial unresolved",owner:"Identity",correction:"Read the exact parallel and full serial from the original pair.",prevention:"Require per-copy serial and variant evidence at identification."},
  {code:"ID01",label:"Identity fields incomplete",owner:"Identity",correction:"Resolve the missing or conflicting year, set, card number or condition.",prevention:"Validate required identity fields before admitting pricing work."},
  {code:"PR01",label:"Usable sold evidence missing",owner:"Pricing",correction:"Consume saved pricing context and investigate only the documented evidence gap.",prevention:"Record search coverage and reuse matching evidence and exclusions."},
  {code:"PR02",label:"Price evidence needs validation",owner:"Pricing",correction:"Validate source identity, sold amount, currency and independence; exclude own acquisitions.",prevention:"Require inspected source evidence and explicit exclusions before approval."},
  {code:"INV01",label:"Inventory clearance unavailable",owner:"Reconciliation",correction:"Complete a fresh active, draft, scheduled and sold check for this copy.",prevention:"Track reconciliation freshness and shared access failures before listing handoff."},
  {code:"SHIP01",label:"Shipping eligibility unresolved",owner:"Listing review",correction:"Confirm packaged size, weight and the applicable shipping service.",prevention:"Capture packaging eligibility with each shipping decision."},
  {code:"LIST01",label:"Listing fields or photo audit",owner:"Listing review",correction:"Complete remaining specifics and original-photo checks on the saved draft.",prevention:"Use a complete verified template and retain the final saved-field audit."},
  {code:"POL01",label:"Offers or promotion policy",owner:"Seller review",correction:"Confirm the required offer thresholds and promotion settings.",prevention:"Validate those settings in the listing template and final review."},
  {code:"HOLD01",label:"Seller hold needs resolution",owner:"Seller review",correction:"Review the saved hold note and document the decision needed to resume.",prevention:"Record a specific owner and release condition with every manual hold."},
  {code:"OTHER01",label:"Cause needs classification",owner:"Triage",correction:"Read the retained reason and classify the actual blocker before taking action.",prevention:"Extend the cause rules after confirming a recurring cause."},
] as const;
export type CauseCode=typeof BLOCKER_CAUSES[number]["code"];
export type BlockerCause={primary:CauseCode;codes:CauseCode[];evidence:{code:CauseCode;reason:string}[]};
export const causeDefinition=(code:CauseCode)=>BLOCKER_CAUSES.find(c=>c.code===code)!;

function classify(reason:string,stage:string):CauseCode {
  const t=reason.toLowerCase();
  if(/eperm|eacces|permission denied|operation not permitted|read.only file|failed.*rename/.test(t))return "SYS01";
  if(/mapping|maps to|stable id|ambiguous.*(id|sku)|sku.*distinct|capture.*conflict|without original front hash/.test(t))return "MAP01";
  if(/conflicting back|front.back convention|pairing|original (front|back|photo|files)|original.*pair/.test(t))return "PHOTO01";
  // A pricing worker's unavailable comparable image is not a missing inventory original.
  if(!/^pricing:/.test(t) && /original.*(missing|unavailable)|rotation|orientation/.test(t))return /optional|specifics|audit/.test(t)?"LIST01":"PHOTO01";
  if(/^reconcile:|seller.?hub|four.scope/.test(t))return "INV01";
  if(/same full serial|conflicting .*serial|conflicting .*parallel/.test(t))return "ID02";
  if(/^identity:/.test(t)&&/serial|numerator|parallel|variant/.test(t))return "ID02";
  if(stage==="identify" && /parallel|variant|serial|numerator|denominator|foil|print.run/.test(t))return "ID02";
  if(/identity source|identity.*(missing|incomplete|conflict)|conflicting (player|season|set|cardnumber|condition)|release (year|season)|card.number.*(disagree|unresolved)|sold.title disagreement/.test(t))return "ID01";
  if(/own.acquisition|owned.physical|independen|source serial|source.*(unverified|inaccessible)|currency|conversion|hidden.offer|undisclosed|price.*(invalid|stale)|pricing.*review|price evidence review/.test(t))return "PR02";
  if(/no (adequate|eligible|usable|recent|saved comp|independent|supported)|missing.*(price|sold|comp)|evidence.*(absent|missing)|sold evidence|no.*(sold|comp)|no guessed price|no invented price/.test(t))return "PR01";
  if(/seller.?hub|four.scope|inventory|reconcil|clearance|duplicate/.test(t))return "INV01";
  if(/shipping|packag|envelope|weight|dimensions/.test(t))return "SHIP01";
  if(/specifics|photo audit|listing.*(field|review)|final.*audit/.test(t))return "LIST01";
  if(/offer|promotion|promoted/.test(t))return "POL01";
  if(/pricing|comp|price|sold/.test(t))return "PR02";
  if(stage==="identify" && /unknown|unresolved|missing|identity|condition|year|set|card number/.test(t))return "ID01";
  return "OTHER01";
}

/** Rule-based blocker categories, not asserted root causes. Source evidence is never rewritten. */
export function blockerCause(card:BacklogCard,review?:CardReview):BlockerCause|null {
  if(workAttention(card,review)!=="blocked")return null;
  const stage=workflowStage(card,review),evidence:{code:CauseCode;reason:string}[]=[];
  if(!card.physicalUnits)evidence.push({code:"MAP01",reason:"No verified original capture mapping"});
  else if(!card.frontHash||card.backHashes.length!==1)evidence.push({code:"PHOTO01",reason:"Original front/back pair is missing or ambiguous"});
  for(const reason of Array.from(new Set([...card.issues,...stageHolds(card,review)])))evidence.push({code:classify(card.pricingHolds?.includes(reason)&&!card.issues.includes(reason)?`pricing: ${reason}`:reason,stage),reason});
  if(review?.holdReason){const code=classify(review.holdReason,stage);evidence.push({code:code==="OTHER01"?"HOLD01":code,reason:review.holdReason});}
  if(!evidence.length)evidence.push({code:"OTHER01",reason:"Blocked without a specific retained cause"});
  const priority:CauseCode[]=stage==="listing"||stage==="listed"?["MAP01","PHOTO01","SYS01","INV01","SHIP01","LIST01","POL01","ID02","ID01","PR01","PR02","HOLD01","OTHER01"]:BLOCKER_CAUSES.map(c=>c.code);
  const codes=priority.filter(code=>evidence.some(e=>e.code===code));
  return {primary:codes[0],codes,evidence};
}
export function blockerPareto(cards:BacklogCard[],workflow:WorkflowSnapshot["workflow"]) {
  const classified=cards.map(card=>({card,cause:blockerCause(card,workflow[card.id])})).filter(r=>r.cause!==null);
  let cumulative=0;
  const rows=BLOCKER_CAUSES.map(c=>({...c,count:classified.filter(r=>r.cause!.primary===c.code).length})).filter(c=>c.count).sort((a,b)=>b.count-a.count||a.code.localeCompare(b.code)).map(c=>{
    cumulative+=c.count;return {...c,share:c.count/classified.length,cumulative:cumulative/classified.length};
  });
  return {total:classified.length,rows};
}
export function blockerRccaCsv(cards:BacklogCard[],snapshot:WorkflowSnapshot) {
  const quote=(value:unknown)=>{let text=String(value??"");if(/^[=+@\-\t\r]/.test(text))text=`'${text}`;return `"${text.replaceAll('"','""')}"`;};
  const rows:unknown[][]=[["As of","Cause rules version","Capture ID","SKU","Listing title","Stage","Primary cause code","Cause label","All cause codes","Exact blocker evidence","Suggested owner","Suggested correction","Suggested prevention","Confirmed root cause","Corrective action","Preventive action","Action owner","Due date","Effectiveness check","Action status"]];
  for(const card of cards){const cause=blockerCause(card,snapshot.workflow[card.id]);if(!cause)continue;const definition=causeDefinition(cause.primary);
    rows.push([snapshot.asOf,CAUSE_VERSION,card.captureId||card.id,card.skus.join(" | "),cardListingTitle(card),workflowStage(card,snapshot.workflow[card.id]),cause.primary,definition.label,cause.codes.join(" | "),cause.evidence.map(e=>`[${e.code}] ${e.reason}`).join("\n"),definition.owner,definition.correction,definition.prevention,"","","","","","",""]);
  }
  return rows.map(r=>r.map(quote).join(",")).join("\r\n");
}
