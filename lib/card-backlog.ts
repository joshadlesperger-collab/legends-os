/** Read-only reconciliation. Positive receipts survive partial or missing marketplace snapshots. */
export type BacklogState = "unprocessed" | "identified" | "priced" | "locally-approved" | "draft" | "live" | "sold" | "held" | "unresolved";
export const BACKLOG_STATES: BacklogState[] = ["unprocessed", "identified", "priced", "locally-approved", "draft", "live", "sold", "held", "unresolved"];
export type CardIdentity = Record<string, string>;
export type BacklogPrice = { item: number; shipping: number | null; source: string; updatedAt?: string; policy?: string; reviewRequired: boolean; approvedAt?: string; stale?: boolean };
export type BacklogReceipt = { id: string; disposition: "draft" | "live" | "sold" | "scheduled"; source: string; observedAt?: string; title?: string; quantity?: number; item?: number; shipping?: number | null; groupId?: string };
export type BacklogEvidence = {
  source: string; kind: "identity" | "pricing" | "orchestrator" | "manifest" | "marketplace" | "scan";
  id?: string; sku?: string; frontHash?: string; backHash?: string; hashes?: string[]; paths?: string[];
  title?: string; identity?: CardIdentity; identityStatus?: "identified" | "not-identified" | "needs-review";
  observedAt?: string; quantity?: number; proposal?: BacklogPrice; override?: BacklogPrice;
  receipts?: BacklogReceipt[]; issues?: string[]; holds?: string[]; reviewed?: boolean;
  approval?: { proposal: BacklogPrice; identityKey: string; photoHashes: string[] };
  identityKey?: string; prepared?: boolean; groupId?: string; overrides?: Record<string, unknown>;
};
export type BacklogScan = { path: string; hash: string };
export type BacklogCard = {
  id: string; aliases: string[]; skus: string[]; title: string; state: BacklogState;
  captureId: string | null; frontHash: string | null; backHashes: string[]; photoHashes: string[]; originalPaths: string[];
  physicalUnits: number; recordedQuantity: number | null; identity: CardIdentity;
  identityStatus: "identified" | "not-identified" | "needs-review" | "unknown";
  proposal: BacklogPrice | null; override: BacklogPrice | null; approvedPrice: BacklogPrice | null;
  prices: BacklogPrice[]; receipts: BacklogReceipt[]; issues: string[]; holds: string[];
  sources: string[]; overrides: { source: string; values: Record<string, unknown> }[];
  textPrepared: boolean; excludedFromNewListing: boolean; nextOwner: string; nextAction: string;
  groupKey: string | null; inboxPaths: string[];
};
export type BacklogSource = { path: string; status: "loaded" | "missing" | "invalid"; records: number; updatedAt?: string };
export type BacklogSnapshot = {
  version: 2; asOf: string; mode: "read-only-local"; cards: BacklogCard[]; sources: BacklogSource[];
  counts: ReturnType<typeof backlogCounts>; scan: ReturnType<typeof reconcileScans>;
  warnings: string[]; marketplace: { complete: false; absenceMeansUnlisted: false; note: string };
};
export const unique = <T>(values: T[]) => Array.from(new Set(values));
const hash = (v?: string) => v && /^[a-f0-9]{64}$/i.test(v) ? v.toLowerCase() : undefined;
const key = (v: string) => v.trim().toLowerCase().replace(/\s+/g, " ");
const serial = (v: string) => v.split("/").map(x => x.replace(/^0+(?=\d)/, "")).join("/");
const rank = (e: BacklogEvidence) => e.kind === "orchestrator" && e.reviewed ? 5 : e.kind === "identity" ? 4 : e.kind === "manifest" ? 3 : e.kind === "pricing" ? 2 : 1;
const time = (v?: string) => v && Number.isFinite(Date.parse(v)) ? Date.parse(v) : 0;
const priceKey = (p: BacklogPrice) => JSON.stringify([p.item, p.shipping, p.updatedAt, p.policy]);
const identityFields = ["player", "season", "set", "manufacturer", "cardNumber", "parallel", "serial", "printRun", "language", "condition", "conditionType"];
function contradicts(a: CardIdentity, b: CardIdentity) {
  return identityFields.filter(f => a[f] && b[f] && (f === "serial" ? serial(key(a[f])) !== serial(key(b[f])) : key(a[f]) !== key(b[f])));
}
function groupKey(identity: CardIdentity, reviewed: boolean) {
  const fields = ["player", "season", "set", "manufacturer", "cardNumber", "parallel", "language", "condition", "conditionType"];
  return reviewed && !identity.serial && !Number(identity.printRun) && fields.every(f => identity[f]) ? fields.map(f => key(identity[f])).join("|") : null;
}
export function reconcileBacklog(evidence: BacklogEvidence[], now: string): BacklogCard[] {
  const groups = new Map<string, BacklogEvidence[]>();
  const ids = new Map<string, Set<string>>(), skus = new Map<string, Set<string>>();
  const addIndex = (map: Map<string, Set<string>>, id: string | undefined, capture: string) => { if (id) map.set(id, new Set([...Array.from(map.get(id) ?? []), capture])); };
  for (const e of evidence) {
    const front = hash(e.frontHash); if (!front) continue;
    const capture = `capture:${front}`;
    groups.set(capture, [...(groups.get(capture) ?? []), { ...e, frontHash: front, backHash: hash(e.backHash) }]);
    addIndex(ids, e.id, capture); addIndex(skus, e.sku, capture);
  }
  // Hash-less receipts may exclude an existing ID/SKU, but cannot confer identity/price approval.
  const loose = evidence.filter(e => !hash(e.frontHash));
  for (const e of loose.filter(e => e.kind !== "marketplace")) {
    const targets = unique([...Array.from(ids.get(e.id ?? "") ?? []), ...Array.from(skus.get(e.sku ?? "") ?? [])]);
    if (targets.length === 1) {
      groups.get(targets[0])!.push({ ...e, identity: undefined, proposal: undefined, override: undefined, approval: undefined,
        identityStatus: undefined, issues: [...(e.issues ?? []), "Record matched by ID/SKU without original front hash; evidence binding needs review"] });
    } else {
      const orphan = `unresolved:${e.id || e.sku || e.source}`;
      groups.set(orphan, [...(groups.get(orphan) ?? []), { ...e, issues: [...(e.issues ?? []), targets.length ? "Ambiguous ID/SKU mapping" : "No original capture mapping"] }]);
      addIndex(ids, e.id, orphan); addIndex(skus, e.sku, orphan);
    }
  }
  const receiptTargets = new Map<string, Set<string>>();
  groups.forEach((rows, g) => rows.forEach(e => e.receipts?.forEach(r => addIndex(receiptTargets, r.id, g))));
  for (const e of loose.filter(e => e.kind === "marketplace")) {
    const byReceipt = unique((e.receipts ?? []).flatMap(r => Array.from(receiptTargets.get(r.id) ?? [])));
    const bySku = Array.from(skus.get(e.sku ?? "") ?? []);
    const targets = byReceipt.length ? byReceipt : bySku.length === 1 ? bySku : [];
    if (targets.length) targets.forEach(g => groups.get(g)!.push({ ...e, issues: [...(e.issues ?? []), ...(!byReceipt.length ? ["Marketplace SKU match needs original-photo verification"] : [])] }));
    else {
      const id = `marketplace:${e.receipts?.[0]?.id || e.id || e.source}`;
      groups.set(id, [...(groups.get(id) ?? []), { ...e, issues: [...(e.issues ?? []), "Marketplace receipt has no mapped local capture"] }]);
    }
  }
  const cards = Array.from(groups, ([capture, rows]): BacklogCard => {
    rows.sort((a, b) => rank(b) - rank(a) || time(b.observedAt) - time(a.observedAt) || a.source.localeCompare(b.source));
    const canonical = rows.find(e => e.identity && Object.keys(e.identity).length) ?? rows[0];
    const identity = canonical.identity ?? {}, frontHash = hash(canonical.frontHash) ?? rows.find(e => e.frontHash)?.frontHash ?? null;
    const backs = unique(rows.map(e => hash(e.backHash)).filter((v): v is string => !!v));
    const issues = rows.flatMap(e => e.issues ?? []);
    if (backs.length > 1) issues.push("One original front has conflicting back hashes; resolve pairing without adding inventory");
    const aliases = unique(rows.flatMap(e => e.id ? [e.id] : []));
    const skuList = unique(rows.flatMap(e => e.sku ? [e.sku] : []));
    if (aliases.some(id => (ids.get(id)?.size ?? 0) > 1)) issues.push("Stable ID belongs to distinct original captures; both copies retained");
    const bound = rows.filter(e => !!frontHash && hash(e.frontHash) === frontHash && (!backs.length || (hash(e.backHash) && backs.includes(hash(e.backHash)!))));
    for (const e of bound.filter(e => e.kind === "pricing" || e.kind === "identity")) {
      const differences = contradicts(identity, e.identity ?? {});
      if (differences.length) issues.push(`Conflicting ${differences.join(", ")} in ${e.source}; saved evidence retained`);
    }
    const compatible = bound.filter(e => !contradicts(identity, e.identity ?? {}).length && backs.length <= 1);
    const prices = rows.flatMap(e => [e.proposal, e.override].filter((p): p is BacklogPrice => !!p));
    const proposals = compatible.filter(e => e.proposal).sort((a, b) => time(b.proposal!.updatedAt) - time(a.proposal!.updatedAt) || rank(b) - rank(a));
    const proposal = proposals[0]?.proposal ?? null;
    const overrides = compatible.filter(e => e.override).map(e => e.override!);
    const override = overrides[0] ?? null;
    if (unique(overrides.map(p => `${p.item}|${p.shipping}`)).length > 1) issues.push("Conflicting explicit price overrides; no formula may replace them");
    const approved = compatible.flatMap(e => e.approval && e.proposal && priceKey(e.approval.proposal) === priceKey(e.proposal) ? [e.approval] : []).find(a => !a.proposal.stale
      && time(a.proposal.updatedAt) > 0 && time(now) >= time(a.proposal.updatedAt) && time(now) - time(a.proposal.updatedAt) <= 90 * 86400000
      && a.identityKey === canonical.identityKey && unique(a.photoHashes.map(h => h.toLowerCase())).sort().join() === [frontHash, ...backs].sort().join()
      && time(a.proposal.approvedAt) >= time(a.proposal.updatedAt) && time(a.proposal.approvedAt) <= time(now));
    const approvedPrice = override || approved?.proposal || null;
    const identityStatus = canonical.identityStatus ?? "unknown";
    const receipts = unique(rows.flatMap(e => e.receipts ?? []).map(r => JSON.stringify(r))).map(r => JSON.parse(r) as BacklogReceipt);
    const holds = unique(rows.flatMap(e => e.holds ?? []));
    const c: BacklogCard = { id: frontHash ? `capture:${frontHash}` : capture, aliases, skus: skuList,
      title: rows.find(e => e.kind === "marketplace" && e.title)?.title || rows.find(e => e.kind === "manifest" && e.title)?.title || canonical.title || identity.player || aliases[0] || "Unmapped card record",
      state: "unresolved", captureId: frontHash ? `sha256:${frontHash}` : null, frontHash, backHashes: backs, photoHashes: unique(rows.flatMap(e => e.hashes ?? []).map(h => hash(h)).filter((h): h is string => !!h)),
      originalPaths: unique(rows.flatMap(e => e.paths ?? [])), physicalUnits: frontHash ? 1 : 0,
      recordedQuantity: Math.max(0, ...rows.map(e => e.quantity ?? 0)) || null, identity, identityStatus,
      proposal, override, approvedPrice, prices, receipts, issues: unique(issues), holds,
      sources: unique(rows.map(e => e.source)), overrides: rows.filter(e => e.overrides).map(e => ({ source: e.source, values: e.overrides! })),
      textPrepared: rows.some(e => e.prepared), excludedFromNewListing: receipts.length > 0,
      nextOwner: "reconciliation", nextAction: "Resolve saved evidence conflicts", groupKey: groupKey(identity, identityStatus === "identified"), inboxPaths: [] };
    assignState(c);
    return c;
  });
  // Sharing a receipt is valid only for an explicitly recorded, compatible unnumbered quantity group.
  const owners = new Map<string, BacklogCard[]>();
  for (const c of cards) for (const id of unique(c.receipts.map(r => r.id))) owners.set(id, [...(owners.get(id) ?? []), c]);
  owners.forEach((members, id) => {
    if (members.length < 2) return;
    const explicitGroups = members.map(c => c.receipts.find(r => r.id === id && r.groupId)?.groupId);
    const groupFields = ["player", "set", "manufacturer", "cardNumber", "parallel", "language", "condition", "conditionType"];
    // Non-seasonal TCG releases can legitimately have no season on every member.
    const sameExplicitIdentity = groupFields.every(f => members.every(c => c.identity[f] && key(c.identity[f]) === key(members[0].identity[f] || "")))
      && members.every(c => key(c.identity.season || "") === key(members[0].identity.season || ""));
    if (explicitGroups.every(Boolean) && new Set(explicitGroups).size === 1 && members.every(c => !c.identity.serial && !Number(c.identity.printRun)) && sameExplicitIdentity) return;
    members.forEach(c => { c.issues.push(`Receipt ${id} maps to multiple captures without a validated quantity group`); assignState(c); });
  });
  skus.forEach((captures, sku) => {
    if (captures.size < 2) return;
    const members = cards.filter(c => c.frontHash && captures.has(c.id));
    const grouped = members.length > 1 && members[0].receipts.some(r => r.groupId && members.every(c => c.receipts.some(x => x.groupId === r.groupId)));
    if (!grouped) members.forEach(c => { c.issues.push(`SKU ${sku} maps to distinct captures without a saved quantity group`); assignState(c); });
  });
  // The same serialized identity across different originals is a reading conflict, never a rescan deduction.
  const serials = new Map<string, BacklogCard[]>();
  cards.filter(c => c.frontHash && c.identity.serial).forEach(c => {
    const k = ["player", "season", "set", "cardNumber", "parallel", "serial"].map(f => f === "serial" ? serial(key(c.identity[f] || "")) : key(c.identity[f] || "")).join("|");
    serials.set(k, [...(serials.get(k) ?? []), c]);
  });
  serials.forEach(members => { if (members.length > 1) members.forEach(c => { c.issues.push("Same full serial on distinct originals; verify serial reading, retain both captures"); assignState(c); }); });
  return cards.sort((a, b) => a.id.localeCompare(b.id));
}
function assignState(c: BacklogCard) {
  const dispositions = new Set(c.receipts.map(r => r.disposition));
  c.state = c.issues.length ? "unresolved" : dispositions.has("sold") ? "sold" : dispositions.has("live") ? "live" : dispositions.has("draft") ? "draft" : dispositions.has("scheduled") ? "held" : c.holds.length ? "held" : c.approvedPrice ? "locally-approved" : c.proposal ? "priced" : c.identityStatus === "identified" ? "identified" : "unprocessed";
  c.nextOwner = c.issues.length || c.excludedFromNewListing ? "reconciliation" : c.identityStatus !== "identified" ? "identity" : !c.proposal && !c.override ? "pricing" : !c.approvedPrice ? "seller-review" : "listing-review";
  c.nextAction = c.issues[0] || (dispositions.has("sold") ? "Retain sold exclusion; reconcile remaining available stock" : dispositions.has("live") ? "Retain live receipt; verify current stock before proposing quantity/price changes" : dispositions.has("draft") ? "Resume recorded draft; finish saved-field review" : c.holds[0] || (c.nextOwner === "identity" ? "Review retained originals and saved identity gaps" : c.nextOwner === "pricing" ? "Read saved pricing context; research only documented gaps" : c.nextOwner === "seller-review" ? "Review saved asking-price proposal" : "Refresh preflight and inventory reconciliation before any external action"));
}
export function reconcileScans(cards: BacklogCard[], files: BacklogScan[]) {
  const byHash = new Map<string, string[]>();
  files.forEach(f => { const h = hash(f.hash); if (h) byHash.set(h, [...(byHash.get(h) ?? []), f.path]); });
  const known = new Set(cards.flatMap(c => [c.frontHash, ...c.backHashes, ...c.photoHashes].filter((h): h is string => !!h)));
  for (const c of cards) c.inboxPaths = unique([c.frontHash, ...c.backHashes].flatMap(h => h ? byHash.get(h) ?? [] : []));
  return { imageFiles: files.length, uniqueImages: byHash.size, duplicateFiles: files.length - byHash.size,
    mappedImages: Array.from(byHash.keys()).filter(h => known.has(h)).length,
    capturedCardsPresent: cards.filter(c => c.frontHash && byHash.has(c.frontHash)).length,
    unmatched: Array.from(byHash, ([h, paths]) => ({ hash: h, paths })).filter(f => !known.has(f.hash)) };
}
export function backlogCounts(cards: BacklogCard[]) {
  const states = Object.fromEntries(BACKLOG_STATES.map(s => [s, cards.filter(c => c.state === s).length])) as Record<BacklogState, number>;
  return { records: cards.length, physicalCaptures: cards.reduce((n, c) => n + c.physicalUnits, 0), states,
    identified: cards.filter(c => c.identityStatus === "identified").length,
    needsIdentityReview: cards.filter(c => c.identityStatus === "needs-review").length,
    notIdentified: cards.filter(c => c.identityStatus === "not-identified").length,
    unknownIdentity: cards.filter(c => c.identityStatus === "unknown").length,
    withProposal: cards.filter(c => c.proposal).length, withApprovedPrice: cards.filter(c => c.approvedPrice).length,
    withReceipts: cards.filter(c => c.receipts.length).length,
    distinctDraftReceipts: unique(cards.flatMap(c => c.receipts.filter(r => r.disposition === "draft").map(r => r.id))).length,
    distinctLiveReceipts: unique(cards.flatMap(c => c.receipts.filter(r => r.disposition === "live").map(r => r.id))).length,
    distinctSoldReceipts: unique(cards.flatMap(c => c.receipts.filter(r => r.disposition === "sold").map(r => r.id))).length,
    withoutReceipt: cards.filter(c => c.physicalUnits && !c.receipts.length).length,
    held: cards.filter(c => c.holds.length).length, conflicting: cards.filter(c => c.issues.length).length };
}
