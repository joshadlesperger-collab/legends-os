import { CARD_POLICY_VERSION } from "./card-orchestrator-policy.ts";
import { existingReceipt, fingerprint, jobBlockers, matchKey, refreshJobs, reviewedIdentity, validateComps, type QueueState } from "./card-orchestrator.ts";

/** A review packet is not permission to write to eBay. */
export function pricingContext(state:QueueState,id:string,now=new Date().toISOString()) {
  const card=state.cards[id];if(!card)throw new Error(`Unknown card: ${id}`);
  refreshJobs(card,now);
  const identity=reviewedIdentity(card)??card.input.identity;
  const related=Object.values(state.cards).filter(other=>other.input.id!==id&&matchKey(reviewedIdentity(other)??other.input.identity)===matchKey(identity));
  const reusable=related.flatMap(other=>{
    refreshJobs(other,now);
    const result=other.jobs.pricing.result;
    if(other.jobs.pricing.state!=="done"||!result)return [];
    try {
      // Re-check each target's physical serial: another copy's comp may be THIS copy's acquisition.
      validateComps(identity,result.comps,now,result.basis as "exact"|"related-print-run"|undefined);
      return [{cardId:other.input.id,comps:result.comps,basis:result.basis,evidence:result.evidence,exactSearchEvidence:result.exactSearchEvidence}];
    } catch {return [];}
  });
  return {cardId:id,researchGroup:matchKey(identity),handoff:card.input.pricingHandoff??null,
    savedCandidates:card.input.candidates,retainedPricingEvidence:card.pricingHistory??[],completedPricing:card.jobs.pricing.state==="done"?card.jobs.pricing.result:null,
    reusableEvidence:reusable,relatedHolds:related.filter(c=>c.jobs.pricing.state==="held").map(c=>({cardId:c.input.id,reason:c.jobs.pricing.reason})),
    instruction:"Read saved handoff and evidence first. Reuse validated evidence through claim/complete; confirm language/condition and exclude this physical copy. Do not repeat unchanged holds or restart completed research. Never copy another card's final price or override."};
}

export type AskingPriceApproval={cardId:string;item:number;shipping:number|null;sourceUpdatedAt:string;policyVersion:string;photoHashes:string[];approvedAt:string;sourceIdentityKey:string};
export function flowPacket(state:QueueState,ids:string[],now=new Date().toISOString(),approvals:AskingPriceApproval[]=[]) {
  if(!ids.length||ids.length>50||new Set(ids).size!==ids.length)throw new Error("Select 1–50 distinct card IDs");
  const cards=ids.map(id=>{
    const c=state.cards[id];if(!c)throw new Error(`Unknown card: ${id}`);
    refreshJobs(c,now);
    const receipt=existingReceipt(c),identity=reviewedIdentity(c),handoff=c.input.pricingHandoff;
    const blockedBy=jobBlockers(state,c,"pricing");
    const proposal=c.jobs.pricing.state==="done"?c.jobs.pricing.result?.projection:null;
    const sourceProposal=handoff?.matchesOriginals&&handoff.item!==null?{item:handoff.item,shipping:handoff.shipping}:null;
    const age=handoff?Date.parse(now)-Date.parse(handoff.updatedAt):NaN;
    const sourceFresh=Number.isFinite(age)&&age>=0&&age<=90*86400000;
    const sourcePolicyCurrent=handoff?.policyVersion===CARD_POLICY_VERSION||handoff?.policyVersion==="item-only-9pct-49-95-under3-exact149-free";
    const approval=sourceProposal&&sourceFresh&&sourcePolicyCurrent&&!identity?.printRun&&!c.input.identity.printRun&&!c.input.override?approvals.find(a=>a.cardId===id&&a.item===sourceProposal.item&&a.shipping===sourceProposal.shipping&&a.sourceUpdatedAt===handoff?.updatedAt&&a.policyVersion===handoff?.policyVersion&&a.sourceIdentityKey===fingerprint(c.input.identity)&&fingerprint([...a.photoHashes].sort())===fingerprint(c.input.photos.map(p=>p.sha256).sort())&&Number.isFinite(Date.parse(a.approvedAt))&&Date.parse(a.approvedAt)<=Date.parse(now)):undefined;
    let nextOwner="pricing",nextAction="Read pricing context and resolve only the missing evidence";
    if(receipt&&receipt.disposition!=="draft") {nextOwner="reconciliation";nextAction="Existing live/scheduled/sold or ambiguous record: exclude from Add";}
    else if(blockedBy.some(reason=>/conflict|also belongs|Same original/i.test(reason))) {nextOwner="reconciliation";nextAction="Resolve the recorded identity/receipt conflict; no new draft";}
    else if(c.jobs.photos.state!=="done"||!identity) {nextOwner="identity";nextAction="Finish original-photo and identity review";}
    else if(c.jobs.pricing.state==="leased") {nextOwner=c.jobs.pricing.lease!.owner;nextAction="Pricing is claimed; wait for its result, do not duplicate research";}
    else if(approval) {nextOwner="listing-review";nextAction="Use the seller-approved pricing-agent asking price; finish inventory, shipping and listing accuracy checks";}
    else if(proposal) {nextOwner="seller-review";nextAction="Review the calculated price and shipping before listing work";}
    else if(sourceProposal) {nextOwner="pricing-review";nextAction="Review the existing pricing-agent proposal and its specific evidence gaps; do not start from scratch";}
    else if(c.jobs.pricing.state==="held"||handoff?.status.startsWith("held")) {nextOwner="pricing";nextAction="Retain the hold; retry only with new evidence";}
    const blockers=[...blockedBy];
    if(!proposal) blockers.push(sourceProposal?"Pricing-agent proposal has not passed evidence validation":"No validated price");
    if(handoff&&!sourceFresh)blockers.push("Pricing handoff date is missing, future or older than 90 days");
    if(sourceProposal&&c.input.identity.printRun)blockers.push("Numbered source proposal requires current scarcity validation; historical approval cannot bypass it");
    if(sourceProposal&&!sourcePolicyCurrent)blockers.push("Source proposal policy needs reconciliation");
    blockers.push(approval?"Asking price approved; shipping/policy checks remain required":"Price approval and shipping/policy checks are not recorded by this local queue","Final save/reopen audit and publication handoff remain required");
    return {id,sku:c.input.sku,identity:identity??c.input.identity,originals:c.input.photos,
      receipt,route:receipt?.disposition==="draft"?"resume-existing-draft":receipt?"excluded":"prepare-new-only-after-reconciliation",
      nextOwner,nextAction,pricing:{validatedProposal:proposal??null,agentProposal:sourceProposal,agentStatus:handoff?.status??null,
        reason:handoff?.reason??c.jobs.pricing.reason??null,sourceUpdatedAt:handoff?.updatedAt??null,sourceFresh,sourcePolicyCurrent,
        savedOnEbay:"not verified by this packet",approved:!!approval,approvedAt:approval?.approvedAt??null,approvedProposal:approval?sourceProposal:null},
      textPrepared:c.jobs.listing.state==="done",blockers:Array.from(new Set(blockers)),
      canUpload:false,canPublish:false};
  });
  return {asOf:now,policyVersion:CARD_POLICY_VERSION,mode:"local-preparation-only",snapshot:fingerprint(cards),
    externalWriterPossible:state.externalWriterPossible,canUpload:false,canPublish:false,cards,
    instruction:"Refresh this packet immediately before listing work. Text prepared, price proposed, price approved and saved on eBay are separate milestones. Never use a cached packet to authorize an external write."};
}

const escape=(value:unknown)=>String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
export function flowHtml(packet:ReturnType<typeof flowPacket>) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Card handoff review</title><style>body{font:16px/1.5 system-ui;max-width:1000px;margin:32px auto;padding:0 24px;background:#f3f6fa;color:#172b3d}article{background:white;padding:22px;margin:20px 0;border-radius:12px}small{color:#526272}li{margin:7px 0}</style><h1>Card handoff review</h1><p>Identity → pricing evidence → price review → listing → saved-field audit → final publication handoff</p><p>Updated ${escape(packet.asOf)}. Local review only; nothing is upload-ready.</p>${packet.cards.map(c=>`<article><h2>${escape(c.identity.player)} · ${escape(c.identity.serial)}</h2><p>${escape(c.sku)} · ${escape(c.route)}${c.receipt?` · ${escape(c.receipt.itemId)}`:""}</p><p><b>Next: ${escape(c.nextOwner)}</b> — ${escape(c.nextAction)}</p><p>Calculated proposal: ${escape(JSON.stringify(c.pricing.validatedProposal))}<br>Pricing agent proposal: ${escape(JSON.stringify(c.pricing.agentProposal))}<br>Agent status: ${escape(c.pricing.agentStatus)} · ${c.pricing.approved?"Seller-approved asking price":"Unapproved"} · eBay price not verified</p><p>${escape(c.pricing.reason)}</p><ul>${c.blockers.map(b=>`<li>${escape(b)}</li>`).join("")}</ul><small>Text prepared: ${c.textPrepared?"yes":"no"}. Photos and individual serial remain attached to this card.</small></article>`).join("")}<p>${escape(packet.instruction)}</p></html>`;
}
