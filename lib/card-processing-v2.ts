import {v2FactualYear} from "./card-processing-v2-year.ts";
import {v2StableCatalogIdentityKey} from './card-processing-v2-stable-identity.ts';
import {v2ArchivePresentation} from "./card-processing-v2-archive-status.ts";
import { createHash } from "node:crypto";
import { z } from "zod";
import { assessV2Description, factualV2Description } from "./card-processing-v2-description.ts";
import { classifyV2IdentificationWarnings } from "./card-processing-v2-identification-warnings.ts";

export const V2_STAGES = ["waiting", "identified", "consolidated", "prepared", "verified", "exception"] as const;
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  return value;
}
export const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const nonempty = z.string().trim().min(1).max(300);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const photoSchema = z.object({ path: nonempty, hash, side: z.enum(["front", "back"]) }).strict();
export const identitySchema = z.object({
  name: nonempty, year: nonempty, manufacturer: nonempty, product: nonempty, number: nonempty,
  categoryId: z.enum(["183454", "261328", "183050"]), language: nonempty, variant: nonempty,
  artwork: nonempty, sportOrGame: nonempty, team: z.string().max(200),
  serial: z.string().max(100), graded: z.boolean(), damage: z.boolean(),
  specifics: z.record(nonempty, z.array(nonempty).min(1).max(20)),
}).strict();
export type V2Identity = z.infer<typeof identitySchema>;
export const identificationSchema = z.object({
  pairMatches: z.boolean(), frontImageIndex: z.enum(["0", "1", "unknown"]), upright: z.boolean(),
  identity: identitySchema.nullable(), warnings: z.array(nonempty).max(30),
}).strict();
export type V2Identification = z.infer<typeof identificationSchema>;
export const categorySchema = z.object({
  categoryId: identitySchema.shape.categoryId, source: nonempty, observedAt: z.string().datetime(),
  requiredAspects: z.array(nonempty).min(1), allowedValues: z.record(z.string(), z.array(nonempty)).default({}),
  conditionId: nonempty, conditionDescriptorName: nonempty, conditionDescriptorValue: nonempty,
  conditionLabel: z.literal("Near mint or better"),
}).strict();
export type V2Category = z.infer<typeof categorySchema>;
const issueSchema = z.object({ code: nonempty, detail: nonempty, owner: nonempty });
export const recordSchema = z.object({
  id: nonempty, sku: nonempty, captureId: hash, photos: z.array(photoSchema).length(2),
  stage: z.enum(V2_STAGES), identity: identitySchema.optional(), identification: identificationSchema.optional(),
  condition: z.literal("Near mint or better"), groupId: z.string().optional(), consolidationVersion:z.literal(2).optional(), title: z.string().default(""),
  description: z.string().max(20000).default(""), descriptionSource: z.enum(["factual", "ebay-ai-reviewed"]).default("factual"),
  issues: z.array(issueSchema), nextAction: nonempty, createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  identificationKey: hash.optional(), draftId: z.string().regex(/^\d+$/).optional(),
  providerOrientation:z.object({kind:z.literal('provider-derived'),callId:z.string().uuid(),original:z.object({path:nonempty,sha256:hash}).strict(),registry:z.object({path:nonempty,sha256:hash}).strict()}).strict().optional(),
  completenessInputKey: hash.optional(),
  draftMergeOwner:z.object({operationId:hash,survivorDraftId:z.string().regex(/^\d+$/),evidence:z.object({path:z.string(),sha256:hash}).strict()}).strict().optional(),
  draftMergeReceipt:z.object({operationId:hash,survivorDraftId:z.string().regex(/^\d+$/),captureId:hash,observedAt:z.string().datetime(),evidence:z.object({path:z.string(),sha256:hash}).strict(),files:z.array(z.object({source:z.string(),destination:z.string(),hash,side:z.enum(['front','back'])}).strict()).length(2)}).strict().optional(),
  readyBatch: z.object({id:z.string().uuid(),manifest:z.object({path:z.string().min(1),sha256:hash}).strict()}).strict().optional(),
  activeQuantityOperationId: hash.optional(),
  activeQuantityReceipt: z.object({status:z.literal("saved-verified"),operationId:hash,batchId:z.string().uuid(),seller:z.literal("imaydit58"),itemId:z.string().regex(/^\d+$/),captureId:hash,captureIds:z.array(hash).min(1).max(20),photoHashes:z.array(hash).length(2),identity:identitySchema,beforeQuantity:z.number().int().nonnegative(),targetQuantity:z.number().int().positive(),observedAt:z.string().datetime(),evidence:z.object({path:z.string(),sha256:hash}).strict()}).strict().optional(),
  resetTransfer: z.object({ resetId: nonempty, legacyCardId: nonempty, receipt: z.string().min(1).max(500), instructionId: nonempty }).strict().optional(),
  identityReview: z.object({ path: nonempty, sha256: hash, reviewer: nonempty, observedAt: z.string().datetime() }).strict().optional(),
  knowledgeReuse: z.object({ enrichedFields: z.array(nonempty), definitions: z.array(z.object({ key: nonempty, evidence: nonempty, verifiedAt: z.string().datetime(), photoHashes: z.array(hash).length(2) }).strict()) }).strict().optional(),
  verification: z.object({ observedAt: z.string().datetime(), evidence: nonempty, payloadHash: hash }).optional(),
  bulkResultVerification:z.object({mode:z.enum(['official-results-and-saved-bulk-grid','official-results-and-native-save-list-row']),batchId:z.string().uuid(),jobId:hash,draftId:z.string().regex(/^\d+$/),captureId:hash,photoHashes:z.array(hash).length(2),payloadHash:hash,observedAt:z.string().datetime(),evidence:z.object({path:nonempty,sha256:hash}).strict(),authorityId:nonempty,pricing:z.literal('deferred-preserved'),individualFieldsReopened:z.literal(false)}).strict().optional(),
  nonpriceVerification: z.object({ scope: z.literal("non-price-fields"), observedAt: z.string().datetime(), evidence: z.string().min(1).max(500), draftId: z.string().regex(/^\d+$/), pricing: z.literal("deferred-preserved") }).strict().optional(),
  draftArchive: z.object({ status: z.enum(["planned", "copied", "moved", "held"]), instructionId: nonempty, authority: z.object({ path: z.string().min(1), sha256: hash }).strict(), draftId: z.string().regex(/^\d+$/), captureId: hash, files: z.array(z.object({ source: z.string().min(1), destination: z.string().min(1), hash, side: z.enum(["front", "back"]) }).strict()).length(2), updatedAt: z.string().datetime(), error: z.string().max(300).optional() }).strict().optional(),
  inventoryArchive: z.object({disposition:z.enum(["listed","sold"]),status:z.enum(["planned","copied","moved","held"]),instructionId:nonempty,authority:z.object({path:z.string(),sha256:hash}).strict(),observation:z.object({path:z.string(),sha256:hash}).strict(),observedAt:z.string().datetime(),seller:z.literal("imaydit58"),itemId:z.string().regex(/^\d+$/),sku:nonempty,captureId:hash,draftId:z.string().regex(/^\d+$/).optional(),payloadHash:hash.optional(),activeQuantityOperationId:hash.optional(),photoProvenance:z.enum(["retained-draft-original-pair; live-photos-not-reinspected","direct-active-quantity-capture; exact-originals-reviewed"]),files:z.array(z.object({original:z.string(),source:z.string(),destination:z.string(),hash,side:z.enum(["front","back"])}).strict()).length(2),updatedAt:z.string().datetime(),error:z.string().max(300).optional()}).strict().superRefine((a,ctx)=>{const direct=a.photoProvenance==="direct-active-quantity-capture; exact-originals-reviewed";if(direct?(!a.activeQuantityOperationId||a.draftId!==undefined||a.payloadHash!==undefined):(!a.draftId||!a.payloadHash||a.activeQuantityOperationId!==undefined))ctx.addIssue({code:"custom",message:"Archive provenance requires its exact direct-active operation or retained draft ID/payload"});}).optional(),
}).strict();
export type V2Card = z.infer<typeof recordSchema>;
export type V2Issue = V2Card["issues"][number];
export const payloadSchema = z.object({
  sku: nonempty, captureIds: z.array(hash).min(1), title: nonempty, categoryId: nonempty,
  specifics: z.record(nonempty, z.array(nonempty).min(1)), quantity: z.number().int().positive(),
  photos: z.array(z.object({ hash, url: z.string().url(), expiresAt: z.string().datetime(), upright: z.literal(true) }).strict()).length(2),
  conditionId: nonempty, conditionDescriptorName: nonempty, conditionDescriptorValue: nonempty,
  condition: z.literal("Near mint or better"), description: z.string().trim().min(1).max(20000),
  descriptionSource: z.enum(["factual", "ebay-ai-reviewed"]),
  pricing: z.literal("unpriced-grok-pending"),
}).strict();
export type V2Payload = z.infer<typeof payloadSchema>;
export const timingSchema = z.object({ id: nonempty, step: nonempty, cardId: nonempty.optional(), cardIds: z.array(nonempty).min(1).max(20).optional(), runId: nonempty.optional(), source: z.literal("external-browser-wall-clock").optional(), pid: z.number().int().positive(), startedAt: z.string().datetime(), endedAt: z.string().datetime().optional(), durationMs: z.number().finite().nonnegative().optional(), status: z.enum(["running", "completed", "failed", "interrupted"]) }).strict();
export type V2Timing = z.infer<typeof timingSchema>;
export const stateSchema = z.object({
  version: z.literal(2), revision: z.number().int().nonnegative(), cards: z.record(z.string(), recordSchema),
  knowledge: z.record(z.string(), z.object({ identity: identitySchema, photoHashes: z.array(hash).length(2), verifiedAt: z.string().datetime(), evidence: nonempty }).strict()),
  calls: z.array(z.object({ id: nonempty, cardId: nonempty, key: hash, provider: z.literal("openai"), model: nonempty,
    status: z.enum(["reserved", "settled", "uncertain"]), reservedMicros: z.number().int().positive(),
    actualMicros: z.number().int().nonnegative().nullable(), inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(), at: z.string().datetime(),
    bound: z.object({ authority: nonempty, pricingSource: z.string().url(), inputUsdPerMillion: z.number().positive(), outputUsdPerMillion: z.number().positive(), maxInputTokens: z.number().int().positive(), maxOutputTokens: z.number().int().positive() }).strict().optional(),
    usageEvidence: z.object({ path: nonempty, sha256: hash, source: nonempty, observedAt: z.string().datetime() }).strict().optional(),
    failure: z.object({stage:z.enum(['provider','validation','persistence']),observedAt:z.string().datetime(),usageBoundExceeded:z.boolean()}).strict().optional(),
  }).strict()),
  submissions: z.record(z.string(), z.object({ key: hash, groupId: nonempty, payload: payloadSchema,
    status: z.enum(["intent", "submitted", "verified", "uncertain"]), jobId: z.string().optional(),
    draftId: z.string().regex(/^\d+$/).optional(), evidence: z.string().optional(), at: z.string().datetime(),
  }).strict()),
  events: z.array(z.object({ at: z.string().datetime(), cardId: z.string().optional(), stage: nonempty, detail: nonempty }).strict()),
  lastRun: z.object({ id: nonempty, pid: z.number().int().positive(), startedAt: z.string().datetime(), finishedAt: z.string().datetime().optional(), status: z.enum(["running", "finished", "interrupted", "failed"]), selection: z.object({ candidateIds: z.array(hash).max(500), photoCount: z.number().int().nonnegative() }).strict().optional() }).optional(),
  notices: z.array(nonempty),
  baseline: z.object({ initializedAt: z.string().datetime(), hashes: z.array(hash), paths: z.array(z.string()).default([]), fileCount: z.number().int().nonnegative() }).optional(),
  media: z.record(hash, z.object({ hash, url: z.string().url(), expiresAt: z.string().datetime(), upright: z.literal(true), orientationHash: hash.optional() }).strict()).default({}),
  prepared: z.record(hash, payloadSchema).default({}),
  timings: z.array(timingSchema).default([]),
}).strict();
export type V2State = z.infer<typeof stateSchema>;
export const emptyV2State = (): V2State => ({ version: 2, revision: 0, cards: {}, knowledge: {}, calls: [], submissions: {}, events: [], notices: [], media: {}, prepared: {}, timings: [] });
export const nowIso = () => new Date().toISOString();
export function event(s: V2State, stage: string, detail: string, cardId?: string) { s.events.push({ at: nowIso(), stage, detail, ...(cardId ? { cardId } : {}) }); }
export function issue(card: V2Card, code: string, detail: string, owner = "Card Processing V2") {
  card.issues = [...card.issues.filter(i => i.code !== code), { code, detail, owner }];
  card.stage = "exception"; card.nextAction = detail; card.updatedAt = nowIso();
}
export function searchableTitle(i: V2Identity) {
  // Keep complete names/numbers/stamps. Only documented product display aliases
  // may shorten a title; Set and the underlying identity remain unchanged.
  const words=(value:string)=>value.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
  const make=(product:string,variant=i.variant)=>[v2FactualYear(i),product,i.name,`#${i.number}`,variant==='Base'||(` ${words(product)} `).includes(` ${words(variant)} `)?'':variant,i.serial].filter(Boolean).join(' ').replace(/\s+/g,' ').trim();
  const full=make(i.product);if(full.length<=80)return full;
  for(const product of v2ProductTitleForms(i))for(const variant of v2VariantTitleForms(i)){const compact=make(product,variant);if(compact.length<=80)return compact;}
  return full;
}
/** Drop only an explanatory standard-insert suffix backed by its exact Insert Set.
 * This is a title display form; the identity and category specifics stay complete. */
export function v2VariantTitleForms(i:V2Identity){const prefix=i.variant.endsWith(' — standard insert')?i.variant.slice(0,-' — standard insert'.length):'';return[i.variant,...(prefix&&i.specifics['Insert Set']?.includes(prefix)?[prefix]:[])];}
export function v2ProductTitleForms(i:V2Identity){return[i.product,...(i.manufacturer==='Topps'&&i.categoryId==='261328'&&/^(?:Topps )?Chrome Update Series$/i.test(i.product)?[i.product.replace(/ Series$/i,'')]:[]),...(i.manufacturer==='Panini'&&i.categoryId==='261328'&&i.sportOrGame==='Basketball'&&['Prizm Basketball','Mosaic Basketball'].includes(i.product)?[i.product.replace(/ Basketball$/,'')]:[])];}
export function identitySpecifics(i: V2Identity): Record<string, string[]> {
  const year=v2FactualYear(i),specifics={...i.specifics};if(!year)delete specifics["Year Manufactured"];
  const common = { Manufacturer: [i.manufacturer], Set: [i.product], "Card Number": [i.number], Language: [i.language], Graded: [i.graded ? "Yes" : "No"] };
  return { ...specifics, ...common, ...(i.categoryId === "261328" ? { Sport: [i.sportOrGame], "Player/Athlete": [i.name], Season: [i.year], ...(i.team ? { Team: [i.team] } : {}) }
    : { "Character": [i.name], ...(year?{"Year Manufactured": [year]}:{}), ...(i.categoryId === "183454" ? { Game: [i.sportOrGame] } : { Franchise: [i.sportOrGame] }) }),
    ...(i.variant !== "Base" ? { "Parallel/Variety": [i.variant] } : {}),
  };
}
export function consolidationKey(card: V2Card) {
  if (!card.identity) throw Error("Identification required before consolidation");
  if(card.consolidationVersion===2)return v2StableCatalogIdentityKey(card);
  const i = card.identity;
  return digest([i.name, i.year, i.manufacturer, i.product, i.number, i.categoryId, i.language, i.variant, i.artwork, i.sportOrGame, i.team,
    card.condition, i.graded, i.damage, i.serial ? card.captureId : "unnumbered"].map(v => typeof v === "string" ? v.normalize("NFKC").trim().toLowerCase() : v));
}
export function consolidate(s: V2State, selectedCardIds?: ReadonlySet<string>) {
  for (const card of Object.values(s.cards)) {
    if (selectedCardIds && !selectedCardIds.has(card.id)) continue;
    if (card.activeQuantityOperationId || card.inventoryArchive || card.stage !== "identified" || !card.identity || card.issues.length) continue;
    const groupId = consolidationKey(card);
    // A new copy cannot change an intent or a saved draft's quantity on retry.
    if (Object.values(s.submissions).some(sub => sub.groupId === groupId)) {
      issue(card, "EXISTING_GROUP", "Reconcile the additional capture with the existing submission before quantity changes.", "Inventory reconciliation"); continue;
    }
    card.groupId = groupId; card.stage = "consolidated"; card.title = searchableTitle(card.identity);
    if(!assessV2Description(card.description,card.identity).acceptable){card.description=factualV2Description(card.identity,card.condition);card.descriptionSource="factual";}
    card.nextAction = "Validate listing completeness and prepare draft handoff"; card.updatedAt = nowIso();
    event(s, "consolidated", "Exact identity, language, variant, artwork and condition bound to capture", card.id);
  }
}
export function completeness(card: V2Card, category: V2Category | undefined, photos: V2Payload["photos"], at = Date.now()): V2Issue[] {
  const errors: V2Issue[] = []; const add = (code: string, detail: string) => errors.push({ code, detail, owner: "Listing completeness" });
  const i = card.identity;
  if (!recordSchema.safeParse(card).success || !i || !card.identification?.pairMatches || card.identification.frontImageIndex !== "0" || !card.identification.upright || classifyV2IdentificationWarnings(card.identification).blocking.length || digest(i) !== digest(card.identification.identity) || card.photos[0]?.side !== "front" || card.photos[1]?.side !== "back") add("IDENTITY", "Resolve identity, pairing, orientation and visual warnings before drafting.");
  if (i && Object.entries(i).some(([k, v]) => !["team", "serial"].includes(k) && typeof v === "string" && /^(unknown|n\/a|unsure|not visible|unidentified)$/i.test(v.trim()))) add("IDENTITY", "Unknown identity placeholders cannot satisfy listing completeness.");
  if(i?.categoryId==="261328"&&i.year.trim()==="Not specified")add("IDENTITY","Sports cards require an identified year or season.");
  if (i?.serial) { const serial = /^(\d+)\s*\/\s*(\d+)$/.exec(i.serial); if (!serial || Number(serial[1]) < 1 || Number(serial[1]) > Number(serial[2])) add("IDENTITY", "Owned numbered cards require the complete observed numerator and denominator."); }
  if (i?.graded || i?.damage) add("CONDITION", "Graded cards or visible damage require an explicit supported condition review.");
  const title = card.title;
  if (!title || title.length > 80 || /[\r\n<>]|^\s*[=+@-]/.test(title) || (i && (!v2ProductTitleForms(i).some(v=>title.toLowerCase().includes(v.toLowerCase()))||(i.variant!=="Base"&&!v2VariantTitleForms(i).some(v=>title.toLowerCase().includes(v.toLowerCase())))||[i.name, v2FactualYear(i), i.number, i.serial].filter(Boolean).some(v => !title.toLowerCase().includes(v.toLowerCase()))))) add("TITLE", "Searchable title must retain name, year, product, card number, variant and serial within 80 characters.");
  if (!category || !categorySchema.safeParse(category).success || category.categoryId !== i?.categoryId || Date.parse(category.observedAt) > at || at - Date.parse(category.observedAt) > 7 * 86400000) add("CATEGORY", "A current verified category requirements and condition template is required (within seven days).");
  if (category && i) {
    const specifics = identitySpecifics(i);
    for (const name of category.requiredAspects) if (!specifics[name]?.length || specifics[name].some(v => !v.trim() || /^(unknown|n\/a|unsure)$/i.test(v.trim()))) add("SPECIFICS", `Missing required category item specific: ${name}`);
    for (const [name, allowed] of Object.entries(category.allowedValues)) if (allowed.length && specifics[name]?.some(v => !allowed.includes(v))) add("SPECIFICS", `Unsupported category value: ${name}`);
    if (category.conditionLabel !== card.condition) add("CONDITION", "Condition does not match the verified category template.");
  }
  if (photos.length !== 2 || photos.some((p, n) => {
    try { const u = new URL(p.url); return u.protocol !== "https:" || u.hostname !== "i.ebayimg.com" || !!u.username || !!u.password || p.hash !== card.photos[n]?.hash || !p.upright || !Number.isFinite(Date.parse(p.expiresAt)) || Date.parse(p.expiresAt) < at + 86400000; } catch { return true; }
  })) add("PHOTOS", "Two exact upright hosted front/back photos valid for at least 24 hours are required.");
  if (!i || !assessV2Description(card.description,i).acceptable) add("DESCRIPTION", "A reviewed factual description matching the identified card is required.");
  return errors;
}
export function preparePayload(card: V2Card, captures: V2Card[], category: V2Category, photos: V2Payload["photos"]): V2Payload {
  const errors = completeness(card, category, photos);
  if (errors.length) throw Error(errors.map(e => e.detail).join(" "));
  if (!captures.length || new Set(captures.map(c => c.captureId)).size !== captures.length || captures.some(c => c.groupId !== card.groupId || !c.identity || consolidationKey(c) !== card.groupId || c.issues.length || !["consolidated", "prepared"].includes(c.stage)
    || completeness(c, category, photos.map((p, n) => ({ ...p, hash: c.photos[n]?.hash }))).length)) throw Error("Exact eligible capture group required");
  return payloadSchema.parse({ sku: card.sku, captureIds: captures.map(c => c.captureId).sort(), title: card.title, categoryId: card.identity!.categoryId,
    specifics: identitySpecifics(card.identity!), quantity: captures.length, photos:photos.map(({hash,url,expiresAt,upright})=>({hash,url,expiresAt,upright})), condition: card.condition,
    conditionId: category.conditionId, conditionDescriptorName: category.conditionDescriptorName, conditionDescriptorValue: category.conditionDescriptorValue,
    description: captures.length>1&&card.descriptionSource==="factual"&&card.description===factualV2Description(card.identity!,card.condition)?factualV2Description(card.identity!,card.condition,captures.length):card.description, descriptionSource: card.descriptionSource, pricing: "unpriced-grok-pending" });
}
export function verifyReadback(expected: V2Payload, actual: V2Payload) {
  // Full comparison, including price-unresolved status and photo order. No thumbnail/count shortcut.
  return digest(payloadSchema.parse(expected)) === digest(payloadSchema.parse(actual));
}
export function v2Summary(s: V2State) {
  const cards = Object.values(s.cards); const settled = s.calls.filter(c => c.status === "settled");
  const unknown = s.calls.filter(c => c.status !== "settled" || c.actualMicros === null).length;
  const measuredMicros = settled.reduce((sum, c) => sum + (c.actualMicros ?? 0), 0);
  return { counts: Object.fromEntries(V2_STAGES.map(stage => [stage, cards.filter(c => c.stage === stage).length])),
    physicalCards: cards.length, photoCount: new Set(cards.flatMap(c => c.photos.map(p => p.hash))).size,
    awaitingDrafts: cards.filter(c => !v2ArchivePresentation(c).archived && !(c.stage === "verified" && c.verification && c.draftId)).length,
    pendingProcessingCards:cards.filter(c=>!v2ArchivePresentation(c).archived).length,
    draftGroups: new Set(cards.filter(c => c.draftId).map(c => c.draftMergeOwner?.survivorDraftId??c.draftId)).size,
    cost: { measuredUsd: measuredMicros / 1e6, unsettledCalls: unknown, usdPerIdentifiedCard: cards.filter(c => c.identity).length && !unknown ? measuredMicros / 1e6 / cards.filter(c => c.identity).length : null,
      scope: "Attributable V2 identification calls only; Grok, eBay and subscription costs are separate." },
  };
}


