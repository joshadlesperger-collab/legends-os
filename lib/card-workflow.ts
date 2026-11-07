import type { BacklogCard, BacklogPrice, BacklogSnapshot } from "./card-backlog.ts";
import { currentEvidencePrice, MINIMUM_CARD_ITEM } from "./card-price-policy.ts";
import { money } from "./card-orchestrator-policy.ts";

export type ManualPrice = { item: number; shipping: number };
export type ReviewAction = "approve-price" | "set-price" | "hold" | "resume" | "note";
export type ReviewEvent = { requestId: string; cardId: string; token: string; action: ReviewAction; note: string; at: string; price?: ManualPrice; priceBinding?: string };
export type ReviewCommand = Omit<ReviewEvent,"at"|"priceBinding">;
export type CardReview = { token: string; approvedAt?: string; approvedBinding?: string; manualPrice?: BacklogPrice; holdReason?: string; history: ReviewEvent[] };
export type WorkflowSnapshot = BacklogSnapshot & { workflow: Record<string, CardReview> };
export const WORK_LANES = [
  { id: "review-price", label: "Review prices", description: "Saved proposals awaiting your decision" },
  { id: "listing-checks", label: "Finish listing review", description: "Current draft prices and existing drafts" },
  { id: "identify", label: "Identify cards", description: "Original photos with identity gaps" },
  { id: "research", label: "Find price evidence", description: "Known cards with missing price evidence" },
  { id: "blocked", label: "Resolve blockers", description: "Conflicts and cards you put on hold" },
  { id: "listed", label: "Recorded eBay status", description: "Saved live, scheduled or sold receipts; not a fresh live check" },
] as const;
export type WorkLane = typeof WORK_LANES[number]["id"];
export type WorkflowStage = "identify" | "price" | "listing" | "listed" | "unmapped";
export type WorkAttention = "review" | "work" | "blocked" | "recorded";
export const WORK_STAGES: {id:WorkflowStage; label:string; description:string}[] = [
  {id:"identify",label:"Identify",description:"Confirm the card and its original photo pair"},
  {id:"price",label:"Price",description:"Find missing evidence or review the saved asking price"},
  {id:"listing",label:"Listing review",description:"Finish checks and resume saved drafts"},
  {id:"listed",label:"Recorded eBay status",description:"Saved live, sold or scheduled receipts; not a fresh live check"},
  {id:"unmapped",label:"Unlinked records",description:"Match saved evidence to an original scan; not additional inventory"},
];
export const ATTENTION_LABELS: Record<WorkAttention,string> = {review:"Review pending",work:"Processing needed",blocked:"Unresolved dependency",recorded:"Receipt saved"};

/** Display saved listing text verbatim; an incomplete record gets only its known identity fields. */
export function cardListingTitle(card:BacklogCard) {
  const receipt=card.receipts.filter(r=>r.title?.trim()).sort((a,b)=>{
    const priority={sold:3,live:3,scheduled:2,draft:1};
    return priority[b.disposition]-priority[a.disposition] || (Date.parse(b.observedAt||"")||0)-(Date.parse(a.observedAt||"")||0);
  })[0];
  if(receipt?.title)return receipt.title;
  if(card.title && card.title!==card.identity.player)return card.title;
  const i=card.identity,season=i.season && !i.set?.includes(i.season)?i.season:"";
  return [season,i.set,i.player,i.cardNumber?`#${i.cardNumber}`:"",i.parallel,i.serial].filter(Boolean).join(" ") || card.title;
}

/** Each capture has one next-work bucket; a hold stays visible in its own stage. */
export function workflowStage(card:BacklogCard,review?:CardReview):WorkflowStage {
  if(!card.physicalUnits)return "unmapped";
  if(card.receipts.some(r=>["live","sold","scheduled"].includes(r.disposition)))return "listed";
  if(card.identityStatus!=="identified")return "identify";
  return draftAskingPrice(card,review)?"listing":"price";
}
export function workAttention(card:BacklogCard,review?:CardReview):WorkAttention {
  if(!card.physicalUnits || card.issues.length || review?.holdReason || !card.frontHash || card.backHashes.length!==1)return "blocked";
  if(workflowStage(card,review)==="listed")return "recorded";
  if(workflowStage(card,review)==="price" && canApprovePrice(card))return "review";
  if(stageHolds(card,review).length)return "blocked";
  return ["identify","price"].includes(workflowStage(card,review))?"work":"review";
}
/** A seller-set price resolves pricing work without claiming that missing research was completed. */
export const workHolds=(card:BacklogCard,review?:CardReview)=>card.holds.filter(reason=>
  !card.identityRequirements?.some(r=>r.reason===reason&&r.resolved)
  &&!(review?.manualPrice&&(/^pricing:/i.test(reason)||card.pricingHolds?.includes(reason))));
/** Explicit downstream holds stay recorded without stopping independent preparation. */
export function stageHolds(card:BacklogCard,review?:CardReview) {
  const stage=workflowStage(card,review);
  return workHolds(card,review).filter(reason=>{
    if(stage==="identify")return !/^(pricing|reconcile|listing):/i.test(reason)
      &&!card.pricingHolds?.includes(reason)&&!card.identityRequirements?.some(r=>r.reason===reason);
    if(stage==="price")return !/^(reconcile|listing):/i.test(reason);
    return true;
  });
}
export function stageWork(snapshot:WorkflowSnapshot,stage:WorkflowStage,attention:WorkAttention|"all"="all",query="") {
  return orderedWork(snapshot,undefined,query).filter(c=>workflowStage(c,snapshot.workflow[c.id])===stage && (attention==="all"||workAttention(c,snapshot.workflow[c.id])===attention));
}
/** Default progression skips blocked/recorded cards; explicit filters retain access to them. */
export function selectableWork(card:BacklogCard,review?:CardReview,attention:WorkAttention|"all"="all") {
  const actual=workAttention(card,review);
  return attention==="all" ? actual==="work"||actual==="review" : actual===attention;
}
export function workflowOverview(snapshot:WorkflowSnapshot) {
  const physical=snapshot.cards.filter(c=>c.physicalUnits>0);
  const milestones={scanned:physical.length,identified:0,priced:0,listed:0};
  const buckets=Object.fromEntries(WORK_STAGES.map(s=>[s.id,{total:0,review:0,work:0,blocked:0,recorded:0}])) as Record<WorkflowStage,{total:number;review:number;work:number;blocked:number;recorded:number}>;
  for(const card of snapshot.cards){
    const review=snapshot.workflow[card.id],stage=workflowStage(card,review),bucket=buckets[stage];
    bucket.total++;bucket[workAttention(card,review)]++;
    if(!card.physicalUnits)continue;
    if(card.identityStatus==="identified")milestones.identified++;
    const price=approvedAskingPrice(card,review)||card.proposal;
    if(price && Number.isFinite(price.item) && price.item>0)milestones.priced++;
    // A draft or scheduled receipt is not evidence of a published listing.
    if(card.receipts.some(r=>r.disposition==="live"||r.disposition==="sold"))milestones.listed++;
  }
  return {milestones,buckets,remaining:buckets.identify.total+buckets.price.total+buckets.listing.total};
}

/** Source-only binding: local notes never mutate the evidence or invalidate other local notes. */
export function reviewBinding(card: BacklogCard) {
  return JSON.stringify({ id: card.id, front: card.frontHash, backs: [...card.backHashes].sort(),
    identity: Object.entries(card.identity).sort(([a],[b]) => a.localeCompare(b)), status: card.identityStatus,
    proposal: card.proposal, approved: card.approvedPrice, override: card.override,
    receipts: Array.from(new Set(card.receipts.map(r => `${r.disposition}:${r.id}`))).sort(), issues: [...card.issues].sort(), holds: [...card.holds].sort() });
}
export function canApprovePrice(card: BacklogCard, now = Date.now()) {
  const p = card.proposal, age = p?.updatedAt ? now - Date.parse(p.updatedAt) : NaN;
  return !!(card.frontHash && card.backHashes.length === 1 && card.identityStatus === "identified" && !card.issues.length
    && !card.approvedPrice && !card.override && p && Number.isFinite(p.item) && p.item > 0 && p.shipping !== null && Number.isFinite(p.shipping) && p.shipping >= 0
    && currentEvidencePrice(p,now) && !p.stale && Number.isFinite(age) && age >= 0 && age <= 90 * 86400000
    && !card.receipts.some(r => ["live", "sold", "scheduled"].includes(r.disposition)));
}
export function manualPriceBinding(card: BacklogCard) {
  return JSON.stringify({id:card.id,front:card.frontHash,backs:[...card.backHashes].sort(),identity:Object.entries(card.identity).sort(([a],[b])=>a.localeCompare(b)),status:card.identityStatus});
}
export const validManualPrice = (price?: ManualPrice): price is ManualPrice => !!price && money(price.item,true) && price.item>=MINIMUM_CARD_ITEM && money(price.shipping);
export const canSetManualPrice = (card:BacklogCard) => !!(card.physicalUnits && card.frontHash && card.backHashes.length===1 && card.identityStatus==="identified"
  && !card.receipts.some(r=>["live","sold","scheduled"].includes(r.disposition)));
/** The typed item amount is final: never round it or add a pricing premium. Shipping is separately editable. */
export function suggestedManualShipping(card:BacklogCard,item:number) {
  const prior=card.override??card.approvedPrice??card.proposal;
  if(item>=20||prior?.shipping===6.29)return 6.29;
  if(item<3)return 0;
  return item>=10||prior?.shipping===1.95?1.95:1.49;
}
export const approvedAskingPrice = (card: BacklogCard, review?: CardReview) => {
 if(review?.holdReason)return null;
 const manual=review?.manualPrice??card.override;
 if(manual && validManualPrice({item:manual.item,shipping:manual.shipping as number}))return manual;
 return review?.approvedAt && review.approvedBinding===reviewBinding(card) && currentEvidencePrice(card.proposal)
  ? card.proposal : null;
};
/** Seller reviews prices in eBay drafts; this does not manufacture an approval event. */
export function draftAskingPrice(card:BacklogCard,review?:CardReview,now=Date.now()) {
  if(review?.holdReason)return null;
  const approved=approvedAskingPrice(card,review);
  if(approved)return approved;
  return card.frontHash&&card.backHashes.length===1&&card.identityStatus==="identified"&&!card.issues.length
    &&!card.receipts.some(r=>["live","sold","scheduled"].includes(r.disposition))
    &&currentEvidencePrice(card.proposal,now)?card.proposal:null;
}
export function workLane(card: BacklogCard, review?: CardReview): WorkLane {
  if (card.issues.length || !card.physicalUnits || review?.holdReason) return "blocked";
  if (card.receipts.some(r => ["live", "sold", "scheduled"].includes(r.disposition))) return "listed";
  if (card.identityStatus !== "identified") return "identify";
  if (draftAskingPrice(card, review)) return "listing-checks";
  return canApprovePrice(card) ? "review-price" : "research";
}
export function orderedWork(snapshot: WorkflowSnapshot, lane?: WorkLane, query = "") {
  const normalized = query.toLowerCase().trim();
  return snapshot.cards.filter(c => (!lane || workLane(c, snapshot.workflow[c.id]) === lane)
    && `${cardListingTitle(c)} ${c.skus.join(" ")} ${c.aliases.join(" ")} ${c.receipts.map(r => r.id).join(" ")}`.toLowerCase().includes(normalized))
    .sort((a,b) => Number(b.receipts.some(r => r.disposition === "draft")) - Number(a.receipts.some(r => r.disposition === "draft"))
      || Number(b.textPrepared) - Number(a.textPrepared) || pricingWorkKey(a).localeCompare(pricingWorkKey(b)) || a.id.localeCompare(b.id));
}
export function pricingWorkKey(card:BacklogCard) {
  const i=card.identity;
  return [i.player,i.set,i.season,i.cardNumber,i.parallel,i.printRun,i.language,i.condition].map(v=>(v??"").trim().toLowerCase()).join("|");
}
export function nextWork(snapshot: WorkflowSnapshot, exclude: string[] = []) {
  // Existing drafts with usable prices take precedence over new reviews/research.
  for (const lane of ["listing-checks", "review-price", "identify", "research"] as WorkLane[]) {
    const next = orderedWork(snapshot, lane).find(c => !exclude.includes(c.id) && selectableWork(c,snapshot.workflow[c.id]));
    if (next) return next;
  }
  return undefined;
}
export function workHandoff(card: BacklogCard, review?: CardReview) {
  const asking = draftAskingPrice(card, review);
  return [`Continue ${card.skus[0] || card.title} (${card.aliases.join(", ")}).`,
    `Capture: ${card.captureId || "unmapped"}. Stage: ${workLane(card, review)}.`,
    asking ? `Use the ${review?.manualPrice?"seller-entered manual":"current draft"} asking price: ${asking.item} plus ${asking.shipping} shipping. Seller price review happens in eBay drafts; do not ask for pre-draft approval. This is not publication authority or evidence of an eBay save.` : "Consume saved pricing context before researching only the documented gaps.",
    ...card.receipts.map(r => `Retain ${r.disposition} receipt ${r.id}; do not recreate it.`),
    ...[...card.issues,...workHolds(card,review),review?.holdReason].filter(Boolean).map(reason => `Open requirement: ${reason}`),
    "Use the orchestrator pricing-context and fresh preflight for this exact card before listing work. Use claim/complete for worker evidence. Preserve originals, overrides and title punctuation. No eBay publication is authorized by this handoff.",
  ].join("\n");
}
