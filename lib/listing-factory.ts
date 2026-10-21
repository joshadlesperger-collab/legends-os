export const FACTORY_STAGES = ["scanned", "identified", "priced", "bulk-upload", "verified-drafts"] as const;
export type FactoryStage = typeof FACTORY_STAGES[number];
export const STAGE_LABELS: Record<FactoryStage, string> = { scanned: "Scanned", identified: "Identified", priced: "Priced", "bulk-upload": "Bulk upload", "verified-drafts": "Verified drafts" };
export type FactoryCard = {
  id: string; definitionId: string; title: string; quantity: number;
  stage: FactoryStage; status: "queued" | "processing" | "held" | "complete";
  enteredAt: string; nextAction: string; holdReason?: string;
  photos?: string[]; confidence?: "low" | "medium" | "high";
  evidenceBasis?: "exact-sold" | "serial-math" | "active-only" | "saved-estimate";
  compCount?: number; evidenceAt?: string; evidenceNotes?: string; evidenceUrls?: string[];
  targetTotal?: number; rangeLow?: number; rangeHigh?: number;
  itemPrice?: number; shipping?: number; policyVersion?: string;
  apiCostUsd?: number; draftUrl?: string; verifiedAt?: string;
  history?: { stage: FactoryStage; completedAt: string }[];
};
export type FactoryManifest = { version: 1; cards: FactoryCard[] };
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export function safeWebUrl(v: unknown): v is string {
  if (typeof v !== "string") return false;
  try { const url = new URL(v); return url.protocol === "https:" && !url.username && !url.password; } catch { return false; }
}
const validDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d\d-\d\dT/.test(v) && Number.isFinite(Date.parse(v));
export function parseFactoryManifest(input: unknown): FactoryManifest {
  if (!record(input) || input.version !== 1 || !Array.isArray(input.cards) || input.cards.length > 10000) throw new Error("Expected version 1 with a cards array (maximum 10,000 records).");
  const ids = new Set<string>();
  for (const raw of input.cards) {
    if (!record(raw)) throw new Error("Every card must be an object.");
    for (const key of ["id", "definitionId", "title", "nextAction"]) if (typeof raw[key] !== "string" || !(raw[key] as string).trim() || (raw[key] as string).length > 2000) throw new Error(`Missing or invalid ${key}.`);
    if (ids.has(raw.id as string)) throw new Error(`Duplicate physical-card ID: ${raw.id}`);
    ids.add(raw.id as string);
    if (!Number.isInteger(raw.quantity) || Number(raw.quantity) < 1) throw new Error(`Invalid quantity: ${raw.id}`);
    if (!FACTORY_STAGES.includes(raw.stage as FactoryStage) || !["queued", "processing", "held", "complete"].includes(String(raw.status))) throw new Error(`Invalid stage/status: ${raw.id}`);
    if (!validDate(raw.enteredAt)) throw new Error(`Invalid enteredAt: ${raw.id}`);
    if (raw.status === "held" && (typeof raw.holdReason !== "string" || !raw.holdReason.trim())) throw new Error(`Held card needs a reason: ${raw.id}`);
    for (const key of ["holdReason", "evidenceNotes", "policyVersion"]) if (raw[key] !== undefined && typeof raw[key] !== "string") throw new Error(`Invalid ${key}: ${raw.id}`);
    for (const key of ["targetTotal", "rangeLow", "rangeHigh", "itemPrice", "shipping", "apiCostUsd", "compCount"]) if (raw[key] !== undefined && (typeof raw[key] !== "number" || !Number.isFinite(raw[key]) || Number(raw[key]) < 0)) throw new Error(`Invalid ${key}: ${raw.id}`);
    if (raw.compCount !== undefined && !Number.isInteger(raw.compCount)) throw new Error(`Invalid comp count: ${raw.id}`);
    if (typeof raw.itemPrice === "number" && raw.itemPrice < 1.49) throw new Error(`Item price below $1.49 floor: ${raw.id}`);
    if (typeof raw.rangeLow === "number" && typeof raw.rangeHigh === "number" && raw.rangeLow > raw.rangeHigh) throw new Error(`Invalid estimate range: ${raw.id}`);
    if (raw.confidence !== undefined && !["low", "medium", "high"].includes(String(raw.confidence))) throw new Error(`Invalid confidence: ${raw.id}`);
    if (raw.evidenceBasis !== undefined && !["exact-sold", "serial-math", "active-only", "saved-estimate"].includes(String(raw.evidenceBasis))) throw new Error(`Invalid evidence basis: ${raw.id}`);
    for (const key of ["evidenceAt", "verifiedAt"]) if (raw[key] !== undefined && !validDate(raw[key])) throw new Error(`Invalid ${key}: ${raw.id}`);
    for (const key of ["photos", "evidenceUrls"]) if (raw[key] !== undefined && (!Array.isArray(raw[key]) || raw[key].length > 30 || !raw[key].every(safeWebUrl))) throw new Error(`${key} must contain HTTPS URLs: ${raw.id}`);
    if (raw.draftUrl !== undefined && !safeWebUrl(raw.draftUrl)) throw new Error(`Invalid draft URL: ${raw.id}`);
    if (raw.stage === "verified-drafts" && (!raw.draftUrl || !raw.verifiedAt)) throw new Error(`Verified drafts require a reference and verification time: ${raw.id}`);
    if (raw.history !== undefined && (!Array.isArray(raw.history) || raw.history.length > 100 || !raw.history.every(e => record(e) && FACTORY_STAGES.includes(e.stage as FactoryStage) && validDate(e.completedAt)))) throw new Error(`Invalid history: ${raw.id}`);
  }
  return { version: 1, cards: input.cards as FactoryCard[] };
}
export function factoryMetrics(cards: FactoryCard[], stage: FactoryStage, now: number) {
  const current = cards.filter(c => c.stage === stage);
  const ages = current.map(c => Math.max(0, now - Date.parse(c.enteredAt))).sort((a,b) => a-b);
  const middle = Math.floor(ages.length / 2);
  const medianWaitMs = ages.length ? (ages.length % 2 ? ages[middle] : (ages[middle-1]+ages[middle])/2) : null;
  // One physical-card record per stage/day, even if an imported history repeats an event.
  const completed = cards.filter(c => c.history?.some(e => e.stage === stage && Date.parse(e.completedAt) <= now && Date.parse(e.completedAt) > now - 86400000)).length;
  return { records: current.length, queued: current.filter(c=>c.status === "queued").length, processing: current.filter(c=>c.status === "processing").length, held: current.filter(c=>c.status === "held").length, completed, medianWaitMs, hasHistory: cards.some(c=>c.history !== undefined) };
}
