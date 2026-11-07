import { randomUUID } from "node:crypto";
import { z } from "zod";
import { existingReceipt, fingerprint, jobBlockers, reviewedIdentity, validDraftGroup, type CardRecord, type QueueState } from "./card-orchestrator.ts";
import { checkSavedDraft, draftExpectationSchema, draftCaptureSchema, parseSavedDraftAX } from "./card-saved-draft-check.ts";
import { CARD_POLICY } from "./card-orchestrator-policy.ts";
import { reportDraftBlockers } from "./card-report-evidence.ts";

export type DraftVerification = ReturnType<typeof checkSavedDraft> & { binding:string; identityKey:string; priceKey:string; evidence:string; expected:z.infer<typeof draftExpectationSchema> };
export type DraftLifecycle = {
  binding:string; draftId?:string; url?:string;
  state:"unknown"|"saved"|"absent"|"live"; observedAt:string; evidence:string;
  liveItemId?:string; operation?:{id:string;startedAt:string;binding:string;priceKey:string;draftId?:string};
  verification?:DraftVerification;
  unpricedVerification?:{binding:string;evidence:string;at:string;draftId:string;canPublish:false};
  failure?:{code:string;binding:string;evidenceKey:string;reason:string;at:string};
};
export type DraftWriter = {owner:string;configuredAt:string;evidence:string;scope:string[];archiveMode?:"copy-only"|"move";
  creationAuthority?:{evidence:string;bindings:Record<string,string>};
  lease?:{token:string;expiresAt:string};};
export type DraftLearning = {failures:number;lastAt:string;remedy:string;verifiedRecoveries:number};
/** Current evidence determines recovery; old generic learning text is retained for audit. */
export function draftRepairRemedy(check:{field:string;status:string},retained?:string){
  if(check.field.startsWith('issues.'))return check.status==='missing'
    ? 'Issue-summary evidence is missing, not proof of a listing defect. Inspect the exact saved draft issue summary and record errors plus evidence; never infer zero errors from absence or submit to test.'
    : 'Inspect recorded errors for this exact saved draft; a bulk workspace may contain unrelated rows. Correct only confirmed affected fields, save/reopen the same ID, and hold after one failed recovery. Never submit to test.';
  return retained??`Inspect saved ${check.field}`;
}
export type DraftPrice = {item:number;shipping:number|null};
// Draft authority is distinct from the seller having reviewed a particular price.
export type DraftContext = {approved:boolean;draftAuthorized?:boolean;price:DraftPrice|null;sellerHold?:string|null};
export const draftBinding=(c:CardRecord)=>fingerprint({sku:c.input.sku,identity:reviewedIdentity(c)??c.input.identity,
  originals:["front","back"].map(side=>c.input.photos.find(p=>p.side===side)?.sha256.toLowerCase())});
const priceAllowed=(c:DraftContext)=>c.approved||c.draftAuthorized===true;
const priceKey=(c:DraftContext)=>fingerprint(priceAllowed(c)?c.price:null);
export const unpricedDraftAllowed=(c:CardRecord)=>!!c.pricingDeferral&&c.pricingDeferral.identityKey===fingerprint(reviewedIdentity(c));
/** Preserve external research timing and evidence; never converts a timeout to a price. */
export function deferDraftPricing(s:QueueState,id:string,startedAt:string,evidence:string,now=new Date().toISOString(),sellerRequested=false) {
  const c=s.cards[id],elapsedMs=sellerRequested?0:Date.parse(now)-Date.parse(startedAt);
  if(!c||!reviewedIdentity(c)||!Number.isFinite(elapsedMs)||(!sellerRequested&&elapsedMs<30000)||evidence.trim().length<10)throw Error("Reviewed identity, elapsed 30-second research interval and evidence required");
  if(c.jobs.pricing.state==="leased")throw Error("Close the owned pricing lease before deferring external research");
  c.pricingDeferral={identityKey:fingerprint(reviewedIdentity(c)),at:now,evidence,elapsedMs,...(sellerRequested?{reason:"seller-request" as const}:{})};
  stamp(s,id,"pricing-deferred",JSON.stringify(c.pricingDeferral),now);return c.pricingDeferral;
}
/** An incomplete saved draft is a separate checkpoint, never a priced verification or archive receipt. */
export function verifyUnpricedDraft(s:QueueState,id:string,raw:unknown,context:DraftContext,evidence:string,now=new Date().toISOString()) {
  const c=s.cards[id],d=c?.draftLifecycle,capture=draftCaptureSchema.parse(raw),p=parseSavedDraftAX(capture.ax);
  if(!d?.draftId||!d.operation||!unpricedDraftAllowed(c)||context.price||context.sellerHold||evidence.trim().length<10)throw Error("Current unpriced intent and evidence required");
  const url=new URL(capture.url),draftId=url.searchParams.get("draftId")??url.searchParams.get("draft_id");
  const hashes=["front","back"].map(side=>c.input.photos.find(p=>p.side===side)!.sha256.toLowerCase());
  const group=Object.values(s.draftCreationGroups??{}).find(g=>g.draftId===d.draftId&&g.members.includes(id));
  const representative=group?.representativePhotos?s.cards[group.members[0]]:undefined;
  const visibleHashes=representative?['front','back'].map(side=>representative.input.photos.find(p=>p.side===side)!.sha256.toLowerCase()):hashes;
  const position=group&&!representative?group.members.indexOf(id)*2+1:1;
  if(group&&(group.price!==null||!validDraftGroup(s,d.draftId,group.members)||capture.visual?.frontPosition!==position||capture.visual?.backPosition!==position+1))throw Error("Unpriced group slots or bindings not verified");
  if(url.origin!=="https://www.ebay.com"||draftId!==d.draftId||!capture.ax.split(/\r?\n/)[0].includes(`URL: "${capture.url}"`)
    ||p.field("Custom label (SKU)")!==(group?.sku??c.input.sku)||p.field("Item price")!==""||p.photoCount!==(group&&!representative?group.members.length*2:2)
    ||p.field("Quantity")!==String(group?.members.length??1)||!p.field("Item title")
    ||Date.parse(capture.savedAt)<Date.parse(d.operation.startedAt)||Date.parse(capture.savedAt)>=Date.parse(capture.reopenedAt)
    ||Date.parse(capture.reopenedAt)>Date.parse(capture.capturedAt)||!fresh(capture.capturedAt,now)
    ||!capture.visual?.identityMatches||(!group&&(!capture.visual.frontMain||!capture.visual.backSecond))
    ||capture.visual.draftId!==d.draftId||fingerprint(capture.visual.originalHashes)!==fingerprint(visibleHashes)
    ||Date.parse(capture.visual.reviewedAt)<Date.parse(capture.reopenedAt)||Date.parse(capture.visual.reviewedAt)>Date.parse(now)
    ||d.operation.binding!==draftBinding(c))throw Error("Unpriced draft save/reopen, blank price, original photos or capture binding not verified");
  d.unpricedVerification={binding:draftBinding(c),draftId:d.draftId,at:now,evidence,canPublish:false};
  d.state="saved";d.observedAt=capture.capturedAt;delete d.operation;
  stamp(s,id,"unpriced-draft-verified",JSON.stringify(d.unpricedVerification),now);return {...d.unpricedVerification, photoIdentityVerified:true as const, captureHash:fingerprint(capture), identityKey:fingerprint(reviewedIdentity(c)), expected:{originalHashes:hashes},...(representative?{representativePhotoCardId:representative.input.id}:{})};
}
const stamp=(s:QueueState,id:string,event:string,detail:string,now:string)=>s.events.push({at:now,cardId:id,kind:"draft",event,detail});
const fresh=(at:string,now:string)=>Number.isFinite(Date.parse(at))&&Date.parse(at)<=Date.parse(now)&&Date.parse(now)-Date.parse(at)<=3600000;

/** Durable owner, bounded stabilization scope, no publication capability. */
export function configureDraftWriter(s:QueueState,owner:string,scope:string[],evidence:string,now=new Date().toISOString(),options:{allowCreate?:boolean;authority?:string;archiveMode?:"copy-only"|"move"}={}) {
  if(!owner.trim()||!evidence.trim()||!scope.length||scope.length>50||new Set(scope).size!==scope.length||scope.some(id=>!s.cards[id]))throw Error("Writer requires an owner, evidence and 1–50 exact existing cards");
  if(s.draftWriter?.lease&&Date.parse(s.draftWriter.lease.expiresAt)>Date.parse(now))throw Error("Release the active writer lease before changing its configuration");
  if((options.allowCreate||options.archiveMode==="move")&&(options.authority?.trim().length??0)<20)throw Error("Explicit seller authority required for new drafts or source moves");
  s.draftWriter={owner,configuredAt:now,evidence,scope,archiveMode:options.archiveMode??"copy-only",
    ...(options.allowCreate?{creationAuthority:{evidence:options.authority!,bindings:Object.fromEntries(scope.map(id=>[id,draftBinding(s.cards[id])]))}}:{})};
  // This asserts only the observed cutover. A local lease cannot fence human edits or unregistered clients.
  s.externalWriterPossible=false;stamp(s,"*","writer-configured",JSON.stringify({owner,scope,evidence,options}),now);
  return s.draftWriter;
}
export function claimDraftWriter(s:QueueState,owner:string,token?:string,now=new Date().toISOString()) {
  const w=s.draftWriter;if(!w||w.owner!==owner)throw Error("Only the configured listing writer can claim draft work");
  if(w.lease&&Date.parse(w.lease.expiresAt)>Date.parse(now)&&w.lease.token!==token)throw Error("Listing writer already leased; resume with its saved token");
  w.lease={token:token&&w.lease?.token===token?token:randomUUID(),expiresAt:new Date(Date.parse(now)+15*60000).toISOString()};
  return {...w,canPublish:false};
}
export function requireDraftWriter(s:QueueState,owner:string,token:string,id?:string,now=new Date().toISOString()) {
  const w=s.draftWriter;
  if(!w||w.owner!==owner||!w.lease||w.lease.token!==token||Date.parse(w.lease.expiresAt)<=Date.parse(now))throw Error("Missing, expired or fenced listing-writer lease");
  if(id&&!w.scope.includes(id))throw Error("Card is outside the current reliability batch");
  return w;
}
export function releaseDraftWriter(s:QueueState,owner:string,token:string,now=new Date().toISOString()) {
  const w=requireDraftWriter(s,owner,token,undefined,now);delete w.lease;
}

const observationSchema=z.object({observationId:z.string().uuid(),seller:z.literal("imaydit58"),cardId:z.string().min(1),sku:z.string().min(1),
  binding:z.string().regex(/^[a-f0-9]{64}$/),draftId:z.string().regex(/^\d+$/),state:z.enum(["unknown","saved","absent","live"]),
  url:z.string().url().optional(),liveItemId:z.string().regex(/^\d+$/).optional(),observedAt:z.iso.datetime(),evidence:z.string().min(10)}).strict();
/** Positive ID evidence is retained even for an unknown outcome or later absence. Never clears Add exclusions. */
export function observeDraft(s:QueueState,raw:unknown,now=new Date().toISOString()) {
  const o=observationSchema.parse(raw),key=fingerprint(o),prior=s.draftObservations?.[o.observationId];
  if(prior){if(prior!==key)throw Error("Observation ID already used for different evidence");return false;}
  const c=s.cards[o.cardId];if(s.seller!==o.seller||!c||c.input.sku!==o.sku||draftBinding(c)!==o.binding)throw Error("Draft capture/identity binding changed");
  if(!fresh(o.observedAt,now)&&o.state!=="unknown")throw Error("Current draft status requires a fresh observation");
  if(!Number.isFinite(Date.parse(o.observedAt))||Date.parse(o.observedAt)>Date.parse(now))throw Error("Invalid observation date");
  if(o.url){const u=new URL(o.url);if(u.origin!=="https://www.ebay.com"||![u.searchParams.get("draft_id"),u.searchParams.get("draftId")].includes(o.draftId))throw Error("Resume URL must identify this eBay draft");}
  if(o.state==="saved"&&!o.url)throw Error("Saved draft requires its observed resume URL");
  if(o.state==="live"&&!o.liveItemId)throw Error("Live status requires observed live item ID");
  const known=[c.input.knownDraft,c.draftLifecycle?.draftId,...(c.input.savedReceipts??[]).filter(r=>r.disposition==="draft").map(r=>r.itemId)].filter(Boolean);
  if(known.some(id=>id!==o.draftId))throw Error("Conflicting draft ID; retain existing mapping for reconciliation");
  const owners=Object.values(s.cards).filter(c=>[c.input.knownDraft,c.draftLifecycle?.draftId,...(c.input.savedReceipts??[]).map(r=>r.itemId)].includes(o.draftId));
  const creationGroup=Object.values(s.draftCreationGroups??{}).find(g=>g.draftId===o.draftId&&g.members.includes(o.cardId));
  const ownerIds=Array.from(new Set([...owners.map(x=>x.input.id),o.cardId]));
  if(owners.some(x=>x!==c)&&!validDraftGroup(s,o.draftId,ownerIds)
    &&!(creationGroup&&ownerIds.every(id=>creationGroup.members.includes(id))&&validDraftGroup(s,o.draftId,creationGroup.members)))throw Error("Draft ID belongs to another capture");
  if(c.draftLifecycle&&Date.parse(c.draftLifecycle.observedAt)>Date.parse(o.observedAt))throw Error("Observation predates the current draft state");
  if(c.draftLifecycle?.state==="live"&&o.state!=="live")throw Error("Cannot downgrade an observed live listing");
  if(o.liveItemId){
    const live=[c.input.knownLive?.itemId,c.exclusion?.disposition==="live"?c.exclusion.itemId:undefined].filter(Boolean);
    if(live.some(id=>id!==o.liveItemId)||Object.values(s.cards).some(x=>x!==c&&x.input.knownLive?.itemId===o.liveItemId&&!owners.includes(x)))throw Error("Conflicting live receipt");
    if(c.exclusion?.disposition==="sold")throw Error("Cannot downgrade sold inventory");
    c.input.knownLive={itemId:o.liveItemId,url:`https://www.ebay.com/itm/${o.liveItemId}`,observedAt:o.observedAt,source:o.evidence};
    c.exclusion={disposition:"live",itemId:o.liveItemId,evidence:o.evidence};
  }
  const previous=c.draftLifecycle;
  c.input.knownDraft=o.draftId;
  c.draftLifecycle={...previous,binding:o.binding,draftId:o.draftId,state:o.state,url:o.url??previous?.url,
    liveItemId:o.liveItemId,observedAt:o.observedAt,evidence:o.evidence};
  // A new inventory observation is not proof a pending write saved or fields passed.
  s.draftObservations??={};s.draftObservations[o.observationId]=key;
  stamp(s,o.cardId,"draft-observed",JSON.stringify(o),now);return true;
}

// Reports may reuse a lookup built from this refreshed snapshot. Writers use the live default.
export function draftNext(s:QueueState,id:string,context:DraftContext,now=new Date().toISOString(),
  blockersFor:(card:CardRecord,kind:"identity"|"listing",hold?:string)=>string[]=(card,kind,hold)=>jobBlockers(s,card,kind,hold)) {
  const c=s.cards[id];if(!c)throw Error("Unknown card");
  const d=c.draftLifecycle,receipt=existingReceipt(c),v=d?.verification;
  const verificationCurrent=!!v&&v.binding===draftBinding(c)&&v.priceKey===priceKey(context)&&!d?.operation;
  const result=(action:string,owner:string,blockers:string[]=[])=>({action,owner,blockers,draftId:d?.draftId??c.input.knownDraft??null,
    resumeUrl:d?.url??null,verification:v??null,verificationCurrent,
    repairFields:v?.checks.filter(x=>x.status!=="pass").map(x=>({...x,remedy:draftRepairRemedy(x,s.draftLearning?.[x.field]?.remedy)}))??[],
    canCreate:action==="create-draft-for-review",canPublish:false});
  if(context.sellerHold)return result("seller-hold","seller",[context.sellerHold]);
  if(receipt&&!["draft","unknown"].includes(receipt.disposition))return result("excluded-existing-inventory","reconciliation",[`${receipt.disposition}: ${receipt.itemId}`]);
  const pendingBulk=Object.values(s.bulkAiSubmissions??{}).find(b=>b.cardIds.includes(id)&&!b.results[id]);
  if(pendingBulk&&!d?.draftId&&!c.input.knownDraft&&!receipt)return result("reconcile-bulk-outcome","reconciliation",[`Bulk intent ${pendingBulk.id} has no confirmed ID for this capture. Reconcile the existing operation; never create through another upload or single-card path.`]);
  if(d?.binding&&d.binding!==draftBinding(c))return result("reconcile-changed-capture","reconciliation",["Originals or identity changed; prior draft evidence cannot transfer"]);
  const guards=[...(c.input.sourceHold?[c.input.sourceHold]:[]),...(c.input.identityIssue&&!reviewedIdentity(c)?[c.input.identityIssue]:[]),...blockersFor(c,"identity",context.sellerHold??undefined)];
  if(guards.length)return result("resolve-source-or-ownership","reconciliation",guards);
  if(d?.failure?.binding===draftBinding(c))return result("held-until-new-evidence","listing-writer",[d.failure.reason]);
  if(d?.operation)return result("reconcile-write-outcome","listing-writer",["Write intent is unfinished; reopen the same ID and verify before any edit"]);
  if(d?.state==="absent"||d?.state==="unknown")return result("reconcile-draft-status","reconciliation",["Retained draft ID is not confirmed saved; inspect active/sold/scheduled inventory. Never recreate"]);
  if(c.jobs.photos.state!=="done"||!reviewedIdentity(c))return result("finish-original-review","identity",["Current photo and identity reviews required"]);
  const unpriced=!context.price&&unpricedDraftAllowed(c);
  if(!unpriced&&(!priceAllowed(context)||!context.price||context.price.shipping===null))return result("resolve-pricing-evidence","pricing",["Pricing remains unresolved; after 30 seconds use the evidence-backed unpriced draft route"]);
  if(!s.draftWriter?.scope.includes(id))return result("outside-reliability-batch","listing-writer",["Finish the selected reliability batch before expansion"]);
  if(unpriced&&d?.unpricedVerification?.binding===draftBinding(c)&&d.state==="saved")return result("unpriced-draft-awaiting-seller-review","seller",["Saved without a price; not publication-ready"]);
  if(!d&&!receipt&&s.draftWriter.creationAuthority?.bindings[id]===draftBinding(c)){
    const reportMatches=reportDraftBlockers(s,id);
    if(reportMatches.length)return result("reconcile-report-match","reconciliation",reportMatches.map(m=>`${m.reportId}: ${m.reason}`));
    const j=c.jobs.reconcile,checked=Date.parse(String(j.result?.checkedAt));
    const clear=j.state==="done"&&j.result?.disposition==="clear"&&Array.isArray(j.result.scopes)&&new Set(j.result.scopes).size===4
      &&checked<=Date.parse(now)&&Date.parse(now)-checked<=CARD_POLICY.reconciliationMaxAgeMinutes*60000;
    const blockers=blockersFor(c,"listing",context.sellerHold??undefined);
    if(!clear||s.inventoryAccess?.available===false||blockers.length)return result("reconcile-before-create","reconciliation",[...blockers,"Fresh active/draft/scheduled/sold clearance required before first creation"]);
    if(c.jobs.listing.state!=="done")return result("prepare-draft-fields","listing-writer",["Prepare the complete draft packet first"]);
    return result("create-draft-for-review","listing-writer");
  }
  // Completion is a retained checkpoint, not a command to re-save every hour.
  // Fresh observations remain required before new edits. Changed inputs, holds,
  // an uncertain write, or later absence/live evidence take precedence above.
  if(verificationCurrent&&v!.allChecksPassed&&s.photoArchives?.[id]?.status==="moved")return result("draft-complete-awaiting-publication-handoff","seller",v!.expected?.general===false?["General promotion remains off; standing 3% promotion and final publication handoff are still separate. Never publish from this queue."]:[]);
  if(!d||!d.url||!fresh(d.observedAt,now))return result(receipt?"reconcile-saved-id":"reconcile-before-create","reconciliation",["Fresh saved-ID observation required; new creation remains disabled during stabilization"]);
  if(!verificationCurrent)return result("inspect-saved-draft","listing-writer",["Save/reopen evidence must match this capture and current draft price"]);
  if(!v)throw Error("Missing verification");
  const failed=v.checks.filter(x=>x.status!=="pass").map(x=>`${x.field}: ${x.status}`);
  if(failed.length)return result("repair-saved-draft","listing-writer",failed);
  if(s.photoArchives?.[id]?.status!=="moved")return result("verify-and-archive-originals","listing-writer",[s.photoArchiveFailures?.[id]?.reason??"Photo receipt and hash-verified Drafted archive required"]);
  return result("draft-complete-awaiting-publication-handoff","seller",v.expected?.general===false?["General promotion remains off; standing 3% promotion and final publication handoff are still separate. Never publish from this queue."]:[]);
}

/** Persist intent BEFORE any browser mutation. A crash always becomes reconciliation, never another Add. */
export function beginDraftWrite(s:QueueState,id:string,owner:string,token:string,context:DraftContext,now=new Date().toISOString()) {
  requireDraftWriter(s,owner,token,id,now);
  const next=draftNext(s,id,context,now),c=s.cards[id];
  if(!["create-draft-for-review","inspect-saved-draft","repair-saved-draft"].includes(next.action))throw Error(`Cannot edit: ${next.action}; ${next.blockers.join("; ")}`);
  const d=c.draftLifecycle??={binding:draftBinding(c),state:"unknown",observedAt:now,evidence:"First draft creation intent persisted before browser action; reconcile any uncertain outcome"};
  d.operation={id:randomUUID(),startedAt:now,binding:draftBinding(c),priceKey:priceKey(context),draftId:d.draftId};
  // Retain the previous failed checks so a subsequent verified repair can teach
  // the recovery record. The pending operation makes that snapshot unusable.
  stamp(s,id,"draft-write-started",JSON.stringify(d.operation),now);return {...d.operation,url:d.url,canPublish:false};
}

/** One explicit creation intent for distinct matching copies; never a fabricated saved receipt. */
export function beginDraftGroup(s:QueueState,groupId:string,members:string[],owner:string,token:string,contexts:Record<string,DraftContext>,evidence:string,now=new Date().toISOString(),representativePhotos=false) {
  if(!/^[a-z0-9-]+$/.test(groupId)||s.draftCreationGroups?.[groupId]||members.length<2||members.length>12||new Set(members).size!==members.length||evidence.trim().length<20)throw Error("New group requires a unique ID, 2–12 exact captures and evidence");
  const cards=members.map(id=>{requireDraftWriter(s,owner,token,id,now);return s.cards[id];});
  if(Object.values(s.draftCreationGroups??{}).some(g=>g.members.some(id=>members.includes(id))))throw Error("Capture already belongs to a creation group; resume its intent");
  const identities=cards.map(c=>reviewedIdentity(c));
  if(identities.some(i=>!i||i.serial||i.printRun||!i.language||i.autograph===null)||new Set(identities.map(i=>fingerprint({...i,colorMatch:undefined}))).size!==1)throw Error("Group requires fully reviewed matching unnumbered identities, language and condition");
  const fronts=cards.map(c=>c.input.photos.find(p=>p.side==="front")?.sha256.toLowerCase());
  if(fronts.some(h=>!h)||new Set(fronts).size!==members.length)throw Error("Group requires distinct original front captures");
  const price=contexts[members[0]]?.price;
  if((!price&&!members.every(id=>unpricedDraftAllowed(s.cards[id])))||price?.shipping===null||members.some(id=>fingerprint(contexts[id]?.price)!==fingerprint(price)))throw Error("Group copies require identical current draft prices");
  for(const id of members)if(draftNext(s,id,contexts[id],now).action!=="create-draft-for-review")throw Error(`Group member ${id} is not cleared for new creation`);
  if(representativePhotos&&price)throw Error("Representative grouped creation currently supports unpriced drafts only");
  // Validate every member on a clone before persisting any intent.
  const staged=structuredClone(s);
  for(const id of members)beginDraftWrite(staged,id,owner,token,contexts[id],now);
  for(const id of members)beginDraftWrite(s,id,owner,token,contexts[id],now);
  if(representativePhotos&&price)throw Error("Representative grouped creation currently supports unpriced drafts only");
  const group={...(representativePhotos?{representativePhotos:true}:{}),id:groupId,members:[...members],sku:cards[0].input.sku,bindings:Object.fromEntries(cards.map(c=>[c.input.id,draftBinding(c)])),price:price?{item:price.item,shipping:price.shipping!}:null,evidence,createdAt:now};
  s.draftCreationGroups??={};s.draftCreationGroups[groupId]=group;
  stamp(s,members[0],"quantity-draft-intent",JSON.stringify(group),now);
  return {...group,quantity:members.length,photoOrder:(representativePhotos?cards.slice(0,1):cards).flatMap(c=>["front","back"].map(side=>({cardId:c.input.id,...c.input.photos.find(p=>p.side===side)!}))),canPublish:false};
}

/** Bind all members atomically to the actual browser-generated ID before uploading. */
export function observeDraftGroup(s:QueueState,groupId:string,raw:unknown,owner:string,token:string,now=new Date().toISOString()) {
  const g=s.draftCreationGroups?.[groupId];if(!g)throw Error("Unknown creation group");
  const o=z.object({draftId:z.string().regex(/^\d+$/),url:z.string().url(),observedAt:z.iso.datetime(),evidence:z.string().min(10)}).strict().parse(raw);
  for(const id of g.members)requireDraftWriter(s,owner,token,id,now);
  if(g.draftId&&g.draftId!==o.draftId)throw Error("Group already has a draft ID; never recreate");
  if(Object.values(s.cards).some(c=>!g.members.includes(c.input.id)&&[c.input.knownDraft,c.draftLifecycle?.draftId,...(c.input.savedReceipts??[]).map(r=>r.itemId)].includes(o.draftId)))throw Error("Draft belongs to another capture");
  const staged=structuredClone(s);staged.draftCreationGroups![groupId].draftId=o.draftId;
  if(!validDraftGroup(staged,o.draftId,g.members))throw Error("Group binding or identity changed");
  const observations=g.members.map(id=>({...o,observationId:randomUUID(),seller:"imaydit58",cardId:id,sku:s.cards[id].input.sku,binding:g.bindings[id],state:"unknown"}));
  for(const observation of observations)observeDraft(staged,observation,now);
  g.draftId=o.draftId;
  for(const observation of observations)observeDraft(s,observation,now);
  return {groupId,draftId:g.draftId,members:g.members,canPublish:false};
}

/** Recompute evidence, never import allChecksPassed from an agent-written report. */
export function verifyDraft(s:QueueState,id:string,expected:unknown,capture:z.infer<typeof draftCaptureSchema>,context:DraftContext,evidence:string,now=new Date().toISOString()) {
  const c=s.cards[id],d=c?.draftLifecycle,e=draftExpectationSchema.parse(expected);
  const group=Object.values(s.draftCreationGroups??{}).find(g=>g.draftId===e.draftId&&g.members.includes(id));
  if(!d||d.draftId!==e.draftId||(group?.sku??c.input.sku)!==e.sku||d.binding!==draftBinding(c))throw Error("Verification must match a reconciled draft and current capture");
  if(group){const position=group.members.indexOf(id)*2+1;
    if(!group.price||!validDraftGroup(s,e.draftId,group.members)||e.photoLayout?.count!==group.members.length*2||e.photoLayout.frontPosition!==position||e.photoLayout.backPosition!==position+1||e.item!==group.price.item||e.shipping!==group.price.shipping)throw Error("Group photo slots, bindings or shared price changed");
  }else if(e.photoLayout)throw Error("Grouped photo layout requires a declared creation group");
  const hashes=["front","back"].map(side=>c.input.photos.find(p=>p.side===side)?.sha256.toLowerCase());
  if(fingerprint(e.originalHashes)!==fingerprint(hashes))throw Error("Verification original pair mismatch");
  const owners=Object.values(s.cards).filter(x=>x.input.knownDraft===e.draftId||(x.input.savedReceipts??[]).some(r=>r.disposition==="draft"&&r.itemId===e.draftId));
  if(e.quantity!==owners.length||(owners.length>1&&!validDraftGroup(s,e.draftId,owners.map(c=>c.input.id))))throw Error("Saved quantity must equal the validated distinct capture group; no stock increments on retry");
  if(context.sellerHold||!priceAllowed(context)||!context.price||e.item!==context.price.item||e.shipping!==context.price.shipping)throw Error("Saved expectation must use the current authorized draft price and shipping");
  if(d.operation&&(d.operation.binding!==draftBinding(c)||d.operation.priceKey!==priceKey(context)||Date.parse(capture.savedAt)<Date.parse(d.operation.startedAt)))throw Error("Write changed or evidence predates its intent; reconcile current saved state");
  if(!evidence.trim())throw Error("Evidence location required");
  const v={...checkSavedDraft(e,capture,Date.parse(now)),binding:draftBinding(c),identityKey:fingerprint(reviewedIdentity(c)??c.input.identity),priceKey:priceKey(context),evidence,expected:e};
  const previous=d.verification;
  if(previous?.identityKey&&previous.captureHash===v.captureHash&&previous.expectationHash===v.expectationHash&&previous.binding===v.binding&&previous.priceKey===v.priceKey)return previous;
  d.verification=v;
  // Only the same-ID saved/reopened snapshot closes an uncertain operation, even when fields still need repair.
  if(v.checks.filter(x=>["draftId","snapshotURL","save/reopen/freshness","sku"].includes(x.field)).every(x=>x.status==="pass")){
    delete d.operation;d.state="saved";d.observedAt=capture.capturedAt;
  }
  for(const check of v.checks.filter(x=>x.status!=="pass")){
    s.draftLearning??={};const rule=s.draftLearning[check.field]??={failures:0,lastAt:now,remedy:check.field.startsWith("issues.")?"Inspect the issue summary for these exact draft IDs. A prior bulk workspace may contain other rows; never submit to test. Hold after one failed recovery.":check.field.startsWith("offers")||["minimumOffer","autoAccept"].includes(check.field)?"Apply standing offer rule: off at $1.49; otherwise $1.49 <= minimum <= auto accept < item price. Save/reopen the same ID.":`Inspect and correct saved ${check.field} against the retained expectation; save, reopen and verify the same draft`,verifiedRecoveries:0};
    if(previous?.captureHash!==v.captureHash)rule.failures++;rule.lastAt=now;
  }
  if(previous&&previous.captureHash!==v.captureHash)for(const old of previous.checks.filter(x=>x.status!=="pass")){
    if(v.checks.some(x=>x.field===old.field&&x.status==="pass")&&s.draftLearning?.[old.field])s.draftLearning[old.field].verifiedRecoveries++;
  }
  stamp(s,id,"draft-checked",JSON.stringify({evidence,captureHash:v.captureHash,passed:v.allChecksPassed,failed:v.checks.filter(x=>x.status!=="pass").map(x=>x.field)}),now);
  return v;
}
export function holdDraft(s:QueueState,id:string,owner:string,token:string,reason:string,evidence:string,now=new Date().toISOString()) {
  requireDraftWriter(s,owner,token,id,now);const d=s.cards[id]?.draftLifecycle;
  if(!d||reason.trim().length<10||evidence.trim().length<10)throw Error("Draft and concrete failure evidence required");
  d.failure={code:"browser-recovery-exhausted",binding:draftBinding(s.cards[id]),evidenceKey:fingerprint(evidence),reason,at:now};
  stamp(s,id,"draft-held",JSON.stringify(d.failure),now);
}
export function recoverDraft(s:QueueState,id:string,evidence:string,now=new Date().toISOString()) {
  const d=s.cards[id]?.draftLifecycle;if(!d?.failure)throw Error("No draft failure to recover");
  if(evidence.trim().length<10||fingerprint(evidence)===d.failure.evidenceKey)throw Error("New successful access or corrected input evidence required; unchanged holds cannot retry");
  stamp(s,id,"draft-recovery",JSON.stringify({previous:d.failure,evidence}),now);delete d.failure;
}
