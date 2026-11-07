/** Pure draft-only consolidation. This plans no active-listing operations and
 * never edits frozen submission history, photos, prices or eBay state. */
import { digest, type V2Card } from './card-processing-v2.ts';
import {v2StableCatalogIdentityKey} from './card-processing-v2-stable-identity.ts';

export type V2MergeEvidence = { path: string; sha256: string };
export type V2MergeDraft = {
  draftId: string; sku: string; quantity: number;
  price: { amount: string | null; currency: string };
  protectedValues: Record<string, string>; evidence: V2MergeEvidence;
};
export type V2RetainedMerge = {
  id: string; status: 'planned' | 'quantity-saved' | 'complete';
  survivorDraftId: string; sourceDraftIds: string[]; newCaptureIds: string[];
};
type Capture = { cardId: string; captureId: string; photoHashes: string[] };
type Exception = { code: string; draftIds: string[]; cardIds: string[]; detail: string };
export type V2DraftMergePlanInput = {
  snapshot: { scope: 'drafts'; complete: true; observedAt: string; evidence: V2MergeEvidence };
  drafts: V2MergeDraft[]; knownCards: V2Card[]; newCards: V2Card[];
  retainedOperations?: V2RetainedMerge[];
};
const ref = (r: V2MergeEvidence) => !!r?.path && /^[a-f0-9]{64}$/.test(r.sha256);
const idSort = (a: V2MergeDraft, b: V2MergeDraft) => a.draftId.length - b.draftId.length || a.draftId.localeCompare(b.draftId);
const capture = (c: V2Card): Capture => ({ cardId: c.id, captureId: c.captureId, photoHashes: c.photos.map(p => p.hash) });
/** Merge-only stable catalog key, never substituted into frozen submission IDs.
 * Pose/background prose is descriptive, not a product discriminator. Preserve
 * explicit named art variations and distinguishing Finish/Edition/Autograph facts.
 */
export function v2DraftMergeIdentityKey(c: V2Card) {
  if (!c.identity || c.identity.serial) throw Error('Exact unnumbered identity required');
  return v2StableCatalogIdentityKey(c);
}
export function planV2DraftMerges(input: V2DraftMergePlanInput, now = Date.now()) {
  const age = now - Date.parse(input.snapshot?.observedAt);
  if (input.snapshot?.scope !== 'drafts' || input.snapshot.complete !== true || !ref(input.snapshot.evidence)
    || !Number.isFinite(age) || age < 0 || age > 3600000) throw Error('Complete fresh draft-only snapshot required');
  if (new Set(input.drafts.map(d => d.draftId)).size !== input.drafts.length
    || input.drafts.some(d => !/^\d+$/.test(d.draftId) || !Number.isSafeInteger(d.quantity) || d.quantity < 1
      || !ref(d.evidence) || !/^[A-Z]{3}$/.test(d.price.currency)
      || d.price.amount !== null && !/^\d+(?:\.\d{1,2})?$/.test(d.price.amount))) throw Error('Unique actual draft IDs, quantities, price values and evidence required');
  const exceptions: Exception[] = [], resumeOperationIds: string[] = [];
  const blockedDrafts = new Set<string>(), consumed = new Set<string>(), blockedKeys = new Set<string>();
  const active = input.retainedOperations ?? [];
  if (new Set(active.map(o => o.id)).size !== active.length) throw Error('Duplicate retained merge operation');
  for (const op of active) {
    if (!op.sourceDraftIds.includes(op.survivorDraftId)) throw Error('Retained operation survivor missing');
    op.newCaptureIds.forEach(id => consumed.add(id));
    if (op.status !== 'complete') {
      resumeOperationIds.push(op.id); op.sourceDraftIds.forEach(id => blockedDrafts.add(id));
      for (const c of input.knownCards.filter(c => c.draftId && op.sourceDraftIds.includes(c.draftId)))
        if (c.identity && !c.identity.serial) blockedKeys.add(v2DraftMergeIdentityKey(c));
    } else for (const id of op.sourceDraftIds.filter(id => id !== op.survivorDraftId && input.drafts.some(d => d.draftId === id))) {
      blockedDrafts.add(id);
      exceptions.push({ code: 'COMPLETED_DONOR_REAPPEARED', draftIds: [id], cardIds: [], detail: 'Previously deleted donor is present; reconcile the retained operation, never add its quantity again.' });
    }
  }
  type Group = { key: string; drafts: V2MergeDraft[]; existing: V2Card[]; added: V2Card[] };
  const groups = new Map<string, Group>();
  const ownedCaptures = new Set(input.knownCards.filter(c => c.draftId || c.draftArchive || c.inventoryArchive || c.activeQuantityOperationId).map(c => c.captureId));
  const group = (key: string) => { let g = groups.get(key); if (!g) { g = { key, drafts: [], existing: [], added: [] }; groups.set(key, g); } return g; };
  for (const draft of input.drafts) {
    if (blockedDrafts.has(draft.draftId)) continue;
    const cards = input.knownCards.filter(c => c.draftId === draft.draftId);
    const reject = (code: string, detail: string) => exceptions.push({ code, detail, draftIds: [draft.draftId], cardIds: cards.map(c => c.id) });
    if (!cards.length || !cards.some(c => c.sku === draft.sku) || cards.some(c => !c.identity || c.issues.length || c.identity.damage || c.identity.graded || c.inventoryArchive || c.activeQuantityOperationId)) {
      reject('UNKNOWN_DRAFT_IDENTITY', 'No unambiguous retained exact identity/condition binding for the current draft.'); continue;
    }
    if (cards.some(c => !!c.identity!.serial)) { reject('SERIALIZED_SEPARATE', 'Serialized cards remain separate; no quantity merge.'); continue; }
    const keys = new Set(cards.map(v2DraftMergeIdentityKey));
    if (keys.size !== 1 || new Set(cards.map(c => c.captureId)).size !== cards.length || cards.length > draft.quantity) {
      reject('DRAFT_OWNERSHIP_CONFLICT', 'Current quantity or local physical ownership conflicts with the retained draft identity.'); continue;
    }
    const g = group(Array.from(keys)[0]); g.drafts.push(draft); g.existing.push(...cards);
  }
  const newSeen = new Set<string>();
  for (const c of input.newCards) {
    if (newSeen.has(c.captureId)) throw Error('Repeated new capture cannot increase quantity twice');
    newSeen.add(c.captureId);
    if (consumed.has(c.captureId)) continue; // Resume/complete receipts already own this exact addition.
    if (ownedCaptures.has(c.captureId) || c.draftId || c.draftArchive || c.inventoryArchive || c.activeQuantityOperationId
      || !c.identity || c.issues.length || c.identity.damage || c.identity.graded || !['identified', 'consolidated', 'prepared'].includes(c.stage)) {
      exceptions.push({ code: 'NEW_CAPTURE_NOT_UNBOUND', draftIds: c.draftId ? [c.draftId] : [], cardIds: [c.id], detail: 'Only identified unheld unbound new physical captures may increase draft quantity.' }); continue;
    }
    if (c.identity.serial) { exceptions.push({ code: 'SERIALIZED_SEPARATE', draftIds: [], cardIds: [c.id], detail: 'Serialized capture remains a separate new draft.' }); continue; }
    const key=v2DraftMergeIdentityKey(c);
    if(blockedKeys.has(key)) { exceptions.push({code:'MERGE_IN_PROGRESS',draftIds:[],cardIds:[c.id],detail:'Matching draft quantity operation is unfinished; resume it before adding another copy.'}); continue; }
    group(key).added.push(c);
  }
  const merges = [], newDraftGroups = [];
  for (const g of Array.from(groups.values()).sort((a, b) => a.key.localeCompare(b.key))) {
    if (!g.drafts.length) { newDraftGroups.push({ identityKey: g.key, quantity: g.added.length, captures: g.added.map(capture) }); continue; }
    if (g.drafts.length === 1 && !g.added.length) continue;
    const priceKeys = new Set(g.drafts.filter(d => d.price.amount !== null).map(d => digest([d.price.currency, Number(d.price.amount)])));
    if (priceKeys.size > 1) {
      exceptions.push({ code: 'PRICE_CONFLICT', draftIds: g.drafts.map(d => d.draftId), cardIds: g.added.map(c => c.id), detail: 'Existing populated prices differ; isolate this group rather than change or silently discard a price.' }); continue;
    }
    const existingIds = g.existing.map(c => c.captureId);
    if (new Set(existingIds).size !== existingIds.length) {
      exceptions.push({ code: 'DRAFT_CAPTURE_OVERLAP', draftIds: g.drafts.map(d => d.draftId), cardIds: g.existing.map(c => c.id), detail: 'A physical capture is attributed to multiple drafts; do not sum it.' }); continue;
    }
    // Preserve priced work first, then the most-developed quantity draft (which
    // already has representative-copy wording), then the lowest numeric ID.
    const ordered = [...g.drafts].sort((a, b) => Number(b.price.amount !== null) - Number(a.price.amount !== null) || b.quantity-a.quantity || idSort(a, b));
    const survivor = ordered[0], sourceDrafts = [...g.drafts].sort(idSort), newCaptures = g.added.map(capture).sort((a, b) => a.captureId.localeCompare(b.captureId));
    const existingQuantity = sourceDrafts.reduce((n, d) => n + d.quantity, 0), targetQuantity = existingQuantity + newCaptures.length;
    const binding = { identityKey: g.key, survivorDraftId: survivor.draftId, sources: sourceDrafts.map(d => ({ draftId: d.draftId, quantity: d.quantity })), newCaptureIds: newCaptures.map(c => c.captureId), targetQuantity };
    merges.push({ id: digest(['v2-draft-merge-1', binding]), ...binding, survivor, sourceDrafts,
      deleteDraftIds: ordered.slice(1).map(d => d.draftId).sort(), existingQuantity, targetQuantity,
      knownExistingCaptures: g.existing.map(capture), unattributedExistingQuantity: existingQuantity - existingIds.length,
      newCaptures, priceWrites: 0 as const, publish: false as const,
      requiredOrder: ['persist-intent', 'save-survivor-quantity', 'reopen-survivor-verify-protected-values', 'delete-exact-donors', 'verify-donor-absence', 'commit-merge-overlay', 'archive-new-originals'] });
  }
  return { version: 1 as const, kind: 'v2-draft-merge-plan' as const, snapshot: input.snapshot, merges, newDraftGroups, exceptions,
    resumeOperationIds: resumeOperationIds.sort(), activeInventoryScans: 0 as const, publish: false as const };
}
