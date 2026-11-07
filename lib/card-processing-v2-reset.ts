import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { withQueue, withQueueSnapshot } from "./card-orchestrator-store.ts";
import { type QueueState, type CardRecord } from "./card-orchestrator.ts";
import { digest } from "./card-processing-v2.ts";
import { acquireV2Lock, readV2Config, readV2State, v2Dir } from "./card-processing-v2-store.ts";

const hash = z.string().regex(/^[a-f0-9]{64}$/), text = z.string().trim().min(1).max(500);
const referenceSchema = z.object({ path: text, sha256: hash }).strict();
const photoSchema = z.object({ path: text, sha256: hash }).strict();
const requestSchema = z.object({ resetId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/), instructionId: text,
  pairs: z.array(z.object({ legacyCardId: text, photos: z.array(photoSchema).length(2) }).strict()).min(1).max(100),
  draftObservation: referenceSchema,
}).strict();
const browserObservationSchema = z.object({ kind: z.literal("read-only-browser-seller-observation"), seller: z.literal("imaydit58"), observedAt: z.string().datetime(),
  source: z.string().url().refine(value => { const url = new URL(value); return url.protocol === "https:" && url.hostname === "www.ebay.com" && url.pathname === "/sh/lst/drafts" && !url.username && !url.password; }), method: text, draftCount: z.literal(0), searchEmpty: z.literal(true), authenticatedBrowserRead: z.literal(true),
  apiConnectionVerified: z.boolean(), scopesObserved: z.array(z.string()).refine(scopes => scopes.includes("drafts")),
  inventoryClearanceComplete: z.literal(false), externalWrites: z.literal(0),
}).strict();
type Ref = z.infer<typeof referenceSchema>;
type Request = z.infer<typeof requestSchema>;
type Guard = { hardHolds: string[]; positiveDispositions: string[]; knownDraftIds: string[]; condition: string };
type ScopedSnapshot = { cards: Record<string, CardRecord>; related: Record<string, Record<string, unknown>>; writer: QueueState["draftWriter"] | null };
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const legacyDir = (root: string) => path.join(root, "artifacts/card-orchestrator");
const normalizedPath = (value: string) => path.resolve(value).toLowerCase();
const fresh = (at: string) => { const age = Date.now() - Date.parse(at); if (!Number.isFinite(age) || age < 0 || age > 3600000) throw Error("A fresh seller draft observation within sixty minutes is required"); };
const resetDirectory = (root: string, id: string) => path.join(v2Dir(root), "resets", id);
const relatedMaps = ["bulkAiSubmissions", "draftCreationGroups", "draftModelWorkflows", "knownInventoryObservations", "soldDraftGroups", "verifiedReceipts", "draftGroupRecoveries", "draftAppends", "draftConsolidations", "quantityReceiptGroups", "photoArchives", "photoArchiveFailures", "rejectedImports"] as const;

async function readReference(root: string, raw: unknown) {
  const reference = referenceSchema.parse(raw);
  if (path.isAbsolute(reference.path) || reference.path.split(/[\\/]/).includes("..")) throw Error("Reset evidence must remain under artifacts");
  const base = await fs.realpath(path.join(root, "artifacts")), filename = await fs.realpath(path.join(root, reference.path));
  const relative = path.relative(base, filename);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw Error("Reset evidence must remain under artifacts");
  const stat = await fs.stat(filename); if (!stat.isFile() || stat.size > 16_000_000) throw Error("Reset evidence exceeds the bounded size limit");
  const bytes = await fs.readFile(filename); if (sha(bytes) !== reference.sha256) throw Error("Reset evidence changed");
  return JSON.parse(bytes.toString("utf8")) as unknown;
}
async function writeReference(root: string, filename: string, body: unknown): Promise<Ref> {
  const bytes = Buffer.from(JSON.stringify(body, null, 2)); await fs.mkdir(path.dirname(filename), { recursive: true });
  const file = await fs.open(filename, "wx"); try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  return { path: path.relative(root, filename).replace(/\\/g, "/"), sha256: sha(bytes) };
}
const refString = (reference: Ref) => `${reference.path}#sha256=${reference.sha256}`;
function parseReference(value: string): Ref { const match = /^(.*)#sha256=([a-f0-9]{64})$/.exec(value); if (!match) throw Error("Reset receipt reference is invalid"); return { path: match[1], sha256: match[2] }; }
async function authority(root: string, instructionId: string) {
  const queue = JSON.parse(await fs.readFile(path.join(root, "artifacts/engineering-mission/work-queue.json"), "utf8")) as { instructions?: { id: string; text: string; capturedAt: string; taskIds: string[]; policyRefs: string[] }[] };
  const instruction = queue.instructions?.find(value => value.id === instructionId);
  if (!instruction || !instruction.taskIds.includes("card-processing-v2-reset-20261103") || !instruction.policyRefs.includes("scoped-local-reset-and-matching-ebay-draft-removal")
    || instruction.text !== "Reset local records and matching eBay drafts" || !Number.isFinite(Date.parse(instruction.capturedAt))) throw Error("The captured exact scoped reset instruction is required");
  return { instructionId: instruction.id, capturedAt: instruction.capturedAt, instructionHash: digest(instruction) };
}
function referencedCards(value: unknown, ids: Set<string>, found = new Set<string>()) {
  if (typeof value === "string" && ids.has(value)) found.add(value);
  else if (Array.isArray(value)) value.forEach(item => referencedCards(item, ids, found));
  else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) { if (ids.has(key)) found.add(key); referencedCards(item, ids, found); }
  return found;
}
function snapshot(s: QueueState, request: Request): ScopedSnapshot {
  const ids = new Set(request.pairs.map(pair => pair.legacyCardId));
  if (ids.size !== request.pairs.length) throw Error("Each physical pair requires one distinct legacy owner");
  const allIds = new Set(Object.keys(s.cards)), cards: Record<string, CardRecord> = {}, related: Record<string, Record<string, unknown>> = {};
  for (const pair of request.pairs) {
    const card = s.cards[pair.legacyCardId];
    if (!card || card.input.photos.length !== 2 || digest(card.input.photos.map(photo => photo.sha256.toLowerCase()).sort()) !== digest(pair.photos.map(photo => photo.sha256).sort())) throw Error("Reset scope does not match the exact legacy original pair");
    if (card.input.photos.some(photo => !pair.photos.some(p => normalizedPath(p.path) === normalizedPath(photo.path) && p.sha256 === photo.sha256.toLowerCase()))) throw Error("Legacy photo paths changed; exact capture reconciliation is required");
    if (Object.values(card.jobs).some(job => job.lease && Date.parse(job.lease.expiresAt) > Date.now())) throw Error("A selected legacy card has an active worker lease");
    cards[pair.legacyCardId] = structuredClone(card);
  }
  for (const field of relatedMaps) {
    const entries = (s[field] ?? {}) as Record<string, unknown>;
    for (const [key, value] of Object.entries(entries)) {
      const members = referencedCards(value, allIds); if (allIds.has(key)) members.add(key);
      if (!Array.from(members).some(id => ids.has(id))) continue;
      if (Array.from(members).some(id => !ids.has(id))) throw Error(`Reset overlaps an unrelated active ${field} group; scoped recovery is required`);
      (related[field] ??= {})[key] = structuredClone(value);
    }
  }
  const writer = s.draftWriter?.scope.some(id => ids.has(id)) ? structuredClone(s.draftWriter) : null;
  if (writer?.lease && Date.parse(writer.lease.expiresAt) > Date.now()) throw Error("The selected draft writer still has an active lease");
  return { cards, related, writer };
}
function guards(card: CardRecord, related: ScopedSnapshot["related"]): Guard {
  const hardHolds = [card.input.sourceHold, card.input.identityIssue, ...Object.entries(card.jobs).flatMap(([kind, job]) => kind !== "pricing" && job.state === "held" && job.reason && !/clearance expired|fresh four-scope|inventory clearance/i.test(job.reason) ? [`${kind}: ${job.reason}`] : [])].filter((value): value is string => !!value);
  if (card.input.identity.condition !== "Near mint or better") hardHolds.push(`Preserve explicit condition: ${card.input.identity.condition}`);
  const positive = [card.input.knownLive || card.draftLifecycle?.liveItemId || card.draftLifecycle?.state === "live" ? "live" : null, card.exclusion?.disposition, card.jobs.reconcile.result?.disposition,
    ...card.input.savedReceipts?.map(receipt => receipt.disposition) ?? []].filter((value): value is string => typeof value === "string" && ["live", "sold", "scheduled"].includes(value));
  for (const entry of Object.values(related.knownInventoryObservations ?? {})) { const row = entry as { cardId?: string; disposition?: string }; if (row.cardId === card.input.id && row.disposition && ["live", "sold", "scheduled"].includes(row.disposition)) positive.push(row.disposition); }
  for (const field of ["verifiedReceipts", "photoArchives"]) for (const entry of Object.values(related[field] ?? {})) {
    const row = entry as { cardId?: string; liveItemId?: string; soldItemId?: string };
    if (row.cardId && row.cardId !== card.input.id) continue;
    if (row.soldItemId) positive.push("sold"); else if (row.liveItemId) positive.push("live");
  }
  const drafts = [card.input.knownDraft, card.draftLifecycle?.draftId, card.exclusion?.disposition === "draft" ? card.exclusion.itemId : undefined,
    ...card.input.savedReceipts?.filter(receipt => receipt.disposition === "draft").map(receipt => receipt.itemId) ?? []].filter((value): value is string => !!value);
  return { hardHolds: Array.from(new Set(hardHolds)), positiveDispositions: Array.from(new Set(positive)), knownDraftIds: Array.from(new Set(drafts)), condition: card.input.identity.condition };
}
async function verifyPhotos(root: string, request: Request) {
  const folder = await fs.realpath((await readV2Config(root)).folder); const seen = new Set<string>();
  for (const pair of request.pairs) for (const photo of pair.photos) {
    const filename = await fs.realpath(photo.path), relative = path.relative(folder, filename), stat = await fs.lstat(photo.path);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !stat.isFile() || stat.isSymbolicLink() || stat.size > 35_000_000 || seen.has(photo.sha256)) throw Error("Reset requires distinct unchanged originals within the existing scan folder");
    if (sha(await fs.readFile(filename)) !== photo.sha256) throw Error("A protected original changed; reset stopped without deleting history");
    seen.add(photo.sha256);
  }
}
const planSchema = z.object({ version: z.literal(1), kind: z.literal("v2-scoped-local-reset-plan"), request: requestSchema,
  authority: z.object({ instructionId: text, capturedAt: z.string().datetime(), instructionHash: hash }).strict(),
  baselineHash: hash, selectedSnapshotHash: hash, scopedSnapshot: z.unknown(), createdAt: z.string().datetime(),
}).strict();
export type V2ResetReceipt = { version: 1; kind: "v2-scoped-local-reset-receipt"; resetId: string; released: true; owner: "card-processing-v2";
  committedAt: string; plan: Ref; authority: z.infer<typeof planSchema>["authority"]; queueRevisionBefore: number; queueRevisionAfter: number;
  pairs: { legacyCardId: string; sku: string; photos: CardRecord["input"]["photos"]; guards: Guard }[];
  photosPreserved: true; sourceFilesMoved: 0; sourceFilesDeleted: 0; ebayDraftsDeleted: 0; ebayDraftOutcome: "already-empty-observed";
  freshFourScopeClearanceRequiredBeforeDraftCreation: true; auditPreserved: true; draftObservation: Ref };
export type V2OwnershipReceipt=V2ResetReceipt|import('./card-processing-v2-legacy-transfer.ts').V2LegacyTransferReceipt;

/** Prepare concrete scoped retirement without changing photos, active legacy jobs or V2 intake. */
export async function prepareV2LocalReset(root: string, raw: unknown): Promise<Ref> {
  const request = requestSchema.parse(raw), release = await acquireV2Lock("worker", root);
  try {
    const approved = await authority(root, request.instructionId), observation = browserObservationSchema.parse(await readReference(root, request.draftObservation)); fresh(observation.observedAt);
    const baseline = (await readV2State(root)).baseline;
    if (!baseline || digest([...baseline.paths].map(normalizedPath).sort()) !== digest(request.pairs.flatMap(pair => pair.photos.map(photo => normalizedPath(photo.path))).sort())
      || digest([...baseline.hashes].sort()) !== digest(request.pairs.flatMap(pair => pair.photos.map(photo => photo.sha256)).sort())) throw Error("Reset must bind the exact complete protected baseline, not unrelated inventory");
    await verifyPhotos(root, request);
    const scoped = await withQueueSnapshot(legacyDir(root), s => snapshot(s, request), { lockWaitMs: 0 });
    const plan = { version: 1, kind: "v2-scoped-local-reset-plan", request, authority: approved, baselineHash: digest(baseline), selectedSnapshotHash: digest(scoped), scopedSnapshot: scoped, createdAt: new Date().toISOString() };
    return writeReference(root, path.join(resetDirectory(root, request.resetId), "plan.json"), plan);
  } finally { await release(); }
}

/** Commit only reviewed exact scope via the supported legacy queue transaction.
 * A committed queue marker plus immutable final receipt is required for readmission. */
export async function commitV2LocalReset(root: string, rawPlanReference: unknown): Promise<V2ResetReceipt> {
  const planReference = referenceSchema.parse(rawPlanReference), plan = planSchema.parse(await readReference(root, planReference)), release = await acquireV2Lock("worker", root);
  try {
    const request = plan.request, directory = resetDirectory(root, request.resetId), finalPath = path.join(directory, "receipt.json");
    const currentAuthority = await authority(root, request.instructionId);
    if (digest(currentAuthority) !== digest(plan.authority)) throw Error("Captured reset authority changed");
    const already = await withQueueSnapshot(legacyDir(root), s => request.pairs.map(pair => s.v2OwnershipTransfers?.[pair.legacyCardId]), { lockWaitMs: 0 });
    if (already.some(Boolean)) {
      if (!already.every(transfer => transfer?.resetId === request.resetId && transfer.receipt === already[0]!.receipt)) throw Error("Reset ownership is partial or belongs to another transfer; reconcile before continuing");
      const expected = parseReference(already[0]!.receipt);
      try { return await readReference(root, expected) as V2ResetReceipt; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        for (const name of (await fs.readdir(directory)).filter(name => name.startsWith("receipt-pending-"))) {
          const bytes = await fs.readFile(path.join(directory, name)); if (sha(bytes) !== expected.sha256) continue;
          await fs.rename(path.join(directory, name), finalPath); return JSON.parse(bytes.toString("utf8")) as V2ResetReceipt;
        }
        throw Error("Committed ownership has no matching pending receipt; retain the checkpoint for recovery");
      }
    }
    const observation = browserObservationSchema.parse(await readReference(root, request.draftObservation)); fresh(observation.observedAt);
    if (digest((await readV2State(root)).baseline) !== plan.baselineHash) throw Error("Protected V2 baseline changed after reset preparation");
    await verifyPhotos(root, request);
    let pending = "";
    const receipt = await withQueue(legacyDir(root), async s => {
      const scoped = snapshot(s, request); if (digest(scoped) !== plan.selectedSnapshotHash) throw Error("Selected active history changed; prepare and review a new reset scope");
      await verifyPhotos(root, request);
      const committedAt = new Date().toISOString();
      const result: V2ResetReceipt = { version: 1, kind: "v2-scoped-local-reset-receipt", resetId: request.resetId, released: true, owner: "card-processing-v2", committedAt,
        plan: planReference, authority: plan.authority, queueRevisionBefore: s.revision, queueRevisionAfter: s.revision + 1,
        pairs: request.pairs.map(pair => { const card = scoped.cards[pair.legacyCardId]; return { legacyCardId: pair.legacyCardId, sku: card.input.sku, photos: card.input.photos, guards: guards(card, scoped.related) }; }),
        photosPreserved: true, sourceFilesMoved: 0, sourceFilesDeleted: 0, ebayDraftsDeleted: 0, ebayDraftOutcome: "already-empty-observed", freshFourScopeClearanceRequiredBeforeDraftCreation: true, auditPreserved: true, draftObservation: request.draftObservation };
      pending = path.join(directory, `receipt-pending-${randomUUID()}.json`); const staged = await writeReference(root, pending, result);
      const finalReference = refString({ path: path.relative(root, finalPath).replace(/\\/g, "/"), sha256: staged.sha256 });
      s.v2OwnershipTransfers ??= {};
      for (const pair of result.pairs) {
        s.v2OwnershipTransfers[pair.legacyCardId] = { resetId: request.resetId, owner: "card-processing-v2", receipt: finalReference, photoHashes: pair.photos.map(photo => photo.sha256.toLowerCase()), retiredAt: committedAt, released: true, hardHolds: pair.guards.hardHolds, positiveDispositions: pair.guards.positiveDispositions };
        delete s.cards[pair.legacyCardId];
        s.events.push({ at: committedAt, cardId: pair.legacyCardId, kind: "ownership", event: "retired-to-card-processing-v2", detail: finalReference });
      }
      for (const [field, entries] of Object.entries(scoped.related)) for (const key of Object.keys(entries)) delete ((s as unknown as Record<string, Record<string, unknown>>)[field])[key];
      if (scoped.writer && s.draftWriter) {
        const ids = new Set(request.pairs.map(pair => pair.legacyCardId)); s.draftWriter.scope = s.draftWriter.scope.filter(id => !ids.has(id));
        if (s.draftWriter.creationAuthority) for (const id of Array.from(ids)) delete s.draftWriter.creationAuthority.bindings[id];
        if (!s.draftWriter.scope.length) delete s.draftWriter.lease;
      }
      return result;
    }, { lockWaitMs: 0 });
    await fs.rename(pending, finalPath);
    return receipt;
  } finally { await release(); }
}

/** Read-only ownership handoff. No old receipt or draft disappearance proves current absence. */
export async function readV2ResetTransfers(root: string) {
  try { await fs.stat(path.join(legacyDir(root), "state.json")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { receipts: [] as V2OwnershipReceipt[], transfers: {} as NonNullable<QueueState["v2OwnershipTransfers"]>, releasedHashes: [] as string[], releasedLegacyIds: [] as string[], inventoryClearanceComplete: false as const };
  }
  const registry = await withQueueSnapshot(legacyDir(root), s => structuredClone(s.v2OwnershipTransfers ?? {}), { lockWaitMs: 0 });
  const receipts: V2OwnershipReceipt[] = [];
  for (const reference of Array.from(new Set(Object.values(registry).map(transfer => transfer.receipt)))) {
    let receipt = await readReference(root, parseReference(reference)) as V2OwnershipReceipt;
    if(receipt.kind==='v2-legacy-ownership-transfer-receipt'){
      const {readV2LegacyTransferManifest}=await import('./card-processing-v2-legacy-transfer.ts');receipt=(await readV2LegacyTransferManifest(root,parseReference(reference))).receipt;
    }
    if (!["v2-scoped-local-reset-receipt","v2-legacy-ownership-transfer-receipt"].includes(receipt.kind) || !receipt.released || receipt.pairs.some(pair => registry[pair.legacyCardId]?.resetId !== receipt.resetId || registry[pair.legacyCardId]?.receipt !== reference)) throw Error("Ownership receipt does not match committed queue ownership");
    receipts.push(receipt);
  }
  return { receipts, transfers: registry, releasedHashes: Array.from(new Set(receipts.flatMap(receipt => receipt.pairs.flatMap(pair => pair.photos.map(photo => photo.sha256.toLowerCase()))))),
    releasedLegacyIds: receipts.flatMap(receipt => receipt.pairs.map(pair => pair.legacyCardId)), inventoryClearanceComplete: false as const };
}
