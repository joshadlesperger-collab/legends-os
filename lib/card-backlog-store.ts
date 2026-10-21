import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { fingerprint, reviewedIdentity, type QueueState } from "./card-orchestrator.ts";
import { importLegacyCard } from "./card-orchestrator-import.ts";
import { backlogCounts, reconcileBacklog, reconcileScans, unique, type BacklogEvidence, type BacklogPrice, type BacklogReceipt, type BacklogScan, type BacklogSnapshot, type BacklogSource, type CardIdentity } from "./card-backlog.ts";

type Row = Record<string, unknown>;
const row = (v: unknown): Row => v && typeof v === "object" && !Array.isArray(v) ? v as Row : {};
const rows = (v: unknown): Row[] => Array.isArray(v) ? v.map(row) : [];
const str = (v: unknown) => typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
const text = (...v: unknown[]) => v.map(str).find(Boolean) || "";
const num = (v: unknown) => v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : null;
const sha = (v: unknown) => /^[a-f0-9]{64}$/i.test(str(v)) ? str(v).toLowerCase() : "";
const normPath = (v: string) => v.replace(/\\/g, "/").toLowerCase();
const basename = (v: string) => v.split(/[\\/]/).pop() || "";
const hashCache = new Map<string, { size: number; mtime: number; hash: string }>();
export const defaultCardInbox = () => process.env.CARD_INBOX_PATH || path.join(os.homedir(), "OneDrive", "Documents", "Legends OS", "Card Inbox");
function identity(r: Row): CardIdentity {
  const fields: Record<string, unknown[]> = { player: [r.player, r.character], season: [r.season, r.year], set: [r.set], manufacturer: [r.manufacturer],
    cardNumber: [r.cardNumber, r.card_number, r.number], parallel: [r.parallel, r.variant], serial: [r.serial, r.serial_text, r.serialNumber],
    printRun: [r.printRun, r.print_run, r.run], language: [r.language], condition: [r.condition_plan, r.condition], conditionType: [r.condition_type, r.conditionType], sport: [r.sport_game, r.sport], team: [r.team] };
  return Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, text(...v)]).filter(([, v]) => v));
}
function price(item: unknown, shipping: unknown, source: string, updatedAt?: string, policy?: string, reviewRequired = true): BacklogPrice | undefined {
  const value = num(item); return value !== null && value > 0 ? { item: value, shipping: num(shipping), source, updatedAt, policy, reviewRequired } : undefined;
}
function references(r: Row, source: string, observedAt?: string): BacklogReceipt[] {
  const result: BacklogReceipt[] = [];
  for (const [disposition, values] of [
    ["draft", [r.draftId, r.draft_id, r.recorded_draft_id]],
    ["live", [r.liveItemId, r.live_item_id, r.recorded_live_item_id, r.itemId]],
    ["sold", [r.soldItemId, r.sold_item_id]], ["scheduled", [r.scheduledItemId]],
  ] as const) for (const id of unique(values.map(str).filter(v => /^\d+$/.test(v)))) {
    result.push({ id, disposition, source, observedAt, title: text(r.title) || undefined, quantity: num(r.savedQuantity ?? r.verifiedLiveQuantity ?? r.quantity) ?? undefined,
      item: num(r.savedPrice ?? r.live_item_price_observed ?? r.saved_item_price) ?? undefined, shipping: num(r.savedShipping), groupId: text(r.groupId, r.group_id) || undefined });
  }
  return result;
}
async function scanInbox(directory: string, warnings: string[]): Promise<BacklogScan[]> {
  const filenames: string[] = [];
  async function walk(dir: string) {
    let entries; try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { warnings.push(`Inbox directory unavailable: ${dir}`); return; }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (/\.(jpe?g|png|webp|heic|tiff?|bmp)$/i.test(e.name)) filenames.push(p);
    }
  }
  await walk(directory);
  if (filenames.length > 20000) throw new Error("Card Inbox exceeds the 20,000-image scan limit");
  let index = 0; const results: BacklogScan[] = [];
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (index < filenames.length) {
      const p = filenames[index++];
      try {
        const stat = await fs.stat(p), cached = hashCache.get(p);
        if (stat.size > 100 * 1024 * 1024) { warnings.push(`Image exceeds 100 MB: ${p}`); continue; }
        let digest = cached?.size === stat.size && cached.mtime === stat.mtimeMs ? cached.hash : "";
        if (!digest) {
          const h = createHash("sha256"); for await (const chunk of createReadStream(p)) h.update(chunk);
          const after = await fs.stat(p);
          if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs) { warnings.push(`Image changed while reading: ${p}`); continue; }
          digest = h.digest("hex"); hashCache.set(p, { size: stat.size, mtime: stat.mtimeMs, hash: digest });
        }
        results.push({ path: p, hash: digest });
      } catch { warnings.push(`Original image could not be read: ${p}`); }
    }
  }));
  return results.sort((a, b) => a.path.localeCompare(b.path));
}

/** Only named workflow files are read; no recursive JSON ingestion, environment files or database access. */
export async function loadCardBacklog(options: { root?: string; inbox?: string; now?: string; scans?: BacklogScan[] } = {}): Promise<BacklogSnapshot> {
  const root = options.root || process.cwd(), inbox = options.inbox || defaultCardInbox(), now = options.now || new Date().toISOString();
  const sources: BacklogSource[] = [], warnings: string[] = [], evidence: BacklogEvidence[] = [];
  const versions = new Map<string, { size: number; mtime: number }>();
  async function read(relative: string): Promise<Row | unknown[] | null> {
    try {
      const file = path.join(root, relative), before = await fs.stat(file);
      const data: unknown = JSON.parse((await fs.readFile(file, "utf8")).replace(/^\uFEFF/, ""));
      const after = await fs.stat(file);
      if (before.mtimeMs !== after.mtimeMs || before.size !== after.size) throw new Error("Source changed during read");
      if (!data || typeof data !== "object") throw new Error("Invalid source object");
      const r = row(data), entries = Array.isArray(data) ? data : r.cards ?? r.groups ?? r.approvals ?? [];
      if (/artifacts\/(identity-queue\/cards|pricing-queue\/queue-state)\.json$/.test(relative) && !Array.isArray(r.cards)) throw new Error("Invalid cards schema");
      versions.set(relative, { size: after.size, mtime: after.mtimeMs });
      sources.push({ path: relative, status: "loaded", records: Array.isArray(entries) ? entries.length : Object.keys(row(entries)).length, updatedAt: text(r.updatedAt, r.updated_at, r.asOf, r.verifiedAt) || undefined });
      return data as Row | unknown[];
    } catch (e) {
      sources.push({ path: relative, status: (e as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "invalid", records: 0 });
      return null;
    }
  }
  const identitySource = "artifacts/identity-queue/cards.json", pricingSource = "artifacts/pricing-queue/queue-state.json", queueSource = "artifacts/card-orchestrator/state.json";
  const [identitiesRaw, pricingRaw, queueRaw, approvalRaw, scans] = await Promise.all([
    read(identitySource), read(pricingSource), read(queueSource), read("artifacts/card-orchestrator/asking-price-approvals.json"), options.scans ?? scanInbox(inbox, warnings),
  ]);
  const identities = rows(row(identitiesRaw).cards), pricing = rows(row(pricingRaw).cards), approvals = rows(row(approvalRaw).approvals);
  const identityById = new Map(identities.map(i => [str(i.card_id), i]));
  const hashByPath = new Map<string, Set<string>>();
  const rememberPath = (p: string, h: string) => { if (p && h) hashByPath.set(normPath(p), new Set([...Array.from(hashByPath.get(normPath(p)) ?? []), h])); };
  scans.forEach(f => rememberPath(f.path, f.hash));
  for (const i of identities) {
    for (const side of ["front", "back"]) for (const field of ["original", "current"]) rememberPath(str(i[`${side}_${field}_path`]), sha(i[`${side}_sha256`]));
    let identityKey: string | undefined; try { identityKey = fingerprint(importLegacyCard(i, {}, []).identity); } catch { /* Partial identities remain visible. */ }
    evidence.push({ source: identitySource, kind: "identity", id: str(i.card_id), sku: str(i.source_key), frontHash: sha(i.front_sha256), backHash: sha(i.back_sha256),
      paths: unique([i.front_original_path, i.back_original_path, i.front_current_path, i.back_current_path].map(str).filter(Boolean)),
      identity: identity(i), identityKey, identityStatus: i.status === "identity-ready" ? "identified" : /^held/.test(str(i.status)) ? "needs-review" : undefined,
      title: text(i.proposed_title, i.player), quantity: num(i.quantity) ?? undefined, observedAt: text(i.verified_at),
      holds: [i.hold_reason, i.unresolved_fields].map(str).filter(Boolean), receipts: references(i, identitySource, text(i.verified_at)),
      overrides: { condition: i.condition_plan, conditionEvidence: i.condition_evidence, correction: i.proposed_correction } });
  }
  for (const p of pricing) {
    const source = pricingSource, updatedAt = text(p.updated_at), policy = text(p.pricing_policy_version), proposal = price(p.proposed_item_price, p.buyer_shipping, source, updatedAt, policy);
    const overrideValue = p.user_price_override;
    const override = overrideValue != null ? price(typeof overrideValue === "object" ? row(overrideValue).item : overrideValue, row(overrideValue).shipping ?? p.buyer_shipping, source, updatedAt, policy, false) : undefined;
    const a = approvals.find(a => a.cardId === p.card_id && a.item === proposal?.item && a.shipping === proposal?.shipping && a.sourceUpdatedAt === updatedAt && a.policyVersion === policy);
    if (proposal) proposal.stale = !Number.isFinite(Date.parse(updatedAt)) || Date.parse(updatedAt) > Date.parse(now) || Date.parse(now) - Date.parse(updatedAt) > 90 * 86400000;
    evidence.push({ source, kind: "pricing", id: str(p.card_id), sku: str(p.source_key), frontHash: sha(p.front_sha256), backHash: sha(p.back_sha256), identity: identity(p),
      paths: [p.front_original_path, p.back_original_path, p.front_current_path, p.back_current_path].map(str).filter(Boolean),
      observedAt: updatedAt, proposal, override, receipts: references(p, source, text(p.live_verified_at, p.updated_at)),
      approval: a && proposal && !proposal.stale ? { proposal: { ...proposal, approvedAt: str(a.approvedAt) }, identityKey: str(a.sourceIdentityKey), photoHashes: Array.isArray(a.photoHashes) ? a.photoHashes.map(str) : [] } : undefined,
      holds: /^held/.test(str(p.status)) ? [text(p.no_evidence_reason, p.review_reason, p.status)] : [],
      overrides: overrideValue != null ? { user_price_override: overrideValue, condition: p.condition, minimumOffer: p.minimum_offer, autoAccept: p.auto_accept } : undefined });
  }
  if (queueRaw && row(queueRaw).seller === "imaydit58" && row(queueRaw).schemaVersion === 1) {
    const queue = queueRaw as unknown as QueueState;
    for (const c of Object.values(queue.cards)) {
      const i = c.input, legacy = identityById.get(i.id) ?? {}, reviewed = reviewedIdentity(c);
      // Preserve the saved approval's source fingerprint when review only fills unknown fields.
      // A correction to any already-known identity value invalidates that source binding.
      const changedIdentity = reviewed && Object.entries(i.identity).some(([field, value]) => value !== null && value !== undefined && value !== "" && JSON.stringify(value) !== JSON.stringify((reviewed as unknown as Row)[field]));
      const photos = i.photos, projection = row(c.jobs.pricing.state === "done" ? c.jobs.pricing.result?.projection : null);
      const receipts = references({ draftId: i.knownDraft, liveItemId: i.knownLive?.itemId }, queueSource, i.knownLive?.observedAt);
      for (const r of [...(i.savedReceipts ?? []), ...(c.exclusion ? [c.exclusion] : [])]) if (/^\d+$/.test(r.itemId) && ["draft", "live", "sold", "scheduled"].includes(r.disposition)) receipts.push({ id: r.itemId, disposition: r.disposition as BacklogReceipt["disposition"], source: queueSource });
      evidence.push({ source: queueSource, kind: "orchestrator", id: i.id, sku: i.sku, frontHash: photos.find(p => p.side === "front")?.sha256,
        backHash: photos.find(p => p.side === "back")?.sha256, paths: photos.map(p => p.path), identity: { ...identity(legacy), ...identity((reviewed ?? i.identity) as unknown as Row) }, identityKey: fingerprint(changedIdentity ? reviewed : i.identity), reviewed: !!reviewed,
        identityStatus: reviewed ? "identified" : undefined, title: str(c.jobs.listing.result?.title), observedAt: c.updatedAt,
        proposal: price(projection.item, projection.shipping, queueSource, c.updatedAt, str(projection.policyVersion)),
        override: i.override ? price(i.override.item, i.override.shipping, queueSource, c.updatedAt, str(projection.policyVersion), false) : undefined,
        receipts, holds: Object.values(c.jobs).filter(j => j.state === "held").map(j => `${j.kind}: ${j.reason || "Held"}`), prepared: c.jobs.listing.state === "done" });
    }
    for (const [id, rejected] of Object.entries(queue.rejectedImports ?? {})) {
      const original = evidence.find(e => e.kind === "identity" && e.id === id);
      if (original) original.holds = [...(original.holds ?? []), `Orchestrator import: ${rejected.reason}`];
    }
  } else if (queueRaw) warnings.push("Orchestrator schema or seller mismatch; queue evidence withheld");
  let dirs: string[] = [];
  try { dirs = (await fs.readdir(path.join(root, "artifacts"), { withFileTypes: true })).filter(d => d.isDirectory() && /^(batch-\d+|bulk-draft-pilot|bulk-photo-(pilot|ten)-\d{8})$/.test(d.name)).map(d => d.name).sort(); } catch { /* Reported by required sources. */ }
  const manifests = await Promise.all([...dirs.map(d => `artifacts/${d}/manifest.json`), "artifacts/one-piece-processing.json", "artifacts/goodman-test/ebay-saved-draft.json", "artifacts/batch-test/batch-audit.json"].map(async source => ({ source, data: await read(source) })));
  // Original path/hash mappings from receipts; basename alone is never a scanner identity key.
  for (const { data } of manifests) for (const r of rows(row(data).cards ?? row(data).groups ?? (Array.isArray(data) ? data : [data]))) {
    for (const f of [...rows(r.files), ...rows(row(r.photoArchive).files), ...rows(r.photos)]) {
      for (const p of [f.source, f.destination, f.path]) rememberPath(str(p), sha(f.sha256));
    }
  }
  const pathHash = (p: string): string => {
    if (!p) return "";
    const full = /^[A-Za-z]:[\\/]|^\//.test(p) ? p : path.join(inbox, p);
    const values = hashByPath.get(normPath(full)); return values?.size === 1 ? Array.from(values)[0] : "";
  };
  // Repair missing historical hashes only through a recorded archive path/receipt, never basename alone.
  for (const e of evidence) {
    if (e.kind !== "identity" && e.kind !== "pricing") continue;
    const i = e.kind === "identity" ? identityById.get(e.id || "")! : pricing.find(p => p.card_id === e.id)!;
    for (const side of ["front", "back"] as const) {
      const original = str(i[`${side}_original_path`]), current = str(i[`${side}_current_path`]);
      let digest = pathHash(current) || pathHash(original);
      if (!digest && original) {
        const matches = scans.filter(f => (e.receipts ?? []).some(r => r.disposition === "live" && normPath(f.path) === normPath(path.join(inbox, "Listed", r.id, basename(original)))));
        if (unique(matches.map(f => f.hash)).length === 1) digest = matches[0].hash;
      }
      if (digest) { rememberPath(original, digest); if (!e[`${side}Hash`]) e[`${side}Hash`] = digest; }
    }
  }
  for (const { source, data } of manifests) {
    if (!data) continue;
    const parent = row(data), entries = [...rows(parent.cards ?? parent.groups ?? parent.records ?? (Array.isArray(data) ? data : [data])), ...rows(parent.groupedCaptures)];
    for (const [index, r] of Array.from(entries.entries())) {
      const files = [...rows(r.files), ...rows(row(r.photoArchive).files), ...rows(r.photos)];
      const frontPath = text(r.front_original_path, r.frontPath, r.frontOriginal, r.sourceFront, r.front), backPath = text(r.back_original_path, r.backPath, r.backOriginal, r.sourceBack, r.back);
      const fileHash = (p: string, side: string) => sha(files.find(f => f.side === side || [f.source, f.destination, f.path].some(x => str(x) && normPath(str(x)) === normPath(p)))?.sha256);
      const id = text(r.cardId, r.card_id, /^LOS-/.test(str(r.id)) ? r.id : "");
      const sku = text(r.key, r.sku, r.source_key, r.id && !id ? `${path.basename(path.dirname(source))}:${r.id}` : "");
      const anchors = evidence.filter(e => e.kind === "identity" && ((id && e.id === id) || (sku && e.sku === sku)));
      const anchor = anchors.length === 1 ? anchors[0] : undefined;
      const fileHashes = files.map(f => sha(f.sha256)).filter(Boolean);
      const frontHash = sha(r.frontHash || r.frontSha256) || fileHash(frontPath, "front") || pathHash(frontPath) || (anchor?.frontHash && fileHashes.includes(anchor.frontHash) ? anchor.frontHash : "");
      const backHash = sha(r.backHash || r.backSha256) || fileHash(backPath, "back") || pathHash(backPath) || (anchor?.backHash && fileHashes.includes(anchor.backHash) ? anchor.backHash : "");
      const observedAt = text(r.liveVerifiedAt, r.verifiedAt, r.reviewedAt, parent.verifiedAt, parent.savedAt, parent.updatedAt, parent.createdAt, parent.preparedAt);
      const receiptList = references(r, source, observedAt);
      const group = source.endsWith("one-piece-processing.json") ? `one-piece:${r.cardNumber}:${r.variant}:${r.language}:${r.condition}`
        : rows(parent.groupedCaptures).some(g => g.draftId === r.draftId) ? `saved-group:${str(r.draftId)}` : undefined;
      // Explicit group front sources bind each physical capture without multiplying the listing quantity.
      const groupFronts = rows(r.frontSources).map(f => pathHash(str(f.file))).filter(Boolean);
      const identityRaw = row(r.identity);
      const make = (front: string, back: string, groupId?: string): BacklogEvidence => ({ source, kind: "manifest", id: id || (!front ? `${source}#${sku || index}` : undefined), sku, frontHash: front, backHash: back, hashes: fileHashes,
        paths: unique([frontPath, backPath, ...files.flatMap(f => [f.source, f.destination, f.path].map(str))].filter(Boolean)),
        title: text(r.title, r.proposedTitle), identity: Object.keys(identityRaw).length ? identity(identityRaw) : undefined,
        quantity: num(r.quantity ?? r.physicalCardCount) ?? undefined, observedAt,
        receipts: receiptList.map(x => ({ ...x, groupId })),
        proposal: price(r.proposedPrice ?? row(r.priceProposal).item ?? r.price, r.shipping ?? row(r.priceProposal).shipping, source, observedAt),
        holds: [...(Array.isArray(r.remainingReview) ? r.remainingReview.map(str) : []), ...(/held/.test(str(r.status)) ? [text(r.reviewReason, r.notes, r.status)] : [])],
        overrides: { title: r.title, condition: r.condition, priceApproval: r.priceApproval ?? r.priceApproved, price: r.price, shipping: r.shipping, quantity: r.quantity, notes: r.notes } });
      if (groupFronts.length) {
        for (const front of unique(groupFronts)) {
          const anchor = evidence.find(e => e.kind === "identity" && e.frontHash === front);
          evidence.push(make(front, anchor?.backHash || backHash, group));
        }
      } else evidence.push(make(frontHash, backHash, group));
    }
  }
  // Saved exact matches have explicit keys. Active table rows join only by receipt ID or exact SKU.
  for (const source of ["artifacts/live-exact-title-matches.json", "artifacts/verified-live-backlog.json", "artifacts/additional-live-matches.json", "artifacts/pricing-queue/live-prizm-reconciliation.json", "artifacts/live-listing-cells.json", "artifacts/live-listings-current-ui.json"]) {
    const data = await read(source); if (!data) continue;
    for (const r of rows(Array.isArray(data) ? data : row(data).matches)) {
      const link = rows(r.links).find(l => /\/itm\/\d+/.test(str(l.href)));
      const itemId = text(r.liveItemId, r.itemId, r.id, str(link?.href).match(/\/itm\/(\d+)/)?.[1]);
      if (!/^\d+$/.test(itemId)) continue;
      const cells = Array.isArray(r.cells) ? r.cells.map(str) : [];
      const observedAt = text(row(data).observed_at, r.verifiedAt);
      evidence.push({ source, kind: "marketplace", sku: text(r.source_key, r.key, cells[3]), title: text(link?.title, r.title), observedAt,
        receipts: [{ id: itemId, disposition: "live", source, observedAt, title: text(link?.title, r.title) || undefined,
          item: num(r.item_price ?? cells[4]?.match(/^\$([\d,.]+)/)?.[1]?.replace(/,/g, "")) ?? undefined,
          quantity: num(r.available ?? cells[6]) ?? undefined }] });
    }
  }
  // Raw named pairs become candidates only after all saved hash identities are known. B/F scanner
  // orientation is not guessed: two unnamed sides stay in the unmatched-photo review list.
  const covered = new Set(evidence.flatMap(e => [e.frontHash, e.backHash, ...(e.hashes ?? [])].filter(Boolean)));
  const named = new Map<string, { front?: BacklogScan; back?: BacklogScan }>();
  for (const f of scans.filter(f => !covered.has(f.hash))) {
    const m = f.path.match(/^(.*?)[ _.-](front|back)\.[^.]+$/i); if (!m) continue;
    const pair = named.get(normPath(m[1])) ?? {}; pair[m[2].toLowerCase() as "front" | "back"] = f; named.set(normPath(m[1]), pair);
  }
  named.forEach(pair => { if (pair.front && pair.back) evidence.push({ source: "Card Inbox (explicit front/back names; pairing not reviewed)", kind: "scan", frontHash: pair.front.hash, backHash: pair.back.hash, paths: [pair.front.path, pair.back.path], title: basename(pair.front.path), identityStatus: "not-identified" }); });
  const cards = reconcileBacklog(evidence, now), scan = reconcileScans(cards, scans), retained = new Set(scans.map(f => f.hash));
  for (const c of cards) {
    const actual = c.originalPaths.filter(p => hashByPath.has(normPath(p)));
    if ([c.frontHash, ...c.backHashes].some(h => h && !retained.has(h)) && actual.some(p => hashByPath.get(normPath(p))!.size > 1)) {
      c.issues.push("Original path now has different bytes from saved evidence; inspect hash provenance"); c.state = "unresolved";
      c.nextOwner = "reconciliation"; c.nextAction = "Resolve original byte mismatch";
    }
  }
  if (scan.unmatched.length) warnings.push(`${scan.unmatched.length} distinct images have no verified card-side mapping; they are not divided by two or counted as physical cards.`);
  sources.filter(s => s.status === "invalid").forEach(s => warnings.push(`Invalid or changing source: ${s.path}; retained receipts in other sources still apply`));
  // Never return a mixed generation if an independent writer changed a source during reconciliation.
  await Promise.all(Array.from(versions, async ([relative, version]) => {
    const after = await fs.stat(path.join(root, relative));
    if (after.size !== version.size || after.mtimeMs !== version.mtime) throw new Error("Source generation changed; refresh the backlog");
  }));
  return { version: 2, asOf: now, mode: "read-only-local", cards, counts: backlogCounts(cards), scan, sources: sources.sort((a, b) => a.path.localeCompare(b.path)), warnings,
    marketplace: { complete: false, absenceMeansUnlisted: false, note: "Saved positive eBay receipts and partial active snapshots only. No fresh four-scope inventory clearance; missing rows never authorize a new listing or stock increment." } };
}
