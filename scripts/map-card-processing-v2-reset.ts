import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { loadCardBacklog } from "../lib/card-backlog-store.ts";
import { pairV2Photos } from "../lib/card-processing-v2-worker.ts";

// Read-only source inspection. The only writes are this bounded scope manifest.
async function main() {
const root = process.cwd();
const output = "artifacts/card-processing-v2-live-20261103/reset-scope.json";
const stateFile = "artifacts/card-processing-v2/state.json";
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const stateBytes = await fs.readFile(path.join(root, stateFile));
const state = JSON.parse(stateBytes.toString("utf8")) as { revision: number; baseline?: { initializedAt: string; paths: string[]; hashes: string[]; fileCount: number } };
if (!state.baseline || state.baseline.paths.length > 100) throw Error("Expected bounded protected V2 baseline");
const baseline = state.baseline;
const protectedHashes = new Set(baseline.hashes);
const images = await Promise.all(baseline.paths.map(async originalPath => {
  try {
    const stat = await fs.lstat(originalPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 35_000_000) return { path: originalPath, exists: true, hash: null, preserved: false, exception: "Original is not a supported regular bounded file" };
    const bytes = await fs.readFile(originalPath), actual = hash(bytes), after = await fs.lstat(originalPath);
    const stable = stat.size === after.size && stat.mtimeMs === after.mtimeMs;
    return { path: originalPath, exists: true, hash: actual, preserved: stable && protectedHashes.has(actual), exception: stable && protectedHashes.has(actual) ? null : "Original changed or its bytes are outside the protected hash set" };
  } catch { return { path: originalPath, exists: false, hash: null, preserved: false, exception: "Protected original is unavailable" }; }
}));
const usable = images.filter((image): image is typeof image & { hash: string } => image.preserved && image.hash !== null);
const pairing = pairV2Photos(usable.map(image => ({ path: image.path, hash: image.hash })), "named");
const backlog = await loadCardBacklog({ root, scans: [] });
const sourceByPath = new Map(backlog.sources.map(source => [source.path, source]));
const summarize = (card: typeof backlog.cards[number]) => ({
  cardId: card.id, aliases: card.aliases, skus: card.skus, captureId: card.captureId,
  state: card.state, frontHash: card.frontHash, backHashes: card.backHashes,
  physicalUnits: card.physicalUnits, recordedQuantity: card.recordedQuantity,
  receipts: card.receipts.map(receipt => ({ id: receipt.id, disposition: receipt.disposition, source: receipt.source,
    observedAt: receipt.observedAt ?? null, groupId: receipt.groupId ?? null, quantity: receipt.quantity ?? null })),
  holds: card.holds, pricingHolds: card.pricingHolds ?? [], issues: card.issues,
  excludedFromNewListing: card.excludedFromNewListing,
  sourceFiles: card.sources.map(source => ({ path: source, status: sourceByPath.get(source)?.status ?? "referenced", sharedFileMustNotBeDeletedWholesale: true })),
  nextOwner: card.nextOwner, nextAction: card.nextAction,
});
const pairs = pairing.pairs.map(([front, back]) => {
  const exact = backlog.cards.filter(card => card.frontHash === front.hash && card.backHashes.includes(back.hash));
  const reversed = backlog.cards.filter(card => card.frontHash === back.hash && card.backHashes.includes(front.hash));
  const partial = backlog.cards.filter(card => !exact.includes(card) && !reversed.includes(card) && card.photoHashes.some(photoHash => photoHash === front.hash || photoHash === back.hash));
  const matches = exact.length ? exact : reversed;
  const dispositions = Array.from(new Set(matches.flatMap(card => card.receipts.map(receipt => receipt.disposition))));
  const positive = dispositions.filter(disposition => ["live", "sold", "scheduled"].includes(disposition));
  const holds = Array.from(new Set(matches.flatMap(card => [...card.holds, ...card.issues])));
  return {
    pairKey: path.basename(front.path).replace(/F(\d{6})\.[^.]+$/i, ":$1"),
    photos: [{ ...front, side: "front" }, { ...back, side: "back" }],
    pairing: "Exact existing scanner filename key; number and six-digit session stamp bound together",
    legacyMatch: exact.length ? "exact-front-back" : reversed.length ? "exact-pair-reversed-legacy-orientation" : partial.length ? "partial-only-needs-reconciliation" : "no-local-match-not-inventory-clearance",
    exactLegacyCards: matches.map(summarize), partialLegacyCards: partial.map(summarize),
    knownDraftIds: Array.from(new Set(matches.flatMap(card => card.receipts.filter(receipt => receipt.disposition === "draft").map(receipt => receipt.id)))),
    positiveNonDraftDispositions: positive,
    sourceOrIdentityHolds: holds,
    localReadmissionAllowed: false,
    nextAction: positive.length ? "Retain live/sold/scheduled exclusion and reconcile exact current seller inventory before any reset or readmission."
      : matches.length !== 1 || partial.length || reversed.length ? "Resolve exact capture ownership, orientation and any partial matches before scoped history reset."
      : holds.length ? "Preserve source, seller, condition and identity holds; obtain exact reset scope and fresh inventory reconciliation."
      : "Await exact local-only versus local-and-eBay reset scope; preserve originals and same-ID receipt evidence until reconciliation.",
  };
});
const manifest = {
  version: 1, kind: "read-only-v2-reset-scope", generatedAt: new Date().toISOString(),
  userWording: "I need to preserve the photos, but delete all other draft history for these 34 cards so we can process them here.",
  scopeStatus: "Awaiting exact local-history versus matching-saved-eBay-draft deletion scope; this manifest authorizes neither.",
  source: { path: stateFile, sha256: hash(stateBytes), revision: state.revision, baselineInitializedAt: baseline.initializedAt },
  counts: {
    protectedPhotoFiles: baseline.fileCount, retainedPaths: images.filter(image => image.exists).length,
    preservedHashSetMembers: images.filter(image => image.preserved).length,
    uniqueCurrentHashes: new Set(usable.map(image => image.hash)).size,
    pairedPhysicalCardCandidates: pairs.length, unmatchedPhotos: pairing.unmatched.length,
    pairsWithExactLegacyMatch: pairs.filter(pair => pair.exactLegacyCards.length > 0).length,
    pairsWithDraftReceipts: pairs.filter(pair => pair.knownDraftIds.length > 0).length,
    pairsWithPositiveNonDraftDisposition: pairs.filter(pair => pair.positiveNonDraftDispositions.length > 0).length,
    pairsWithRetainedHolds: pairs.filter(pair => pair.sourceOrIdentityHolds.length > 0).length,
    invalidEvidenceSources: backlog.sources.filter(source => source.status === "invalid").length,
    missingEvidenceSources: backlog.sources.filter(source => source.status === "missing").length,
  },
  preservation: { sourcePhotosMoved: 0, sourcePhotosDeleted: 0, legacyFilesChanged: 0, ebayWrites: 0,
    baselineHashSetPreserved: usable.length === baseline.paths.length && new Set(usable.map(image => image.hash)).size === protectedHashes.size,
    initialPerPathHashMappingAvailable: false,
    note: "The existing baseline retains separate path and hash sets. Current collection preservation is checked against the full retained hash set; legacy exact pairs supply additional orientation/ownership evidence." },
  inventoryClearance: { fresh: false, absenceMeansUnlisted: false, note: "Local positive receipts are retained historical observations. Missing local receipts never prove absence from current eBay drafts, active, sold or scheduled inventory." },
  resetConstraints: [
    "34 protected files are not automatically 34 physical cards; this manifest counts exact filename front/back pairs separately.",
    "Never delete shared legacy manifests or queues wholesale to remove a subset of card history.",
    "No delete, move, archive, readmission or eBay edit occurred during this read-only mapping.",
    "Positive live/sold/scheduled dispositions and source/seller/condition/identity holds must survive any draft-history reset until exact supported reconciliation resolves them.",
    "Known saved draft IDs must be reconciled before new creation; local history deletion alone does not delete an eBay draft.",
  ],
  images, pairs, unmatchedPhotos: pairing.unmatched,
};
await fs.mkdir(path.dirname(path.join(root, output)), { recursive: true });
await fs.writeFile(path.join(root, output), JSON.stringify(manifest, null, 2), { flag: "wx" });
console.log(JSON.stringify({ manifest: output, counts: manifest.counts, preservation: manifest.preservation }));
}
main().catch(() => { console.error("Read-only V2 reset mapping stopped; no source photos or history were changed."); process.exitCode = 1; });
