import {createV2MediaCommitter,matchesV2MediaOrientation,shouldRecoverV2MediaAck} from './card-processing-v2-media-committer.ts';
import {withV2PhotoResources} from './card-processing-v2-media.ts';
import {readV2PhotoRotations} from './card-processing-v2-photo-rotation.ts';
import {factualV2Description} from './card-processing-v2-description.ts';
import {observeV2PhotoStep,appendV2PhotoSegments,type V2PhotoTimingObserver,type V2PhotoSegment} from './card-processing-v2-photo-timing.ts';
import {planV2BatchConsolidation} from './card-processing-v2-batch-consolidation.ts';
import {v2IdentificationAccounting} from './card-processing-v2-accounting.ts';
import {withV2AcceptedActivity} from './card-processing-v2-activity.ts';
import {prepareV2ValidatedPreview,inspectV2SelectedMedia,inspectV2KnownCategories} from './card-processing-v2-media-preflight.ts';
import { measureV2, recoverV2Timings, withV2TimingContext } from "./card-processing-v2-timing.ts";
import {V2_IDENTIFICATION_SYSTEM_PROMPT} from "./card-processing-v2-identification-prompt.ts";
import {normalizeV2ProductIdentification} from './card-processing-v2-product-references.ts';
import { classifyV2IdentificationWarnings } from "./card-processing-v2-identification-warnings.ts";
import {retainedV2BackOrientation,V2_BACK_ROTATION_WARNING} from './card-processing-v2-retained-orientation.ts';
import {retainV2ProviderOrientation} from './card-processing-v2-provider-orientation.ts';
import {loadV2IdentificationContext,buildV2IdentificationPrompt,type V2IdentificationContext} from "./card-processing-v2-batch-context.ts";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { generateText, Output } from "ai";
import { loadCardBacklog } from "./card-backlog-store.ts";
import { createLanguageModel, providerOptionsFor } from "./ai-providers.ts";
import { singleRequestFetch } from "./ai-benchmark-budget.ts";
import { identificationSchema, digest, nowIso, event, issue, consolidate, completeness, preparePayload, searchableTitle, v2ProductTitleForms,
  type V2Card, type V2Identification, type V2Payload, type V2State } from "./card-processing-v2.ts";
import { acquireV2Lock, readV2Config, readV2State, withV2State, withV2PreparationCommits, withV2ConfigReads, v2Dir, type V2Config } from "./card-processing-v2-store.ts";
import { draftCsv, historicalMethodReview } from "./card-processing-v2-transport.ts";
import { findVerifiedDefinition } from "./card-processing-v2-knowledge.ts";
import { openAiIdentificationSchema, normalizeOpenAiIdentification } from "./card-processing-v2-openai.ts";
import type { V2CategoryAcquisition } from "./card-processing-v2-category.ts";
import {mergeV2CategoryReports} from './card-processing-v2-category-cache.ts';
import {replaceV2Checkpoint} from './card-processing-v2-atomic-replace.ts';
import { readV2ResetTransfers } from "./card-processing-v2-reset.ts";
import { candidateId, resolveV2Selection, readV2ScopedTransferPairs, canRecoverV2BudgetHold, type ResolvedV2Selection } from "./card-processing-v2-selection.ts";
import { recoverV2DraftArchivesAfterOperation } from "./card-processing-v2-draft-archive.ts";
import { mapV2Bounded, v2Limiter, v2PhotoPacer, V2_PREPARATION_LIMITS } from "./card-processing-v2-concurrency.ts";
import { nextV2BrowserAction } from "./card-processing-v2-browser-dispatch.ts";
import {assertV2UploaderLive,signalV2UploaderHandoff,V2UploaderAdmissionError} from './card-processing-v2-uploader-admission.ts';

import { enqueueV2BrowserUploadGroups, listV2BrowserJobs, claimV2BrowserJob, executeV2BrowserUpload, type V2InternalBrowserUploadAdapter, type V2BrowserJob } from "./card-processing-v2-browser-upload-workflow.ts";

type ScanPhoto = { path: string; hash: string };
export type IdentificationResult = { finding: V2Identification; inputTokens: number; outputTokens: number };
export type V2WorkerDependencies = {
  selection?: ResolvedV2Selection;
  /** Identify/sort intake never hosts photos, prepares drafts or consumes browser jobs. */
  identifyOnly?:boolean;
  /** Button end-to-end runs must keep their acknowledged agent live. Legacy
   * CLI recoveries are explicitly preparation-only unless this is requested. */
  requireUploaderAdmission?:boolean;
  uploaderRunId?:string;
  browserAdapter?: V2InternalBrowserUploadAdapter;
  identify?: (images: string[], config: NonNullable<V2Config["identification"]>, context?:V2IdentificationContext) => Promise<IdentificationResult>;
  legacyHashes?: () => Promise<string[]>;
  hostPhoto?: (bytes: Uint8Array, hash: string, observer?:V2PhotoTimingObserver) => Promise<{ url: string; expiresAt: string }>;
  categoryRequirements?: (ids: ("183454" | "261328" | "183050")[]) => Promise<V2CategoryAcquisition>;
};
const boundedText = (text: string) => text.slice(0, 295);
/** Preparation never replaces an existing browser operation. Carry exact jobs
 * forward and pack only uncovered groups by physical captures, not listing rows. */
export async function enqueueV2PreparedBrowserJobs(root:string,groupIds:string[]):Promise<V2BrowserJob[]> {
  if(new Set(groupIds).size!==groupIds.length)throw Error('Duplicate prepared group scope');
  const state=await readV2State(root),expected=groupIds.map(groupId=>{
    const payload=state.prepared[groupId],cards=Object.values(state.cards).filter(c=>c.groupId===groupId);
    if(!payload||!cards.length||cards.length>20||cards.some(c=>c.stage!=='prepared'||c.issues.length||c.draftId)||payload.captureIds.length!==cards.length||digest([...payload.captureIds].sort())!==digest(cards.map(c=>c.captureId).sort()))throw Error('Exact prepared groups of at most20 physical captures required');
    return{groupId,payload,cardIds:cards.map(c=>c.id).sort()};
  }),captures=new Set(expected.flatMap(g=>g.payload.captureIds)),covered=new Set<string>(),jobs:V2BrowserJob[]=[];
  const matches=(actual:V2BrowserJob['groups'][number],wanted:typeof expected[number])=>actual.groupId===wanted.groupId&&digest(actual.payload)===digest(wanted.payload)&&digest([...actual.cardIds].sort())===digest(wanted.cardIds);
  for(const job of await listV2BrowserJobs(root)){
    if(job.stage==='superseded'||!job.groups.some(g=>groupIds.includes(g.groupId)||g.payload.captureIds.some(c=>captures.has(c))))continue;
    if(job.groups.reduce((n,g)=>n+g.cardIds.length,0)>20)throw Error('Existing browser job exceeds physical capture scope; explicit reconciliation required');
    for(const g of job.groups){const wanted=expected.find(e=>e.groupId===g.groupId);if(!wanted||!matches(g,wanted)||covered.has(g.groupId))throw Error('Existing browser job has foreign overlap or changed payload; explicit reconciliation required');covered.add(g.groupId);}
    jobs.push(job);
  }
  const chunks:string[][]=[];let chunk:string[]=[],physical=0;
  for(const g of expected.filter(g=>!covered.has(g.groupId))){if(physical+g.cardIds.length>20){chunks.push(chunk);chunk=[];physical=0;}chunk.push(g.groupId);physical+=g.cardIds.length;}
  if(chunk.length)chunks.push(chunk);
  for(const ids of chunks){const added=await enqueueV2BrowserUploadGroups(root,ids),returned=added.flatMap(j=>j.groups);
    if(returned.length!==ids.length||new Set(returned.map(g=>g.groupId)).size!==ids.length||returned.some(g=>!ids.includes(g.groupId)||!matches(g,expected.find(e=>e.groupId===g.groupId)!))||added.some(j=>j.groups.reduce((n,g)=>n+g.cardIds.length,0)>20))throw Error('Browser enqueue coverage changed; reconcile without replay');
    jobs.push(...added);
  }
  return jobs;
}
const bytesHash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const completenessInput = (card: V2Card, s: V2State, config: V2Config) => {
  const category = config.categories.find(c => c.categoryId === card.identity?.categoryId);
  return digest([config.inputVersion, Boolean(process.env.DATABASE_URL), card.title, card.description, card.identity, card.identification, category,
    category ? Date.now() - Date.parse(category.observedAt) <= 7 * 86400000 : false,
    card.photos.map(p => [p.hash, s.media[p.hash], s.media[p.hash] ? Date.parse(s.media[p.hash].expiresAt) > Date.now() + 86400000 : false])]);
};
export function recoverCompletenessHolds(s: V2State, config: V2Config, inScope: (card: V2Card) => boolean) {
  const ownedGroups = new Set(Object.values(s.submissions).map(submission => submission.groupId));
  for (const card of Object.values(s.cards)) {
    if (!inScope(card) || !card.identity || card.draftId || card.draftArchive || card.inventoryArchive || card.activeQuantityOperationId || card.groupId && ownedGroups.has(card.groupId) || Object.values(s.submissions).some(sub=>sub.payload.captureIds.includes(card.captureId)) || !card.issues.length
      || !card.issues.every(issue => ["CATEGORY", "SPECIFICS", "PHOTOS", "TITLE", "DESCRIPTION"].includes(issue.code))) continue;
    const rebuilt=searchableTitle(card.identity),aliasRepair=card.issues.every(i=>i.code==='TITLE')&&card.title.length>80&&rebuilt.length<=80&&rebuilt!==card.title&&v2ProductTitleForms(card.identity).some(product=>product!==card.identity!.product&&card.title.replace(card.identity!.product,product)===rebuilt);
    if(!aliasRepair&&card.completenessInputKey===completenessInput(card,s,config))continue;
    if(aliasRepair)card.title=rebuilt;
    card.issues = []; card.stage = "consolidated";
  }
}

/** Top-level files only: Drafted/Listed/Sold/Hold and other unfinished inventories are never walked. */
export async function scanV2Folder(folder: string): Promise<ScanPhoto[]> {
  const entries = await fs.readdir(folder, { withFileTypes: true });
  const files = entries.filter(e => e.isFile() && !e.isSymbolicLink() && /\.(png|jpe?g|webp|tiff?|bmp)$/i.test(e.name));
  if (files.length > 2000) throw Error("V2 scan folder exceeds 2,000 loose images; no files were moved.");
  const result: ScanPhoto[] = [];
  for (const file of files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))) {
    const absolute = path.join(folder, file.name), stat = await fs.lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 35_000_000 || Date.now() - stat.mtimeMs < 2000) continue;
    const bytes = await fs.readFile(absolute), after = await fs.lstat(absolute);
    if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || after.isSymbolicLink()) continue;
    result.push({ path: absolute, hash: bytesHash(bytes) });
  }
  return result;
}
export function pairV2Photos(files: ScanPhoto[], mode: V2Config["pairing"]) {
  const pairs: [ScanPhoto, ScanPhoto][] = [], unmatched: ScanPhoto[] = [];
  if (mode === "alternating") {
    for (let n = 0; n < files.length; n += 2) { if (files[n + 1]) pairs.push([files[n], files[n + 1]]); else unmatched.push(files[n]); }
  } else {
    const groups = new Map<string, { front: ScanPhoto[]; back: ScanPhoto[] }>();
    for (const file of files) {
      const filename = path.basename(file.path);
      const named = /^(.*?)[ _.-](front|back|f|b)\.[^.]+$/i.exec(filename);
      // Existing CardScans captures use Card0001F162155 / Card0001B162155.
      // Bind the capture number AND session stamp; never interleave sessions by card number alone.
      const scanner = /^(.*?\d+)([fb])(\d{6})\.[^.]+$/i.exec(filename);
      const match = named ?? (scanner ? [scanner[0], `${scanner[1]}:${scanner[3]}`, scanner[2]] : null);
      if (!match) { unmatched.push(file); continue; }
      const key = match[1].toLowerCase(), group = groups.get(key) ?? { front: [], back: [] };
      group[/^(front|f)$/i.test(match[2]) ? "front" : "back"].push(file); groups.set(key, group);
    }
    for (const group of Array.from(groups.values())) {
      if (group.front.length === 1 && group.back.length === 1) pairs.push([group.front[0], group.back[0]]);
      else unmatched.push(...group.front, ...group.back);
    }
  }
  return { pairs, unmatched };
}
async function verifiedBytes(photo: V2Card["photos"][number]) {
  const stat = await fs.lstat(photo.path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 35_000_000) throw Error("Original is missing or changed.");
  const bytes = await fs.readFile(photo.path);
  if (bytesHash(bytes) !== photo.hash) throw Error("Original changed since capture; no call or upload was attempted.");
  return bytes;
}
async function imagePreview(photo: V2Card["photos"][number], root:string,rotations?:Awaited<ReturnType<typeof readV2PhotoRotations>>) {
  const {preview}=await prepareV2ValidatedPreview(root,photo,rotations);
  return `data:image/jpeg;base64,${preview.toString("base64")}`;
}
export async function identifyOpenAI(images: string[], config: NonNullable<V2Config["identification"]>,context?:V2IdentificationContext): Promise<IdentificationResult> {
  const result = await generateText({
    model: createLanguageModel("openai", config.model, "recognition", singleRequestFetch(fetch, config.maxRequestBytes)),
    output: Output.object({ schema: openAiIdentificationSchema }), maxRetries: 0, maxOutputTokens: config.maxOutputTokens,
    abortSignal: AbortSignal.timeout(60_000), providerOptions: providerOptionsFor("openai"),
    system: V2_IDENTIFICATION_SYSTEM_PROMPT,
    messages: [{ role: "user", content: [{ type: "text", text: buildV2IdentificationPrompt(context) }, ...images.map(image => ({ type: "image" as const, image }))] }],
  });
  return { finding: normalizeOpenAiIdentification(result.output), inputTokens: result.usage.inputTokens ?? NaN, outputTokens: result.usage.outputTokens ?? NaN };
}
async function knownLegacyHashes(root: string) {
  const legacy = await loadCardBacklog({ root, scans: [] });
  if (legacy.sources.some(s => s.status === "invalid")) throw Error("Existing inventory evidence is invalid; V2 intake held to preserve unfinished work.");
  return legacy.cards.flatMap(c => c.photoHashes);
}
/** Activation protects every loose pre-existing image, including unfinished photos without a legacy queue row. */
export async function initializeV2(root = process.cwd()) {
  const config = await readV2Config(root);
  // Protect paths independently of readability/size/stability so an in-flight old scan cannot appear new later.
  const paths = (await fs.readdir(config.folder, { withFileTypes: true })).filter(e => e.isFile() && !e.isSymbolicLink()).map(e => path.join(config.folder, e.name));
  const files = await scanV2Folder(config.folder);
  return withV2State(s => {
    if (s.baseline) return { initialized: false, files: s.baseline.fileCount };
    s.baseline = { initializedAt: nowIso(), hashes: Array.from(new Set(files.map(p => p.hash))), paths, fileCount: paths.length };
    s.notices = ["Existing loose scans are protected. Scan new cards after V2 activation, then select Process New Cards."];
    event(s, "activation", `${files.length} existing images protected; original files and Listing Factory were not changed.`);
    return { initialized: true, files: files.length };
  }, root);
}
async function intake(root: string, config: V2Config, deps: V2WorkerDependencies) {
  const scoped=deps.selection?.readyBatchIds?await(await import('./card-processing-v2-selection.ts')).readV2ScopedReadyBatchUnionPairs(root,deps.selection.readyBatchIds):deps.selection?.readyBatchId?(await(await import('./card-processing-v2-ready-batches.ts')).resolveV2ReadyBatch(root,deps.selection.readyBatchId)).cards.map(card=>card.photos.map(photo=>({path:photo.path,hash:photo.hash})) as [ScanPhoto,ScanPhoto]):deps.selection?.sourceTransferId?await readV2ScopedTransferPairs(root,deps.selection.sourceTransferId):undefined;
  const [files, legacyHashes, reset] = await Promise.all([scoped?Promise.resolve(scoped.flat()):scanV2Folder(config.folder), (scoped&&(deps.selection?.readyBatchId||deps.selection?.readyBatchIds))?Promise.resolve([]):deps.legacyHashes ? deps.legacyHashes() : knownLegacyHashes(root), readV2ResetTransfers(root)]);
  return withV2State(s => {
    if (!s.baseline) throw Error("Initialize V2 before scanning new cards; current loose scans must first be protected.");
    const protectedHashes = new Set([...s.baseline.hashes, ...legacyHashes]);
    const protectedPaths = new Set(s.baseline.paths.map(p => path.resolve(p).toLowerCase()));
    const owned = new Set(Object.values(s.cards).flatMap(c => c.photos.map(p => p.hash)));
    const seen = new Set<string>();
    // Pair all filenames before excluding owners so an odd/missing side cannot shift alternating pairs.
    const { pairs, unmatched } = scoped?{pairs:scoped,unmatched:[]}:pairV2Photos(files, config.pairing);
    if (deps.selection) for (const capture of deps.selection.captures) if (capture.photos.some(p => !files.some(f => f.hash === p.hash && path.resolve(f.path).toLowerCase() === path.resolve(p.path).toLowerCase()))) throw Error("Selected originals changed before processing; refresh the photo picker.");
    s.notices = unmatched.length ? [boundedText(`${unmatched.length} unmatched image(s). Use front/back filenames or explicitly configure alternating scanner order. No pairing was guessed.`)] : [];
    let added = 0;
    for (const pair of pairs) {
      if (deps.selection && !deps.selection.candidateIds.includes(candidateId(pair))) continue;
      if (!deps.selection && added >= config.batchLimit) break;
      const transferred = reset.receipts.flatMap(receipt => receipt.pairs.map(p => ({ receipt, pair: p }))).find(t => !t.pair.guards.hardHolds.length && !t.pair.guards.positiveDispositions.length
        && digest(t.pair.photos.map(p => p.sha256.toLowerCase()).sort()) === digest(pair.map(p => p.hash).sort())
        && t.pair.photos.every(p => pair.some(q => path.resolve(q.path).toLowerCase() === path.resolve(p.path).toLowerCase() && q.hash === p.sha256.toLowerCase())));
      if (pair.some(p => (!transferred && (protectedPaths.has(path.resolve(p.path).toLowerCase()) || protectedHashes.has(p.hash))) || owned.has(p.hash) || seen.has(p.hash)) || pair[0].hash === pair[1].hash) continue;
      pair.forEach(p => seen.add(p.hash));
      const captureId = digest(["original-front-capture-v2", pair[0].hash]), id = `V2-${captureId.slice(0, 24)}`, at = nowIso();
      if (s.cards[id]) continue;
      s.cards[id] = { id, sku: id, captureId, photos: [{ ...pair[0], side: "front" }, { ...pair[1], side: "back" }], stage: "waiting", condition: "Near mint or better",
        title: "", description: "", descriptionSource: "factual", issues: [], nextAction: "OpenAI visual identification", createdAt: at, updatedAt: at };
      if (transferred) s.cards[id].resetTransfer = { resetId: transferred.receipt.resetId, legacyCardId: transferred.pair.legacyCardId,
        receipt: reset.transfers[transferred.pair.legacyCardId].receipt, instructionId: transferred.receipt.authority.instructionId };
      event(s, "waiting", "New original pair admitted; existing inventory remains excluded", id); added++;
    }
    return added;
  }, root);
}
/** Explicit intake checkpoint lets an authorized reset appear as waiting work
 * without spending on identification or touching the seller's drafts. */
export async function admitNewV2Cards(root = process.cwd(), deps: V2WorkerDependencies = {}) {
  const release = await acquireV2Lock("worker", root);
  try { return { added: await intake(root, await readV2Config(root), deps), externalWrites: 0, providerCalls: 0 }; }
  finally { await release(); }
}
export function v2Provider429(error:unknown):{httpStatus:429;providerCode:'credit_balance_exhausted'|'insufficient_quota'|'rate_limit_exceeded'|'unknown'}|undefined {
  if(!error||typeof error!=='object')return;
  const e=error as Record<string,unknown>;
  if(e.statusCode!==429&&e.status!==429)return;
  const allowed=['credit_balance_exhausted','insufficient_quota','rate_limit_exceeded'] as const;
  let body:unknown=e.data;
  if(typeof e.responseBody==='string'&&e.responseBody.length<=65536){try{body=JSON.parse(e.responseBody);}catch{/* Never retain raw provider content. */}}
  const nested=body&&typeof body==='object'?(body as Record<string,unknown>).error:undefined;
  const values=[e.code,e.type,...[body,nested].flatMap(x=>x&&typeof x==='object'?[(x as Record<string,unknown>).code,(x as Record<string,unknown>).type]:[])];
  return {httpStatus:429,providerCode:allowed.find(code=>values.includes(code))??'unknown'};
}
class V2ProviderAdmissionStopped extends Error {
  constructor(){super('Identification provider admission stopped after HTTP 429; retained calls require accounting reconciliation.');this.name='V2ProviderAdmissionStopped';}
}
async function identifyOne(id: string, root: string, config: V2Config, deps: V2WorkerDependencies, activeCalls: Set<string>,rotations?:Awaited<ReturnType<typeof readV2PhotoRotations>>,admission?:{stopped:boolean}) {
  if(admission?.stopped)throw new V2ProviderAdmissionStopped();
  let card = (await readV2State(root)).cards[id];
  if (card.identity || card.issues.some(i => i.code !== "IDENTIFICATION_SETUP")) return;
  const knowledge = (await readV2State(root)).knowledge[digest(card.photos.map(p => p.hash))];
  if (knowledge) {
    await withV2State(s => {
      const c = s.cards[id]; c.identity = knowledge.identity; c.identification = { pairMatches: true, frontImageIndex: "0", upright: true, identity: knowledge.identity, warnings: [] };
      c.identificationKey = digest(["verified-knowledge-v2", card.photos.map(p => p.hash)]); c.stage = "identified"; c.issues = []; c.nextAction = "Consolidate exact copies";
      event(s, "identified", "Reused exact verified front/back identity evidence", id);
    }, root); return;
  }
  const settings = config.identification;
  if (!settings || Date.parse(settings.expiresAt) <= Date.now() || (!deps.identify && !process.env.OPENAI_API_KEY)) {
    await withV2State(s => issue(s.cards[id], "IDENTIFICATION_SETUP", "Configure OpenAI identification with a current model, verified cost bounds and spending authority.", "Local configuration"), root); return;
  }
  const key = digest(["openai-identification-v2", card.photos.map(p => p.hash), settings.model]);
  let context:V2IdentificationContext|undefined;
  try{context=await loadV2IdentificationContext(root,card);}catch{await withV2State(s=>issue(s.cards[id],"IDENTIFICATION_CONTEXT","Exact-photo context is stale, changed or unsupported; register a fresh captured context before identification.","Batch context"),root);return;}
  // Prepare and verify local image bytes before reserving any paid call.
  let images: string[];
  try { images = await measureV2(root, "image-preparation", () => Promise.all(card.photos.map(photo=>imagePreview(photo,root,rotations))), {cardId:id}); }
  catch { await withV2State(s => issue(s.cards[id], "ORIGINAL_CHANGED", "Original pair is unreadable or changed; reconcile the capture before processing."), root); return; }
  const reserve = Math.ceil(settings.maxInputTokens * settings.inputUsdPerMillion + settings.maxOutputTokens * settings.outputUsdPerMillion);
  if(deps.requireUploaderAdmission){if(!deps.uploaderRunId)throw new V2UploaderAdmissionError();await assertV2UploaderLive(root,deps.uploaderRunId,deps.selection);}
  const callId = randomUUID();
  const reserved = await withV2State(s => {
    const accounting=v2IdentificationAccounting(s.calls,activeCalls),committed=accounting.committedMicros;
    if (!Number.isSafeInteger(reserve) || reserve <= 0 || !accounting.safe || s.calls.some(c => c.key === key||c.cardId===id)
      || committed + reserve > settings.capMicros) {
      issue(s.cards[id], "IDENTIFICATION_BUDGET", "Reconcile pending identification usage or the spending limit; completed calls will not be repeated.", "Provider accounting"); return false;
    }
    s.calls.push({ id: callId, cardId: id, key, provider: "openai", model: settings.model, status: "reserved", reservedMicros: reserve, actualMicros: null, at: nowIso(),
      bound: { authority: settings.authority, pricingSource: settings.pricingSource, inputUsdPerMillion: settings.inputUsdPerMillion, outputUsdPerMillion: settings.outputUsdPerMillion, maxInputTokens: settings.maxInputTokens, maxOutputTokens: settings.maxOutputTokens } });
    activeCalls.add(callId);
    s.cards[id].issues = []; event(s, "identification-started", "Bounded OpenAI request reserved before sending; pricing excluded", id); return true;
  }, root);
  if (!reserved) return;
  let failureStage:'provider'|'validation'|'persistence'='provider',usageBoundExceeded=false;
  let observedUsage:{inputTokens:unknown,outputTokens:unknown}|undefined;
  try {
    const result = await measureV2(root, "openai-identification", async () => {
      try{return await (deps.identify ?? identifyOpenAI)(images, settings,context);}
      catch(error){if(v2Provider429(error)&&admission)admission.stopped=true;throw error;}
    }, {cardId:id});
    observedUsage={inputTokens:result.inputTokens,outputTokens:result.outputTokens};
    failureStage='validation';
    const rawFinding = identificationSchema.parse(result.finding);
    usageBoundExceeded=result.inputTokens>settings.maxInputTokens||result.outputTokens>settings.maxOutputTokens;
    if (![result.inputTokens, result.outputTokens].every(n => Number.isSafeInteger(n) && n >= 0) || usageBoundExceeded) throw Error("Uncertain usage");
    failureStage='persistence';
    // Retain the first validated provider result before orientation normalization,
    // knowledge enrichment or a later human review changes the working finding.
    const originalResult = { kind: "original-openai-identification-result", callId, cardId: id, model: settings.model, observedAt: nowIso(), identificationSystemPromptSha256:bytesHash(Buffer.from(V2_IDENTIFICATION_SYSTEM_PROMPT)), inputPhotos: card.photos, identificationContext:context??null, finding:rawFinding, inputTokens: result.inputTokens, outputTokens: result.outputTokens };
    const resultDirectory = path.join(v2Dir(root), "identification-results");
    await fs.mkdir(resultDirectory, { recursive: true });
    const originalBytes=JSON.stringify(originalResult,null,2);
    await fs.writeFile(path.join(resultDirectory, `${callId}.json`), originalBytes, { flag: "wx", flush: true });
    const providerOrientationPlan=retainedV2BackOrientation(rawFinding);
    const workingFinding=providerOrientationPlan?{...providerOrientationPlan.finding,upright:true,warnings:providerOrientationPlan.finding.warnings.filter(w=>w!==V2_BACK_ROTATION_WARNING)}:rawFinding;
    // Product checks must see the same prepared orientation for sideways and
    // upright cards. A known rotation never bypasses a reference conflict.
    const productReference=normalizeV2ProductIdentification(workingFinding),finding=productReference.finding;
    let productReferenceEvidence:string|undefined;
    if(productReference.provenance){
      const relative=`artifacts/card-processing-v2/identification-normalizations/${callId}-product-reference.json`,body=JSON.stringify({kind:'verified-product-reference-normalization',callId,cardId:id,observedAt:nowIso(),original:{path:`artifacts/card-processing-v2/identification-results/${callId}.json`,sha256:bytesHash(Buffer.from(originalBytes))},...productReference.provenance,finding},null,2);
      await fs.mkdir(path.dirname(path.join(root,relative)),{recursive:true});await fs.writeFile(path.join(root,relative),body,{flag:'wx',flush:true});productReferenceEvidence=relative+'#sha256='+bytesHash(Buffer.from(body));
    }
    await withV2State(async s => {
      const c = s.cards[id], call = s.calls.find(c => c.id === callId)!;
      call.status = "settled"; call.inputTokens = result.inputTokens; call.outputTokens = result.outputTokens;
      call.actualMicros = Math.ceil(result.inputTokens * settings.inputUsdPerMillion + result.outputTokens * settings.outputUsdPerMillion);
      if(providerOrientationPlan){
        const orientation=await retainV2ProviderOrientation(root,s,id,{path:`artifacts/card-processing-v2/identification-results/${callId}.json`,sha256:bytesHash(Buffer.from(originalBytes))});
        if(!orientation)throw Error('The prepared orientation must have exact durable provider provenance');
        c.providerOrientation=orientation;event(s,'provider-orientation-prepared','Exact original paid observation registered a 270-degree back derivative; originals and raw upright=false finding retained; product/identity checks still apply; no repeat identification or manual inspection',id);
      }
      // Reordering requires retaining the exact capture/photos, not claiming a rotation.
      if (finding.frontImageIndex === "1") {
        c.photos = [{ ...c.photos[1], side: "front" }, { ...c.photos[0], side: "back" }]; finding.frontImageIndex = "0";
      }
      c.identification = finding; c.identificationKey = key;
      const warnings = classifyV2IdentificationWarnings(finding);
      event(s, "identification-evidence", `Original result retained: artifacts/card-processing-v2/identification-results/${callId}.json`, id);
      const productReferenceHold=productReference.provenance?.outcome==='held-reference-conflict';
      if(productReferenceEvidence)event(s,productReferenceHold?'product-reference-conflict':'product-reference-normalized',productReferenceEvidence,id);
      if (productReferenceHold || !finding.identity || !finding.pairMatches || finding.frontImageIndex !== "0" || !finding.upright || warnings.blocking.length || finding.identity.graded || finding.identity.damage) {
        issue(c, "IDENTITY_REVIEW", boundedText(productReferenceHold?productReference.provenance?.blockingReason??"Verified product-reference conflict requires resolution.":warnings.blocking.join(" ") || "Resolve uncertain identity, pairing, orientation or condition from both originals."), "Identity review");
      } else {
        const reuse = findVerifiedDefinition(s, finding.identity);
        if (reuse) {
          finding.identity = reuse.identity;
          c.knowledgeReuse = { enrichedFields: reuse.enrichedFields, definitions: reuse.source.definitions };
          event(s, "knowledge-reused", "Verified exact card/product facts reused with per-definition provenance; original identity and serial retained", id);
        }
        c.identity = finding.identity; c.stage = "identified"; c.nextAction = "Consolidate exact copies"; c.issues = []; c.updatedAt = nowIso();
      }
      event(s, c.stage, "OpenAI result and actual token usage retained; no pricing generated", id);
    }, root);
  } catch (error) {
    // Retain only allowlisted scalar diagnostics, never messages, bodies, headers or credentials.
    const e=error as {name?:unknown,statusCode?:unknown,usage?:{inputTokens?:unknown,outputTokens?:unknown}};
    const token=(x:unknown)=>Number.isSafeInteger(x)&&Number(x)>=0?Number(x):null;
    const usage={inputTokens:token(observedUsage?.inputTokens??e?.usage?.inputTokens),outputTokens:token(observedUsage?.outputTokens??e?.usage?.outputTokens)};
    usageBoundExceeded ||= (usage.inputTokens??0)>settings.maxInputTokens||(usage.outputTokens??0)>settings.maxOutputTokens;
    const failure={stage:failureStage,observedAt:nowIso(),usageBoundExceeded};
    const provider429=v2Provider429(error);
    const diagnostic={...(provider429?{provider429}:{}),kind:'identification-failure-diagnostic',callId,cardId:id,model:settings.model,...failure,errorType:['AbortError','TimeoutError','AI_NoObjectGeneratedError','AI_APICallError','AI_TypeValidationError'].includes(String(e?.name))?String(e.name):'UnclassifiedError',httpStatus:Number.isInteger(e?.statusCode)&&Number(e.statusCode)>=400&&Number(e.statusCode)<=599?e.statusCode:null,usage};
    try{const dir=path.join(v2Dir(root),'identification-failures');await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,`${callId}.json`),JSON.stringify(diagnostic,null,2),{flag:'wx',flush:true});}catch{/* Durable uncertain accounting remains authoritative if telemetry retention fails. */}
    await withV2State(s => {
      const call = s.calls.find(c => c.id === callId)!; call.status = "uncertain";
      call.failure=failure;
      issue(s.cards[id], "IDENTIFICATION_UNCERTAIN", "Identification or usage is uncertain. Reconcile the retained call before retrying; no automatic repeat.", "Provider accounting");
      event(s, "exception", "Provider failure retained without raw response or credentials", id);
    }, root);
    if(provider429)throw new V2ProviderAdmissionStopped();
  } finally { activeCalls.delete(callId); }
}
async function prepareGroups(root: string, config: V2Config, deps: V2WorkerDependencies) {
  const selectedIds = deps.selection ? new Set(Object.values((await readV2State(root)).cards).filter(c => deps.selection!.candidateIds.includes(candidateId(c.photos))).map(c => c.id)) : undefined;
  const batchPlan = await measureV2(root,"consolidation",()=>withV2State(s => {
    for(const c of Object.values(s.cards))if((!selectedIds||selectedIds.has(c.id))&&c.stage==='identified'&&c.identity&&!c.issues.length&&!c.draftId&&!c.activeQuantityOperationId&&!c.inventoryArchive&&!Object.values(s.submissions).some(sub=>sub.payload.captureIds.includes(c.captureId)))c.consolidationVersion=2;
    const plan=planV2BatchConsolidation(s,selectedIds?Array.from(selectedIds):Object.keys(s.cards));
    consolidate(s, selectedIds);
    event(s,'batch-consolidation',`${plan.physicalCards} selected physical cards -> ${plan.draftGroups} quantity groups; no active inventory scan`);
    return plan;
  }, root));
  let state = await readV2State(root);
  const ownedGroups = new Set(Object.values(state.submissions).map(sub => sub.groupId));
  const plannedGroups=new Set(batchPlan.groups.map(g=>g.groupId));
  const groupIds = Array.from(new Set(Object.values(state.cards).filter(c => (!selectedIds || selectedIds.has(c.id)) && c.groupId && plannedGroups.has(c.groupId) && !c.draftId && !ownedGroups.has(c.groupId) && (c.stage === "consolidated" || (c.stage === "prepared" && (c.completenessInputKey !== completenessInput(c, state, config) || c.description !== state.prepared[c.groupId!]?.description))))
    .sort((a, b) => Number(a.stage === "prepared") - Number(b.stage === "prepared")).map(c => c.groupId!)));
  const payloads: V2Payload[] = [];
  const photoLimit = v2Limiter(V2_PREPARATION_LIMITS.photoUploads), pace = v2PhotoPacer();
  const rotations=await readV2PhotoRotations(root,{state,cardIds:selectedIds?Array.from(selectedIds):Object.keys(state.cards)});
  const orientationHashes=new Map(Object.values(state.cards).filter(c=>!selectedIds||selectedIds.has(c.id)).flatMap(c=>c.photos.map(p=>[p.hash,digest(rotations.filter(r=>r.photo.hash===p.hash))] as const)));
  const mediaCommitter=createV2MediaCommitter(root,Object.values(state.cards).filter(c=>!selectedIds||selectedIds.has(c.id)),orientationHashes);
  const mediaSnapshot=state.media; // Detached request snapshot; photoRequests owns each hash once.
  const photoRequests = new Map<string, Promise<void>>();
  const host = (photo: V2Card["photos"][number], cardId: string) => {
    const existing = photoRequests.get(photo.hash); if (existing) return existing;
    const request = photoLimit(async () => {
      const cached = mediaSnapshot[photo.hash];
      if (matchesV2MediaOrientation(cached,orientationHashes.get(photo.hash)!,!!state.cards[cardId].providerOrientation) && cached && Date.parse(cached.expiresAt) > Date.now() + 86400000) return;
      const segments:V2PhotoSegment[]=[],observe:V2PhotoTimingObserver=segment=>{segments.push(segment);};
      try {
        const owner=state.cards[cardId];
        if(shouldRecoverV2MediaAck(cached,orientationHashes.get(photo.hash)!,!!owner.providerOrientation)&&await observeV2PhotoStep(observe,'photo-media-ack-recovery',()=>mediaCommitter.recover(owner,photo.hash)))return;
        const uploadAttempt=await observeV2PhotoStep(observe,'photo-upload-attempt-fence',()=>mediaCommitter.begin(owner,photo.hash));
        await measureV2(root, "photo-upload-pacing-wait", pace, {cardId});
        const hosted = await measureV2(root, "photo-upload", async () => withV2PhotoResources({root,rotations},async()=>deps.hostPhoto!(await observeV2PhotoStep(observe,'photo-verified-original-read',()=>verifiedBytes(photo)), photo.hash,observe)), {cardId});
        await observeV2PhotoStep(observe,'photo-media-state-commit',()=>mediaCommitter.retain(owner,photo.hash,hosted,uploadAttempt));
      } catch { /* Completeness retains the photo gap. Never replay an uncertain upload in this run. */ }
      finally{try{await appendV2PhotoSegments(root,segments,{cardId,runId:state.lastRun?.id});}catch{process.stderr.write('Photo diagnostic timing checkpoint unavailable; preserve domain result and do not replay requests.\n');}}
    });
    photoRequests.set(photo.hash, request); return request;
  };
  await mapV2Bounded(deps.selection ? groupIds : groupIds.slice(0, config.batchLimit), V2_PREPARATION_LIMITS.groups, async groupId => {
    const groupState = await readV2State(root);
    const copies = Object.values(groupState.cards).filter(c => c.groupId === groupId && !c.draftId), card = copies[0];
    if (selectedIds && copies.some(c => !selectedIds.has(c.id))) {
      await withV2State(s => { for (const c of copies.filter(c => selectedIds.has(c.id))) issue(s.cards[c.id], "SELECTION_GROUP", "Select all matching copies in the existing quantity group together before changing its prepared quantity.", "Photo selection"); }, root); return;
    }
    if (!card || copies.some(c => c.activeQuantityOperationId || c.inventoryArchive || c.issues.length)) return;
    // Local originals must remain unchanged for EVERY physical copy, even for representative photos.
    try { for (const copy of copies) for (const photo of copy.photos) await verifiedBytes(photo); }
    catch { await withV2State(s => copies.forEach(c => issue(s.cards[c.id], "ORIGINAL_CHANGED", "Original pair changed; restore or reconcile before preparation.")), root); return; }
    if (deps.hostPhoto) await Promise.all(card.photos.map(photo => host(photo, card.id)));
    const preparedState = await readV2State(root);
    const photos = card.photos.flatMap(p => matchesV2MediaOrientation(preparedState.media[p.hash],orientationHashes.get(p.hash)!,!!card.providerOrientation) ? [preparedState.media[p.hash]] : []);
    const category = config.categories.find(c => c.categoryId === card.identity?.categoryId);
    const errors = await measureV2(root,"listing-completeness",()=>completeness(card, category, photos),{cardIds:copies.map(c=>c.id).slice(0,20)});
    if (errors.length || !category) {
      await withV2State(s => {
        for (const copy of copies) { const c = s.cards[copy.id]; c.issues = errors; c.stage = "exception"; c.completenessInputKey = completenessInput(c, s, config); c.nextAction = boundedText(errors.map(e => e.detail).join(" ")); c.updatedAt = nowIso(); }
        delete s.prepared[groupId];
        event(s, "completeness-held", boundedText(errors.map(e => e.code).join(", ")), card.id);
      }, root); return;
    }
    const payload = await measureV2(root,"payload-preparation",()=>preparePayload(card, copies, category, photos),{cardIds:copies.map(c=>c.id).slice(0,20)}); payloads.push(payload);
    await withV2State(s => {
      for (const copy of copies) { const c = s.cards[copy.id]; if(c.identity && c.descriptionSource === "factual" && c.description === factualV2Description(c.identity,c.condition)) c.description = payload.description; c.stage = "prepared"; c.issues = []; c.completenessInputKey = completenessInput(c, s, config); c.nextAction = "Await verified bulk method and fresh inventory clearance; Grok pricing remains separate"; c.updatedAt = nowIso(); }
      s.prepared[groupId] = payload;
      event(s, "prepared", "Title, category specifics, original photos and supported condition passed pre-draft completeness", card.id);
    }, root);
  });
  state = await readV2State(root);
  // Keep prior completed group payloads available while new groups advance through the bounded worker.
  const retainedPayloads = Object.entries(state.prepared).filter(([groupId]) => {
    if (Object.values(state.submissions).some(sub => sub.groupId === groupId)) return false;
    const cards = Object.values(state.cards).filter(c => c.groupId === groupId);
    if (selectedIds && cards.some(c => !selectedIds.has(c.id))) return false;
    return cards.length && cards.every(c => !c.activeQuantityOperationId && !c.inventoryArchive && !c.draftId && c.stage === "prepared" && !c.issues.length && c.completenessInputKey === completenessInput(c, state, config));
  }).map(([, payload]) => payload);
  const preparedGroupIds = Object.entries(state.prepared).filter(([,p]) => retainedPayloads.some(payload => digest(payload) === digest(p))).map(([id]) => id);
  const browserJobs = await enqueueV2PreparedBrowserJobs(root,preparedGroupIds);
  const method = await historicalMethodReview(root);
  const owner = `cpv2-${state.lastRun?.id ?? "prepared"}`;
  const browserActions = [];
  for (const job of browserJobs) browserActions.push(await nextV2BrowserAction(root, { id: job.id, owner: job.lease?.owner ?? owner }));
  const backgroundAttached=Boolean(deps.requireUploaderAdmission&&deps.uploaderRunId),attachedExecutor=Boolean(deps.browserAdapter||backgroundAttached);
  const browserHandoff = { version: 2, runId: state.lastRun?.id ?? null, createdAt: nowIso(), attachedExecutor, internalBrowserOnly: true,
    status: browserActions.length ? (attachedExecutor ? "adapter-pending" : "awaiting-internal-browser-agent") : "no-prepared-jobs", completed: false,
    jobs: browserActions, nextOwner: deps.browserAdapter ? "Attached internal-browser adapter" : backgroundAttached?"Connected background uploader":"ChatGPT internal-browser agent",
    limitation: attachedExecutor?"The attached uploader consumes these exact jobs. Completion requires saved draft verification and photo archival.":"The local preparation worker cannot operate ChatGPT's browser. The named agent must consume these exact jobs; preparation is not draft creation." };
  // Retain each run's exact handoff instead of relying on the overwriteable latest pointer.
  const handoffBytes = JSON.stringify(browserHandoff, null, 2), handoffHash = digest(browserHandoff);
  const handoffRelative = `artifacts/card-processing-v2/browser-handoffs/${handoffHash}.json`;
  await fs.mkdir(path.dirname(path.join(root, handoffRelative)), { recursive: true });
  try { await fs.writeFile(path.join(root, handoffRelative), handoffBytes, { flag: "wx", flush: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST" || await fs.readFile(path.join(root, handoffRelative), "utf8") !== handoffBytes) throw error; }
  await fs.writeFile(path.join(v2Dir(root), "browser-next-actions.json"), JSON.stringify({ ...browserHandoff, retainedHandoff: { path: handoffRelative, sha256: bytesHash(Buffer.from(handoffBytes)) } }, null, 2));
  if(deps.requireUploaderAdmission&&deps.uploaderRunId)await signalV2UploaderHandoff(root,deps.uploaderRunId,{handoff:{path:handoffRelative,sha256:bytesHash(Buffer.from(handoffBytes))},jobIds:browserJobs.map(j=>j.id)});
  if (browserActions.length && !deps.browserAdapter) await withV2State(s => {
    for (const job of browserJobs) for (const group of job.groups) for (const id of group.cardIds) {
      const card = s.cards[id];
      if (card?.stage === "prepared" && !card.draftId && !card.issues.length) card.nextAction = backgroundAttached?"The connected background uploader will create and verify this draft, then move its photos. Pricing stays separate.":"Waiting for ChatGPT internal-browser uploader: reconcile inventory, upload the exact retained job, verify saved draft, then move photos. Pricing stays separate.";
    }
    event(s, backgroundAttached?"background-uploader-handoff":"browser-handoff-required", `${browserJobs.length} retained browser jobs ${backgroundAttached?"are queued to the connected background uploader":"require the internal-browser agent"}; no drafts are claimed. Handoff: ${handoffRelative}`);
  }, root);
  const output = { version: 2, createdAt: nowIso(), mode: "draft-only-handoff", methodStatus: method.status, canPublish: false, verifiedInEbay: false,
    browserNextActions: "artifacts/card-processing-v2/browser-next-actions.json",
    retainedBrowserHandoff: { path: handoffRelative, sha256: bytesHash(Buffer.from(handoffBytes)) },
    browserJobs: browserJobs.map(j => ({ id:j.id,stage:j.stage,requiredBridge:"ChatGPT internal browser",completed:false })),
    blockers: method.findings, listings: retainedPayloads, pricingOwner: "Grok proposal, independent Muse and actual Baxter reviews", descriptionAI: "eBay description-only action requires an available supported editor capability and readback review" };
  await fs.writeFile(path.join(v2Dir(root), "draft-handoff.json"), JSON.stringify(output, null, 2));
  await fs.writeFile(path.join(v2Dir(root), "pricing-handoff.json"), JSON.stringify({
    version: 2, createdAt: nowIso(), provider: "xai", role: "Grok draft pricing only", openaiPricingAllowed: false,
    requiredReviews: ["Muse", "actual Baxter Dot"], noAutomaticDecrease: true, noLiveRepricing: true,
    sourceFirst: ["saved active listings", "all available seller sold history", "verified knowledge evidence"],
    researchLimitSeconds: 30, status: "pending-separate-pricing-worker",
    cards: Object.values((await readV2State(root)).cards).filter(c => (!selectedIds || selectedIds.has(c.id)) && c.identity && !c.issues.some(i => i.owner === "Identity review")).map(c => ({
      cardId: c.id, captureId: c.captureId, identity: c.identity, condition: c.condition, groupId: c.groupId,
      draftId: c.draftId ?? null, sourceChecks: "pending; no sources have been claimed checked", pricing: "unpriced", nextOwner: "Grok pricing worker",
    })),
  }, null, 2));
  // Export never represents an upload. An unproven method cannot produce an upload-ready file.
  const csvPath = path.join(v2Dir(root), "draft-upload.csv");
  if (method.status === "validated" && retainedPayloads.length) await fs.writeFile(csvPath, draftCsv(retainedPayloads));
  else await fs.rm(csvPath, { force: true });
  await withV2State(s => { s.notices.push(...method.findings.map(boundedText)); }, root);
}
async function runV2Local(root = process.cwd(), jobId: string = randomUUID(), deps: V2WorkerDependencies = {}) {
  const release = await acquireV2Lock("worker", root);
  try {
    const config = await readV2Config(root);
    if (deps.selection) deps = { ...deps, selection: await resolveV2Selection(root, deps.selection.activationRequired ? { mode: "all", token: deps.selection.token,...(deps.selection.sourceTransferId?{sourceTransferId:deps.selection.sourceTransferId}:{}),...(deps.selection.readyBatchId?{readyBatchId:deps.selection.readyBatchId}:{}),...(deps.selection.readyBatchIds?{readyBatchIds:deps.selection.readyBatchIds}:{}) } : { mode: "selected", token: deps.selection.token, candidateIds: deps.selection.candidateIds,...(deps.selection.sourceTransferId?{sourceTransferId:deps.selection.sourceTransferId}:{}),...(deps.selection.readyBatchId?{readyBatchId:deps.selection.readyBatchId}:{}),...(deps.selection.readyBatchIds?{readyBatchIds:deps.selection.readyBatchIds}:{}) }) };
    if(deps.requireUploaderAdmission&&deps.selection&&!deps.selection.activationRequired){deps={...deps,uploaderRunId:jobId};await assertV2UploaderLive(root,jobId,deps.selection);}
    await recoverV2Timings(root);
    const inScope = (c: V2Card) => !deps.selection || deps.selection.candidateIds.includes(candidateId(c.photos));
    await withV2State(s => {
      if (s.lastRun?.status === "running") event(s, "recovery", "Prior worker ended; durable completed stages retained and uncertain calls fenced");
      for (const call of s.calls.filter(c => c.status === "reserved" && (!deps.identifyOnly || Boolean(s.cards[c.cardId] && inScope(s.cards[c.cardId]))))) {
        call.status = "uncertain"; if (s.cards[call.cardId] && inScope(s.cards[call.cardId])) issue(s.cards[call.cardId], "IDENTIFICATION_UNCERTAIN", "Interrupted identification call requires usage reconciliation before retry.", "Provider accounting");
      }
      s.lastRun = { id: jobId, pid: process.pid, startedAt: nowIso(), status: "running", ...(deps.selection ? { selection: { candidateIds: deps.selection.candidateIds, photoCount: deps.selection.captures.length * 2 } } : {}) };
      // Completeness gaps can recover when category/media evidence changes; paid calls and identity holds cannot.
      recoverCompletenessHolds(s, config, inScope);
      if (deps.selection) for (const card of Object.values(s.cards)) {
        if (!inScope(card) || !canRecoverV2BudgetHold(card, s, config)) continue;
        card.issues = []; card.stage = "waiting"; card.updatedAt = nowIso(); card.nextAction = "OpenAI visual identification";
        event(s, "identification-budget-recovered", "Exact selected never-sent pair released after settled accounting and fresh spending headroom; prior calls retained", card.id);
      }
      for (const c of Object.values(s.cards)) if (inScope(c) && c.identity && c.issues.length && c.issues.every(i => i.code === "SELECTION_GROUP")
        && Object.values(s.cards).filter(p => p.groupId === c.groupId).every(inScope)) { c.issues = []; c.stage = "identified"; c.completenessInputKey = undefined; }
      event(s, "run-started", "Bounded isolated V2 worker started");
    }, root);
    const state = await readV2State(root);
    if (!state.baseline) { await initializeV2(root); }
    else {
      await measureV2(root,"scan-intake",()=>intake(root, config, deps));
      const pendingAll = Object.values((await readV2State(root)).cards).filter(c => inScope(c) && !c.identity && (c.stage === "waiting" || c.issues.every(i => i.code === "IDENTIFICATION_SETUP")));
      const pending = deps.selection ? pendingAll : pendingAll.slice(0, config.batchLimit);
      // This whole-scope barrier completes before any concurrent paid request.
      // Per-card checks remain at reservation time, and reuse the verified preview.
      const mediaScope=deps.selection?.captures??pending.map(c=>({cardId:c.id,photos:c.photos}));
      const mediaState=await readV2State(root),rotationCardIds=deps.selection?Object.values(mediaState.cards).filter(inScope).map(c=>c.id):pending.map(c=>c.id);
      const identificationRotations=await readV2PhotoRotations(root,{state:mediaState,cardIds:rotationCardIds});
      const media=await measureV2(root,'selected-media-preflight',()=>inspectV2SelectedMedia(root,mediaScope,identificationRotations),{runId:jobId});
      const categories=inspectV2KnownCategories(await readV2State(root),config,mediaScope);
      await fs.writeFile(path.join(v2Dir(root),'media-preflight-latest.json'),JSON.stringify({media,categories,runId:jobId,providerCalls:0},null,2));
      const prePaidState=await readV2State(root),requiresPaid=pending.some(c=>!prePaidState.knowledge[digest(c.photos.map(p=>p.hash))]);
      if(!media.ready||!deps.identifyOnly&&requiresPaid&&!categories.ready){await withV2State(s=>{
        const detail=!media.ready?'Selected original media did not pass full decode preflight; zero new identification calls were sent.':'Known selected categories require fresh supported metadata before paid identification.';s.notices.push(detail);
        for(const card of Object.values(s.cards).filter(inScope)){const failed=media.rows.filter(r=>r.status==='blocked'&&card.photos.some(p=>p.hash===r.hash));if(failed.length&&!card.draftId&&!Object.values(s.submissions).some(sub=>sub.payload.captureIds.includes(card.captureId)))issue(card,failed.some(r=>r.reason==='original-changed')?'ORIGINAL_CHANGED':'IDENTIFICATION_SETUP',detail,'Media preflight');}
        s.lastRun!.status='failed';s.lastRun!.finishedAt=nowIso();event(s,'pre-paid-preflight-blocked',detail);
      },root);return readV2State(root);} 
      const activeCalls = new Set<string>(), admission={stopped:false};
      await mapV2Bounded(pending, V2_PREPARATION_LIMITS.identification, card => measureV2(root,"identification",()=>identifyOne(card.id, root, config, deps, activeCalls,identificationRotations,admission),{cardId:card.id,runId:jobId}));
      if(deps.identifyOnly){await withV2State(s=>{s.lastRun!.status='finished';s.lastRun!.finishedAt=nowIso();event(s,'identify-only-finished','Identification and actual token usage retained; category, media hosting, draft preparation and browser handoff skipped');},root);return readV2State(root);}
      const identified = Object.values((await readV2State(root)).cards).filter(c => inScope(c) && c.identity && !c.draftId);
      const missingCategories = Array.from(new Set(identified.flatMap(c => {
        const category = config.categories.find(t => t.categoryId === c.identity!.categoryId);
        return !category || Date.now() - Date.parse(category.observedAt) > 7 * 86400000 ? [c.identity!.categoryId] : [];
      })));
      if (deps.categoryRequirements && missingCategories.length) {
        try {
          const report = await measureV2(root,"category-requirements",()=>deps.categoryRequirements!(missingCategories),{runId:jobId});
          let retainedReport:unknown=null;
          try{retainedReport=JSON.parse(await fs.readFile(path.join(v2Dir(root),'category-metadata.json'),'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
          const merged=mergeV2CategoryReports(retainedReport,report,config.categories);
          const temporary = path.join(v2Dir(root), `category-metadata-${randomUUID()}.tmp`);
          await fs.writeFile(temporary, JSON.stringify(merged, null, 2),{flag:'wx',flush:true}); await replaceV2Checkpoint(temporary, path.join(v2Dir(root), "category-metadata.json"));
          config.categories = (await readV2Config(root)).categories;
          await withV2State(s => {
            recoverCompletenessHolds(s, config, inScope);
            event(s, "category-metadata", `${report.categories.length} current category condition/specific requirements retained from eBay`);
          }, root);
        } catch {
          await withV2State(s => { s.notices.push("Current category requirements could not be read through the seller connection; no required values were guessed."); }, root);
        }
      }
      await measureV2(root,"draft-preparation",()=>prepareGroups(root, config, deps),{runId:jobId});
    }
    await withV2State(s => { s.lastRun!.status = "finished"; s.lastRun!.finishedAt = nowIso(); event(s, "run-finished", "Local bounded processing finished; only retained readbacks establish eBay verification"); }, root);
    return readV2State(root);
  } catch (error) {
    await withV2State(s => {
      if (s.lastRun?.id === jobId) { s.lastRun.status = "failed"; s.lastRun.finishedAt = nowIso(); }
      s.notices.push(error instanceof V2UploaderAdmissionError?error.message:"V2 processing stopped safely. Check scan-folder access, local configuration and retained evidence; existing inventory was preserved.");
      event(s, "run-failed", "No raw provider or credential details were retained");
    }, root);
    throw Error("V2 processing did not finish. Review the dashboard checkpoint; no existing work was replaced.");
  } finally { await release(); }
}
async function runV2Measured(root = process.cwd(), jobId: string = randomUUID(), deps: V2WorkerDependencies = {}) {
  await withV2PreparationCommits(()=>withV2TimingContext({runId:jobId},async()=>{const local=await runV2Local(root,jobId,deps);if(local.lastRun?.status==='failed'||deps.identifyOnly)return local;
  await recoverV2DraftArchivesAfterOperation(root);
  if(deps.browserAdapter && deps.selection) for(const job of await listV2BrowserJobs(root)) {
    const state=await readV2State(root);
    if(job.stage!=="ready-upload" || job.lease || job.groups.some(g=>g.cardIds.some(id=>!state.cards[id] || !deps.selection!.candidateIds.includes(candidateId(state.cards[id].photos))))) continue;
    const claimed=await claimV2BrowserJob(root,job.id,`worker-${jobId}`);
    await executeV2BrowserUpload(root,job.id,claimed.lease,deps.browserAdapter);
  }
  }));
  return readV2State(root);
}


export async function runV2(root=process.cwd(),jobId:string=randomUUID(),deps:V2WorkerDependencies={}){
 return withV2ConfigReads(()=>withV2AcceptedActivity(root,{batchId:jobId,lane:'worker',phase:'preparation',owner:`worker-${jobId}`,step:'Accepted worker execution started',nextStep:deps.identifyOnly?'Organize exact identified intake into named ready batches; preserve any identity holds':'Consume the exact browser handoff or resolve current per-card exceptions'},()=>runV2Measured(root,jobId,deps)));
}
