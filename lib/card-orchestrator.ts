import { ownedCardCondition } from "./card-condition-default.ts";
import { createHash, randomUUID } from "node:crypto";
import type { DraftLifecycle, DraftWriter, DraftLearning } from "./card-draft-lifecycle.ts";
import { z } from "zod";
import { draftFields } from "./card-draft-fields.ts";
import { CARD_POLICY, CARD_POLICY_VERSION, CARD_EVIDENCE_VERSION, calculateCardPrice, cardPremiumReasons, premiumCompAdjustment, conditionCompAdjustment, money } from "./card-orchestrator-policy.ts";

export const kinds = ["photos", "identity", "reconcile", "pricing", "listing"] as const;
export type JobKind = typeof kinds[number];
export class JobCompletionConflict extends Error {}
export type Photo = { side: "front" | "back"; path: string; sha256: string };
const text = z.string().trim().min(1).max(500);
const identitySchema = z.object({
  player: text, season: text, set: text, manufacturer: text, cardNumber: text,
  sport: text, team: z.string().max(200), parallel: text, serial: z.string().max(50),
  printRun: z.number().int().positive().nullable(), condition: z.enum(["Near mint or better", "Excellent", "Very good", "Poor", "Not specified"]),
  autograph: z.boolean().nullable(), patch: z.boolean(),
  language: text.optional(), artwork: text.optional(), conditionType: text.optional(),
  colorMatch: z.object({ matches: z.boolean(), evidence: text }).strict().optional(),
}).strict();
export type Identity = z.infer<typeof identitySchema>;
// Intake may retain unknown text, but only the strict schema can complete identity review.
const intakeText = z.string().trim().max(500);
const intakeIdentitySchema = identitySchema.extend({player:intakeText,season:intakeText,set:intakeText,
  manufacturer:intakeText,cardNumber:intakeText,sport:intakeText,parallel:intakeText});
export function hasCompleteIdentity(identity: Identity) {
  if(!identitySchema.safeParse(identity).success)return false;
  if(!identity.serial&&!identity.printRun)return true;
  const serial=/^(\d+)\/(\d+)$/.exec(identity.serial);
  return !!(serial&&identity.printRun&&Number(serial[2])===identity.printRun&&Number(serial[1])>=1&&Number(serial[1])<=identity.printRun);
}
const recoverySchema = z.object({when:z.enum(["pricing-ready","inventory-access"])}).strict();
type HoldRecovery = {when:"pricing-ready"|"inventory-access"|"clearance-expired"; observedAccess?:string; blockedAt?:string};
export type PricingHandoff = {
  status: string; item: number | null; shipping: number | null; updatedAt: string;
  policyVersion: string; reason: string; source: string; matchesOriginals: boolean;
  needsReview: true;
};
export type CardInput = { id: string; sku: string; identity: Identity; photos: Photo[];
  candidates: unknown[]; override?: { item: number; shipping: number; evidence: string };
  pricingHandoff?: PricingHandoff;
  source: string; sourceHold?: string; identityIssue?: string;
  knownLive?: { itemId: string; url: string; observedAt: string; source: string };
  knownDraft?: string;
  savedReceipts?: {disposition:"live"|"draft";itemId:string;source:string;listingQuantity?:number;captureQuantity?:number}[];
};
type JobResult = Record<string, unknown>;
export type Job = { kind: JobKind; inputKey: string; state: "todo" | "leased" | "done" | "held";
  attempts: number; elapsedMs: number; reason?: string; result?: JobResult;
  /** Reconciliation retains lifetime attempts but budgets retries since its last successful clearance. */
  attemptsSinceClearance?: number;
  recovery?: HoldRecovery;
  lease?: { token: string; owner: string; startedAt: string; expiresAt: string } };
export type CardRecord = { input: CardInput; createdAt: string; updatedAt: string; jobs: Record<JobKind, Job>;
  pricingDeferral?: {identityKey:string;at:string;evidence:string;elapsedMs:number;reason?:"seller-request"};
  identityReviewHistory?: {at:string;evidence:string;snapshot:string;jobs:Record<JobKind,Job>;draftLifecycle?:DraftLifecycle;pricingDeferral?:CardRecord["pricingDeferral"];pricingEvidence?:CardRecord["pricingEvidence"]}[];
  identityCorrectionHolds?: Partial<Record<JobKind,{reason?:string;attempts:number;elapsedMs:number}>>;
  draftLifecycle?: DraftLifecycle;
  pricingEvidence?: { key: string; identityKey: string; comps: CompEvidence[]; basis: CompBasis; evidence: string; exactSearchEvidence?: string; at: string };
  pricingEvidenceHistory?: { key: string; previousJob: Job }[];
  exclusion?: { disposition: string; itemId: string; evidence: string } };
export type QueueState = {
  /** Active ownership fence after exact evidenced V2 transfer. Legacy records
   * may remain as immutable history; all old claims/imports must stay fenced. */
  v2OwnershipTransfers?: Record<string, { resetId: string; owner: "card-processing-v2"; receipt: string; photoHashes: string[];
    retiredAt: string; released: true; hardHolds: string[]; positiveDispositions: string[] }>;
  draftModelWorkflows?: Record<string, import('./draft-model-workflow.ts').DraftModelWorkflow>;
  draftModelWorkflowHistory?: import('./draft-model-workflow.ts').DraftModelWorkflow[];
  draftModelBudget?: import('./draft-model-runner.ts').DraftModelBudget;
  baxterReviewConnection?: {identity:string;resultSource:string;verifiedAt:string;evidence:string};
  schemaVersion: 1; revision: number; policyVersion: string; seller: string;
  bulkAiSubmissions?: Record<string, import('./card-bulk-ai.ts').BulkAiSubmission>;
  draftCreationGroups?: Record<string,{representativePhotos?:boolean;id:string;members:string[];sku:string;bindings:Record<string,string>;price:{item:number;shipping:number}|null;evidence:string;createdAt:string;draftId?:string}>;
  draftWriter?: DraftWriter;
  draftObservations?: Record<string,string>;
  draftLearning?: Record<string,DraftLearning>;
  knownInventoryObservations?: Record<string, KnownInventoryObservation>;
  soldDraftGroups?: Record<string, SoldDraftGroup>;
  verifiedReceipts?: Record<string, VerifiedReceipt>;
  draftGroupRecoveries?: Record<string, import("./card-group-recovery.ts").GroupRecovery>;
  draftAppends?: Record<string, import("./card-draft-append.ts").DraftAppend>;
  draftConsolidations?: Record<string, import("./card-draft-consolidation.ts").DraftConsolidation>;
  quantityReceiptGroups?: Record<string, QuantityReceiptGroup>;
  draftArchiveAuthority?: {evidence:string;at:string};
  photoArchives?: Record<string,{soldItemId?:string;liveItemId?:string;draftId?:string;captureId:string;manifestPath:string;archiveRoot:string;status:"copied"|"moved";files:{side:string;source:string;originalSource?:string;destination:string;sha256:string}[]}>;
  photoArchiveFailures?: Record<string,{at:string;reason:string}>;
  mode: "local-preparation-only"; externalWriterPossible: boolean; cards: Record<string, CardRecord>;
  rejectedImports?: Record<string, { inputKey: string; reason: string; sku?:string; player?:string }>;
  inventoryAccess?: { observationId:string; available:boolean; evidence:string; at:string };
  inventoryAccessObservations?: Record<string,string>;
  events: { at: string; cardId: string; kind: string; event: string; detail: string }[] };

export const fingerprint = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const knownInventorySchema=z.object({observationId:z.string().uuid(),seller:z.literal("imaydit58"),cardId:text,sku:text,
  identityKey:z.string().regex(/^[a-f0-9]{64}$/),photoKey:z.string().regex(/^[a-f0-9]{64}$/),itemId:z.string().regex(/^\d+$/),
  disposition:z.enum(["live","sold"]),observedAt:z.string().datetime(),source:text,evidence:z.string().min(10).max(4000)}).strict();
type KnownInventoryObservation=z.infer<typeof knownInventorySchema>;
const soldDraftGroupSchema=z.object({observationId:z.string().uuid(),seller:z.literal("imaydit58"),
  draftId:z.string().regex(/^\d+$/),itemId:z.string().regex(/^\d+$/),soldQuantity:z.number().int().min(2),
  observedAt:z.string().datetime(),source:text,evidence:z.string().min(10).max(4000),
  members:z.array(z.object({cardId:text,sku:text,identityKey:z.string().regex(/^[a-f0-9]{64}$/),photoKey:z.string().regex(/^[a-f0-9]{64}$/)}).strict()).min(2)}).strict();
type SoldDraftGroup=z.infer<typeof soldDraftGroupSchema>;
/** A fully sold quantity draft retires every bound capture atomically; never relists or adjusts stock. */
export function recordSoldDraftGroup(s:QueueState,raw:unknown,now=new Date().toISOString()) {
  const v=soldDraftGroupSchema.parse(raw),prior=s.soldDraftGroups?.[v.observationId];
  if(prior){if(fingerprint(prior)!==fingerprint(v))throw Error("Observation ID already belongs to different evidence");return false;}
  const ids=v.members.map(m=>m.cardId);
  if(s.seller!==v.seller||Date.parse(v.observedAt)>Date.parse(now)||Date.parse(now)-Date.parse(v.observedAt)>3600000)throw Error("Observation must be fresh and seller-bound");
  if(new Set(ids).size!==ids.length||v.soldQuantity!==ids.length||!validDraftGroup(s,v.draftId,ids))throw Error("Complete declared draft group required");
  const owners=Object.values(s.cards).filter(c=>[c.input.knownDraft,c.exclusion?.itemId,c.input.knownLive?.itemId,...(c.input.savedReceipts??[]).map(r=>r.itemId)].some(id=>id===v.draftId||id===v.itemId));
  if(owners.some(c=>!ids.includes(c.input.id)))throw Error("Receipt has another capture owner");
  for(const m of v.members){const c=s.cards[m.cardId],i=reviewedIdentity(c);if(!i||c.jobs.photos.state!=="done"||c.input.sku!==m.sku||fingerprint(i)!==m.identityKey||fingerprint(c.input.photos)!==m.photoKey)throw Error("Group identity or original pair changed");}
  s.soldDraftGroups??={};s.soldDraftGroups[v.observationId]=v;
  for(const id of ids){s.cards[id].exclusion={disposition:"sold",itemId:v.itemId,evidence:`Draft ${v.draftId} resolved to sold quantity ${v.soldQuantity}. ${v.source}; ${v.evidence}`};event(s,id,"reconcile","sold-draft-group-observed",v.observationId,now);}
  return true;
}
function verifiedSoldGroup(s:QueueState,itemId:string,owners:readonly string[]) {
  return Object.values(s.soldDraftGroups??{}).some(v=>(v.itemId===itemId||v.draftId===itemId)&&v.members.length===owners.length&&v.members.every(m=>{
    const c=s.cards[m.cardId];return owners.includes(m.cardId)&&c?.exclusion?.disposition==="sold"&&c.exclusion.itemId===v.itemId&&c.input.sku===m.sku&&fingerprint(reviewedIdentity(c))===m.identityKey&&fingerprint(c.input.photos)===m.photoKey;
  }));
}
/** Refresh a known positive receipt only. No new ownership, clearance, job completion or external writes. */
export function recordKnownInventoryObservation(s:QueueState,raw:unknown,now=new Date().toISOString()) {
  const v=knownInventorySchema.parse(raw),prior=s.knownInventoryObservations?.[v.observationId];
  if(prior){if(fingerprint(prior)!==fingerprint(v))throw Error("Observation ID already belongs to different evidence");return false;}
  const c=s.cards[v.cardId],identity=c&&reviewedIdentity(c);
  if(s.seller!==v.seller||Date.parse(v.observedAt)>Date.parse(now)||Date.parse(now)-Date.parse(v.observedAt)>3600000)throw Error("Observation must be fresh and seller-bound");
  if(!c||!identity||c.input.sku!==v.sku||fingerprint(identity)!==v.identityKey||fingerprint(c.input.photos)!==v.photoKey)throw Error("Inventory identity or original pair changed");
  if(![c.input.knownLive?.itemId,c.exclusion?.itemId,...(c.input.savedReceipts??[]).filter(r=>r.disposition==="live").map(r=>r.itemId)].includes(v.itemId))throw Error("Only an existing positive live receipt can be refreshed");
  const previousExclusion=c.exclusion;
  // A fresh observation of this card's already-bound live receipt may supersede
  // an obsolete draft exclusion. Never clear an input/manifest ownership conflict.
  if(receiptOwnershipConflicts(s).some(r=>r.cardIds.includes(v.cardId))) {
    if(previousExclusion?.disposition!=="draft"||c.input.knownLive?.itemId!==v.itemId)throw Error("Receipt ownership conflict");
    c.exclusion={disposition:v.disposition,itemId:v.itemId,evidence:v.evidence};
    const remaining=receiptOwnershipConflicts(s).some(r=>r.cardIds.includes(v.cardId));
    c.exclusion=previousExclusion;
    if(remaining)throw Error("Receipt ownership conflict");
  }
  if(v.disposition==="live"&&(c.exclusion?.disposition==="sold"||c.jobs.reconcile.result?.disposition==="sold"))throw Error("Cannot downgrade sold inventory");
  c.exclusion={disposition:v.disposition,itemId:v.itemId,evidence:`Observed ${v.observedAt}: ${v.source}; ${v.evidence}`};
  s.knownInventoryObservations??={};s.knownInventoryObservations[v.observationId]=v;
  if(previousExclusion&&previousExclusion.itemId!==v.itemId)event(s,v.cardId,"reconcile","obsolete-draft-exclusion-superseded",JSON.stringify({observationId:v.observationId,previousExclusion}),now);
  event(s,v.cardId,"reconcile","known-inventory-observed",v.observationId,now);return true;
}
const verifiedReceiptSchema=z.object({
  observationId:z.string().uuid(),seller:z.literal("imaydit58"),cardId:text,sku:text,
  frontHash:z.string().regex(/^[a-f0-9]{64}$/),backHash:z.string().regex(/^[a-f0-9]{64}$/),
  identityKey:z.string().regex(/^[a-f0-9]{64}$/),draftId:z.string().regex(/^\d+$/).optional(),
  quantityGroupId:z.string().uuid().optional(),
  quantityUpdate:z.object({existingCardId:text,listingIdentity:identitySchema,listingSku:text,before:z.number().int().nonnegative(),after:z.number().int().positive(),evidence:text}).strict().optional(),
  liveItemId:z.string().regex(/^\d+$/).optional(),observedAt:z.string().datetime(),
  representativePhotoCardId:z.string().optional(),photosVerified:z.literal(true),source:text,evidence:z.string().trim().min(10).max(4000),
}).strict();
export type VerifiedReceipt=z.infer<typeof verifiedReceiptSchema>;
/** Positive receipt feedback only; call under the queue lock. Never grants clearance or approval. */
export function recordVerifiedReceipt(s:QueueState,raw:unknown,now=new Date().toISOString()) {
  const value=verifiedReceiptSchema.parse(raw);
  if(s.seller!==value.seller||Date.parse(value.observedAt)>Date.parse(now))throw new Error("Receipt account or observation date is invalid");
  const prior=s.verifiedReceipts?.[value.observationId];
  if(prior) {if(fingerprint(prior)!==fingerprint(value))throw new Error("Observation ID already belongs to different evidence");return false;}
  const card=s.cards[value.cardId];
  if(!card||card.input.sku!==value.sku||card.input.photos.find(p=>p.side==="front")?.sha256.toLowerCase()!==value.frontHash
    ||card.input.photos.find(p=>p.side==="back")?.sha256.toLowerCase()!==value.backHash
    ||fingerprint(reviewedIdentity(card)??card.input.identity)!==value.identityKey)throw new Error("Receipt identity or original photo pair changed; review current evidence");
  const identity=reviewedIdentity(card);
  if(!identity||!hasCompleteIdentity(identity)||card.jobs.photos.state!=="done"||card.jobs.photos.inputKey!==jobInputKey(card,"photos")||card.jobs.identity.inputKey!==jobInputKey(card,"identity"))throw new Error("Complete current original-photo and identity review before adopting a receipt");
  const receipts=(c:CardRecord)=>[c.input.knownDraft,c.input.knownLive?.itemId,c.exclusion?.itemId,...(c.input.savedReceipts??[]).map(r=>r.itemId)];
  const group=value.quantityGroupId?s.quantityReceiptGroups?.[value.quantityGroupId]:undefined;
  if(value.quantityGroupId&&(!group||value.quantityUpdate||value.draftId||value.liveItemId!==group.liveItemId||value.source!==group.source||!group.members.some(m=>m.cardId===value.cardId&&m.sku===value.sku&&m.frontHash===value.frontHash&&m.backHash===value.backHash&&m.identityKey===value.identityKey)||!validQuantityReceiptGroup(s,group)))throw Error("Invalid aggregate quantity receipt binding");
  const q=value.quantityUpdate,existing=q?.existingCardId?s.cards[q.existingCardId]:undefined,existingIdentity=q?.listingIdentity;
  const quantityKey=(i:Identity)=>matchKey({...i,set:i.set.replace(/\s+x\s+/gi,' ')},true);
  if(q&&(!value.liveItemId||value.draftId||card.input.knownDraft||!existing||existing===card||existing.input.sku!==q.listingSku||!existingIdentity||identity.serial||identity.printRun||existingIdentity.serial||existingIdentity.printRun||q.after!==q.before+1||!identity.language||identity.language!==existingIdentity.language||identity.condition!==existingIdentity.condition||quantityKey(identity)!==quantityKey(existingIdentity)||fingerprint(reviewedIdentity(existing))!==fingerprint(existingIdentity)))throw Error("Quantity receipt requires an exact unnumbered existing listing and verified one-copy update; no draft permitted");
  if(q&&(value.source!==`https://www.ebay.com/itm/${value.liveItemId}`||[existing!.input.knownLive?.itemId,existing!.exclusion?.disposition==='live'?existing!.exclusion.itemId:undefined].some(id=>id&&id!==value.liveItemId)))throw Error('Quantity receipt conflicts with existing live listing');
  if(!q&&!group&&(!value.draftId||![card.input.knownDraft,...(card.input.savedReceipts??[]).filter(r=>r.disposition==="draft").map(r=>r.itemId),card.exclusion?.disposition==="draft"?card.exclusion.itemId:undefined].includes(value.draftId)))throw new Error("Verify an existing saved draft; unknown draft ID cannot be adopted");
  const draftOwners=value.draftId?Object.values(s.cards).filter(c=>receipts(c).includes(value.draftId)):[];
  const declared=Object.values(s.draftCreationGroups??{}).find(g=>g.draftId===value.draftId);
  const recoveredPhotoGroup=!!value.draftId&&(Object.values(s.draftAppends??{}).some(g=>g.completedAt&&g.packet.draftId===value.draftId)||Object.values(s.draftGroupRecoveries??{}).some(g=>g.draftId===value.draftId&&!!g.completedAt)||Object.values(s.draftConsolidations??{}).some(g=>!!g.completedAt&&g.packet.groups.some(p=>p.members.find(m=>m.cardId===p.keepCardId)?.draftId===value.draftId)));
  const representativeAppend=Object.values(s.draftAppends??{}).find(g=>g.completedAt&&g.packet.representativePhotos&&g.packet.draftId===value.draftId&&[...g.packet.existing,...g.packet.added].includes(value.cardId));
  const representativeId=representativeAppend?.packet.primary??(declared?.representativePhotos?declared.members[0]:undefined);
  if(value.representativePhotoCardId!==undefined&&value.representativePhotoCardId!==representativeId||representativeId&&value.cardId!==representativeId&&value.representativePhotoCardId!==representativeId)throw Error('Explicit representative photo receipt binding required');
  const groupedDraft=!!value.draftId&&validDraftGroup(s,value.draftId,draftOwners.map(c=>c.input.id),value.liveItemId)
    &&draftOwners.every(c=>c.jobs.photos.state==="done"&&c.jobs.identity.state==="done"&&!!reviewedIdentity(c)?.language
      &&(recoveredPhotoGroup||!!reviewedIdentity(c)?.artwork&&!!reviewedIdentity(c)?.conditionType||!!declared&&(!!c.draftLifecycle?.verification?.photoIdentityVerified||c.draftLifecycle?.unpricedVerification?.binding===declared.bindings[c.input.id])));
  if(Object.values(s.cards).some(c=>c!==card&&((!!value.draftId&&receipts(c).includes(value.draftId)&&!groupedDraft)
    ||!!value.liveItemId&&receipts(c).includes(value.liveItemId)&&!(groupedDraft&&draftOwners.includes(c))&&!(q&&c===existing)&&!(group&&group.members.some(m=>m.cardId===c.input.id))&&!verifiedQuantityGroupOwners(s,value.liveItemId,[card.input.id,c.input.id])&&!verifiedQuantityPair(s,value.liveItemId,[card.input.id,c.input.id])
    ||c.input.photos.some(p=>p.side==="front"&&p.sha256.toLowerCase()===value.frontHash))))throw new Error("Conflicting receipt ownership or original capture; reconcile before adoption");
  if((card.exclusion&&!["draft","live"].includes(card.exclusion.disposition))||["sold","scheduled"].includes(String(card.jobs.reconcile.result?.disposition)))throw new Error("Existing sold/scheduled disposition requires explicit reconciliation");
  const liveIds=[card.input.knownLive?.itemId,card.exclusion?.disposition==="live"?card.exclusion.itemId:undefined,...(card.input.savedReceipts??[]).filter(r=>r.disposition==="live").map(r=>r.itemId)].filter(Boolean);
  if(value.liveItemId&&liveIds.some(id=>id!==value.liveItemId))throw new Error("Conflicting live receipt; preserve existing evidence");
  // Exclusion is retained across source refreshes without resetting jobs, attempts or holds.
  if(value.liveItemId)card.exclusion={disposition:"live",itemId:value.liveItemId,evidence:`Verified ${value.observedAt}: ${value.source}; ${value.evidence}`};
  s.verifiedReceipts??={};s.verifiedReceipts[value.observationId]=value;
  event(s,value.cardId,"reconcile","receipt-verified",value.observationId,now);
  return true;
}

const quantityMemberSchema=z.object({cardId:text,sku:text,frontHash:z.string().regex(/^[a-f0-9]{64}$/),backHash:z.string().regex(/^[a-f0-9]{64}$/),identityKey:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const quantityReceiptGroupSchema=z.object({
  operationId:z.string().uuid(),seller:z.literal("imaydit58"),liveItemId:z.string().regex(/^\d+$/),
  listingIdentity:identitySchema,before:z.number().int().nonnegative(),after:z.number().int().positive(),
  operationStartedAt:z.string().datetime(),reopenedAt:z.string().datetime(),observedAt:z.string().datetime(),
  source:z.string().url(),evidence:z.string().min(10).max(4000),photosVerified:z.literal(true),
  members:z.array(quantityMemberSchema).min(1).max(50)
}).strict();
export type QuantityReceiptGroup=z.infer<typeof quantityReceiptGroupSchema>;
function validQuantityReceiptGroup(s:QueueState,g:QuantityReceiptGroup) {
  const key=(i:Identity)=>matchKey({...i,set:i.set.replace(/\s+x\s+/gi,' ')},true);
  if(g.seller!==s.seller||g.source!==`https://www.ebay.com/itm/${g.liveItemId}`||g.after-g.before!==g.members.length
    ||new Set(g.members.map(m=>m.cardId)).size!==g.members.length||new Set(g.members.map(m=>m.frontHash)).size!==g.members.length
    ||!g.listingIdentity.language||g.listingIdentity.serial||g.listingIdentity.printRun)return false;
  return g.members.every(m=>{const c=s.cards[m.cardId],i=c&&reviewedIdentity(c);
    return !!c&&!!i&&identityReviewIsCurrent(c)&&hasCompleteIdentity(i)&&!c.input.sourceHold&&!i.serial&&!i.printRun
      &&i.language===g.listingIdentity.language&&i.condition===g.listingIdentity.condition&&i.autograph===g.listingIdentity.autograph&&i.patch===g.listingIdentity.patch
      &&key(i)===key(g.listingIdentity)&&fingerprint(i)===m.identityKey&&c.input.sku===m.sku
      &&c.input.photos.find(p=>p.side==='front')?.sha256.toLowerCase()===m.frontHash&&c.input.photos.find(p=>p.side==='back')?.sha256.toLowerCase()===m.backHash
      &&!c.input.knownDraft&&!(c.input.savedReceipts??[]).some(r=>r.disposition==='draft'||r.itemId!==g.liveItemId)
      &&(!c.input.knownLive||c.input.knownLive.itemId===g.liveItemId)&&(!c.exclusion||c.exclusion.disposition==='live'&&c.exclusion.itemId===g.liveItemId)
      &&!['sold','scheduled'].includes(String(c.jobs.reconcile.result?.disposition));});
}
function verifiedQuantityGroupOwners(s:QueueState,itemId:string,owners:readonly string[]) {
  return Object.values(s.quantityReceiptGroups??{}).some(g=>g.liveItemId===itemId&&owners.every(id=>g.members.some(m=>m.cardId===id))&&validQuantityReceiptGroup(s,g));
}
/** Admit the actual aggregate operation atomically. This records evidence only, never changes stock. */
export function recordQuantityReceiptGroup(s:QueueState,raw:unknown,now=new Date().toISOString()) {
  const g=quantityReceiptGroupSchema.parse(raw),prior=s.quantityReceiptGroups?.[g.operationId];
  if(prior){if(fingerprint(prior)!==fingerprint(g))throw Error('Quantity operation ID already has different evidence');if(!validQuantityReceiptGroup(s,prior))throw Error('Quantity group inputs changed');return false;}
  if(Date.parse(g.operationStartedAt)>Date.parse(g.reopenedAt)||Date.parse(g.reopenedAt)>Date.parse(g.observedAt)||Date.parse(g.observedAt)>Date.parse(now)
    ||Date.parse(now)-Date.parse(g.observedAt)>3600000||!validQuantityReceiptGroup(s,g))throw Error('Exact current aggregate quantity evidence required');
  const ids=new Set(g.members.map(m=>m.cardId)),hashes=new Set(g.members.map(m=>m.frontHash));
  if(Object.values(s.quantityReceiptGroups??{}).some(old=>old.members.some(m=>ids.has(m.cardId)||hashes.has(m.frontHash)))
    ||Object.values(s.verifiedReceipts??{}).some(r=>ids.has(r.cardId)||hashes.has(r.frontHash)))throw Error('Capture already represented by a receipt; never recount');
  // Work on a clone so a conflict on the final member cannot partially adopt the group.
  const next=structuredClone(s);next.quantityReceiptGroups??={};next.quantityReceiptGroups[g.operationId]=g;
  for(const m of g.members)recordVerifiedReceipt(next,{...m,observationId:randomUUID(),seller:g.seller,quantityGroupId:g.operationId,
    liveItemId:g.liveItemId,observedAt:g.observedAt,photosVerified:true,source:g.source,evidence:g.evidence},now);
  s.quantityReceiptGroups=next.quantityReceiptGroups;s.verifiedReceipts=next.verifiedReceipts;s.events=next.events;
  for(const m of g.members)s.cards[m.cardId].exclusion=next.cards[m.cardId].exclusion;
  return true;
}

export const newQueue = (): QueueState => ({schemaVersion:1,revision:0,policyVersion:CARD_POLICY_VERSION,seller:CARD_POLICY.seller,mode:"local-preparation-only",externalWriterPossible:true,cards:{},events:[]});
const expiredClearanceReason = "Previous inventory clearance expired; fresh four-scope check required";
const retryAttempts = (job: Job) => job.kind === "reconcile" ? job.attemptsSinceClearance ?? job.attempts : job.attempts;
const event = (s:QueueState,id:string,kind:string,action:string,detail:string,now:string) => {
  s.events.push({at:now,cardId:id,kind,event:action,detail});
};
export function reviewedIdentity(card: CardRecord): Identity | undefined {
  return card.jobs.identity?.state === "done" ? card.jobs.identity.result?.identity as Identity : undefined;
}
function jobInputKey(card: CardRecord, kind: JobKind):string {
  const i = card.input, identity = reviewedIdentity(card) ?? i.identity;
  // Compute at the point of use: earlier stages may invalidate downstream inputs.
  // Avoid hashing the four unused stages on every iteration of refreshJobs.
  switch(kind) {
    case "photos":return fingerprint(i.photos);
    case "identity":return fingerprint([i.identity,i.photos,i.identityIssue??"",i.sourceHold??"",card.jobs.photos?.inputKey]);
    case "reconcile":return fingerprint([CARD_POLICY.seller,identity,card.jobs.identity?.inputKey,i.photos,i.knownLive??null,i.knownDraft??null]);
    case "pricing":return fingerprint([CARD_EVIDENCE_VERSION,identity,card.jobs.identity?.inputKey,i.candidates,i.override??null,...(card.pricingEvidence?[card.pricingEvidence.key]:[])]);
    case "listing":return fingerprint(["local-review-v2",CARD_EVIDENCE_VERSION,identity,card.jobs.identity?.inputKey,i.photos,card.jobs.pricing?.state,card.jobs.pricing?.result??null,i.sku]);
  }
}
/** Read-only freshness check for consumers of completed copy knowledge. */
export function identityReviewIsCurrent(card:CardRecord) {
  return card.jobs.photos.state==="done"&&card.jobs.identity.state==="done"
    &&card.jobs.photos.inputKey===jobInputKey(card,"photos")
    &&card.jobs.identity.inputKey===jobInputKey(card,"identity");
}
export function refreshJobs(card: CardRecord, now: string) {
  // Dependents see the freshly invalidated identity before their own keys are calculated.
  for (const kind of kinds) {
    const key = jobInputKey(card,kind), old = card.jobs[kind];
    if (!old || old.inputKey !== key) {
      const retained=card.identityCorrectionHolds?.[kind];
      card.jobs[kind]=retained?{kind,inputKey:key,state:"held",...retained}:{kind,inputKey:key,state:"todo",attempts:0,elapsedMs:0};
    }
    const job = card.jobs[kind];
    if(kind==="pricing"&&job.state==="leased"&&job.elapsedMs+Date.parse(now)-Date.parse(job.lease!.startedAt)>=CARD_POLICY.researchLimitSeconds*1000) {
      const elapsedMs=job.elapsedMs+Math.max(0,Date.parse(now)-Date.parse(job.lease!.startedAt));
      card.pricingDeferral={identityKey:fingerprint(reviewedIdentity(card)),at:now,elapsedMs,evidence:"Durable pricing lease reached the 30-second limit"};
      job.elapsedMs=elapsedMs;job.state="held";job.reason="30-second pricing limit reached; continue an unpriced draft";delete job.lease;
    }
    if (kind === "reconcile" && job.attemptsSinceClearance === undefined) {
      // Upgrade saved successful/expired clearances without reopening failed or ambiguous work.
      const successful = job.result?.disposition === "clear"
        && (job.state === "done" || (job.state === "held" && job.reason === expiredClearanceReason));
      job.attemptsSinceClearance = successful ? 0 : job.attempts;
    }
    if (job.state === "leased" && Date.parse(job.lease!.expiresAt) <= Date.parse(now)) {
      job.state = retryAttempts(job) >= CARD_POLICY.maxAttemptsPerInput ? "held" : "todo";
      job.reason = "Lease expired; prior worker is fenced from completing";
      job.elapsedMs += Math.max(0,Date.parse(job.lease!.expiresAt)-Date.parse(job.lease!.startedAt));
      delete job.lease;
    }
    if(kind==="pricing"&&job.state==="done") {
      try{validateComps(reviewedIdentity(card)??card.input.identity,job.result?.comps,now,job.result?.basis as CompBasis|undefined);}
      catch(error){job.state="held";job.reason=`Saved comp evidence needs review: ${error instanceof Error ? error.message : "validation failed"}`;}
    }
    if(kind==="reconcile"&&job.state==="done"&&job.result?.disposition==="clear"&&Date.parse(now)-Date.parse(String(job.result.checkedAt))>CARD_POLICY.reconciliationMaxAgeMinutes*60000) {
      job.state="held";job.reason=expiredClearanceReason;
    }
    if(kind==="reconcile"&&job.state==="held"&&job.reason===expiredClearanceReason&&job.result?.disposition==="clear") {
      job.recovery??={when:"clearance-expired"};
    }
  }
}
/** Shared read-only intake check; admitting identity work must retain photo/condition guards. */
export function validateCardIntake(input:CardInput) {
  if (!/^[\w-]{1,100}$/.test(input.id) || !input.sku.trim() || input.photos.length!==2 || new Set(input.photos.map(p=>p.side)).size!==2) throw new Error("Invalid card ID, SKU or photo pair");
  if (input.photos.some(p=>!p.path || !/^[a-f0-9]{64}$/i.test(p.sha256))) throw new Error("Missing original photo hashes");
  intakeIdentitySchema.parse(input.identity);
}
export function upsertCard(s:QueueState,input:CardInput,now=new Date().toISOString()) {
  const transferred = s.v2OwnershipTransfers?.[input.id] ?? Object.values(s.v2OwnershipTransfers ?? {}).find(transfer => input.photos?.some(photo => transfer.photoHashes.includes(photo.sha256.toLowerCase())));
  if (transferred) throw Error(`Capture ownership transferred to Card Processing V2; legacy import is fenced (${transferred.resetId})`);
  const existingCondition=s.cards[input.id]?.input.identity.condition;
  input={...input,identity:{...input.identity,condition:ownedCardCondition(input.identity.condition === "Not specified" || !input.identity.condition?.trim() ? existingCondition : input.identity.condition) as Identity["condition"]}};
  validateCardIntake(input);
  const old = s.cards[input.id];
  input={...input,knownLive:input.knownLive??old?.input.knownLive,knownDraft:input.knownDraft??old?.input.knownDraft};
  if (old && fingerprint(old.input)===fingerprint(input)) { refreshJobs(old,now); return false; }
  const card = old ?? {input,createdAt:now,updatedAt:now,jobs:{} as Record<JobKind,Job>};
  // A missing legacy live marker must never erase a positive receipt already recorded here.
  card.input={...input,knownLive:input.knownLive??old?.input.knownLive,knownDraft:input.knownDraft??old?.input.knownDraft};
  card.updatedAt=now; refreshJobs(card,now); s.cards[input.id]=card;
  event(s,input.id,"import",old?"source-updated":"imported",input.source,now); return true;
}
export function alreadyListed(card:CardRecord) {
  return !!card.input.knownLive || !!card.input.knownDraft || !!card.exclusion || (card.jobs.reconcile.state==="done" && card.jobs.reconcile.result?.disposition!=="clear");
}
export function existingReceipt(card:CardRecord):{disposition:string;itemId:string}|null {
  if(card.exclusion?.disposition==="sold")return {disposition:"sold",itemId:card.exclusion.itemId};
  if(card.input.knownLive)return {disposition:"live",itemId:card.input.knownLive.itemId};
  if(card.exclusion)return {disposition:card.exclusion.disposition,itemId:card.exclusion.itemId};
  if(card.input.knownDraft)return {disposition:"draft",itemId:card.input.knownDraft};
  const result=card.jobs.reconcile.state==="done"?card.jobs.reconcile.result:undefined;
  return result&&result.disposition!=="clear"&&result.itemId?{disposition:String(result.disposition),itemId:String(result.itemId)}:null;
}
// A manifest may intentionally bind distinct unnumbered captures to one quantity draft.
// This only permits local evidence maintenance; it never grants Add or quantity writes.
export function validDraftGroup(s:QueueState,itemId:string,owners:readonly string[],verifiedLiveItemId?:string) {
  const recovered=Object.values(s.draftGroupRecoveries??{}).find(g=>g.draftId===itemId&&g.packet.members.length===owners.length&&g.packet.members.every(id=>owners.includes(id)));
  if(recovered&&!verifiedLiveItemId)return owners.length>1&&owners.every(id=>{const c=s.cards[id];return !!c&&c.input.knownDraft===itemId&&!c.input.knownLive&&identityReviewIsCurrent(c)&&recovered.bindings[id]===fingerprint({sku:c.input.sku,identity:reviewedIdentity(c)??c.input.identity,originals:["front","back"].map(side=>c.input.photos.find(p=>p.side===side)?.sha256.toLowerCase())});});
  const consolidated=Object.values(s.draftConsolidations??{}).filter(c=>c.completedAt).flatMap(c=>c.packet.groups.map(g=>({c,g}))).find(({g})=>g.members.find(m=>m.cardId===g.keepCardId)?.draftId===itemId&&g.members.length===owners.length&&g.members.every(m=>owners.includes(m.cardId)));
  if(consolidated&&!verifiedLiveItemId)return owners.length>1&&owners.every(id=>{const c=s.cards[id];return !!c&&c.input.knownDraft===itemId&&c.exclusion?.disposition==='draft'&&!c.input.knownLive&&identityReviewIsCurrent(c)&&consolidated.c.bindings[id]===fingerprint({sku:c.input.sku,identity:reviewedIdentity(c)??c.input.identity,originals:['front','back'].map(side=>c.input.photos.find(p=>p.side===side)?.sha256.toLowerCase())});});
  const appended=Object.values(s.draftAppends??{}).find(g=>g.completedAt&&g.packet.draftId===itemId&&g.packet.existing.length+g.packet.added.length===owners.length&&[...g.packet.existing,...g.packet.added].every(id=>owners.includes(id)));
  if(appended&&!verifiedLiveItemId)return owners.length>1&&owners.every(id=>{const c=s.cards[id];return !!c&&c.input.knownDraft===itemId&&!c.input.knownLive&&c.exclusion?.disposition==='draft'&&identityReviewIsCurrent(c)&&appended.bindings[id]===fingerprint({sku:c.input.sku,identity:reviewedIdentity(c)??c.input.identity,originals:['front','back'].map(side=>c.input.photos.find(p=>p.side===side)?.sha256.toLowerCase())});});
  if(owners.length<2)return false;
  const cards=owners.map(id=>s.cards[id]);
  if(cards.some(c=>!c))return false;
  const fronts=cards.map(c=>c.input.photos.find(p=>p.side==="front")?.sha256.toLowerCase());
  if(fronts.some(h=>!h||!/^([a-f0-9]{64})$/.test(h))||new Set(fronts).size!==cards.length)return false;
  const identities=cards.map(c=>reviewedIdentity(c)??c.input.identity);
  if(identities.some(i=>!hasCompleteIdentity(i)||i.serial||i.printRun))return false;
  const groupIdentity=(i:Identity)=>fingerprint({...i,colorMatch:undefined,autograph:undefined,language:undefined,artwork:undefined,conditionType:undefined});
  if(new Set(identities.map(groupIdentity)).size!==1)return false;
  // Optional review details arrive one capture at a time. Unknown values must
  // not deadlock the remaining reviews, but explicit disagreements still block.
  for(const field of ["language","artwork","conditionType"] as const)
    if(new Set(identities.map(i=>i[field]).filter(Boolean)).size>1)return false;
  if(new Set(identities.map(i=>i.autograph).filter(v=>v!==null)).size>1)return false;
  const sources=cards.map(c=>(c.input.savedReceipts??[]).filter(r=>r.disposition==="draft"&&r.itemId===itemId&&r.listingQuantity===cards.length&&r.captureQuantity===1).map(r=>r.source));
  const declared=Object.values(s.draftCreationGroups??{}).find(g=>g.draftId===itemId&&g.members.length===owners.length&&g.members.every(id=>owners.includes(id)));
  const declaredCurrent=!!declared&&cards.every(c=>declared.bindings[c.input.id]===fingerprint({sku:c.input.sku,identity:reviewedIdentity(c)??c.input.identity,
    originals:["front","back"].map(side=>c.input.photos.find(p=>p.side===side)?.sha256.toLowerCase())}));
  if(!declaredCurrent&&!sources[0].some(source=>sources.every(list=>list.includes(source))))return false;
  const verifiedLive=(c:CardRecord)=>!!verifiedLiveItemId&&Object.values(s.verifiedReceipts??{}).some(r=>r.cardId===c.input.id&&r.draftId===itemId&&r.liveItemId===verifiedLiveItemId);
  return cards.every(c=>(!c.input.knownLive||c.input.knownLive.itemId===verifiedLiveItemId&&verifiedLive(c))
    &&!(c.input.savedReceipts??[]).some(r=>r.disposition==="live"&&(r.itemId!==verifiedLiveItemId||!verifiedLive(c)))
    &&(!c.exclusion||c.exclusion.disposition==="draft"&&c.exclusion.itemId===itemId
      ||!!verifiedLiveItemId&&c.exclusion.disposition==="live"&&c.exclusion.itemId===verifiedLiveItemId
        &&verifiedLive(c))
    &&!['live','sold','scheduled'].includes(String(c.jobs.reconcile.result?.disposition))
    &&(!c.input.knownDraft||c.input.knownDraft===itemId));
}
function verifiedLiveGroup(s:QueueState,itemId:string,owners:readonly string[]) {
  return Object.values(s.verifiedReceipts??{}).some(r=>{
    if(!r.liveItemId||!r.draftId||(r.draftId!==itemId&&r.liveItemId!==itemId))return false;
    const members=Object.values(s.cards).filter(c=>c.input.knownDraft===r.draftId||(c.input.savedReceipts??[]).some(x=>x.disposition==="draft"&&x.itemId===r.draftId)).map(c=>c.input.id);
    return owners.every(id=>members.includes(id))&&validDraftGroup(s,r.draftId,members,r.liveItemId);
  });
}
/** Retained one-copy update links two distinct captures, not a new stock operation. */
function verifiedQuantityPair(s:QueueState,itemId:string,owners:readonly string[]) {
  if(owners.length!==2||new Set(owners).size!==2)return false;
  return Object.values(s.verifiedReceipts??{}).some(r=>{
    const q=r.quantityUpdate,c=s.cards[r.cardId],original=q&&s.cards[q.existingCardId];
    if(!q||!c||!original||r.liveItemId!==itemId||!owners.includes(r.cardId)||!owners.includes(q.existingCardId)
      ||r.seller!==s.seller||!r.photosVerified||r.source!==`https://www.ebay.com/itm/${itemId}`||q.after!==q.before+1)return false;
    const i=reviewedIdentity(c),oi=reviewedIdentity(original);
    const key=(v:Identity)=>matchKey({...v,set:v.set.replace(/\s+x\s+/gi,' ')},true);
    return !!i&&!!oi&&!i.serial&&!oi.serial&&!i.printRun&&!oi.printRun&&!!i.language&&i.language===oi.language
      &&i.condition===oi.condition&&key(i)===key(oi)&&fingerprint(i)===r.identityKey&&fingerprint(oi)===fingerprint(q.listingIdentity)
      &&c.input.sku===r.sku&&original.input.sku===q.listingSku
      &&c.input.photos.find(p=>p.side==='front')?.sha256.toLowerCase()===r.frontHash
      &&c.input.photos.find(p=>p.side==='back')?.sha256.toLowerCase()===r.backHash
      &&original.input.photos.every(p=>p.side!=='front'||p.sha256.toLowerCase()!==r.frontHash)
      &&[c.input.knownLive?.itemId,c.exclusion?.itemId].includes(itemId);
  });
}
function receiptOwnershipConflicts(s:QueueState) {
  const owners=new Map<string,Set<string>>();
  for(const c of Object.values(s.cards)) {
    const ids=[c.input.knownLive?.itemId,c.input.knownDraft,c.exclusion?.itemId,...(c.input.savedReceipts??[]).map(r=>r.itemId)].filter((id):id is string=>!!id);
    for(const id of ids){const cards=owners.get(id)??new Set<string>();cards.add(c.input.id);owners.set(id,cards);}
  }
  return Array.from(owners).filter(([itemId,owners])=>owners.size>1&&!validDraftGroup(s,itemId,Array.from(owners))&&!verifiedLiveGroup(s,itemId,Array.from(owners))&&!verifiedSoldGroup(s,itemId,Array.from(owners))&&!verifiedQuantityGroupOwners(s,itemId,Array.from(owners))&&!verifiedQuantityPair(s,itemId,Array.from(owners))).map(([itemId,owners])=>({itemId,cardIds:Array.from(owners).sort()}));
}
function duplicateReason(s:QueueState,c:CardRecord):string|undefined {
  const id = reviewedIdentity(c) ?? c.input.identity;
  const frontHash = c.input.photos.find(p=>p.side==="front")?.sha256.toLowerCase();
  const photoKey = c.input.photos.map(p=>p.sha256.toLowerCase()).sort().join(":");
  for (const other of Object.values(s.cards)) {
    if(other.input.id===c.input.id)continue;
    if(other.input.sku===c.input.sku)return `SKU also belongs to ${other.input.id}`;
    if(other.input.photos.map(p=>p.sha256.toLowerCase()).sort().join(":")===photoKey)return `Same original photo bytes as ${other.input.id}; no additional inventory assumed`;
    if(frontHash && other.input.photos.find(p=>p.side==="front")?.sha256.toLowerCase()===frontHash)return `Same original front capture as ${other.input.id} with conflicting back photos; resolve pairing without adding inventory`;
    const oi=reviewedIdentity(other)??other.input.identity;
    if(id.serial && oi.serial && hasCompleteIdentity(id) && hasCompleteIdentity(oi) && matchKey(id,true)===matchKey(oi,true))return `Exact serialized identity also belongs to ${other.input.id}`;
  }
  return undefined;
}
export function jobBlockers(s:QueueState,c:CardRecord,kind:JobKind,sellerHold?:string):string[] {
  return cardBlockers(s,c,kind,sellerHold,()=>duplicateReason(s,c),()=>receiptOwnershipConflicts(s).some(conflict=>conflict.cardIds.includes(c.input.id)));
}
function cardBlockers(s:QueueState,c:CardRecord,kind:JobKind,sellerHold:string|undefined,duplicate:()=>string|undefined,receiptConflict:()=>boolean):string[] {
  if(s.v2OwnershipTransfers?.[c.input.id])return ['Capture ownership transferred to Card Processing V2; preserve legacy history without claiming it'];
  const reasons:string[]=[];
  if(sellerHold)reasons.push(`Seller hold: ${sellerHold}`);
  if(kind==="reconcile"&&s.inventoryAccess?.available===false)reasons.push("Inventory access unavailable; record a new successful access observation before reconciliation");
  // Listing exclusion is not a ban on local evidence maintenance. Sold inventory remains excluded.
  const localEvidence = ["photos","identity","pricing"].includes(kind)
    && ["draft","live","scheduled"].includes(existingReceipt(c)?.disposition ?? "")
    && c.exclusion?.disposition!=="sold" && c.jobs.reconcile.result?.disposition!=="sold";
  const receiptReconciliation=kind==="reconcile"&&existingReceipt(c)?.disposition==="draft";
  if(alreadyListed(c) && !localEvidence && !receiptReconciliation) reasons.push("Already live or existing draft/scheduled/sold match: do not create Add");
  if((localEvidence||receiptReconciliation) && receiptConflict()) reasons.push("Conflicting draft receipt ownership; reconcile before local work");
  const duplicateMessage=duplicate(); if(duplicateMessage)reasons.push(duplicateMessage);
  if(kind!=="photos" && c.jobs.photos.state!=="done")reasons.push("Original photo audit required");
  if(["pricing","reconcile","listing"].includes(kind) && !reviewedIdentity(c))reasons.push("Reviewed identity required");
  if(kind==="pricing"&&(reviewedIdentity(c)??c.input.identity).condition==="Not specified")reasons.push("Condition unresolved; retain an incomplete draft without a price or condition claim");
  return reasons;
}
/** Report-only lookup: build after refreshing all cards; discard before any source/identity mutation. */
export function createJobBlockerLookup(s:QueueState) {
  const conflicts=new Set(receiptOwnershipConflicts(s).flatMap(conflict=>conflict.cardIds));
  const rows=Object.values(s.cards).map(c=>{
    const identity=reviewedIdentity(c)??c.input.identity;
    return {id:c.input.id,sku:c.input.sku,photoKey:c.input.photos.map(p=>p.sha256.toLowerCase()).sort().join(":"),
      front:c.input.photos.find(p=>p.side==="front")?.sha256.toLowerCase(),
      serialKey:identity.serial&&hasCompleteIdentity(identity)?matchKey(identity,true):undefined};
  });
  const duplicates=new Map<string,string>();
  // Keep the first two queue positions for each identity key. For any card, the
  // earliest non-self candidate across keys is exactly the old nested-loop match.
  const indexes = ["sku","photoKey","front","serialKey"].map(field=>{
    const index=new Map<string,number[]>();
    rows.forEach((row,position)=>{
      const key=row[field as "sku"|"photoKey"|"front"|"serialKey"];
      if(key===undefined)return;
      const positions=index.get(key)??[];
      if(positions.length<2)positions.push(position);
      index.set(key,positions);
    });
    return index;
  });
  rows.forEach((c,position)=>{
    const keys=[c.sku,c.photoKey,c.front,c.serialKey];
    let earliest=Infinity;
    keys.forEach((key,i)=>{
      if(key===undefined)return;
      const other=indexes[i].get(key)?.find(candidate=>candidate!==position);
      if(other!==undefined)earliest=Math.min(earliest,other);
    });
    if(!Number.isFinite(earliest))return;
    const other=rows[earliest];
    let reason:string|undefined;
    if(other.sku===c.sku)reason=`SKU also belongs to ${other.id}`;
    else if(other.photoKey===c.photoKey)reason=`Same original photo bytes as ${other.id}; no additional inventory assumed`;
    else if(c.front&&other.front===c.front)reason=`Same original front capture as ${other.id} with conflicting back photos; resolve pairing without adding inventory`;
    else if(c.serialKey&&other.serialKey===c.serialKey)reason=`Exact serialized identity also belongs to ${other.id}`;
    if(reason)duplicates.set(c.id,reason);
  });
  return (c:CardRecord,kind:JobKind,sellerHold?:string)=>cardBlockers(s,c,kind,sellerHold,()=>duplicates.get(c.input.id),()=>conflicts.has(c.input.id));
}
export function recoverableHold(s:QueueState,c:CardRecord,now:string,sellerHold?:string,approvedPrice:boolean|(()=>boolean)=false) {
  return recoverableWithBlockers(s,c,now,approvedPrice,()=>jobBlockers(s,c,"reconcile",sellerHold));
}
function recoverableWithBlockers(s:QueueState,c:CardRecord,now:string,approvedPrice:boolean|(()=>boolean),blockers:()=>string[]) {
  const j=c.jobs.reconcile;
  if(j.state!=="held"||!j.recovery||existingReceipt(c)||retryAttempts(j)>=CARD_POLICY.maxAttemptsPerInput
    ||blockers().length
    ||!(c.jobs.pricing.state==="done"||(typeof approvedPrice==="function"?approvedPrice():approvedPrice)))return false;
  const access=s.inventoryAccess;
  return j.recovery.when!=="inventory-access"||(access?.available===true&&access.observationId!==j.recovery.observedAccess
    &&(!j.recovery.blockedAt||Date.parse(access.at)>=Date.parse(j.recovery.blockedAt))
    &&Date.parse(now)>=Date.parse(access.at)&&Date.parse(now)-Date.parse(access.at)<=CARD_POLICY.reconciliationMaxAgeMinutes*60000);
}
export function claimJob(s:QueueState,owner:string,kind?:JobKind,cardId?:string,now=new Date().toISOString(),sellerHolds:Record<string,string>={},excludeIds:readonly string[]=[],approvedPrices:readonly string[]|((card:CardRecord)=>boolean)=[]) {
  if(!owner.trim()||owner.length>200)throw new Error("Worker name required");
  const ordered=Object.values(s.cards).map(card=>({card,key:processingKey(card)}))
    .sort((a,b)=>a.key.localeCompare(b.key)||a.card.createdAt.localeCompare(b.card.createdAt)||a.card.input.id.localeCompare(b.card.input.id));
  for(const {card:c} of ordered) {
    if((cardId && c.input.id!==cardId)||excludeIds.includes(c.input.id))continue;
    if(s.v2OwnershipTransfers?.[c.input.id])continue;
    refreshJobs(c,now);
    for(const k of kind?[kind]:kinds) {
      // Filing verified draft photos must not prevent later pricing maintenance.
      if(s.photoArchives?.[c.input.id] && !(kind==="pricing" && cardId===c.input.id && existingReceipt(c)?.disposition==="draft"))continue;
      const j=c.jobs[k];
      if(k==="reconcile"&&recoverableHold(s,c,now,sellerHolds[c.input.id],()=>typeof approvedPrices==="function"?approvedPrices(c):approvedPrices.includes(c.input.id))) {
        j.state="todo";event(s,c.input.id,k,"hold-recovered",`${j.recovery!.when}: ${j.reason}`,now);
        delete j.recovery;
      }
      if(j.state!=="todo" || jobBlockers(s,c,k,sellerHolds[c.input.id]).length)continue;
      if(k==="pricing"&&Object.values(s.cards).some(other=>other.input.id!==c.input.id
        &&other.jobs.pricing.state==="leased"&&Date.parse(other.jobs.pricing.lease!.expiresAt)>Date.parse(now)
        &&matchKey(reviewedIdentity(other)??other.input.identity)===matchKey(reviewedIdentity(c)??c.input.identity)))continue;
      if(retryAttempts(j)>=CARD_POLICY.maxAttemptsPerInput) {j.state="held";j.reason="Attempt limit reached for unchanged input";continue;}
      if(k==="reconcile")j.attemptsSinceClearance=retryAttempts(j)+1;
      j.state="leased";j.attempts++;
      j.lease={token:randomUUID(),owner,startedAt:now,expiresAt:new Date(Date.parse(now)+CARD_POLICY.leaseSeconds*1000).toISOString()};
      event(s,c.input.id,k,"claimed",owner,now);
      return {card:c.input,job:structuredClone(j),reviewedIdentity:reviewedIdentity(c)??null,policy:CARD_POLICY};
    }
  }
  return null;
}
const https = z.string().url().refine(value=>{const u=new URL(value);return u.protocol==="https:"&&!u.username&&!u.password;},"HTTPS source without credentials required");
const compSchema=z.object({
  saleId:text,sourceUrl:https,soldDate:z.string(),itemPrice:z.number().refine(x=>money(x,true)),
  shipping:z.number().refine(x=>money(x)).nullable(),currency:z.literal("USD"),
  identity:identitySchema,serialObserved:z.boolean(),priceDisclosed:z.literal(true),
  printRunObserved:z.boolean().optional(),
  ownAcquisition:z.literal(false),graded:z.literal(false),lot:z.literal(false),
  condition:z.enum(["Near mint or better","Excellent","Very good","Unknown"]),
  evidenceMode:z.enum(["original-sale","sold-result"]),evidence:text,
}).strict();
const activeCompSchema=z.object({listingId:z.string().regex(/^\d+$/),sourceUrl:z.string().url(),observedAt:z.iso.datetime(),
  itemPrice:z.number().refine(x=>money(x,true)),shipping:z.number().refine(x=>money(x)),currency:z.literal("USD"),
  identity:identitySchema,seller:text,active:z.literal(true),buyItNow:z.literal(true),singleCard:z.literal(true),
  exactVariantVerified:z.literal(true),unconditionalPrice:z.literal(true),evidenceMode:z.literal("active-listing"),evidence:text}).strict();
export type CompEvidence=z.infer<typeof compSchema>|z.infer<typeof activeCompSchema>;
export type CompBasis = "exact" | "related-print-run" | "active-lowest" | "seller-asking";
/** Active asking-price fallback matches cents exactly; ordinary sold-price rounding remains unchanged. */
export function pricingProjection(total:number,basis:CompBasis,options:Parameters<typeof calculateCardPrice>[1]={},asking?:{item:number;shipping:number}) {
  if(basis==="seller-asking"&&!options.override){
    if(!asking||Math.abs(asking.item+asking.shipping-total)>0.001)throw Error("Validated seller asking split required");
    return {...calculateCardPrice(total,{...options,override:{...asking,evidence:"Verified current seller asking price"}}),overridden:false,estimateLabel:"current seller asking price",floorLimited:false};
  }
  const ordinary=calculateCardPrice(total,options);
  if(basis!=="active-lowest"||options.override)return ordinary;
  const item=Math.max(1.49,Math.round((total-ordinary.shipping)*100)/100);
  return {...calculateCardPrice(total,{...options,override:{item,shipping:ordinary.shipping,evidence:"Seller-authorized lowest exact active buyer-total fallback"}}),
    overridden:false,estimateLabel:"active-listing estimate",floorLimited:item+ordinary.shipping>total+0.001};
}
export function matchKey(i:Identity,withSerial=false) {
  // Physical serial is excluded only for comparable-copy matching, never for inventory identity.
  return [i.player,i.season,i.set,i.manufacturer,i.cardNumber,i.sport,i.parallel,i.printRun??"",i.autograph??"unknown",i.patch,withSerial?normalizeSerial(i.serial):""].map(v=>String(v).trim().toLowerCase().replace(/\s+/g," ")).join("|");
}
function normalizeSerial(serial:string) {return serial.replace(/\d+/g,x=>String(Number(x)));}
export function processingKey(card: CardRecord) {
  const i = reviewedIdentity(card) ?? card.input.identity;
  return [i.player,i.set,i.season,i.cardNumber,i.parallel,i.printRun ?? "",i.condition,i.autograph ?? "unknown",i.patch].join("|").toLowerCase();
}
export function validateComps(identity:Identity,raw:unknown,now:string,basis:CompBasis="exact") {
  if(basis==="active-lowest"||basis==="seller-asking") {
    const comps=z.array(activeCompSchema).min(1).max(50).parse(raw),seen=new Set<string>();
    if(basis==="seller-asking"&&comps.length!==1)throw Error("Seller asking reuse requires one exact source");
    for(const c of comps){
      const age=Date.parse(now)-Date.parse(c.observedAt),u=new URL(c.sourceUrl);
      if(age<0||age>CARD_POLICY.reconciliationMaxAgeMinutes*60000||!Number.isFinite(age))throw Error("Active comparable is not fresh");
      if(u.protocol!=="https:"||u.hostname!=="www.ebay.com"||u.pathname!==`/itm/${c.listingId}`||seen.has(c.listingId))throw Error("Invalid or duplicate active listing");
      seen.add(c.listingId);
      if(basis==="seller-asking"&&identity.printRun){
        const serial=/^(\d+)\/(\d+)$/.exec(c.identity.serial);
        if(!serial||Number(serial[2])!==identity.printRun||Number(serial[1])<1||Number(serial[1])>identity.printRun)throw Error("Seller asking source requires inspected complete serial");
      }
      if((basis==="seller-asking"?c.seller.toLowerCase()!==CARD_POLICY.seller:c.seller.toLowerCase()===CARD_POLICY.seller)||matchKey(identity)!==matchKey(c.identity)||identity.condition!==c.identity.condition
        ||['language','artwork','conditionType'].some(k=>identity[k as keyof Identity]&&identity[k as keyof Identity]!==c.identity[k as keyof Identity])
        ||(identity.serial&&normalizeSerial(identity.serial)===normalizeSerial(c.identity.serial)))throw Error("Active comparable identity, condition or ownership mismatch");
    }
    const selected=[...comps].sort((a,b)=>(a.itemPrice+a.shipping)-(b.itemPrice+b.shipping)||a.listingId.localeCompare(b.listingId))[0];
    const total=Math.round((selected.itemPrice+selected.shipping)*100)/100;
    return {comps,basis,basisDetails:[],reviewEstimate:true,directColorMatch:false,buyerTotalMean:total,mean:total,
      estimateLabel:basis==="seller-asking"?"current seller asking price":"active-listing estimate",selectedListingId:selected.listingId,
      asking:basis==="seller-asking"?{item:selected.itemPrice,shipping:selected.shipping}:undefined};
  }
  if(basis!=="exact"&&basis!=="related-print-run")throw new Error("Unsupported comp basis");
  const comps=z.array(compSchema).min(1).max(50).parse(raw),seen=new Set<string>();let reviewEstimate=false;
  const directColorMatch=basis==="exact"&&comps.length>=CARD_POLICY.minimumDirectColorMatchSales
    &&identity.colorMatch?.matches===true&&comps.every(c=>c.identity.colorMatch?.matches!==false);
  const basisDetails:{saleId:string;sourceUrl:string;itemPrice:number;sourcePrintRun:number|null;targetPrintRun:number|null;multiplier:number;premiumMultiplier:number;premiumPercent:number;conditionMultiplier:number;conditionPercent:number;sourceCondition:string;targetCondition:string;targetPremiums:string[];sourcePremiums:string[];adjustedItemPrice:number}[]=[];
  for(const c of comps) {
    const date=new Date(`${c.soldDate}T00:00:00Z`),age=(Date.parse(now)-date.getTime())/86400000;
    if(!/^\d{4}-\d{2}-\d{2}$/.test(c.soldDate)||!Number.isFinite(age)||date.toISOString().slice(0,10)!==c.soldDate||age<0||age>=CARD_POLICY.compMaxAgeDays+1)throw new Error("Comp date outside the supported 90-day window");
    const u=new URL(c.sourceUrl),ebayId=/(?:^|\.)ebay\.[a-z.]+$/i.test(u.hostname)?u.pathname.match(/\/itm\/(?:[^/]+\/)?(\d+)/)?.[1]:undefined;
    const key=ebayId??`${u.origin}${u.pathname}`;
    if(["language","artwork","conditionType"].some(k=>{const field=k as keyof Identity;return identity[field]&&c.identity[field]&&identity[field]!==c.identity[field];}))throw new Error("Comp language, artwork or condition type does not match");
    if(seen.has(key)||seen.has(`id:${c.saleId}`))throw new Error("Duplicate sale evidence");
    seen.add(key);seen.add(`id:${c.saleId}`);
    let multiplier=1;
    if(basis==="related-print-run") {
      if(!identity.printRun||!c.identity.printRun)throw new Error("Related estimates require known numbered print runs");
      if(matchKey(identity)===matchKey(c.identity))throw new Error("Use the exact basis for matching parallels");
      if(matchKey(identity)!==matchKey({...c.identity,parallel:identity.parallel,printRun:identity.printRun}))throw new Error("Related comp must be the same card; only parallel and print run may differ");
      multiplier=c.identity.printRun/identity.printRun;
      reviewEstimate=true;
    } else if(matchKey(identity)!==matchKey(c.identity))throw new Error("Comp identity/parallel does not match");
    const denominatorOnly=/^\/(\d+)$/.exec(c.identity.serial);
    const partialSerial=!!(denominatorOnly && c.printRunObserved===true && !c.serialObserved && Number(denominatorOnly[1])===c.identity.printRun);
    if(identity.serial && !partialSerial && (!c.serialObserved || !c.identity.serial))throw new Error("Comp physical serial or explicitly observed print run required");
    if(c.identity.printRun) {
      const serial=/^(\d+)\/(\d+)$/.exec(c.identity.serial);
      if(!partialSerial && (!c.serialObserved||!serial||Number(serial[2])!==c.identity.printRun||Number(serial[1])<1||Number(serial[1])>c.identity.printRun))throw new Error("Comp serial requires an inspected complete numerator/denominator or observed /denominator matching its print run");
    }
    if(partialSerial)reviewEstimate=true;
    if(identity.serial && normalizeSerial(identity.serial)===normalizeSerial(c.identity.serial))throw new Error("Own exact-serial acquisition excluded");
    if(c.condition==="Unknown" && c.evidenceMode!=="sold-result")throw new Error("Unresolved original-sale condition");
    if(c.condition!==identity.condition || c.evidenceMode==="sold-result")reviewEstimate=true;
    const premium = premiumCompAdjustment(identity,c.identity,directColorMatch);
    const condition = conditionCompAdjustment(identity.condition,c.condition);
    if(premium.premiumPercent)reviewEstimate=true;
    basisDetails.push({saleId:c.saleId,sourceUrl:c.sourceUrl,itemPrice:c.itemPrice,sourcePrintRun:c.identity.printRun,targetPrintRun:identity.printRun,multiplier,
      premiumMultiplier:premium.multiplier,premiumPercent:premium.premiumPercent,targetPremiums:premium.targetReasons,sourcePremiums:premium.sourceReasons,
      conditionMultiplier:condition.multiplier,conditionPercent:condition.percent,sourceCondition:c.condition,targetCondition:identity.condition,
      adjustedItemPrice:c.itemPrice*multiplier*premium.multiplier*condition.multiplier});
  }
  const buyerTotalMean=comps.some(c=>c.shipping===null)?NaN:comps.reduce((sum,c,i)=>{const d=basisDetails[i];return sum+(c.itemPrice*d.conditionMultiplier*d.premiumMultiplier+c.shipping!)*d.multiplier;},0)/comps.length;
  return {comps,basis,basisDetails,reviewEstimate,directColorMatch,buyerTotalMean,mean:basisDetails.reduce((sum,c)=>sum+c.adjustedItemPrice,0)/comps.length};
}
export function completeJob(s:QueueState,id:string,kind:JobKind,token:string,raw:unknown,now=new Date().toISOString(),sellerHolds:Record<string,string>={}) {
  const c=s.cards[id];if(!c)throw new JobCompletionConflict("Unknown card");if(s.v2OwnershipTransfers?.[id])throw new JobCompletionConflict('Capture ownership transferred to V2; old completion is fenced');refreshJobs(c,now);
  const job=c.jobs[kind];if(job.state!=="leased"||job.lease?.token!==token)throw new JobCompletionConflict("Lease expired, superseded or owned by another worker");
  if(jobBlockers(s,c,kind,sellerHolds[id]).length)throw new JobCompletionConflict("Card prerequisites or seller hold changed during this lease");
  const envelope=z.object({outcome:z.enum(["done","held"]),reason:z.string().max(2000).optional(),data:z.unknown().optional(),recovery:recoverySchema.optional()}).strict().parse(raw);
  if(envelope.recovery&&(kind!=="reconcile"||envelope.outcome!=="held"))throw new Error("Recovery conditions apply only to held reconciliation jobs");
  let result:JobResult|undefined;
  if(envelope.outcome==="held") {
    if(!envelope.reason?.trim())throw new Error("A held task needs a concrete reason");
  } else if(kind==="photos") {
    result=z.object({hashes:z.array(z.object({side:z.enum(["front","back"]),sha256:z.string()})).length(2),evidence:text}).strict().parse(envelope.data);
    const hashes=result.hashes as {side:string;sha256:string}[];
    if(new Set(hashes.map(p=>p.side)).size!==2||c.input.photos.some(p=>!hashes.some(h=>h.side===p.side&&h.sha256.toLowerCase()===p.sha256.toLowerCase())))throw new Error("Original photo hash mismatch");
  } else if(kind==="identity") {
    result=z.object({identity:identitySchema,pairMatches:z.literal(true),frontFirst:z.literal(true),serialInspected:z.boolean(),evidence:text}).strict().parse(envelope.data);
    const i=result.identity as Identity;
    if(i.serial) {
      const m=/^(\d+)\/(\d+)$/.exec(i.serial);
      if(!result.serialInspected||!m||!i.printRun||Number(m[2])!==i.printRun||Number(m[1])<1||Number(m[1])>i.printRun)throw new Error("Serialized cards need an inspected, complete numerator/denominator");
    } else if(i.printRun)throw new Error("Missing physical serial");
    if(i.condition!==c.input.identity.condition)throw new Error("Condition override needs a direct user correction in the input source");
    if(i.autograph===null)throw new Error("Confirm autograph presence or absence during visual review");
  } else if(kind==="pricing") {
    const payload=z.object({comps:z.unknown(),tracked:z.boolean(),envelopeEligible:z.boolean(),evidence:text,
      basis:z.enum(["exact","related-print-run","active-lowest","seller-asking"]).default("exact"),exactSearchEvidence:text.optional()}).strict().parse(envelope.data);
    if((payload.basis==="active-lowest"||payload.basis==="seller-asking")&&!payload.exactSearchEvidence)throw Error("Active fallback requires saved-source and sold-evidence gap record");
    if(payload.basis==="related-print-run"&&!payload.exactSearchEvidence)throw new Error("Related estimates require evidence that usable exact sold comps were unavailable");
    const i=reviewedIdentity(c)!,validated=validateComps(i,payload.comps,now,payload.basis);
    result={...validated,premiumReasons:cardPremiumReasons(i),colorMatchReviewed:!!i.colorMatch,projection:pricingProjection(validated.buyerTotalMean,payload.basis,{patch:i.patch,tracked:payload.tracked,override:c.input.override},validated.asking),envelopeEligible:payload.envelopeEligible,tracked:payload.tracked,evidence:payload.evidence,exactSearchEvidence:payload.exactSearchEvidence};
  } else if(kind==="reconcile") {
    const payload=z.object({seller:z.literal("imaydit58"),disposition:z.enum(["clear","live","draft","scheduled","sold","ambiguous"]),
      checkedAt:z.string().datetime(),scopes:z.array(z.enum(["active","drafts","scheduled","sold"])),
      itemId:z.string().optional(),url:https.optional(),evidence:text}).strict().parse(envelope.data);
    if(Date.parse(payload.checkedAt)>Date.parse(now)||Date.parse(now)-Date.parse(payload.checkedAt)>CARD_POLICY.reconciliationMaxAgeMinutes*60000)throw new Error("Reconciliation observation is not fresh");
    if(payload.disposition==="clear"&&new Set(payload.scopes).size!==4)throw new Error("Clearance needs active, draft, scheduled and sold checks");
    if(payload.disposition==="ambiguous")throw new Error("Ambiguous inventory must be held");
    if(payload.disposition==="clear"&&existingReceipt(c))throw new Error("A saved receipt cannot be cleared by an absence check; retain and reconcile it");
    if(payload.disposition==="draft"&&existingReceipt(c)?.disposition==="draft"&&existingReceipt(c)?.itemId!==payload.itemId)throw new Error("A different draft requires explicit receipt reconciliation");
    if(payload.disposition!=="clear"&&!payload.itemId)throw new Error("Existing inventory requires a receipt ID");
    result=payload;
    if(payload.disposition==="clear")job.attemptsSinceClearance=0;
    if(payload.disposition!=="clear")c.exclusion={disposition:payload.disposition,itemId:payload.itemId!,evidence:payload.evidence};
  } else {
    // Listing text is deterministic. Workers cannot inject an executable Add action or an arbitrary price.
    z.object({prepare:z.literal(true)}).strict().parse(envelope.data);
    result=prepareLocalListing(c);
  }
  const elapsed=Math.max(0,Date.parse(now)-Date.parse(job.lease!.startedAt));
  const recovery=envelope.recovery;
  if(recovery?.when==="inventory-access")recordInventoryAccess(s,{observationId:job.lease!.token,available:false,evidence:envelope.reason!},now);
  job.recovery=recovery?{...recovery,...(recovery.when==="inventory-access"?{observedAccess:s.inventoryAccess?.observationId,blockedAt:now}:{})}:undefined;
  job.elapsedMs+=elapsed;delete job.lease;job.state=envelope.outcome;job.result=result;job.reason=envelope.reason;
  if(kind==="pricing"&&elapsed>=CARD_POLICY.researchLimitSeconds*1000&&job.state!=="done") {
    c.pricingDeferral={identityKey:fingerprint(reviewedIdentity(c)),at:now,evidence:job.reason??"Pricing deadline reached",elapsedMs:elapsed};
    job.reason=[job.reason,"30-second pricing limit reached; continue an unpriced draft"].filter(Boolean).join("; ");
  }
  c.updatedAt=now;event(s,id,kind,envelope.outcome,envelope.reason??"Result validated",now);refreshJobs(c,now);
  if(kind==="identity"&&envelope.outcome==="done")delete c.identityCorrectionHolds;
}
/** Recover only a retained local queue-write failure after re-reading the same original bytes. */
export function recoverPhotoWriteFailure(s:QueueState,id:string,raw:unknown,now=new Date().toISOString(),sellerHolds:Record<string,string>={}) {
  const value=z.object({inputKey:text,reason:text,hashes:z.array(z.object({side:z.enum(["front","back"]),sha256:text}).strict()).length(2)}).strict().parse(raw);
  const c=s.cards[id],j=c?.jobs.photos;
  if(!c||!j||j.state!=="held"||j.inputKey!==value.inputKey||j.reason!==value.reason
    ||!/^EPERM: operation not permitted, rename '.+[\\/]state\.[\w-]+\.tmp' -> '.+[\\/]state\.json'$/.test(value.reason))throw new Error("Not the current held queue-write failure");
  if(c.input.sourceHold||sellerHolds[id]||jobBlockers(s,c,"photos",sellerHolds[id]).length
    ||j.attempts>=CARD_POLICY.maxAttemptsPerInput)throw new Error("Protected hold or attempt limit prevents recovery");
  for(const side of ["front","back"] as const) {
    const observed=value.hashes.filter(h=>h.side===side),original=c.input.photos.filter(p=>p.side===side);
    if(observed.length!==1||original.length!==1||observed[0].sha256.toLowerCase()!==original[0].sha256.toLowerCase())throw new Error("Original photo bytes changed; recovery refused");
  }
  // Run the ordinary claim/complete contract on a transaction copy. Rejection changes nothing.
  const candidate=structuredClone(s),evidence="Targeted EPERM recovery: retained front/back originals re-read and SHA-256 verified; queue write retried atomically.";
  retryHeld(candidate,id,"photos",evidence,now);
  const claim=claimJob(candidate,"local-write-recovery","photos",id,now,sellerHolds);
  if(!claim)throw new Error("Photo recovery could not claim the unchanged input");
  completeJob(candidate,id,"photos",claim.job.lease!.token,{outcome:"done",data:{hashes:value.hashes,evidence}},now,sellerHolds);
  Object.assign(s,candidate);
}
/** Reopen a mistaken completed review under the queue lock; correction still needs a normal claim. */
export function reopenIdentityReview(s:QueueState,id:string,snapshot:string,evidence:string,now=new Date().toISOString(),sellerHolds:Record<string,string>={},savedDraftId?:string) {
  const c=s.cards[id];
  if(!c||fingerprint(c)!==snapshot)throw Error("Card snapshot changed; reread before reopening identity");
  if(!evidence.trim()||evidence.length>2000)throw Error("Correction evidence required (maximum 2000 characters)");
  if(sellerHolds[id]||c.jobs.identity.state!=="done"||kinds.some(k=>c.jobs[k].state==="leased"))throw Error("Completed unleased review without seller hold required");
  const lifecycle=c.draftLifecycle;
  if(lifecycle) {
    if(!savedDraftId||lifecycle.draftId!==savedDraftId||lifecycle.state!=="saved"
      ||c.input.knownLive||c.exclusion||Object.values(s.verifiedReceipts??{}).some(receipt=>receipt.cardId===id)||s.photoArchives?.[id]
      ||s.draftWriter?.lease||Object.values(s.draftCreationGroups??{}).some(g=>g.members.includes(id))
      ||Object.values(s.cards).some(other=>other!==c&&other.draftLifecycle?.draftId===savedDraftId)
      ||(lifecycle.operation&&(!lifecycle.failure||lifecycle.failure.code!=="browser-recovery-exhausted"
        ||Date.parse(lifecycle.observedAt)<Date.parse(lifecycle.operation.startedAt))))
      throw Error("Saved-draft recovery requires exact ID, settled failed operation, no writer lease, group, receipt or archive");
  } else if(savedDraftId)throw Error("Saved draft recovery requires a retained lifecycle");
  const jobs=JSON.parse(JSON.stringify(c.jobs)) as Record<JobKind,Job>;
  c.identityReviewHistory??=[];
  c.identityReviewHistory.push({at:now,evidence,snapshot,jobs,...(lifecycle?{draftLifecycle:structuredClone(lifecycle)}:{}),...(c.pricingDeferral?{pricingDeferral:structuredClone(c.pricingDeferral)}:{}),...(c.pricingEvidence?{pricingEvidence:JSON.parse(JSON.stringify(c.pricingEvidence))}:{})});
  delete c.pricingEvidence;
  delete c.pricingDeferral;
  if(lifecycle) {
    c.draftLifecycle={binding:lifecycle.binding,draftId:lifecycle.draftId,url:lifecycle.url,
      state:"unknown",observedAt:now,evidence, failure:{code:"identity-review-reopened",binding:lifecycle.binding,
        evidenceKey:fingerprint(evidence),reason:"Identity correction requires fresh observation of the same external ID",at:now}};
  }
  c.identityCorrectionHolds={};
  for(const kind of kinds.filter(k=>k!=="photos")) {
    const prior=jobs[kind];
    if(prior.state==="held")c.identityCorrectionHolds[kind]={reason:prior.reason,attempts:prior.attempts,elapsedMs:prior.elapsedMs};
    c.jobs[kind]={kind,inputKey:jobInputKey(c,kind),state:prior.state==="held"?"held":"todo",attempts:0,elapsedMs:0,
      ...c.identityCorrectionHolds[kind]};
  }
  c.updatedAt=now;
  event(s,id,"identity","review-reopened",JSON.stringify({snapshot,evidence}),now);
}
/** Explicit completed visual review recovery; never grants another unattended retry. */
export function recoverExpiredIdentity(s:QueueState,id:string,raw:unknown,now=new Date().toISOString(),sellerHolds:Record<string,string>={}) {
  const value=z.object({snapshot:text,hashes:z.array(z.object({side:z.enum(["front","back"]),sha256:text}).strict()).length(2),result:z.unknown()}).strict().parse(raw);
  const c=s.cards[id],j=c?.jobs.identity;
  if(!c||fingerprint(c)!==value.snapshot||!j||j.state!=="held"
    ||j.reason!=="Lease expired; prior worker is fenced from completing"
    ||j.attempts!==CARD_POLICY.maxAttemptsPerInput||j.result||c.identityReviewHistory?.length
    ||c.input.sourceHold||sellerHolds[id]||c.draftLifecycle||kinds.some(k=>c.jobs[k].state==="leased"))throw Error("Only the current exhausted lease-only identity hold can be recovered");
  for(const side of ["front","back"] as const) {
    const observed=value.hashes.filter(h=>h.side===side),original=c.input.photos.filter(p=>p.side===side);
    if(observed.length!==1||original.length!==1||observed[0].sha256.toLowerCase()!==original[0].sha256.toLowerCase())throw Error("Original photo bytes changed");
  }
  const envelope=z.object({outcome:z.literal("done"),data:z.record(z.string(),z.unknown())}).strict().parse(value.result);
  const candidate=structuredClone(s),copy=candidate.cards[id],prior=structuredClone(copy.jobs);
  copy.jobs.identity={...copy.jobs.identity,state:"todo",attempts:0};
  const claim=claimJob(candidate,"explicit-identity-recovery","identity",id,now,sellerHolds);
  if(!claim)throw Error("Identity recovery blocked by ordinary ownership or dependency guards");
  completeJob(candidate,id,"identity",claim.job.lease!.token,envelope,now,sellerHolds);
  copy.jobs.identity.attempts=j.attempts+1;
  copy.identityReviewHistory=[{at:now,evidence:String(envelope.data.evidence??""),snapshot:value.snapshot,jobs:prior}];
  event(candidate,id,"identity","expired-review-recovered","Original hashes verified; prior attempts retained; completed review validated",now);
  Object.assign(s,candidate);
}
export function retryHeld(s:QueueState,id:string,kind:JobKind,evidence:string,now=new Date().toISOString()) {
  if(s.cards[id])refreshJobs(s.cards[id],now);
  const j=s.cards[id]?.jobs[kind];if(!j||j.state!=="held")throw new Error("Only a held job can be retried");
  if(!evidence.trim()||retryAttempts(j)>=CARD_POLICY.maxAttemptsPerInput)throw new Error("New input evidence is required after the attempt limit");
  j.state="todo";j.reason=`Retry supported by: ${evidence}`;event(s,id,kind,"retry",evidence,now);
  delete j.recovery;
}
/** Explicit local observation, never a per-card inventory clearance or an eBay write. */
export function recordInventoryAccess(s:QueueState,raw:unknown,now=new Date().toISOString()) {
  const value=z.object({observationId:z.string().regex(/^[\w-]{1,100}$/),available:z.boolean(),evidence:z.string().trim().min(1).max(2000)}).strict().parse(raw);
  const key=fingerprint(value),previous=s.inventoryAccessObservations?.[value.observationId];
  if(previous) {if(previous!==key)throw new Error("Access observation ID already has different evidence");return false;}
  s.inventoryAccessObservations??={};s.inventoryAccessObservations[value.observationId]=key;
  s.inventoryAccess={...value,at:now};event(s,"*","reconcile","inventory-access",JSON.stringify(value),now);return true;
}
/** Classify one legacy hold against its exact current snapshot; never infer release from prose. */
export function setHoldRecovery(s:QueueState,id:string,raw:unknown,now=new Date().toISOString(),sellerHolds:Record<string,string>={}) {
  const value=z.object({inputKey:text,reason:z.string().min(1).max(2000),evidence:text,recovery:recoverySchema}).strict().parse(raw);
  const c=s.cards[id];if(!c)throw new Error("Unknown card");refreshJobs(c,now);
  const j=c.jobs.reconcile;
  if(sellerHolds[id]||alreadyListed(c))throw new Error("Seller hold or existing receipt prevents hold recovery");
  if(j.state!=="held"||j.inputKey!==value.inputKey||j.reason!==value.reason)throw new Error("Held reconciliation snapshot changed; review it again");
  if(retryAttempts(j)>=CARD_POLICY.maxAttemptsPerInput)throw new Error("Unchanged input reached attempt limit");
  if(j.recovery)throw new Error("Hold already has a recovery condition");
  const blockers=jobBlockers(s,c,"reconcile").filter(reason=>reason!=="Inventory access unavailable; record a new successful access observation before reconciliation");
  if(blockers.length)throw new Error(`Card prerequisites block hold classification: ${blockers.join("; ")}`);
  let blockedAt:string|undefined;
  if(value.recovery.when==="inventory-access") {
    const held=s.events.findLast(e=>e.cardId===id&&e.kind==="reconcile"&&e.event==="held");
    if(!held||held.detail!==j.reason||!Number.isFinite(Date.parse(held.at))||!(Date.parse(held.at)<=Date.parse(now)))
      throw new Error("Matching dated hold evidence required for inventory-access classification");
    blockedAt=held.at;
  }
  // Classifying historical evidence is not a new observation of shared inventory access.
  j.recovery={...value.recovery,...(blockedAt?{blockedAt,observedAccess:s.inventoryAccess?.available===false?s.inventoryAccess.observationId:undefined}:{})};
  event(s,id,"reconcile","hold-classified",JSON.stringify(value),now);
}
/** Admit genuinely changed, validated sold evidence; completion still requires a fresh lease. */
export function admitPricingEvidence(s:QueueState,id:string,raw:unknown,now=new Date().toISOString()) {
  const c=s.cards[id];if(!c)throw new Error("Unknown card");
  refreshJobs(c,now);
  if(c.jobs.pricing.state!=="held")throw new Error("New evidence intake requires a held pricing job");
  if(jobBlockers(s,c,"pricing").length||c.jobs.listing.state==="leased")throw new Error("Card prerequisites or active listing work block new evidence");
  const payload=z.object({comps:z.unknown(),basis:z.enum(["exact","related-print-run","active-lowest","seller-asking"]).default("exact"),evidence:text,exactSearchEvidence:text.optional()}).strict().parse(raw);
  if((payload.basis==="active-lowest"||payload.basis==="seller-asking")&&!payload.exactSearchEvidence)throw Error("Active fallback requires saved-source and sold-evidence gap record");
  if(payload.basis==="related-print-run"&&!payload.exactSearchEvidence)throw new Error("Related estimates require exact-search evidence");
  const identity=reviewedIdentity(c)!,validated=validateComps(identity,payload.comps,now,payload.basis);
  // Prose edits and reordering cannot reset attempts. Keep substantive sale facts only.
  const key=fingerprint([fingerprint(identity),payload.basis,validated.comps.map(({evidence,...facts})=>({...facts,identity:{...facts.identity,colorMatch:facts.identity.colorMatch?{matches:facts.identity.colorMatch.matches}:undefined}})).sort((a,b)=>('saleId' in a?a.saleId:a.listingId).localeCompare('saleId' in b?b.saleId:b.listingId))]);
  if(c.pricingEvidence?.key===key||c.pricingEvidenceHistory?.some(h=>h.key===key))throw new Error("Evidence was already admitted; unchanged holds cannot reset attempts");
  c.pricingEvidenceHistory??=[];
  c.pricingEvidenceHistory.push({key,previousJob:structuredClone(c.jobs.pricing)});
  c.pricingEvidence={key,identityKey:fingerprint(identity),comps:validated.comps,basis:payload.basis,evidence:payload.evidence,exactSearchEvidence:payload.exactSearchEvidence,at:now};
  event(s,id,"pricing","new-evidence",`${key}: ${payload.evidence}`,now);
  c.updatedAt=now;refreshJobs(c,now);
  return {id,evidenceKey:key,state:c.jobs.pricing.state,previousAttempts:c.pricingEvidenceHistory.at(-1)!.previousJob.attempts};
}
function rulePriceBinding(c:CardRecord) {
  const r=c.jobs.pricing.result;
  return fingerprint({identity:reviewedIdentity(c),photos:c.input.photos,projection:r?.projection,comps:r?.comps,basis:r?.basis,override:c.input.override});
}
export function approvedRulePrice(c:CardRecord,now=new Date().toISOString()) {
  const r=c.jobs.pricing.result, approval=r?.ruleCorrectionApproval as {at:string;evidence:string;binding:string}|undefined;
  const projection=r?.projection as ReturnType<typeof calculateCardPrice>|undefined;
  if(c.jobs.pricing.state!=="done"||!reviewedIdentity(c))return null;
  try {validateComps(reviewedIdentity(c)!,r?.comps,now,r?.basis as CompBasis|undefined);}catch{return null;}
  return c.jobs.pricing.state==="done" && reviewedIdentity(c) && projection?.policyVersion===CARD_POLICY_VERSION && approval?.evidence
    && Number.isFinite(Date.parse(approval.at)) && Date.parse(approval.at)<=Date.parse(now) && approval.binding===rulePriceBinding(c)
    ? {projection,approvedAt:approval.at,evidence:approval.evidence} : null;
}
/** Bounded, audited formula correction. Never supplies missing evidence or changes an external listing. */
export function correctSavedPrices(s:QueueState,ids:string[],authority:string,apply=false,now=new Date().toISOString()) {
  if(!ids.length||ids.length>50||new Set(ids).size!==ids.length||ids.some(id=>!s.cards[id]))throw new Error("Select 1–50 distinct known cards");
  if(!authority.trim())throw new Error("Price correction requires the seller's recorded authority");
  const working=apply?s:structuredClone(s);
  const rows=ids.map(id=>{
    const c=working.cards[id],old=c.jobs.pricing.result,identity=reviewedIdentity(c);
    const skip=(reason:string)=>({id,status:"skipped",reason});
    if(c.jobs.pricing.state!=="done"||!old||!identity||c.jobs.photos.state!=="done")return skip("Validated pricing, reviewed identity and original-photo audit required");
    if(c.jobs.listing.state==="leased")return skip("Listing worker holds an active lease");
    if(c.input.override)return skip("Explicit seller override retained");
    const conflicts=jobBlockers(working,c,"pricing").filter(reason=>!reason.startsWith("Already live or existing"));
    if(conflicts.length)return skip(conflicts.join("; "));
    try {
      refreshJobs(c,now);
      if(c.jobs.pricing.state!=="done")return skip(c.jobs.pricing.reason??"Inputs changed; use normal worker protocol");
      const validated=validateComps(identity,old.comps,now,old.basis as CompBasis|undefined);
      const projection=pricingProjection(validated.buyerTotalMean,old.basis as CompBasis,{patch:identity.patch,tracked:old.tracked===true},validated.asking);
      const prior=old.projection as ReturnType<typeof calculateCardPrice>;
      const changed=prior.item!==projection.item||prior.shipping!==projection.shipping;
      if(prior.policyVersion===CARD_POLICY_VERSION&&fingerprint(prior)===fingerprint(projection)&&approvedRulePrice(c,now))return {id,status:"unchanged",changed:false,previous:prior,projection};
      const listingWasDone=c.jobs.listing.state==="done";
      c.jobs.pricing.result={...old,...validated,projection,premiumReasons:cardPremiumReasons(identity),colorMatchReviewed:!!identity.colorMatch,
        correctionHistory:[...((old.correctionHistory as unknown[])??[]),{at:now,previous:prior,authority}]};
      c.jobs.pricing.result.ruleCorrectionApproval={at:now,evidence:authority,binding:rulePriceBinding(c)};
      c.updatedAt=now;
      refreshJobs(c,now);
      // Refresh already-prepared local text; never create a new draft or consume a worker lease.
      if(listingWasDone){c.jobs.listing.result=prepareLocalListing(c);c.jobs.listing.state="done";}
      event(working,id,"pricing","rule-correction",JSON.stringify({previous:prior,projection,authority}),now);
      return {id,status:apply?"corrected":"proposed",changed,previous:prior,projection,premiumReasons:cardPremiumReasons(identity),colorMatchReviewed:!!identity.colorMatch};
    } catch(error) {return skip(error instanceof Error?error.message:"Evidence validation failed");}
  });
  if(apply)working.policyVersion=CARD_POLICY_VERSION;
  return {asOf:now,applied:apply,policyVersion:CARD_POLICY_VERSION,authority,canUpload:false,canPublish:false,rows};
}
export function quarantineImport(s:QueueState,id:string,reason:string,now=new Date().toISOString()) {
  const c=s.cards[id];if(!c)return;
  const message=`Source import requires review: ${reason}`;
  if(c.input.sourceHold===message)return;
  c.input.sourceHold=message;c.updatedAt=now;
  for(const kind of kinds){const job=c.jobs[kind];job.state="held";job.reason=message;delete job.lease;delete job.result;delete job.recovery;}
  event(s,id,"import","held",message,now);
  // Retain these holds until a valid import or an explicit, evidenced retry changes the input.
  for(const kind of kinds)c.jobs[kind].inputKey=jobInputKey(c,kind);
}
export function listingTitle(i:Identity):string {
  const format=(set:string,parallel:string)=>[i.season,set,i.player,`#${i.cardNumber}`,parallel,i.serial].filter(Boolean).join(" ").replace(/\s+/g," ").trim();
  const set=i.set.toLowerCase().startsWith(`${i.manufacturer.toLowerCase()} `)?i.set.slice(i.manufacturer.length).trim():i.set;
  const parallel=/\bPrizm\b/i.test(set)?i.parallel.replace(/\s+Prizm$/i,""):i.parallel;
  // Sport remains in item specifics. Remove only an exact trailing sport label;
  // never truncate product, player, parallel, card number or serial information.
  const sport=i.sport.trim();
  const season=i.season.trim();
  const seasonless=season&&set.toLowerCase().startsWith(`${season.toLowerCase()} `)?set.slice(season.length).trim():set;
  const brandless=seasonless.toLowerCase().startsWith(`${i.manufacturer.toLowerCase()} `)?seasonless.slice(i.manufacturer.length).trim():seasonless;
  const compactSet=sport&&brandless.toLowerCase().endsWith(` ${sport.toLowerCase()}`)?brandless.slice(0,-sport.length).trim():brandless;
  const compactTitle=[format(compactSet,parallel),i.autograph&&!/\b(auto|autograph|autographs)\b/i.test(`${compactSet} ${parallel}`)?"Auto":""].filter(Boolean).join(" ");
  // Use the established competition acronym only as a final overflow fallback.
  // The full competition/product wording remains in reviewed identity and specifics.
  const competitionTitle=/^\d{4}(?:-\d{2,4})?\b/.test(compactSet)?compactTitle:compactTitle.replace(/\bUEFA Champions League\b/g,"UCL");
  const mosaicTitle=/\bMosaic\b/i.test(compactSet)?competitionTitle.replace(/ Choice Peacock Mosaic(?= |$)/," Choice Peacock"):competitionTitle;
  // Dragon Scale identifies the Select foil variant without its generic Prizm suffix.
  const scaleTitle=/\bSelect\b/i.test(compactSet)&&/\bDragon Scale Prizm$/i.test(parallel)?format(compactSet,parallel.replace(/ Prizm$/i,"")):mosaicTitle;
  const universityTitle=scaleTitle.replace(/\bBowman University Chrome\b/g,"Bowman U Chrome");
  const title=[format(i.set,i.parallel),format(set,i.parallel),format(set,parallel),draftFields(i).title,compactTitle,competitionTitle,mosaicTitle,scaleTitle,universityTitle].find(value=>value.length<=80);
  if(!title)throw new Error("Title exceeds 80 characters after removing redundant brand words; verified wording needs review");
  return title;
}
export function localReviewListings(s:QueueState,now=new Date().toISOString(),sellerHolds:Record<string,string>={}):(JobResult & {id:string})[] {
  for(const c of Object.values(s.cards))refreshJobs(c,now);
  const blockers=createJobBlockerLookup(s);
  return Object.values(s.cards).filter(c=>c.jobs.listing.state==="done"&&!blockers(c,"listing",sellerHolds[c.input.id]).length)
    .map(c=>({id:c.input.id,...c.jobs.listing.result}));
}
export function prepareLocalListing(c:CardRecord):JobResult {
  const i=reviewedIdentity(c);if(!i)throw new Error("Identity review required");
  const title=listingTitle(i);
  return {action:"",seller:CARD_POLICY.seller,category:"261328",sku:c.input.sku,title,quantity:1,
    conditionType:"Ungraded",condition:i.condition,description:`${title}. One ungraded card. You will receive the exact card pictured. Please inspect both original photos.`,
    specifics:{Sport:i.sport,"Player/Athlete":i.player,Season:i.season,Manufacturer:i.manufacturer,Set:i.set,"Card Number":i.cardNumber,Team:i.team,"Parallel/Variety":i.parallel},
    pricing:c.jobs.pricing.state==="done"?c.jobs.pricing.result?.projection:null,
    priceBasis:c.jobs.pricing.state==="done"?c.jobs.pricing.result?.basis??"exact":null,
    priceBasisDetails:c.jobs.pricing.state==="done"?c.jobs.pricing.result?.basisDetails??null:null,
    priceNeedsReview:!approvedRulePrice(c),reviewEstimate:c.jobs.pricing.result?.reviewEstimate??false,
    premiumReasons:cardPremiumReasons(i),colorMatchReviewed:!!i.colorMatch,
    shippingNeedsReview:c.jobs.pricing.state!=="done"||(!c.jobs.pricing.result?.tracked&&!c.jobs.pricing.result?.envelopeEligible),
    promotion:{generalPercent:CARD_POLICY.generalPromotionPercent,priority:false},
    front:c.input.photos.find(p=>p.side==="front"),back:c.input.photos.find(p=>p.side==="back"),canUpload:false,canPublish:false};
}
export function queueSummary(s:QueueState,now=new Date().toISOString(),sellerHolds:Record<string,string>={},approvedPriceIds:readonly string[]=[]) {
  for(const c of Object.values(s.cards))refreshJobs(c,now);
  const blockersFor=createJobBlockerLookup(s),approved=new Set(approvedPriceIds);
  const conflicts=receiptOwnershipConflicts(s);
  const importExceptions=Object.entries(s.rejectedImports??{}).map(([id,{reason,sku,player}])=>({id,reason,sku:sku??null,player:player??null}));
  const cards=Object.values(s.cards),counts={cards:cards.length,alreadyListed:0,localListingsPrepared:0,excludedPreparedListings:0,receiptConflicts:conflicts.length,importExceptions:importExceptions.length,heldJobs:0,doneJobs:0,leasedJobs:0,actionableJobs:0,readyForUpload:0};
  const rows=cards.map(c=>{if(alreadyListed(c))counts.alreadyListed++;
    const jobs=kinds.map(kind=>{const j=c.jobs[kind],blockers=blockersFor(c,kind,sellerHolds[c.input.id]);
      if(j.state==="held")counts.heldJobs++;if(j.state==="done")counts.doneJobs++;if(j.state==="leased")counts.leasedJobs++;
      const recoverable=kind==="reconcile"&&recoverableWithBlockers(s,c,now,approved.has(c.input.id),()=>blockers);
      if((j.state==="todo"&&!blockers.length)||recoverable)counts.actionableJobs++;
      return {kind,state:j.state,attempts:j.attempts,elapsedMs:j.elapsedMs,owner:j.lease?.owner??null,reason:j.reason??null,recovery:j.recovery??null,recoverable,blockers};});
    if(c.jobs.listing.state==="done") {
      if(jobs.find(j=>j.kind==="listing")!.blockers.length)counts.excludedPreparedListings++;else counts.localListingsPrepared++;
    }
    const receipt=existingReceipt(c);
    return {id:c.input.id,sku:c.input.sku,player:(reviewedIdentity(c)??c.input.identity).player,serial:(reviewedIdentity(c)??c.input.identity).serial,existingReceipt:receipt,pricingHandoff:c.input.pricingHandoff??null,receiptConflicts:conflicts.filter(conflict=>conflict.cardIds.includes(c.input.id)).map(conflict=>conflict.itemId),liveItemId:receipt?.disposition==="live"?receipt.itemId:null,sourceHold:c.input.sourceHold??null,identityIssue:c.input.identityIssue??null,jobs};});
  const execution={automaticLocal:0,identityReview:0,pricingReview:0,inventoryReview:0,recoverableInventoryHolds:0};
  for(const row of rows)for(const job of row.jobs){
    if(job.recoverable)execution.recoverableInventoryHolds++;
    else if(job.state==="todo"&&!job.blockers.length){
      if(job.kind==="photos"||job.kind==="listing")execution.automaticLocal++;
      else if(job.kind==="identity")execution.identityReview++;
      else if(job.kind==="pricing")execution.pricingReview++;
      else execution.inventoryReview++;
    }
  }
  return {asOf:now,policyVersion:CARD_POLICY_VERSION,mode:s.mode,externalWriterPossible:s.externalWriterPossible,inventoryAccess:s.inventoryAccess??null,counts,execution,
    capabilities:{localPreparation:true,originalFileAudit:true,workerLeases:true,automaticPhotoHosting:false,liveListingWrites:false},
    globalHolds:["Hosted-image CSV route is not connected; native photo-upload and draft-first routes are separate and not automated here","Final eBay publication remains a user handoff","Existing Card Inbox automation has not adopted this queue"],receiptConflicts:conflicts,importExceptions,cards:rows};
}
