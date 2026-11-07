import runtimeRoot from './card-processing-v2-runtime-root.cjs';
import {v2IdentificationAccounting} from './card-processing-v2-accounting.ts';
import {v2OrientedImage} from './card-processing-v2-photo-rotation.ts';
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { z } from "zod";
import { digest, type V2Card, type V2State } from "./card-processing-v2.ts";
import { readV2Config, readV2State, v2Dir, type V2Config } from "./card-processing-v2-store.ts";
import { loadCardBacklog } from "./card-backlog-store.ts";
import { readV2ResetTransfers } from "./card-processing-v2-reset.ts";

const idSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const v2ReadyBatchIdsSchema=z.array(z.string().uuid()).min(1).max(100).refine(ids=>new Set(ids).size===ids.length,'Select each ready batch once').transform(ids=>ids.slice().sort());
export const v2SelectionSchema = z.object({ mode: z.enum(["all", "selected"]), token: idSchema, candidateIds: z.array(idSchema).min(1).max(500).optional(), sourceTransferId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/).optional(), readyBatchId:z.string().uuid().optional(), readyBatchIds:v2ReadyBatchIdsSchema.optional() }).strict()
  .superRefine((s, ctx) => { if([s.sourceTransferId,s.readyBatchId,s.readyBatchIds].filter(Boolean).length>1)ctx.addIssue({code:"custom",message:"Choose either a committed transfer or a named ready batch."}); if (s.mode === "selected" && !s.candidateIds?.length || s.mode === "all" && s.candidateIds !== undefined) ctx.addIssue({ code: "custom", message: "Choose all eligible pairs or an explicit nonempty selection." }); });
export type V2Selection = z.infer<typeof v2SelectionSchema>;
export const candidateId = (photos: { hash: string }[]) => digest(["v2-photo-pair-selection", photos.map(p => p.hash).sort()]);
export type V2SelectedCapture = { candidateId: string; cardId?: string; photos: V2Card["photos"] };
export type ResolvedV2Selection = { token: string; candidateIds: string[]; captures: V2SelectedCapture[]; activationRequired: boolean; sourceTransferId?: string; readyBatchId?: string; readyBatchIds?:string[] };
type InternalCandidate = V2SelectedCapture & { id: string; photoCount: 2; label: string; stage: string; eligible: boolean; detail: string; groupId?: string };
const normalizePath = (p: string) => path.resolve(p).toLowerCase();
/** A never-sent card can recover after fresh spending authority; retained calls are never erased or retried. */
export function canRecoverV2BudgetHold(card: V2Card, state: V2State, config: V2Config, now = Date.now()) {
  const settings = config.identification;
  if (!settings || Date.parse(settings.expiresAt) <= now || card.identity || card.draftId || card.inventoryArchive
    || !card.issues.length || !card.issues.every(i => i.code === "IDENTIFICATION_BUDGET")
    || state.calls.some(call => call.cardId === card.id)
    || card.groupId && Object.values(state.submissions).some(sub => sub.groupId === card.groupId)) return false;
  const reserve = Math.ceil(settings.maxInputTokens * settings.inputUsdPerMillion + settings.maxOutputTokens * settings.outputUsdPerMillion);
  const accounting=v2IdentificationAccounting(state.calls),committed=accounting.committedMicros;
  const key = digest(["openai-identification-v2", card.photos.map(p => p.hash), settings.model]);
  return accounting.safe&&Number.isSafeInteger(reserve) && reserve > 0 && Number.isSafeInteger(committed)
    && committed + reserve <= settings.capMicros && !state.calls.some(call => call.key === key);
}
function eligibility(card: V2Card, submissionOwned: boolean, state: V2State, config: V2Config) {
  if(card.activeQuantityOperationId)return{eligible:false,detail:"Existing active quantity operation owns this capture; reconcile same item and archive, never prepare a draft."};
  if(card.inventoryArchive)return{eligible:false,detail:card.inventoryArchive.disposition==="sold"?"Sold inventory; resume its retained archive only.":"Listed inventory; resume its retained archive only."};
  if (submissionOwned || card.draftId || card.stage === "verified") return { eligible: false, detail: "Already bound to a draft or upload. Resume its existing ID." };
  const recoverable = ["IDENTIFICATION_SETUP", "IDENTIFICATION_CONTEXT", "CATEGORY", "SPECIFICS", "PHOTOS", "TITLE", "DESCRIPTION", "SELECTION_GROUP"];
  if (canRecoverV2BudgetHold(card, state, config)) return { eligible: true, detail: "Spending headroom restored; this original pair has no prior identification call. Process to resume it once." };
  if (card.issues.some(i => !recoverable.includes(i.code))) return { eligible: false, detail: card.issues.map(i => i.detail).join(" ") };
  return { eligible: true, detail: card.issues.length ? card.nextAction : "Both original sides will be processed together." };
}
async function snapshot(root: string, sourceTransferId?: string, readyBatchId?:string, readyBatchIds?:string[]) {
  if(readyBatchIds)readyBatchIds=v2ReadyBatchIdsSchema.parse(readyBatchIds);
  if([sourceTransferId,readyBatchId,readyBatchIds].filter(Boolean).length>1)throw Error("Choose one committed source scope");
  let [{ scanV2Folder, pairV2Photos }, state, config, reset, legacy] = await Promise.all([
    import("./card-processing-v2-worker.ts"), readV2State(root), readV2Config(root), readV2ResetTransfers(root), (readyBatchId||readyBatchIds) ? Promise.resolve({cards:[],sources:[]}) : loadCardBacklog({ root, scans: [] }),
  ]);
  if (legacy.sources.some(s => s.status === "invalid")) throw Error("Existing inventory evidence needs reconciliation before selecting photos.");
  const readyScope=readyBatchId||readyBatchIds?await readV2ScopedReadyBatchScope(root,readyBatchIds??[readyBatchId!],state):undefined;
  if(readyScope)state=readyScope.state;
  const scoped=sourceTransferId?await readV2ScopedTransferPairs(root,sourceTransferId):readyScope?.pairs;
  const files = scoped ? scoped.flat() : await scanV2Folder(config.folder), { pairs, unmatched } = scoped ? {pairs:scoped,unmatched:[]} : pairV2Photos(files, config.pairing);
  const legacyHashes = new Set(legacy.cards.flatMap(c => c.photoHashes));
  const baselineHashes = new Set(state.baseline?.hashes ?? []), baselinePaths = new Set((state.baseline?.paths ?? []).map(normalizePath));
  const ownedCards = Object.values(state.cards), submissions = new Set(Object.values(state.submissions).map(s => s.groupId));
  const duplicates = new Map<string, number>();
  for (const pair of pairs) duplicates.set(candidateId(pair), (duplicates.get(candidateId(pair)) ?? 0) + 1);
  const candidates: InternalCandidate[] = [], seen = new Set<string>();
  for (const pair of pairs) {
    const id = candidateId(pair); if (seen.has(id)) continue; seen.add(id);
    const card = ownedCards.find(c => candidateId(c.photos) === id);
    if(card?.readyBatch&&!readyBatchId&&!readyBatchIds)continue;
    const transfer = reset.receipts.flatMap(r => r.pairs).find(p => !p.guards.hardHolds.length && !p.guards.positiveDispositions.length && candidateId(p.photos.map(p => ({ hash: p.sha256.toLowerCase() }))) === id
      && p.photos.every(p => pair.some(q => normalizePath(q.path) === normalizePath(p.path) && q.hash === p.sha256.toLowerCase())));
    const protectedWork = !transfer && pair.some(p => baselineHashes.has(p.hash) || baselinePaths.has(normalizePath(p.path)) || legacyHashes.has(p.hash));
    const status = card ? eligibility(card, !!card.groupId && submissions.has(card.groupId), state, config) : { eligible: !!state.baseline && !protectedWork && pair[0].hash !== pair[1].hash,
      detail: !state.baseline ? "Activate V2 first to protect existing work." : protectedWork ? "Protected existing inventory; an exact authorized transfer is required." : "New original pair ready for identification." };
    const photos: V2Card["photos"] = card ? card.photos : [{ ...pair[0], side: "front" }, { ...pair[1], side: "back" }];
    candidates.push({ id, candidateId: id, ...(card ? { cardId: card.id } : {}), photos, photoCount: 2, label: card?.title || card?.identity?.name || path.basename(pair[0].path).replace(/\.[^.]+$/, ""),
      stage: card?.stage ?? (protectedWork ? "protected" : "waiting"), ...status,
      ...(duplicates.get(id)! > 1 ? { detail: `${status.detail} Copied files are counted once.` } : {}), ...(card?.groupId ? { groupId: card.groupId } : {}) });
  }
  if (candidates.length > 500) throw Error("Select from at most 500 original pairs per processing run.");
  // Fingerprint actual selection inputs, not unrelated global checkpoint revisions.
  // Existing retained snapshots remain immutable and validate against their own body.
  const content = { version: 1, ...(sourceTransferId?{sourceTransferId}:{}), ...(readyBatchId?{readyBatchId}:{}), ...(readyBatchIds?{readyBatchIds}:{}), folder: normalizePath(config.folder), pairing: config.pairing, activationRequired: !state.baseline,
    configKey: digest(config),
    legacyKey: digest(Array.from(legacyHashes).sort()), transfersKey: digest(reset.transfers), unmatched: unmatched.map(p => [normalizePath(p.path), p.hash]), candidates };
  return { token: digest(content), content };
}
export async function listV2Candidates(root = process.cwd(), sourceTransferId?: string, readyBatchId?:string, readyBatchIds?:string[]) {runtimeRoot.assertV2RuntimeRoot(root);
  const current = await snapshot(root,sourceTransferId,readyBatchId,readyBatchIds), directory = path.join(v2Dir(root), "selections"); await fs.mkdir(directory, { recursive: true });
  try { await fs.writeFile(path.join(directory, `${current.token}.json`), JSON.stringify(current), { flag: "wx" }); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
  return { token: current.token, activationRequired: current.content.activationRequired, unmatchedPhotos: current.content.unmatched.length,
    candidates: current.content.candidates.map(({ photos: _photos, candidateId: _candidateId, groupId: _groupId, ...candidate }) => ({ ...candidate,
      frontUrl: `/api/card-processing-v2/candidate-photo?token=${current.token}&id=${candidate.id}&side=front`,
      backUrl: `/api/card-processing-v2/candidate-photo?token=${current.token}&id=${candidate.id}&side=back` })) };
}
export async function resolveV2Selection(root: string, raw: unknown): Promise<ResolvedV2Selection> {
  const request = v2SelectionSchema.parse(raw), current = await snapshot(root,request.sourceTransferId,request.readyBatchId,request.readyBatchIds);
  if (request.token !== current.token) throw Error("The photos or processing records changed. Refresh the selection before starting.");
  const ids = request.mode === "all" ? current.content.candidates.filter(c => c.eligible).map(c => c.id) : request.candidateIds!;
  if (new Set(ids).size !== ids.length) throw Error("Select each physical card pair only once.");
  if (!ids.length && !current.content.activationRequired) throw Error("No eligible photo pairs are selected. Review the retained holds.");
  const selected = ids.map(id => { const c = current.content.candidates.find(c => c.id === id); if (!c || !c.eligible) throw Error("Unknown or held photo pair; refresh and select eligible cards."); return c; });
  for (const candidate of selected) if (candidate.groupId && current.content.candidates.some(c => c.groupId === candidate.groupId && !ids.includes(c.id))) throw Error("Select every card in the existing quantity group together.");
  return { token: current.token, ...(request.sourceTransferId?{sourceTransferId:request.sourceTransferId}:{}), ...(request.readyBatchId?{readyBatchId:request.readyBatchId}:{}), ...(request.readyBatchIds?{readyBatchIds:request.readyBatchIds}:{}), candidateIds: ids, captures: selected.map(c => ({ candidateId: c.id, ...(c.cardId ? { cardId: c.cardId } : {}), photos: c.photos })), activationRequired: current.content.activationRequired };
}
export async function readV2CandidatePhoto(root: string, token: string, id: string, side: "front" | "back") {
  idSchema.parse(token); idSchema.parse(id);
  const bytes = await fs.readFile(path.join(v2Dir(root), "selections", `${token}.json`)); if (bytes.length > 2_000_000) throw Error("Photo selection exceeds the preview bound.");
  const saved = JSON.parse(bytes.toString("utf8")) as Awaited<ReturnType<typeof snapshot>>;
  if (saved.token !== token || digest(saved.content) !== token) throw Error("Photo selection evidence changed.");
  const photo = saved.content.candidates.find(c => c.id === id)?.photos.find(p => p.side === side); if (!photo) throw Error("Selected original is unavailable.");
  if([saved.content.sourceTransferId,saved.content.readyBatchId,saved.content.readyBatchIds].filter(Boolean).length>1)throw Error("Ambiguous committed preview source");
  const transferred=saved.content.sourceTransferId?await readV2ScopedTransferPairs(root,saved.content.sourceTransferId):saved.content.readyBatchId?await readV2ScopedReadyBatchPairs(root,saved.content.readyBatchId):saved.content.readyBatchIds?await readV2ScopedReadyBatchUnionPairs(root,saved.content.readyBatchIds):undefined;
  const scopedPhoto=transferred?.flat().find(p=>normalizePath(p.path)===normalizePath(photo.path)&&p.hash===photo.hash);
  if(transferred&&!scopedPhoto)throw Error("Selected photo is outside committed transfer");
  const folder = await fs.realpath(scopedPhoto?path.dirname(scopedPhoto.path):(await readV2Config(root)).folder), file = await fs.realpath(photo.path), relative = path.relative(folder, file), before = await fs.lstat(photo.path);
  if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`) || before.isSymbolicLink() || !before.isFile() || before.size > 35_000_000) throw Error("Selected original escaped the configured folder.");
  const original = await fs.readFile(file), after = await fs.lstat(photo.path);
  if (after.isSymbolicLink() || before.size !== after.size || before.mtimeMs !== after.mtimeMs || createHash("sha256").update(original).digest("hex") !== photo.hash) throw Error("Selected original changed. Refresh the photo picker.");
  return sharp(await v2OrientedImage(original,root), { limitInputPixels: 80_000_000 }).rotate().resize({ width: 800, height: 1000, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
}



/** Exact committed ownership scope, never a folder scan or a copied-photo intake. */
export async function readV2ScopedTransferPairs(root:string,transferId:string):Promise<[{path:string;hash:string},{path:string;hash:string}][]>{
 if(!/^[a-z0-9][a-z0-9-]{0,79}$/.test(transferId))throw Error("Invalid source transfer");
 const reset=await readV2ResetTransfers(root),receipts=reset.receipts.filter(r=>r.resetId===transferId);
 if(receipts.length!==1||!receipts[0].pairs.length||receipts[0].pairs.length>100)throw Error("One committed scoped transfer required");
 const seen=new Set<string>(),pairs:[{path:string;hash:string},{path:string;hash:string}][]=[],state=await readV2State(root);
 for(const pair of receipts[0].pairs){if(pair.guards.hardHolds.length||pair.guards.positiveDispositions.length)throw Error("Transferred capture remains held");
  const owned=Object.values(state.cards).find(c=>digest(c.photos.map(p=>p.hash).sort())===digest(pair.photos.map(p=>p.sha256.toLowerCase()).sort()));
  if(owned?.draftArchive?.status==="moved"||owned?.draftMergeReceipt){const {resolveV2ArchivedPhoto}=await import("./card-processing-v2-draft-archive.ts");for(const photo of owned.photos)await resolveV2ArchivedPhoto(root,owned,photo);continue;}
  const ordered=[pair.photos.find(p=>p.side==="front"),pair.photos.find(p=>p.side==="back")];if(ordered.some(p=>!p))throw Error("Exact original sides required");
  const photos=[];for(const p of ordered){const photo=p!,st=await fs.lstat(photo.path),actual=await fs.realpath(photo.path);if(!st.isFile()||st.isSymbolicLink()||st.size>35000000||Date.now()-st.mtimeMs<2000||normalizePath(actual)!==normalizePath(photo.path)||seen.has(photo.sha256.toLowerCase()))throw Error("Scoped original missing, copied or changed");const bytes=await fs.readFile(photo.path),after=await fs.lstat(photo.path);if(st.size!==after.size||st.mtimeMs!==after.mtimeMs||after.isSymbolicLink()||createHash("sha256").update(bytes).digest("hex")!==photo.sha256.toLowerCase())throw Error("Scoped original changed");seen.add(photo.sha256.toLowerCase());photos.push({path:photo.path,hash:photo.sha256.toLowerCase()});}
  pairs.push(photos as [{path:string;hash:string},{path:string;hash:string}]);
 }return pairs;
}

/** Named batches expose only their committed manifest's exact original pairs.
 * No descendant folder discovery or uncommitted copied-photo intake is allowed. */
export async function readV2ScopedReadyBatchPairs(root:string,readyBatchId:string){return(await readV2ScopedReadyBatchScope(root,[readyBatchId])).pairs;}
/** Union committed scopes using one request-owned state snapshot. */
async function readV2ScopedReadyBatchScope(root:string,rawIds:string[],retainedState?:V2State){
 const ids=v2ReadyBatchIdsSchema.parse(rawIds),{resolveV2ReadyBatchSet}=await import('./card-processing-v2-ready-batches.ts'),{manifests,state}=await resolveV2ReadyBatchSet(root,ids,{state:retainedState}),pairs:[{path:string;hash:string},{path:string;hash:string}][]=[],seen=new Set<string>(),hashes=new Set<string>();
 for(const manifest of manifests)for(const entry of manifest.cards){const card=state.cards[entry.cardId];if(!card||card.captureId!==entry.captureId||candidateId(card.photos)!==entry.candidateId||entry.photos.length!==2||entry.photos.some(photo=>!card.photos.some(p=>p.hash===photo.hash&&normalizePath(p.path)===normalizePath(photo.path)&&p.side===photo.side)))throw Error('Named ready batch original ownership changed');
  if(card.draftArchive?.status==='moved'||card.inventoryArchive?.status==='moved'||card.draftMergeReceipt)continue;
  const front=entry.photos.find(p=>p.side==='front'),back=entry.photos.find(p=>p.side==='back');if(!front||!back||front.hash===back.hash)throw Error('Named ready batch requires exact original sides');
  if(seen.has(entry.candidateId)||entry.photos.some(p=>hashes.has(p.hash)))throw Error('Repeated original across ready manifests');seen.add(entry.candidateId);for(const p of entry.photos)hashes.add(p.hash);
  pairs.push([{path:front.path,hash:front.hash},{path:back.path,hash:back.hash}]);
 }
 if(pairs.length>500)throw Error('Select at most 500 committed original pairs');return{pairs,state};
}
export async function readV2ScopedReadyBatchUnionPairs(root:string,rawIds:string[]){return(await readV2ScopedReadyBatchScope(root,rawIds)).pairs;}
