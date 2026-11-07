import { draftModelAuthorizedPrice, draftModelStatus } from "./draft-model-workflow.ts";
import { CONDITION_DEFAULT_POLICY } from "./card-condition-default.ts";
import { CARD_POLICY_VERSION, calculateCardPrice, cardPremiumReasons } from "./card-orchestrator-policy.ts";
import { approvedRulePrice, createJobBlockerLookup, existingReceipt, fingerprint, jobBlockers, localReviewListings, matchKey, refreshJobs, reviewedIdentity, validateComps, pricingProjection, type CompBasis, type QueueState } from "./card-orchestrator.ts";
import type { BacklogPrice } from "./card-backlog.ts";
import type { WorkflowSnapshot } from "./card-workflow.ts";
import { draftNext } from "./card-draft-lifecycle.ts";
import { MINIMUM_CARD_ITEM } from "./card-price-policy.ts";
import { PRICING_SOURCE_FIRST } from "./pricing-source-policy.ts";
import { ACTIVE_DUPLICATE_POLICY } from "./card-active-duplicate-policy.ts";

export type WorkflowDecision = { manualPrice?: BacklogPrice; approvedPrice?: BacklogPrice; holdReason?: string };
/** Only project decisions already validated against the current backlog by withWorkflow. */
export function workflowDecisions(state:QueueState,snapshot:WorkflowSnapshot,ids:string[]) {
  const decisions:Record<string,WorkflowDecision>={};
  const cardsById=new Map<string,WorkflowSnapshot["cards"][number]>();
  // Preserve find()'s first-match behavior even for malformed duplicate IDs.
  for(const card of snapshot.cards)if(!cardsById.has(card.id))cardsById.set(card.id,card);
  for(const id of ids) {
    const input=state.cards[id]?.input;if(!input)continue;
    const front=input.photos.find(p=>p.side==="front")?.sha256.toLowerCase();
    const back=input.photos.find(p=>p.side==="back")?.sha256.toLowerCase();
    const card=cardsById.get(`capture:${front}`),review=card&&snapshot.workflow[card.id];
    if(!card||!review)continue;
    const pairMatches=card.frontHash===front&&card.backHashes.length===1&&card.backHashes[0]===back;
    decisions[id]={holdReason:review.holdReason,
      manualPrice:pairMatches?review.manualPrice:undefined,
      approvedPrice:pairMatches&&!review.manualPrice&&review.approvedAt&&card.proposal
        ? {...card.proposal,approvedAt:review.approvedAt,reviewRequired:false}:undefined};
  }
  return decisions;
}

/** A review packet is not permission to write to eBay. */
export function pricingContext(state:QueueState,id:string,now=new Date().toISOString()) {
  const card=state.cards[id];if(!card)throw new Error(`Unknown card: ${id}`);
  refreshJobs(card,now);
  const identity=reviewedIdentity(card);
  const related=identity?Object.values(state.cards).filter(other=>other.input.id!==id&&reviewedIdentity(other)&&matchKey(reviewedIdentity(other)!)===matchKey(identity)):[];
  const reusable=related.flatMap(other=>{
    refreshJobs(other,now);
    const result=other.jobs.pricing.result;
    if(other.jobs.pricing.state!=="done"||!result)return [];
    try {
      // Re-check each target's physical serial: another copy's comp may be THIS copy's acquisition.
      validateComps(identity!,result.comps,now,result.basis as CompBasis|undefined);
      return [{cardId:other.input.id,comps:result.comps,basis:result.basis,evidence:result.evidence,exactSearchEvidence:result.exactSearchEvidence}];
    } catch {return [];}
  });
  return {cardId:id,sourceFirst:PRICING_SOURCE_FIRST,activeDuplicatePolicy:ACTIVE_DUPLICATE_POLICY,conditionPolicy:CONDITION_DEFAULT_POLICY,researchGroup:identity?matchKey(identity):null,identityReviewRequired:!identity,handoff:card.input.pricingHandoff??null,
    savedCandidates:card.input.candidates,admittedEvidence:card.pricingEvidence??null,completedPricing:card.jobs.pricing.state==="done"?card.jobs.pricing.result:null,
    reusableEvidence:reusable,relatedHolds:related.filter(c=>c.jobs.pricing.state==="held").map(c=>({cardId:c.input.id,reason:c.jobs.pricing.reason})),
    instruction:"Follow sourceFirst: check active listings, sold listings and knowledge graph before external research; stop when sufficient fresh validated evidence exists. Read saved handoff and evidence first. Reuse validated evidence through claim/complete; confirm language/condition and exclude this physical copy. Do not repeat unchanged holds or restart completed research. Never copy another card's final price or override."};
}

export type AskingPriceApproval={cardId:string;item:number;shipping:number|null;sourceUpdatedAt:string;policyVersion:string;photoHashes:string[];approvedAt:string;sourceIdentityKey:string};
export function flowPacket(state:QueueState,ids:string[],now=new Date().toISOString(),approvals:AskingPriceApproval[]=[],manualPrices:Record<string,BacklogPrice>={},decisions:Record<string,WorkflowDecision>={}) {
  return buildFlowPacket(state,ids,now,approvals,manualPrices,decisions,(card,kind,hold)=>jobBlockers(state,card,kind,hold));
}
function buildFlowPacket(state:QueueState,ids:string[],now:string,approvals:AskingPriceApproval[],manualPrices:Record<string,BacklogPrice>,decisions:Record<string,WorkflowDecision>,blockersFor:ReturnType<typeof createJobBlockerLookup>) {
  if(!ids.length||ids.length>50||new Set(ids).size!==ids.length)throw new Error("Select 1–50 distinct card IDs");
  const cards=ids.map(id=>{
    const c=state.cards[id];if(!c)throw new Error(`Unknown card: ${id}`);
    refreshJobs(c,now);
    const receipt=existingReceipt(c),identity=reviewedIdentity(c),handoff=c.input.pricingHandoff;
    const sellerHold=decisions[id]?.holdReason;
    const blockedBy=blockersFor(c,"pricing",sellerHold);
    let proposal=c.jobs.pricing.state==="done"?c.jobs.pricing.result?.projection:null;
    if(proposal&&identity&&((proposal as {policyVersion?:string}).policyVersion!==CARD_POLICY_VERSION||["seller-asking","active-lowest"].includes(String(c.jobs.pricing.result?.basis)))){
      try {const result=c.jobs.pricing.result!,validated=validateComps(identity,result.comps,now,result.basis as "exact"|"related-print-run"|undefined);
        proposal=pricingProjection(validated.buyerTotalMean,result.basis as CompBasis,{patch:identity.patch,tracked:result.tracked===true,override:c.input.override},validated.asking);
      }catch{proposal=null;}
    }
    const sourceProposal=handoff?.matchesOriginals&&handoff.item!==null?{item:handoff.item,shipping:handoff.shipping}:null;
    const age=handoff?Date.parse(now)-Date.parse(handoff.updatedAt):NaN;
    const sourceFresh=Number.isFinite(age)&&age>=0&&age<=90*86400000;
    const premiums=cardPremiumReasons(identity??c.input.identity),correction=approvedRulePrice(c,now);
    const manual=decisions[id]?.manualPrice??manualPrices[id],workflowApproval=decisions[id]?.approvedPrice;
    const sourcePolicyCurrent=handoff?.policyVersion===CARD_POLICY_VERSION;
    const approval=sourceProposal&&sourceFresh&&sourcePolicyCurrent&&!c.input.override?approvals.find(a=>a.cardId===id&&a.item===sourceProposal.item&&a.shipping===sourceProposal.shipping&&a.sourceUpdatedAt===handoff?.updatedAt&&a.policyVersion===handoff?.policyVersion&&a.sourceIdentityKey===fingerprint(c.input.identity)&&fingerprint([...a.photoHashes].sort())===fingerprint(c.input.photos.map(p=>p.sha256).sort())&&Number.isFinite(Date.parse(a.approvedAt))&&Date.parse(a.approvedAt)<=Date.parse(now)):undefined;
    let nextOwner="pricing",nextAction="Read pricing context and resolve only the missing evidence";
    if(sellerHold) {nextOwner="seller-review";nextAction=`Resolve the saved seller hold before continuing: ${sellerHold}`;}
    else if(receipt&&receipt.disposition!=="draft") {nextOwner="reconciliation";nextAction="Existing live/scheduled/sold or ambiguous record: exclude from Add";}
    else if(blockedBy.some(reason=>/conflict|also belongs|Same original/i.test(reason))) {nextOwner="reconciliation";nextAction="Resolve the recorded identity/receipt conflict; no new draft";}
    else if(c.jobs.photos.state!=="done"||!identity) {nextOwner="identity";nextAction="Finish original-photo and identity review";}
    else if(manual) {nextOwner="listing-review";nextAction="Use the seller-entered manual asking price; preserve it through inventory, shipping and listing checks";}
    else if(c.jobs.pricing.state==="leased") {nextOwner=c.jobs.pricing.lease!.owner;nextAction="Pricing is claimed; wait for its result, do not duplicate research";}
    else if(workflowApproval||correction||approval) {nextOwner="listing-review";nextAction="Use the seller-approved asking price; finish inventory, shipping and listing accuracy checks";}
    else if(proposal) {nextOwner="listing-review";nextAction="Use the current validated price for the draft; the seller reviews prices in eBay drafts";}
    else if(sourceProposal) {nextOwner="pricing-review";nextAction="Review the existing pricing-agent proposal and its specific evidence gaps; do not start from scratch";}
    else if(c.jobs.pricing.state==="held"||handoff?.status.startsWith("held")) {nextOwner="pricing";nextAction="Retain the hold; retry only with new evidence";}
    const blockers=[...blockedBy];
    const stageHolds=Object.values(c.jobs).filter(job=>job.state==="held").map(job=>({kind:job.kind,reason:job.reason??"Held",recovery:job.recovery??null}));
    blockers.push(...stageHolds.filter(hold=>!manual||hold.kind!=="pricing").map(hold=>`${hold.kind}: ${hold.reason}`));
    if(!receipt && !(c.jobs.reconcile.state==="done"&&c.jobs.reconcile.result?.disposition==="clear"))blockers.push("Fresh four-scope inventory clearance required");
    if(!proposal&&!manual) blockers.push(sourceProposal?"Pricing-agent proposal has not passed evidence validation":"No validated price");
    if(handoff&&!sourceFresh&&!manual&&!proposal)blockers.push("Pricing handoff date is missing, future or older than 90 days");
    if(sourceProposal&&!sourcePolicyCurrent&&!correction&&!manual&&!proposal)blockers.push("Source proposal policy needs reconciliation");
    blockers.push(manual||workflowApproval||correction||approval?"Asking price approved; shipping/policy checks remain required":"Seller reviews prices in eBay drafts; shipping/policy checks remain required","Final save/reopen audit and publication handoff remain required");
    const approvedProposal=manual??workflowApproval??correction?.projection??(approval?sourceProposal:null);
    const calculated=proposal as {item:number;shipping:number|null;policyVersion?:string}|null;
    const validCalculated=calculated?.policyVersion===CARD_POLICY_VERSION&&Number.isFinite(calculated.item)&&calculated.item>=MINIMUM_CARD_ITEM
      &&calculated.shipping!==null&&Number.isFinite(calculated.shipping)&&calculated.shipping>=0;
    const modelSellerPrice=manual??workflowApproval??c.input.override??null;
    const modelPrice=draftModelAuthorizedPrice(state,id,sellerHold,modelSellerPrice,now);
    const modelWorkflow=draftModelStatus(state,id,sellerHold,modelSellerPrice,now);
    const draftProposal=modelPrice??approvedProposal??(validCalculated?calculated:null);
    const draftAuthorized=!!draftProposal&&!sellerHold&&(!state.draftModelWorkflows?.[id]||!!modelPrice);
    const lifecycle=(c.draftLifecycle||state.draftWriter?.scope.includes(id))?draftNext(state,id,{approved:!!approvedProposal,draftAuthorized,price:draftProposal as {item:number;shipping:number|null}|null,sellerHold},now,blockersFor):null;
    if(lifecycle){nextOwner=lifecycle.owner;nextAction=lifecycle.action;}
    if(state.draftModelWorkflows?.[id]){nextOwner=modelWorkflow.nextOwner;nextAction=modelWorkflow.stage;}
    const savedOnEbay=lifecycle?.verificationCurrent&&lifecycle.verification?.checks.filter(c=>["item","shipping.amount","shipping.policy"].includes(c.field)).every(c=>c.status==="pass")
      ?`Draft price verified in saved snapshot ${lifecycle.verification.checkedAt}`:"eBay price not verified against the current draft price";
    return {id,sku:c.input.sku,identity:identity??c.input.identity,originals:c.input.photos,activeDuplicatePolicy:ACTIVE_DUPLICATE_POLICY,conditionPolicy:CONDITION_DEFAULT_POLICY,
      receipt,route:receipt?.disposition==="draft"?"resume-existing-draft":receipt?"excluded":"prepare-new-only-after-reconciliation",
      nextOwner,nextAction,draft:lifecycle,sellerHold:sellerHold??null,stageHolds,pricing:{validatedProposal:proposal??null,agentProposal:sourceProposal,agentStatus:handoff?.status??null,
        estimateLabel:c.jobs.pricing.result?.estimateLabel??null,reason:proposal?String(c.jobs.pricing.result?.evidence??"Validated pricing evidence"):handoff?.reason??c.jobs.pricing.reason??null,sourceUpdatedAt:handoff?.updatedAt??null,sourceFresh,sourcePolicyCurrent,
        premiumReasons:premiums,colorMatchReviewed:!!identity?.colorMatch,
        modelWorkflow,draftProposal,draftAuthorized,reviewStage:"ebay-draft" as const,
        manualOverride:manual??null,workflowApproval:workflowApproval??null,savedOnEbay,approved:!!(manual||workflowApproval||correction||approval),approvedAt:manual?.approvedAt??workflowApproval?.approvedAt??correction?.approvedAt??approval?.approvedAt??null,approvedProposal},
      textPrepared:c.jobs.listing.state==="done",blockers:Array.from(new Set(lifecycle?lifecycle.blockers:blockers)),
      canUpload:false,canPublish:false};
  });
  return {asOf:now,policyVersion:CARD_POLICY_VERSION,mode:"local-preparation-only",snapshot:fingerprint(cards),
    externalWriterPossible:state.externalWriterPossible,canUpload:false,canPublish:false,cards,activeDuplicatePolicy:ACTIVE_DUPLICATE_POLICY,conditionPolicy:CONDITION_DEFAULT_POLICY,
    instruction:"Refresh this packet immediately before listing work. Use the current validated or seller-set price for drafts without a pre-draft approval question. Price review happens in the saved eBay draft. Missing evidence and explicit holds still block; never publish or use a cached packet to authorize an external write."};
}

/** Reports use the same current asking-price decision as preflight, never a saved display flag. */
export function reportHandoff(state:QueueState,now=new Date().toISOString(),approvals:AskingPriceApproval[]=[],decisions:Record<string,WorkflowDecision>={}) {
  for(const card of Object.values(state.cards))refreshJobs(card,now);
  const blockersFor=createJobBlockerLookup(state);
  const ids=Object.keys(state.cards),cards:ReturnType<typeof flowPacket>["cards"]=[];
  for(let offset=0;offset<ids.length;offset+=50)cards.push(...buildFlowPacket(state,ids.slice(offset,offset+50),now,approvals,{},decisions,blockersFor).cards);
  const byId=new Map(cards.map(card=>[card.id,card]));
  const holds=Object.fromEntries(Object.entries(decisions).flatMap(([id,d])=>d.holdReason?[[id,d.holdReason]]:[]));
  const listings=localReviewListings(state,now,holds).map(listing=>{
    const card=byId.get(listing.id)!,price=card.pricing;
    return {...listing,pricing:price.approvedProposal??price.validatedProposal??price.agentProposal,
      approvedAskingPrice:price.approvedProposal,manualAskingPrice:price.manualOverride,
      priceNeedsReview:!price.approved,priceReviewStage:price.reviewStage,draftAskingPrice:price.draftProposal,approvedAt:price.approvedAt,
      validatedPricing:price.validatedProposal,pricingEvidenceValidated:price.validatedProposal!==null,
      blockers:card.blockers,nextOwner:card.nextOwner,canUpload:false,canPublish:false};
  });
  return {cards,listings};
}

const escape=(value:unknown)=>String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
export function flowHtml(packet:ReturnType<typeof flowPacket>) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Card handoff review</title><style>body{font:16px/1.5 system-ui;max-width:1000px;margin:32px auto;padding:0 24px;background:#f3f6fa;color:#172b3d}article{background:white;padding:22px;margin:20px 0;border-radius:12px}small{color:#526272}li{margin:7px 0}</style><h1>Card handoff review</h1><p><b>Active duplicate rule:</b> ${escape(packet.activeDuplicatePolicy.instructions[0])}</p><p>Identity → pricing evidence → draft → saved-field audit → seller price review in eBay → final publication handoff</p><p>Updated ${escape(packet.asOf)}. Local review only; nothing is upload-ready.</p>${packet.cards.map(c=>`<article><h2>${escape(c.identity.player)} · ${escape(c.identity.serial)}</h2><p>${escape(c.sku)} · ${escape(c.route)}${c.receipt?` · ${escape(c.receipt.itemId)}`:""}</p><p><b>Next: ${escape(c.nextOwner)}</b> — ${escape(c.nextAction)}</p><p>Draft asking price: ${escape(JSON.stringify(c.pricing.draftProposal))}<br>Calculated proposal: ${escape(JSON.stringify(c.pricing.validatedProposal))}<br>Pricing agent proposal: ${escape(JSON.stringify(c.pricing.agentProposal))}<br>Agent status: ${escape(c.pricing.agentStatus)} · ${c.pricing.approved?"Seller-set / previously approved":c.pricing.draftAuthorized?"Review price in eBay draft":"Pricing evidence required"} · ${escape(c.pricing.savedOnEbay)}</p><p>${escape(c.pricing.reason)}</p><ul>${c.blockers.map(b=>`<li>${escape(b)}</li>`).join("")}</ul><small>Text prepared: ${c.textPrepared?"yes":"no"}. Photos and individual serial remain attached to this card.</small></article>`).join("")}<p>${escape(packet.instruction)}</p></html>`;
}
