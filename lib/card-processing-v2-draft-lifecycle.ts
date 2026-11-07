import{validateV2QuantitySpecifics}from'./card-processing-v2-quantity-specifics.ts';
import { measureV2 } from "./card-processing-v2-timing.ts";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { digest, event, issue, consolidationKey, nowIso, payloadSchema, preparePayload, verifyReadback, type V2Card, type V2Payload, type V2State } from "./card-processing-v2.ts";
import { acquireV2Lock, readV2Config, readV2State, v2Dir, withV2State } from "./card-processing-v2-store.ts";
import { draftCsv, historicalMethodReview } from "./card-processing-v2-transport.ts";
import { observedV2DraftId } from "./card-processing-v2-observation-values.ts";
import { assessV2Description } from "./card-processing-v2-description.ts";
import { readV2ResetTransfers } from "./card-processing-v2-reset.ts";
import { resolveV2ArchivedPhoto, recoverV2DraftArchivesAfterOperation } from "./card-processing-v2-draft-archive.ts";

const text = z.string().trim().min(1).max(300), hash = z.string().regex(/^[a-f0-9]{64}$/), id = z.string().regex(/^\d+$/);
const feedJobId = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const evidenceSchema = z.object({ path: text, sha256: hash }).strict();
export const v2DraftPoliciesSchema = z.object({ payment: text, returns: z.literal("No Return Accepted"), shipping: text.nullable(), location: text,
  pricingShippingUnresolved: z.boolean(),
}).strict().refine(p => p.shipping !== null || p.pricingShippingUnresolved, "Shipping must be bound or explicitly unresolved");
export const v2DraftReconciliationSchema = z.object({
  seller: z.literal("imaydit58"), observedAt: z.string().datetime(), source: z.literal("live-seller-read"),
  scopes: z.object({ drafts: z.literal(true), active: z.literal(true), sold: z.literal(true), scheduled: z.literal(true) }).strict(),
  captures: z.array(z.object({ captureId: hash, sku: text, disposition: z.enum(["absent", "draft", "live", "sold", "scheduled"]), id: id.optional() }).strict()).min(1),
  expectedPolicies: v2DraftPoliciesSchema, evidence: evidenceSchema,
}).strict();
/** Seller-authorized throughput route: no remote inventory absence is claimed. */
export const v2SellerDuplicateRiskReconciliationSchema = z.object({
  seller:z.literal('imaydit58'), observedAt:z.string().datetime(), source:z.literal('seller-accepted-duplicate-risk'), instructionId:text,
  captures:z.array(z.object({captureId:hash,sku:text,disposition:z.literal('duplicate-risk-accepted'),id:z.never().optional()}).strict()).min(1),
  expectedPolicies:v2DraftPoliciesSchema,evidence:evidenceSchema,
}).strict();
export const v2DraftReconciliationInputSchema=z.union([v2DraftReconciliationSchema,v2SellerDuplicateRiskReconciliationSchema]);
const reconciliationBodySchema=z.union([v2DraftReconciliationSchema.omit({evidence:true}),v2SellerDuplicateRiskReconciliationSchema.omit({evidence:true})]);
export async function readV2SellerDuplicateRiskAuthority(root:string,instructionId:string){
 const queue=JSON.parse(await fs.readFile(path.join(root,'artifacts/engineering-mission/work-queue.json'),'utf8'));
 const instruction=queue.instructions?.find((i:{id:string})=>i.id===instructionId);
 if(!instruction||typeof instruction.text!=='string'||!instruction.text.trim()||!Number.isFinite(Date.parse(instruction.capturedAt))||Date.parse(instruction.capturedAt)>Date.now()||!instruction.policyRefs?.includes('seller-accepts-existing-inventory-duplicates')||!Array.isArray(instruction.taskIds)||!instruction.taskIds.some((id:string)=>queue.tasks?.some((t:{id:string})=>t.id===id))||queue.instructions.some((i:{supersedes?:string[]})=>i.supersedes?.includes(instructionId)))throw Error('Current captured seller acceptance of existing inventory duplicate risk required');
 return instruction as {id:string;text:string;capturedAt:string;taskIds:string[];policyRefs:string[]};
}
async function validateDuplicateRiskReconciliation(root:string,reconciliation:z.infer<typeof v2DraftReconciliationInputSchema>,background:z.infer<typeof v2BackgroundDraftAuthoritySchema>|undefined,cards:V2Card[],historical=false){
 if(reconciliation.source!=='seller-accepted-duplicate-risk')return;
 if(!background)throw Error('Seller duplicate-risk acceptance requires the dedicated background route');
 const instruction=await readV2SellerDuplicateRiskAuthority(root,reconciliation.instructionId);
 if(Date.parse(reconciliation.observedAt)<Date.parse(instruction.capturedAt))throw Error('Duplicate-risk evidence predates seller authorization');
 if(historical)await validateV2BackgroundScope(root,background,cards);else await validateV2BackgroundAuthority(root,background,cards);
}
function clearedCapture(reconciliation:z.infer<typeof v2DraftReconciliationInputSchema>,capture:{disposition:string;id?:string}){return !capture.id&&capture.disposition===(reconciliation.source==='seller-accepted-duplicate-risk'?'duplicate-risk-accepted':'absent');}
function sameReconciliationRoute(a:z.infer<typeof v2DraftReconciliationInputSchema>,b:z.infer<typeof v2DraftReconciliationInputSchema>){return a.source===b.source&&(a.source!=='seller-accepted-duplicate-risk'||b.source==='seller-accepted-duplicate-risk'&&a.instructionId===b.instructionId);}
export const v2ImportReceiptSchema = z.object({ jobId: feedJobId, draftId: id, observedAt: z.string().datetime(), evidence: evidenceSchema }).strict();
export const v2SavedDraftSchema = z.object({ kind: z.literal("saved-reopened-ebay-draft"), seller: z.literal("imaydit58"), draftId: id,
  url: z.string().url(), observedAt: z.string().datetime(), payload: payloadSchema, policies: v2DraftPoliciesSchema,
  savedItemPrice: z.null(), savedShippingAmount: z.number().nonnegative().nullable(), editorErrors: z.array(text), evidence: evidenceSchema,
}).strict();
export const v2ReviewedDescriptionSchema = z.object({ kind: z.literal("reviewed-ebay-ai-description"), seller: z.literal("imaydit58"), draftId: id,
  url: z.string().url(), generatedAt: z.string().datetime(), observedAt: z.string().datetime(), capability: z.literal("ebay-editor-description-ai"),
  reviewer: text, reviewed: z.literal(true), unsupportedClaims: z.literal(false), contradictions: z.literal(false),
  beforePayloadHash: hash, title: payloadSchema.shape.title, categoryId: payloadSchema.shape.categoryId, specifics: payloadSchema.shape.specifics,
  description: payloadSchema.shape.description, evidence: evidenceSchema,
}).strict();
export type V2DraftReconciliation = z.infer<typeof v2DraftReconciliationInputSchema>;
export type V2ImportReceipt = z.infer<typeof v2ImportReceiptSchema>;
export type V2SavedDraft = z.infer<typeof v2SavedDraftSchema>;
export type V2ReviewedDescription = z.infer<typeof v2ReviewedDescriptionSchema>;
type Evidence = z.infer<typeof evidenceSchema>;
const pilotSchema = z.object({ instructionId: text, admissionInstructionId: text.optional(), expiresAt: z.string().datetime(), captureIds: z.array(hash).min(1).max(20) }).strict();
export const v2BackgroundDraftAuthoritySchema = z.object({instructionId:text,batchId:z.string().uuid(),expiresAt:z.string().datetime(),captureIds:z.array(hash).min(1).max(20)}).strict();
export const v2DraftBeginOptionsSchema = z.union([z.object({pilot:pilotSchema}).strict(),z.object({background:v2BackgroundDraftAuthoritySchema}).strict()]);
/** Explicit seller-authorized dedicated browser route; never impersonates the
 * historical internal-browser pilot or claims the bulk method was validated. */
export async function readV2BackgroundAuthority(root:string,instructionId:string){
 const queue=JSON.parse(await fs.readFile(path.join(root,'artifacts/engineering-mission/work-queue.json'),'utf8'));
 const instruction=queue.instructions?.find((i:{id:string})=>i.id===instructionId),required=['dedicated-background-browser-authorized','leave-pricing-alone','draft-only-no-publication','preserve-all-photo-bytes'];
 if(!instruction||typeof instruction.text!=='string'||!instruction.text.trim()||!Number.isFinite(Date.parse(instruction.capturedAt))||required.some(p=>!instruction.policyRefs?.includes(p))||!instruction.taskIds?.includes('v2-background-runner-20261105')||!queue.tasks?.some((t:{id:string})=>t.id==='v2-background-runner-20261105')||queue.instructions.some((i:{supersedes?:string[]})=>i.supersedes?.includes(instructionId)))throw Error('Current captured dedicated-background draft-only authority required');
 return instruction as {id:string;text:string;capturedAt:string;taskIds:string[];policyRefs:string[]};
}
export async function validateV2BackgroundAuthority(root:string,raw:unknown,cards:V2Card[]){
 const authority=v2BackgroundDraftAuthoritySchema.parse(raw);
 if(Date.parse(authority.expiresAt)<=Date.now()||Date.parse(authority.expiresAt)>Date.now()+3600000)throw Error('Background authority requires exact current captures and expiry within60minutes');
 return validateV2BackgroundScope(root,authority,cards);
}
async function validateV2BackgroundScope(root:string,authority:z.infer<typeof v2BackgroundDraftAuthoritySchema>,cards:V2Card[]){
 const instruction=await readV2BackgroundAuthority(root,authority.instructionId);
 if(new Set(authority.captureIds).size!==authority.captureIds.length||digest([...authority.captureIds].sort())!==digest(cards.map(c=>c.captureId).sort()))throw Error('Background authority requires exact current captures and expiry within60minutes');
 const {processingBatchSchema}=await import('./card-processing-v2-processing-batches.ts'),file=path.join(root,'artifacts/card-processing-v2/processing-batches',authority.batchId+'.json'),st=await fs.lstat(file);
 if(!st.isFile()||st.isSymbolicLink()||st.size>262144)throw Error('Exact accepted background batch required');
 const batch=processingBatchSchema.parse(JSON.parse(await fs.readFile(file,'utf8')));
 if(batch.jobId!==authority.batchId||batch.status==='failed'||Date.parse(batch.clickedAt)<Date.parse(instruction.capturedAt)||cards.some(c=>batch.captures.filter(b=>(!b.cardId||b.cardId===c.id)&&digest(b.photos.map(p=>p.hash).sort())===digest(c.photos.map(p=>p.hash).sort())).length!==1))throw Error('Background authority does not bind this exact newly accepted photo selection');
 return authority;
}

function fresh(at: string, lowerBound?: string) {
  const stamp = Date.parse(at), age = Date.now() - stamp;
  if (!Number.isFinite(stamp) || age < 0 || age > 60 * 60 * 1000 || (lowerBound && stamp < Date.parse(lowerBound))) throw Error("Fresh exact seller observation within 60 minutes is required");
}
async function evidenceValue(root: string, reference: Evidence) {
  if (path.isAbsolute(reference.path) || reference.path.split(/[\\/]/).includes("..")) throw Error("Operation evidence must remain inside artifacts");
  const base = await fs.realpath(path.join(root, "artifacts"));
  const filename = await fs.realpath(path.join(root, reference.path)); const relative = path.relative(base, filename);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw Error("Operation evidence must remain inside artifacts");
  const stat = await fs.stat(filename); if (!stat.isFile() || stat.size > 1_000_000) throw Error("Operation evidence exceeds bounded file size");
  const bytes = await fs.readFile(filename);
  if (createHash("sha256").update(bytes).digest("hex") !== reference.sha256) throw Error("Operation evidence hash changed");
  return JSON.parse(bytes.toString("utf8")) as unknown;
}
async function writeOperation(root: string, kind: string, data: unknown) {
  const dir = path.join(v2Dir(root), "operations"); await fs.mkdir(dir, { recursive: true });
  const relative = `artifacts/card-processing-v2/operations/${kind}-${randomUUID()}.json`;
  const bytes = Buffer.from(JSON.stringify(data, null, 2)); const out = await fs.open(path.join(root, relative), "wx");
  try { await out.writeFile(bytes); await out.sync(); } finally { await out.close(); }
  return `${relative}#sha256=${createHash("sha256").update(bytes).digest("hex")}`;
}
async function readOperation(root: string, reference: string) {
  const match = /^(.*)#sha256=([a-f0-9]{64})$/.exec(reference);
  if (!match) throw Error("Bound operation checkpoint is missing");
  return evidenceValue(root, { path: match[1], sha256: match[2] });
}
const capturesFor = (s: V2State, payload: V2Payload) => Object.values(s.cards).filter(c => payload.captureIds.includes(c.captureId));
const capturesHash = (cards: V2Card[]) => digest(cards.map(c => ({ id: c.id, sku: c.sku, captureId: c.captureId, photos: c.photos, identity: c.identity,
  groupId: c.groupId, title: c.title, description: c.description, descriptionSource: c.descriptionSource, condition: c.condition, resetTransfer: c.resetTransfer })).sort((a, b) => a.id.localeCompare(b.id)));
/** A baseline exception belongs only to a committed, hash-bound, explicitly
 * authorized reset transfer. A disappeared draft or a caller-supplied marker is
 * never sufficient, and positive inventory/condition/source guards survive. */
async function verifiedResetCards(root: string, cards: V2Card[]) {
  const selected = cards.filter(c => c.resetTransfer); const accepted = new Set<string>(); if (!selected.length) return accepted;
  const handoff = await readV2ResetTransfers(root);
  const engineering = JSON.parse(await fs.readFile(path.join(root, "artifacts/engineering-mission/work-queue.json"), "utf8")) as { instructions?: Record<string, unknown>[] };
  const normalize = (value: string) => path.resolve(value).toLowerCase();
  for (const card of selected) {
    const claimed = card.resetTransfer!, transfer = handoff.transfers[claimed.legacyCardId];
    if (!transfer || !transfer.released || transfer.owner !== "card-processing-v2" || transfer.resetId !== claimed.resetId || transfer.receipt !== claimed.receipt
      || transfer.hardHolds.length || transfer.positiveDispositions.length || digest([...transfer.photoHashes].sort()) !== digest(card.photos.map(p => p.hash).sort())) throw Error("Reset transfer does not match committed unheld exact capture ownership");
    const receipt = handoff.receipts.find(r => r.resetId === claimed.resetId && r.authority?.instructionId === claimed.instructionId);
    const pair = receipt?.pairs.find(p => p.legacyCardId === claimed.legacyCardId);
    const instruction = engineering.instructions?.find(i => i.id === claimed.instructionId);
    const oldResetAuthority=receipt?.kind==='v2-scoped-local-reset-receipt'&&instruction?.text==='Reset local records and matching eBay drafts'&&Array.isArray(instruction.taskIds)&&instruction.taskIds.includes('card-processing-v2-reset-20261103')&&Array.isArray(instruction.policyRefs)&&instruction.policyRefs.includes('scoped-local-reset-and-matching-ebay-draft-removal');
    const preservedTransferAuthority=receipt?.kind==='v2-legacy-ownership-transfer-receipt'&&receipt.legacyRecordsPreserved&&Array.isArray(instruction?.taskIds)&&instruction.taskIds.includes(receipt.authority.taskId)&&Array.isArray(instruction?.policyRefs)&&['scoped-legacy-v2-transfer','selected-original-paths','preserve-existing-work','internal-browser-only','draft-only-no-publication','leave-pricing-alone'].every(p=>(instruction.policyRefs as unknown[]).includes(p));
    if (!receipt || !pair || !instruction || (!oldResetAuthority&&!preservedTransferAuthority)
      || digest(instruction) !== receipt.authority.instructionHash || instruction.capturedAt !== receipt.authority.capturedAt
      || receipt.owner !== "card-processing-v2" || !receipt.released || !receipt.photosPreserved || receipt.sourceFilesMoved !== 0 || receipt.sourceFilesDeleted !== 0 || !receipt.auditPreserved
      || transfer.retiredAt !== receipt.committedAt || !Number.isFinite(Date.parse(receipt.committedAt)) || Date.parse(receipt.committedAt) > Date.now() || Date.parse(receipt.committedAt) < Date.parse(receipt.authority.capturedAt) || Date.parse(card.createdAt) < Date.parse(receipt.committedAt)
      || pair.guards.hardHolds.length || pair.guards.positiveDispositions.length || pair.guards.condition !== card.condition || pair.photos.length !== 2
      // Reset transfers photo ownership, not legacy orientation/identity. The new
      // OpenAI review establishes front/back; its result is frozen in capturesHash.
      || card.photos.some(p => !pair.photos.some(original => normalize(original.path) === normalize(p.path) && original.sha256.toLowerCase() === p.hash))) throw Error("Reset receipt, exact pair guards or captured reset authority do not match this card");
    accepted.add(card.id);
  }
  return accepted;
}
async function verifyOriginals(cards: V2Card[], folder: string, root: string) {
  const transferred = await verifiedResetCards(root, cards);
  const sourceRoot = await fs.realpath(folder).catch(error => { if (cards.every(c => transferred.has(c.id)) && error.code === "ENOENT") return path.resolve(folder); throw error; });
  for (const card of cards) for (const photo of card.photos) {
    const original = await fs.realpath(await resolveV2ArchivedPhoto(root,card,photo)), relative = path.relative(sourceRoot, original);
    if ((!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) && !transferred.has(card.id)) throw Error("Original photo escaped the configured source folder");
    const stat = await fs.stat(original); if (!stat.isFile() || stat.size > 100 * 1024 * 1024) throw Error("Original photo exceeds bounded file size");
    if (createHash("sha256").update(await fs.readFile(original)).digest("hex") !== photo.hash) throw Error("Original photo changed since preparation");
  }
}
function ownCaptureSet(s: V2State, key: string) {
  const submission = s.submissions[key]; if (!submission) throw Error("Unknown V2 submission intent");
  const cards = capturesFor(s, submission.payload);
  if (cards.length !== submission.payload.captureIds.length || cards.some(c => c.groupId !== submission.groupId)) throw Error("Submission no longer owns the exact capture group");
  if (Object.values(s.submissions).some(other => other.key !== key && (other.draftId && other.draftId === submission.draftId || other.payload.captureIds.some(c => submission.payload.captureIds.includes(c))))) throw Error("Submission capture or draft ownership overlaps another intent");
  return { submission, cards };
}
const beginSchema = z.object({ kind: z.literal("v2-draft-begin"), key: hash, groupId: text, payload: payloadSchema, capturesHash: hash,
  reconciliation: v2DraftReconciliationInputSchema, at: z.string().datetime(), canPublish: z.literal(false),
  methodStatus: z.enum(["validated", "pilot-unvalidated", "background-authorized-unvalidated"]).optional(), pilot: pilotSchema.optional(), background:v2BackgroundDraftAuthoritySchema.optional(),
}).strict();
const amendmentSchema = z.object({ kind: z.literal("v2-draft-description-amendment"), key: hash, draftId: id, originalBegin: text, previousCheckpoint: text,
  previousPayloadHash: hash, previousCapturesHash: hash, nextPayload: payloadSchema, nextCapturesHash: hash, observation: v2ReviewedDescriptionSchema, at: z.string().datetime(),
}).strict();
const descriptionsFor = (cards: V2Card[], payload: V2Payload) => cards.map(c => ({ ...c, description: payload.description, descriptionSource: payload.descriptionSource }));
function descriptionBinds(packet: V2ReviewedDescription, keyPayload: V2Payload, draftId: string, cards:V2Card[]) {
  return packet.draftId === draftId && observedV2DraftId(packet.url) === draftId
    && packet.beforePayloadHash === digest(keyPayload) && packet.title === keyPayload.title && packet.categoryId === keyPayload.categoryId && digest(packet.specifics) === digest(keyPayload.specifics)
    && Date.parse(packet.generatedAt) <= Date.parse(packet.observedAt) && cards.every(c=>c.identity&&assessV2Description(packet.description,c.identity).acceptable);
}
/** Replay immutable description-only amendments against the original intent. The
 * current capture records are reconstructed at each prior text version, proving
 * that no identity, photo, condition, quantity or other prepared field changed. */
async function expectedDraft(root: string, s: V2State, key: string, cards: V2Card[]) {
  await verifiedResetCards(root, cards);
  const submission = s.submissions[key];
  const beginIndex = s.events.findIndex(e => e.stage === "draft-intent" && cards.some(c => c.id === e.cardId));
  if (beginIndex < 0) throw Error("Original write-ahead checkpoint is missing");
  const originalBegin = s.events[beginIndex].detail;
  const begin = beginSchema.parse(await readOperation(root, originalBegin));
  if (begin.key !== key || begin.groupId !== submission.groupId || capturesHash(descriptionsFor(cards, begin.payload)) !== begin.capturesHash) throw Error("Original capture fields changed after the write-ahead intent");
  let payload = begin.payload, capturesKey = begin.capturesHash, checkpoint = originalBegin;
  for (const entry of s.events.slice(beginIndex + 1).filter(e => e.stage === "draft-description-reviewed" && cards.some(c => c.id === e.cardId))) {
    const amendment = amendmentSchema.parse(await readOperation(root, entry.detail));
    const observation = amendment.observation;
    const { evidence: _reference, ...body } = observation;
    const retained = v2ReviewedDescriptionSchema.omit({ evidence: true }).parse(await evidenceValue(root, observation.evidence));
    const descriptionOnly = payloadSchema.parse({ ...payload, description: observation.description, descriptionSource: "ebay-ai-reviewed" });
    if (amendment.key !== key || amendment.draftId !== submission.draftId || amendment.originalBegin !== originalBegin || amendment.previousCheckpoint !== checkpoint
      || amendment.previousPayloadHash !== digest(payload) || amendment.previousCapturesHash !== capturesKey || digest(retained) !== digest(body)
      || !descriptionBinds(observation, payload, submission.draftId ?? "",cards) || !verifyReadback(amendment.nextPayload, descriptionOnly)
      || amendment.nextCapturesHash !== capturesHash(descriptionsFor(cards, descriptionOnly))) throw Error("Description amendment chain does not preserve the original intent");
    payload = amendment.nextPayload; capturesKey = amendment.nextCapturesHash; checkpoint = entry.detail;
  }
  if (!verifyReadback(payload, submission.payload) || capturesHash(cards) !== capturesKey) throw Error("Current draft fields differ from their bound intent and reviewed amendments");
  return { begin, originalBegin, payload, capturesKey, checkpoint };
}

/** Read-only saved quantity ownership gate, shared by strict review/audit.
 * Reuses the original intent and description amendment chain; no new write. */
export async function validateV2NonpriceGroupOwnership(root:string,key:string,state?:V2State){
 const s=state??await readV2State(root),{submission,cards}=ownCaptureSet(s,key);
 if(submission.status!=='submitted'||!submission.draftId||submission.payload.quantity!==cards.length||cards.length!==submission.payload.captureIds.length||cards.some(c=>c.stage!=='prepared'||c.draftId!==submission.draftId||c.issues.length||!c.identity||c.identity.damage||c.identity.graded||c.groupId!==submission.groupId||consolidationKey(c)!==submission.groupId))throw Error('Exact unheld matching quantity members required');
 await validateV2QuantitySpecifics(root,cards);
 if(Object.values(s.cards).some(c=>c.groupId===submission.groupId&&!submission.payload.captureIds.includes(c.captureId)))throw Error('Quantity group contains foreign captures');
 await expectedDraft(root,s,key,cards);await verifyOriginals(cards,(await readV2Config(root)).folder,root);
 return cards.map(c=>c.id);
}
const renewalSchema=z.object({kind:z.literal('v2-draft-authorization-renewal'),key:hash,originalBegin:text,previousCheckpoint:text,payloadHash:hash,capturesHash:hash,reconciliation:v2DraftReconciliationInputSchema,pilot:pilotSchema.optional(),background:v2BackgroundDraftAuthoritySchema.optional(),at:z.string().datetime(),browserLease:z.object({jobId:hash,owner:text,token:hash}).strict().optional()}).strict();
const renewalPacketSchema=z.object({reconciliation:v2DraftReconciliationInputSchema,pilot:pilotSchema.optional(),background:v2BackgroundDraftAuthoritySchema.optional(),browserLease:z.object({jobId:hash,owner:text,token:hash}).strict().optional()}).strict();
async function currentRenewalAuthority(root:string,pilot:z.infer<typeof pilotSchema>|undefined,original:z.infer<typeof pilotSchema>|undefined,captureIds:string[]){
 if(!original){if(pilot||(await historicalMethodReview(root)).status!=='validated')throw Error('Renewal method authority changed');return;}
 if(!pilot||pilot.instructionId!==original.instructionId||pilot.admissionInstructionId!==original.admissionInstructionId||digest([...pilot.captureIds].sort())!==digest([...captureIds].sort())||new Set(pilot.captureIds).size!==captureIds.length)throw Error('Renewal must preserve exact original pilot authority and captures');
 const q=JSON.parse(await fs.readFile(path.join(root,'artifacts/engineering-mission/work-queue.json'),'utf8')),a=q.instructions?.find((i:{id:string})=>i.id===pilot.instructionId);
 if(!a||!a.policyRefs?.includes('card-processing-v2-draft-pilot')||!a.taskIds?.includes('card-processing-v2-live-validation-20261103')||q.instructions.some((i:{supersedes?:string[]})=>i.supersedes?.includes(a.id)||original.admissionInstructionId&&i.supersedes?.includes(original.admissionInstructionId)))throw Error('Original pilot authority missing or superseded');
}
async function validateRenewalRoute(root:string,next:{pilot?:z.infer<typeof pilotSchema>;background?:z.infer<typeof v2BackgroundDraftAuthoritySchema>},original:{pilot?:z.infer<typeof pilotSchema>;background?:z.infer<typeof v2BackgroundDraftAuthoritySchema>},cards:V2Card[],historical=false){
 if(original.background){const a=next.background,b=original.background;if(next.pilot||!a||a.instructionId!==b.instructionId||a.batchId!==b.batchId||digest([...a.captureIds].sort())!==digest([...b.captureIds].sort()))throw Error('Renewal must preserve exact background authority and batch');if(historical)await validateV2BackgroundScope(root,a,cards);else await validateV2BackgroundAuthority(root,a,cards);return;}
 if(next.background)throw Error('Renewal cannot change the original execution route');
 await currentRenewalAuthority(root,next.pilot,original.pilot,cards.map(c=>c.captureId));
}
async function authorizationForUpload(root:string,state:V2State,key:string,cards:V2Card[],expected:Awaited<ReturnType<typeof expectedDraft>>){
 let authorization={reconciliation:expected.begin.reconciliation,pilot:expected.begin.pilot,background:expected.begin.background,at:expected.begin.at},checkpoint=expected.originalBegin;
 for(const e of state.events.filter(e=>e.stage==='draft-authorization-renewed'&&cards.some(c=>c.id===e.cardId))){const r=renewalSchema.parse(await readOperation(root,e.detail));
 if(r.key!==key||r.originalBegin!==expected.originalBegin||r.previousCheckpoint!==checkpoint||r.payloadHash!==digest(expected.payload)||r.capturesHash!==expected.capturesKey||!sameReconciliationRoute(r.reconciliation,expected.begin.reconciliation)||digest(r.reconciliation.expectedPolicies)!==digest(expected.begin.reconciliation.expectedPolicies))throw Error('Authorization renewal chain changed');
 const {evidence,...body}=r.reconciliation;if(digest(await evidenceValue(root,evidence))!==digest(body)||r.reconciliation.captures.length!==cards.length||cards.some(c=>!r.reconciliation.captures.some(x=>x.captureId===c.captureId&&x.sku===c.sku&&clearedCapture(r.reconciliation,x))))throw Error('Renewal source or exact absent capture scope changed');
 await validateRenewalRoute(root,r,expected.begin,cards,true);await validateDuplicateRiskReconciliation(root,r.reconciliation,r.background,cards,true);authorization={reconciliation:r.reconciliation,pilot:r.pilot,background:r.background,at:r.at};checkpoint=e.detail;}
 return {...authorization,checkpoint};
}
async function untouchedRenewalTransport(root:string,key:string,payload:V2Payload,lease:z.infer<typeof renewalPacketSchema>['browserLease']){
 let found=false;const dir=path.join(v2Dir(root),'browser-jobs');for(const name of await fs.readdir(dir).catch((e:NodeJS.ErrnoException)=>{if(e.code==='ENOENT')return [];throw e;})){if(!/^[a-f0-9]{64}\.json$/.test(name))continue;const j=JSON.parse(await fs.readFile(path.join(dir,name),'utf8'));if(j.stage==='superseded'||!j.groups?.some((g:{payload:V2Payload})=>g.payload.captureIds.some(c=>payload.captureIds.includes(c))))continue;
 if(found||!lease||j.id!==lease.jobId||j.stage!=='ready-upload'||j.lease?.owner!==lease.owner||j.lease?.token!==lease.token||j.uploadEvidence||j.groups.some((g:{key?:string,payload:V2Payload})=>g.payload.captureIds.some(c=>payload.captureIds.includes(c))&&(g.key!==key||!verifyReadback(g.payload,payload))))throw Error('Renewal requires exact owned untouched ready-upload browser job');
 if(digest(j.groups.map(({key:_key,...g}:{key?:string})=>g))!==j.id)throw Error('Frozen browser job changed');if(j.csvPath){if(j.csvPath!==`artifacts/card-processing-v2/browser-jobs/${j.id}.csv`||createHash('sha256').update(await fs.readFile(path.join(root,j.csvPath))).digest('hex')!==j.csvSha256)throw Error('Frozen browser CSV changed');}found=true;}
 if(lease&&!found)throw Error('Renewal browser lease has no exact job');
 const uploads=path.join(v2Dir(root),'uploads');for(const name of await fs.readdir(uploads).catch((e:NodeJS.ErrnoException)=>{if(e.code==='ENOENT')return [];throw e;})){if(!name.endsWith('.json'))continue;const j=JSON.parse(await fs.readFile(path.join(uploads,name),'utf8'));if(j.bindings?.some((b:{key:string})=>b.key===key))throw Error('Existing uploader checkpoint prohibits authorization renewal');}
}
/** Timing/authorization-only renewal of an exact never-sent intent. Original
 * intent, payload, source observations, CSV and capture ownership are immutable. */
export async function renewV2DraftAuthorization(root:string,key:string,raw:unknown){const packet=renewalPacketSchema.parse(raw),bridgeRelease=await (await import('./card-processing-v2-browser-upload-workflow.ts')).acquireV2BrowserBridgeLock(root);let release:(()=>Promise<void>)|undefined;try{release=await acquireV2Lock('worker',root);
 const state=await readV2State(root),{submission,cards}=ownCaptureSet(state,key);if(submission.status!=='intent'||submission.draftId||cards.some(c=>c.draftId||c.stage!=='prepared'||c.issues.length))throw Error('Only untouched unheld intents may renew authorization');
 const expected=await expectedDraft(root,state,key,cards),prior=await authorizationForUpload(root,state,key,cards,expected);if(submission.evidence!==expected.originalBegin)throw Error('Intent already has a non-original external checkpoint');
 await untouchedRenewalTransport(root,key,submission.payload,packet.browserLease);await validateRenewalRoute(root,packet,expected.begin,cards);await validateDuplicateRiskReconciliation(root,packet.reconciliation,packet.background,cards);
 if(packet.pilot&&(Date.parse(packet.pilot.expiresAt)<=Date.now()||Date.parse(packet.pilot.expiresAt)>Date.now()+3600000))throw Error('Renewal pilot expiry must be within 60 minutes');
 fresh(packet.reconciliation.observedAt);if(Date.parse(packet.reconciliation.observedAt)<Date.parse(prior.reconciliation.observedAt))throw Error('Renewal cannot backdate seller evidence');const {evidence,...body}=packet.reconciliation;
 if(!sameReconciliationRoute(packet.reconciliation,expected.begin.reconciliation)||digest(await evidenceValue(root,evidence))!==digest(body)||digest(body.expectedPolicies)!==digest(expected.begin.reconciliation.expectedPolicies)||body.captures.length!==cards.length||new Set(body.captures.map(c=>c.captureId)).size!==cards.length||cards.some(c=>!body.captures.some(r=>r.captureId===c.captureId&&r.sku===c.sku&&clearedCapture(packet.reconciliation,r))))throw Error('Fresh exact absent inventory and unchanged policies required');
 const cfg=await readV2Config(root);await verifyOriginals(cards,cfg.folder,root);const rep=cards.find(c=>c.sku===submission.payload.sku),category=cfg.categories.find(c=>c.categoryId===rep?.identity?.categoryId);if(!rep||!category||!verifyReadback(preparePayload(rep,cards,category,rep.photos.flatMap(p=>state.media[p.hash]?[state.media[p.hash]]:[])),submission.payload))throw Error('Current payload differs from frozen intent');
 const checkpoint=await writeOperation(root,'authorization-renewal',{kind:'v2-draft-authorization-renewal',key,originalBegin:expected.originalBegin,previousCheckpoint:prior.checkpoint,payloadHash:digest(submission.payload),capturesHash:expected.capturesKey,reconciliation:packet.reconciliation,...(packet.pilot?{pilot:packet.pilot}:{}),...(packet.background?{background:packet.background}:{}),...(packet.browserLease?{browserLease:packet.browserLease}:{}),at:nowIso()});
 await withV2State(s=>{if(digest(s.submissions[key])!==digest(submission)||capturesHash(capturesFor(s,submission.payload))!==expected.capturesKey)throw Error('Intent changed during renewal');event(s,'draft-authorization-renewed',checkpoint,rep.id);},root);return{key,checkpoint};
 }finally{try{await release?.();}finally{await bridgeRelease();}}}
/** Fresh, read-only write-boundary validation. The uploader already holds the
 * worker lease; known tasks may resume GET-only without passing a new-write gate. */
export async function validateV2DraftForUpload(root: string, key: string) {
  const state = await readV2State(root), { submission, cards } = ownCaptureSet(state, key);
  if (submission.status !== "intent" || submission.draftId || cards.some(c => c.draftId || c.stage !== "prepared" || c.issues.length)) throw Error("New upload requires unheld prepared captures and an untouched new-draft intent");
  const expected = await expectedDraft(root, state, key, cards);
  const authorization=await authorizationForUpload(root,state,key,cards,expected);
  fresh(authorization.reconciliation.observedAt); fresh(authorization.at);
  if(authorization.background)await validateV2BackgroundAuthority(root,authorization.background,cards);
  await validateDuplicateRiskReconciliation(root,authorization.reconciliation,authorization.background,cards);
  if (authorization.pilot) { if (Date.parse(authorization.pilot.expiresAt) <= Date.now()) throw Error("Scoped pilot authority expired before upload; reconcile the existing intent"); }
  else if (!authorization.background&&(await historicalMethodReview(root)).status !== "validated") throw Error("The bound upload method no longer has valid live evidence");
  const config = await readV2Config(root); await verifyOriginals(cards, config.folder, root);
  const representative = cards.find(c => c.sku === submission.payload.sku), category = config.categories.find(c => c.categoryId === representative?.identity?.categoryId);
  if (!representative || !category) throw Error("Current representative card/category evidence is missing");
  const photos = representative.photos.flatMap(p => state.media[p.hash] ? [state.media[p.hash]] : []);
  if (!verifyReadback(preparePayload(representative, cards, category, photos), submission.payload)) throw Error("Current listing completeness differs from the frozen upload intent");
  return submission.payload;
}

/** Persist an exact new-draft intent before the separately supported operator upload.
 * This function never uploads, invokes eBay AI identification, or publishes. */
async function beginV2DraftTimedLocal(root: string, groupId: string, rawPayload: unknown, rawReconciliation: unknown, rawOptions?: unknown): Promise<string> {
  const payload = payloadSchema.parse(rawPayload), reconciliation = v2DraftReconciliationInputSchema.parse(rawReconciliation);
  const options = rawOptions === undefined ? undefined : v2DraftBeginOptionsSchema.parse(rawOptions);
  const release = await acquireV2Lock("worker", root);
  try {
    const method = await historicalMethodReview(root);
    let pilot: z.infer<typeof pilotSchema> | undefined;
    const background=options&&"background" in options?options.background:undefined;
    let authorizedAfter = "";
    if(background){await readV2BackgroundAuthority(root,background.instructionId);}
    else if (method.status !== "validated") {
      if (!options||!("pilot" in options)) throw Error("Bulk method remains unvalidated; no draft intent or upload is authorized without a scoped real-capture pilot instruction");
      pilot = options.pilot;
      if (Date.parse(pilot.expiresAt) <= Date.now() || Date.parse(pilot.expiresAt) > Date.now() + 60 * 60000 || digest([...pilot.captureIds].sort()) !== digest([...payload.captureIds].sort()) || new Set(pilot.captureIds).size !== pilot.captureIds.length) throw Error("Pilot requires exact current capture scope and an expiry within 60 minutes");
      const engineering = z.object({ instructions: z.array(z.object({ id: text, capturedAt: z.string().datetime({offset:true}), taskIds: z.array(z.string()), policyRefs: z.array(z.string()), supersedes: z.array(z.string()).optional() }).passthrough()), tasks: z.array(z.object({id:z.string(),status:z.string()}).passthrough()).optional() }).passthrough()
        .parse(JSON.parse(await fs.readFile(path.join(root, "artifacts/engineering-mission/work-queue.json"), "utf8")));
      const instructions=engineering.instructions;
      const authority = instructions.find(i => i.id === pilot!.instructionId);
      if (!authority || !authority.policyRefs.includes("card-processing-v2-draft-pilot") || !authority.taskIds.includes("card-processing-v2-live-validation-20261103")) throw Error("A captured current V2 draft-only pilot instruction and linked live-validation task are required");
      if(instructions.some(i=>i.supersedes?.includes(authority.id))) throw Error("Current pilot authority was superseded");
      authorizedAfter = authority.capturedAt;
      if(pilot.admissionInstructionId){
        fresh(authority.capturedAt); // Fresh current execution authorization remains mandatory.
        const admission=instructions.find(i=>i.id===pilot!.admissionInstructionId),requiredPolicies=["draft-only-no-publication","internal-browser-only","preserve-all-photo-bytes"];
        const sharedTasks=admission?.taskIds.filter(t=>t!=="card-processing-v2-live-validation-20261103"&&authority.taskIds.includes(t)&&engineering.tasks?.some(task=>task.id===t&&task.status==="in-progress"))??[];
        if(!admission||admission.id===authority.id||Date.parse(admission.capturedAt)>Date.parse(authority.capturedAt)||!sharedTasks.length||requiredPolicies.some(p=>!admission.policyRefs.includes(p)||!authority.policyRefs.includes(p))||instructions.some(i=>i.supersedes?.includes(admission.id))) throw Error("Admission boundary requires an earlier unsuperseded captured request for the same active concrete task and protected scope");
        authorizedAfter=admission.capturedAt;
      }
    }
    fresh(reconciliation.observedAt);
    const body = reconciliationBodySchema.parse(await evidenceValue(root, reconciliation.evidence));
    const { evidence: _reconciliationReference, ...reconciliationBody } = reconciliation;
    if (digest(body) !== digest(reconciliationBody)) throw Error("Reconciliation evidence does not match the supplied observation");
    const config = await readV2Config(root);
    const result = await withV2State(async s => {
      if (Object.values(s.submissions).some(sub => sub.groupId === groupId || sub.payload.captureIds.some(c => payload.captureIds.includes(c)))) throw Error("A submission intent already owns these captures. Reconcile its result; never reupload");
      const cards = capturesFor(s, payload), representative = cards.find(c => c.sku === payload.sku);
      if (!representative || cards.length !== payload.captureIds.length || Object.values(s.cards).filter(c => c.groupId === groupId).length !== cards.length
        || cards.some(c => c.groupId !== groupId || c.stage !== "prepared" || c.draftId || c.issues.length || c.title !== payload.title || c.description !== payload.description || c.descriptionSource !== payload.descriptionSource)) throw Error("Prepared exact current capture group is required");
      await validateV2QuantitySpecifics(root,cards);
      const resetCards = await verifiedResetCards(root, cards);
      if(background)await validateV2BackgroundAuthority(root,background,cards);
      await validateDuplicateRiskReconciliation(root,reconciliation,background,cards);
      if (pilot && (!s.baseline || cards.some(c => (!resetCards.has(c.id) || Boolean(pilot!.admissionInstructionId)) && (Date.parse(c.createdAt) < Date.parse(authorizedAfter) || c.photos.some(p => s.baseline!.hashes.includes(p.hash)))))) throw Error("Pilot authority covers only newly admitted captures or exact authorized committed reset transfers; activation originals and unfinished inventory remain protected");
      if (reconciliation.captures.length !== cards.length || new Set(reconciliation.captures.map(c => c.captureId)).size !== cards.length
        || cards.some(c => !reconciliation.captures.some(r => r.captureId === c.captureId && r.sku === c.sku))) throw Error("Fresh reconciliation must bind every exact capture and SKU");
      if (reconciliation.captures.some(c => !clearedCapture(reconciliation,c))) {
        for (const card of cards) issue(card, "EXISTING_INVENTORY", "Existing draft/live/sold/scheduled evidence requires same-ID reconciliation; new creation is excluded.", "Inventory reconciliation");
        event(s, "draft-intent-held", "Fresh seller reconciliation found existing inventory; no new intent created"); return { error: "Existing inventory cannot create a new V2 draft" };
      }
      // Freeze every original's bytes before upload, including grouped non-representative copies.
      try { await verifyOriginals(cards, config.folder, root); }
      catch {
        for (const card of cards) issue(card, "ORIGINAL_CHANGED", "Original photo changed or is unreadable; reconcile the frozen capture before creating any draft.", "Photo evidence");
        event(s, "draft-intent-held", "Original evidence changed; no external operation began"); return { error: "Original photo changed or is unreadable" };
      }
      const category = config.categories.find(c => c.categoryId === representative.identity?.categoryId);
      if (!category) throw Error("Current verified category requirements are missing");
      const photos = representative.photos.flatMap(photo => s.media[photo.hash] ? [s.media[photo.hash]] : []);
      const current = preparePayload(representative, cards, category, photos);
      if (!verifyReadback(current, payload)) throw Error("Draft payload changed since completeness validation");
      draftCsv([payload]); // Candidate transport guards also apply at the write-ahead boundary.
      const key = digest({ workflow: "card-processing-v2-draft", groupId, payload });
      const checkpoint = await writeOperation(root, "begin", { kind: "v2-draft-begin", key, groupId, payload, capturesHash: capturesHash(cards), reconciliation, at: nowIso(), canPublish: false,
        methodStatus: background?"background-authorized-unvalidated":pilot ? "pilot-unvalidated" : "validated", ...(pilot ? { pilot } : {}),...(background?{background}:{}) });
      s.submissions[key] = { key, groupId, payload, status: "intent", evidence: checkpoint, at: nowIso() };
      for (const card of cards) { card.nextAction = "Upload this bound Draft handoff once through the supported route, then retain its import result. Unknown outcomes require reconciliation."; card.updatedAt = nowIso(); }
      event(s, "draft-intent", checkpoint, representative.id); return { key };
    }, root);
    if (result.error) throw Error(result.error); return result.key!;
  } finally { await release(); }
}

/** Import success maps the intent to its actual same draft ID. It is not verification. */
async function recordV2ImportTimedLocal(root: string, key: string, raw: unknown) {
  hash.parse(key); const receipt = v2ImportReceiptSchema.parse(raw); fresh(receipt.observedAt);
  const release = await acquireV2Lock("worker", root);
  try {
    const result = await withV2State(async s => {
      const { submission, cards } = ownCaptureSet(s, key); fresh(receipt.observedAt, submission.at);
      const row = z.object({ kind: z.literal("live-ebay-draft-import-row"), seller: z.literal("imaydit58"), action: z.literal("Draft"), jobId: feedJobId,
        draftId: id, sku: text, result: z.literal("Success"), observedAt: z.string().datetime(),
      }).strict().parse(await evidenceValue(root, receipt.evidence));
      if (row.jobId !== receipt.jobId || row.draftId !== receipt.draftId || row.sku !== submission.payload.sku || row.observedAt !== receipt.observedAt
        || submission.draftId && submission.draftId !== receipt.draftId || submission.jobId && submission.jobId !== receipt.jobId
        || Object.values(s.submissions).some(other => other.key !== key && other.draftId === receipt.draftId)
        || cards.some(c => c.draftId && c.draftId !== receipt.draftId)) {
        submission.status = "uncertain";
        for (const card of cards) issue(card, "IMPORT_UNCERTAIN", "Import job, SKU or draft ID conflicts with the bound intent. Reconcile the same operation; do not reupload.", "Draft reconciliation");
        event(s, "import-uncertain", "Conflicting import observation retained without creating another draft"); return { error: "Import observation conflicts with intent ownership" };
      }
      if (submission.status === "verified") return { key, draftId: submission.draftId, status: submission.status };
      const checkpoint = await writeOperation(root, "import", { kind: "v2-draft-import", key, receipt, at: nowIso() });
      submission.draftId = receipt.draftId; submission.jobId = receipt.jobId; submission.status = "submitted"; submission.evidence = checkpoint;
      for (const card of cards) { card.draftId = receipt.draftId; card.issues = card.issues.filter(i => i.code !== "IMPORT_UNCERTAIN");
        if (!card.issues.length) { card.stage = "prepared"; card.nextAction = "Save and reopen this same eBay draft; verify all persisted fields and policies before marking it verified."; }
        card.updatedAt = nowIso(); }
      event(s, "draft-imported", checkpoint, cards[0].id); return { key, draftId: receipt.draftId, status: submission.status };
    }, root);
    if (result.error) throw Error(result.error); return result;
  } finally { await release(); }
}

/** The available eBay editor must actually generate the description, followed by
 * an attributable factual review. This records that observation only; it invokes
 * no invented AI endpoint and cannot change any other prepared listing field. */
async function reviewV2DraftDescriptionTimedLocal(root: string, key: string, raw: unknown) {
  hash.parse(key); const packet = v2ReviewedDescriptionSchema.parse(raw); fresh(packet.generatedAt); fresh(packet.observedAt, packet.generatedAt);
  const release = await acquireV2Lock("worker", root);
  try {
    return await withV2State(async s => {
      const { submission, cards } = ownCaptureSet(s, key); fresh(packet.generatedAt, submission.at);
      if (!submission.draftId || !submission.jobId || submission.status === "intent" || submission.status === "verified" || cards.some(c => c.verification)) throw Error("Description review requires the same imported draft before verification");
      if (cards.some(c => c.issues.some(i => !["SAVED_FIELDS", "ORIGINAL_CHANGED"].includes(i.code)))) throw Error("Preserve seller, identity, condition, import and ownership holds before reviewing a description");
      const { evidence: _reference, ...body } = packet;
      const retained = v2ReviewedDescriptionSchema.omit({ evidence: true }).parse(await evidenceValue(root, packet.evidence));
      if (digest(retained) !== digest(body)) throw Error("Description review evidence does not match the supplied observation");
      const expected = await expectedDraft(root, s, key, cards);
      if (!descriptionBinds(packet, expected.payload, submission.draftId,cards)) throw Error("Description review must preserve the same draft, title, category, item specifics and factual identity");
      await verifyOriginals(cards, (await readV2Config(root)).folder, root);
      const nextPayload = payloadSchema.parse({ ...expected.payload, description: packet.description, descriptionSource: "ebay-ai-reviewed" });
      const nextCapturesHash = capturesHash(descriptionsFor(cards, nextPayload));
      const checkpoint = await writeOperation(root, "description", { kind: "v2-draft-description-amendment", key, draftId: submission.draftId,
        originalBegin: expected.originalBegin, previousCheckpoint: expected.checkpoint, previousPayloadHash: digest(expected.payload), previousCapturesHash: expected.capturesKey,
        nextPayload, nextCapturesHash, observation: packet, at: nowIso() });
      submission.payload = nextPayload; submission.evidence = checkpoint;
      for (const card of cards) { card.description = packet.description; card.descriptionSource = "ebay-ai-reviewed"; card.updatedAt = nowIso();
        card.nextAction = "Reviewed eBay AI description retained. Save and reopen this same draft ID, then verify the full text and every other bound field."; }
      event(s, "draft-description-reviewed", checkpoint, cards[0].id);
      return { key, draftId: submission.draftId, payloadHash: digest(nextPayload), status: "description-reviewed-awaiting-save-reopen", canPublish: false };
    }, root);
  } finally { await release(); }
}

/** Record full saved/reopened evidence, release its lease, then recover authorized photo archival. */
async function verifyV2DraftLocal(root: string, key: string, raw: unknown) {
  hash.parse(key); const readback = v2SavedDraftSchema.parse(raw); fresh(readback.observedAt);
  const release = await acquireV2Lock("worker", root);
  try {
    const result = await withV2State(async s => {
      const { submission, cards } = ownCaptureSet(s, key); fresh(readback.observedAt, submission.at);
      if (!submission.draftId || !submission.jobId || !["submitted", "verified", "uncertain"].includes(submission.status)) throw Error("An actual imported same-ID draft is required before verification");
      if (cards.some(c => c.issues.some(i => !["IMPORT_UNCERTAIN", "SAVED_FIELDS", "ORIGINAL_CHANGED"].includes(i.code)))) throw Error("Preserve the capture's seller, identity, condition or ownership hold before verification");
      const stored = v2SavedDraftSchema.omit({ evidence: true }).parse(await evidenceValue(root, readback.evidence));
      const { evidence: _readbackReference, ...readbackBody } = readback;
      if (digest(stored) !== digest(readbackBody)) throw Error("Saved readback evidence does not match the supplied observation");
      let expected: Awaited<ReturnType<typeof expectedDraft>>;
      try { expected = await expectedDraft(root, s, key, cards); }
      catch {
        submission.status = "uncertain";
        for (const card of cards) issue(card, "SAVED_FIELDS", "Current fields or reviewed-description evidence differ from the original intent. Reconcile the same draft; never recreate it.", "Draft verification");
        event(s, "draft-verification-failed", "Original intent or immutable description amendment chain did not match"); return { error: "Saved draft does not match the original intent and reviewed amendments" };
      }
      if (readback.draftId !== submission.draftId || observedV2DraftId(readback.url) !== submission.draftId
        || !verifyReadback(expected.payload, readback.payload) || digest(expected.begin.reconciliation.expectedPolicies) !== digest(readback.policies) || readback.editorErrors.length) {
        submission.status = "uncertain";
        for (const card of cards) issue(card, "SAVED_FIELDS", "Saved/reopened draft fields or policy bindings differ. Repair and reopen this same draft ID; never create a replacement.", "Draft verification");
        event(s, "draft-verification-failed", "Bound saved-field mismatch retained; original photos were not moved"); return { error: "Saved draft does not match all bound fields and policies" };
      }
      if (submission.status !== "verified") {
        try { await verifyOriginals(cards, (await readV2Config(root)).folder, root); }
        catch {
          submission.status = "uncertain";
          for (const card of cards) issue(card, "ORIGINAL_CHANGED", "Original evidence changed after draft import. Preserve the same draft ID and reconcile photos before verification or archive.", "Photo evidence");
          event(s, "draft-verification-failed", "Original evidence changed; verification and archive remain pending"); return { error: "Original photo changed or is unreadable" };
        }
      }
      const checkpoint = await writeOperation(root, "verify", { kind: "v2-draft-verified", key, readback, at: nowIso(), archive: "pending-supported-receipt-handoff" });
      submission.status = "verified"; submission.evidence = checkpoint;
      for (const card of cards) {
        card.stage = "verified"; card.issues = []; card.draftId = readback.draftId;
        card.verification = { observedAt: readback.observedAt, evidence: checkpoint, payloadHash: digest(submission.payload) };
        card.nextAction = "eBay draft verified. Archive pending: use the supported receipt/archive handoff and verify every destination hash. Grok pricing remains unresolved.";
        card.updatedAt = nowIso();
        if (card.identity) s.knowledge[digest(card.photos.map(p => p.hash))] = { identity: card.identity, photoHashes: card.photos.map(p => p.hash), verifiedAt: readback.observedAt, evidence: checkpoint };
      }
      event(s, "draft-verified", checkpoint, cards[0].id); return { key, draftId: submission.draftId, status: submission.status, archive: "pending-supported-receipt-handoff", canPublish: false };
    }, root);
    if (result.error) throw Error(result.error); return result;
  } finally { await release(); }
}
export async function verifyV2Draft(root: string, key: string, raw: unknown) {
  const result=await measureV2(root,"saved-draft-verification",()=>verifyV2DraftLocal(root,key,raw),await submissionTimingContext(root,key));
  const archiveRecovery=await recoverV2DraftArchivesAfterOperation(root);
  return {...result,archiveRecovery};
}

export async function beginV2Draft(root: string, groupId: string, rawPayload: unknown, rawReconciliation: unknown, rawOptions?: unknown): Promise<string> { const state=await readV2State(root),cardIds=Object.values(state.cards).filter(c=>c.groupId===groupId).map(c=>c.id).slice(0,20); return measureV2(root,"draft-intent",()=>beginV2DraftTimedLocal(root,groupId,rawPayload,rawReconciliation,rawOptions),cardIds.length?{cardIds}:{}); }
export async function recordV2Import(root: string,key: string,raw: unknown) { return measureV2(root,"draft-import-receipt",()=>recordV2ImportTimedLocal(root,key,raw),await submissionTimingContext(root,key)); }
export async function reviewV2DraftDescription(root: string,key: string,raw: unknown) { return measureV2(root,"description-review",()=>reviewV2DraftDescriptionTimedLocal(root,key,raw),await submissionTimingContext(root,key)); }

async function submissionTimingContext(root:string,key:string){const state=await readV2State(root),groupId=state.submissions[key]?.groupId;const cardIds=Object.values(state.cards).filter(c=>groupId&&c.groupId===groupId).map(c=>c.id).slice(0,20);return cardIds.length?{cardIds}:{};}
