import {assertV2PreparedOrientation} from './card-processing-v2-photo-rotation.ts';
import { measureV2 } from "./card-processing-v2-timing.ts";
import { assessV2Description, factualV2Description } from './card-processing-v2-description.ts';
import { classifyV2IdentificationWarnings } from "./card-processing-v2-identification-warnings.ts";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { digest, event, identificationSchema, issue, nowIso, searchableTitle } from "./card-processing-v2.ts";
import { acquireV2Lock, processAlive, withV2State } from "./card-processing-v2-store.ts";

const ref = z.object({ path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
async function checkedEvidence(root: string, evidence: z.infer<typeof ref>, expected: unknown) {
  if (path.isAbsolute(evidence.path) || evidence.path.split(/[\\/]/).includes("..")) throw Error("Evidence must stay under artifacts.");
  const artifactRoot = await fs.realpath(path.join(root, "artifacts")), file = await fs.realpath(path.join(root, evidence.path));
  const relative = path.relative(artifactRoot, file);
  if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) throw Error("Evidence must stay under artifacts.");
  const stat = await fs.stat(file); if (!stat.isFile() || stat.size > 1_000_000) throw Error("Evidence exceeds the bounded review limit.");
  const bytes = await fs.readFile(file);
  if (createHash("sha256").update(bytes).digest("hex") !== evidence.sha256 || digest(JSON.parse(bytes.toString("utf8"))) !== digest(expected)) throw Error("Review evidence does not match the retained observation.");
}
function fresh(at: string) { const age = Date.now() - Date.parse(at); if (age < 0 || age > 3600000) throw Error("A fresh observed review within sixty minutes is required."); }
// An immutable original-pair observation remains valid while its exact body,
// ordered photos, current bytes and unsubmitted owner still pass below.
function identityObservedAt(at:string){const observed=Date.parse(at);if(!Number.isFinite(observed)||observed>Date.now())throw Error('Identity observation must have a valid non-future timestamp.');}
function assertIdle(s: { lastRun?: { status: string; pid: number } }) { if (s.lastRun?.status === "running" && processAlive(s.lastRun.pid)) throw Error("Wait for the current V2 worker before reconciling its results."); }
const identityReview = z.object({
  kind: z.literal("original-pair-identity-review"), cardId: z.string().min(1), reviewer: z.string().min(1), observedAt: z.string().datetime(),
  photoHashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).length(2), finding: identificationSchema, preparedOrientation: ref.optional(),
}).strict();
async function reviewV2IdentityTimedLocal(root: string, raw: unknown) {
  const packet = identityReview.extend({ evidence: ref }).parse(raw); const { evidence, ...body } = packet;
  identityObservedAt(body.observedAt); await checkedEvidence(root, evidence, body);
  // Evidence describes the current input order honestly. Only the working copy is canonicalized.
  const finding = structuredClone(body.finding);
  // The raw review keeps this precise orientation finding. Only the prepared
  // working copy may clear it, after the registered pair is validated below.
  if(body.preparedOrientation)finding.warnings=finding.warnings.filter(w=>w!=="Original front is upright; original back text is sideways and requires 90-degree counterclockwise derivative rotation before final upright approval.");
  const warningContext=body.preparedOrientation?{...finding,upright:true}:finding;
  if (!finding.identity || !finding.pairMatches || (!finding.upright&&!body.preparedOrientation) || finding.frontImageIndex === "unknown" || classifyV2IdentificationWarnings(warningContext).blocking.length || finding.identity.damage || finding.identity.graded) throw Error("Unresolved identity/condition cannot be approved.");
  const confirmedIdentity = finding.identity;
  return withV2State(async s => {
    assertIdle(s); const card = s.cards[body.cardId];
    if (!card || card.draftId || card.inventoryArchive || Object.values(s.submissions).some(sub => sub.groupId === card.groupId || sub.payload.captureIds.includes(card.captureId)) || digest(card.photos.map(p => p.hash)) !== digest(body.photoHashes)) throw Error("Review does not match a new owned original pair.");
    if(body.preparedOrientation){const {preparedOrientation,...rawObservation}=body;await assertV2PreparedOrientation(root,card,preparedOrientation,rawObservation);finding.upright=true;}
    const titleRecovery = card.issues.some(i => i.code === "TITLE");
    const allowedIssues = titleRecovery ? ["IDENTITY", "IDENTITY_REVIEW", "TITLE", "DESCRIPTION"] : ["IDENTITY", "IDENTITY_REVIEW", "IDENTIFICATION_SETUP", "IDENTIFICATION_BUDGET", "IDENTIFICATION_UNCERTAIN"];
    if (card.issues.some(i => !allowedIssues.includes(i.code))) throw Error("A separate source/condition/ownership hold must be resolved first.");
    if(titleRecovery&&card.issues.some(i=>i.code==='DESCRIPTION')){
      const generated=factualV2Description(confirmedIdentity,card.condition);
      if(card.descriptionSource!=='factual'||!card.identity||card.description!==factualV2Description(card.identity,card.condition)||!assessV2Description(generated,confirmedIdentity).acceptable)throw Error('Generated factual description recovery requires the exact original generator and valid corrected identity');
    }
    if (titleRecovery) {
      const title = searchableTitle(confirmedIdentity), serial = confirmedIdentity.serial;
      const invalidPlaceholder = Object.entries(confirmedIdentity).some(([key, value]) => !["team", "serial"].includes(key) && typeof value === "string" && /^(unknown|n\/a|unsure|not visible|unidentified)$/i.test(value.trim()));
      const stamp = /^(\d+)\s*\/\s*(\d+)$/.exec(serial);
      if (!title || title.length > 80 || /[\r\n<>]|^\s*[=+@-]/.test(title) || invalidPlaceholder || serial && (!stamp || Number(stamp[1]) < 1 || Number(stamp[1]) > Number(stamp[2]))) throw Error("Reviewed identity must produce a supported searchable title within 80 characters; TITLE remains held.");
    }
    for (const photo of card.photos) {
      const stat = await fs.lstat(photo.path); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 35_000_000) throw Error("Original is not available for this review.");
      if (createHash("sha256").update(await fs.readFile(photo.path)).digest("hex") !== photo.hash) throw Error("Original changed after review.");
    }
    if(finding.frontImageIndex==='1')card.photos=[{...card.photos[1],side:'front'},{...card.photos[0],side:'back'}];
    finding.frontImageIndex='0';
    card.identity = confirmedIdentity; card.identification = finding; card.issues = []; card.stage = "identified";
    card.identityReview = { path: evidence.path, sha256: evidence.sha256, reviewer: body.reviewer, observedAt: body.observedAt };
    card.title = ""; card.groupId = undefined; card.completenessInputKey = undefined; card.updatedAt = nowIso(); card.nextAction = "Consolidate reviewed identity and rerun completeness";
    event(s, "identity-reviewed", `Original-pair review retained: ${evidence.path}`, card.id); return { cardId: card.id, stage: card.stage };
  }, root);
}
const usageReview = z.object({
  kind: z.literal("provider-usage-reconciliation"), provider: z.literal("openai"), callId: z.string().min(1), model: z.string().min(1),
  observedAt: z.string().datetime(), source: z.string().min(1), inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(),
}).strict();
export async function reconcileV2Usage(root: string, raw: unknown) {
  const packet = usageReview.extend({ evidence: ref }).parse(raw); const { evidence, ...body } = packet;
  fresh(body.observedAt); await checkedEvidence(root, evidence, body);
  return withV2State(s => {
    assertIdle(s); const call = s.calls.find(c => c.id === body.callId);
    if (!call || call.status !== "uncertain" || !call.bound || call.model !== body.model || body.inputTokens > call.bound.maxInputTokens || body.outputTokens > call.bound.maxOutputTokens) throw Error("Usage does not reconcile the exact retained bounded call.");
    call.actualMicros = Math.ceil(body.inputTokens * call.bound.inputUsdPerMillion + body.outputTokens * call.bound.outputUsdPerMillion);
    call.inputTokens = body.inputTokens; call.outputTokens = body.outputTokens; call.status = "settled";
    call.usageEvidence = { path: evidence.path, sha256: evidence.sha256, source: body.source, observedAt: body.observedAt };
    const card = s.cards[call.cardId];
    if (card && !card.identity) issue(card, "IDENTITY_REVIEW", "Usage is reconciled; review the original pair or retained provider result. This paid identification will not be repeated.", "Identity review");
    event(s, "usage-reconciled", `Actual bounded usage retained: ${evidence.path}`, call.cardId);
    return { callId: call.id, actualMicros: call.actualMicros, repeatsAllowed: false };
  }, root);
}

/** Seller release removes the hold without inventing an identity review or authorizing another paid call. */
export async function releaseV2IdentityHolds(root: string, raw: unknown) {
  const packet=z.object({instructionId:z.string().min(1),cardIds:z.array(z.string()).min(1).max(20),evidence:ref}).strict().parse(raw);
  const body=JSON.parse(await fs.readFile(path.join(root,packet.evidence.path),"utf8"));
  await checkedEvidence(root,packet.evidence,body);
  const queue=JSON.parse(await fs.readFile(path.join(root,"artifacts/engineering-mission/work-queue.json"),"utf8"));
  if(body.instruction?.id!==packet.instructionId||!queue.instructions.some((i:unknown)=>digest(i)===digest(body.instruction))||new Set(packet.cardIds).size!==packet.cardIds.length)throw Error("Captured seller instruction and unique scope required");
  const release=await acquireV2Lock("worker",root);
  try{return await withV2State(s=>{
    assertIdle(s);
    const cards=packet.cardIds.map(id=>s.cards[id]);
    if(cards.some(c=>!c||c.draftId||!c.issues.some(i=>i.code==="IDENTITY_REVIEW")))throw Error("Scope must contain only new cards with identity-review holds");
    for(const c of cards){c.issues=c.issues.filter(i=>i.code!=="IDENTITY_REVIEW");c.stage=c.issues.length?"exception":c.identity?"identified":"waiting";c.nextAction="Seller released identity-review hold; retained identification evidence still requires a complete identity before draft preparation";c.updatedAt=nowIso();event(s,"identity-hold-released",packet.instructionId+"; evidence "+packet.evidence.path,c.id);}
    return {released:cards.map(c=>c.id),identityVerified:false};
  },root);}finally{await release();}
}

export async function reviewV2Identity(root:string,raw:unknown){const packet=identityReview.extend({evidence:ref}).parse(raw);return measureV2(root,"identity-review",()=>reviewV2IdentityTimedLocal(root,raw),{cardId:packet.cardId});}
