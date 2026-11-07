import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { payloadSchema, verifyReadback, type V2Payload } from "./card-processing-v2.ts";
import { observedV2DraftId } from "./card-processing-v2-observation-values.ts";
import { assessV2DescriptionFormatting } from "./card-processing-v2-description.ts";
import { parseV2FeedCsv } from "./card-processing-v2-uploader.ts";

export const V2_TRANSPORT_CONTRACT = "card-processing-v2-draft-1";
export const V2_LIVE_METHOD_CONTRACT = "card-processing-v2-draft-2";
const evidenceReference = z.object({ path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const policiesSchema = z.object({
  payment: z.string().trim().min(1), returns: z.literal("No Return Accepted"),
  shipping: z.string().trim().min(1).nullable(), location: z.string().trim().min(1),
  pricingShippingUnresolved: z.boolean(),
}).strict().refine(p => p.shipping !== null || p.pricingShippingUnresolved, "Shipping must be bound or explicitly unresolved");
const readbackSchema = z.object({
  kind: z.literal("saved-reopened-ebay-draft"), seller: z.literal("imaydit58"),
  draftId: z.string().regex(/^\d+$/), url: z.string().url(), observedAt: z.string().datetime(),
  payload: payloadSchema, policies: policiesSchema, editorErrors: z.array(z.string()).max(0),
}).strict();
const legacyMethodProofSchema = z.object({
  version: z.literal(1), contract: z.literal(V2_TRANSPORT_CONTRACT), method: z.literal("seller-hub-draft-csv"),
  kind: z.literal("live"), importAction: z.literal("Draft"), importJobId: z.string().regex(/^\d+$/),
  startedAt: z.string().datetime(), finishedAt: z.string().datetime(),
  published: z.literal(false), duplicateInventory: z.literal(false), ebayIdentityAIUsed: z.literal(false),
  fieldRepairs: z.literal(0),
  observations: z.array(z.object({
    expected: payloadSchema, expectedPolicies: policiesSchema,
    savedReadback: evidenceReference,
  }).strict()).min(2).max(20),
  importReport: evidenceReference,
}).strict();
const liveMethodProofSchema = legacyMethodProofSchema.omit({ version: true, contract: true, method: true, importJobId: true, fieldRepairs: true }).extend({
  version: z.literal(2), contract: z.literal(V2_LIVE_METHOD_CONTRACT), method: z.literal("seller-hub-fx-listing"),
  importJobId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/), fieldRepairs: z.number().int().nonnegative(),
  repairs: z.array(z.object({ draftId: z.string().regex(/^\d+$/), field: z.string().trim().min(1), reason: z.string().trim().min(1), evidence: evidenceReference }).strict()),
}).strict();
export const methodProofSchema = z.union([legacyMethodProofSchema, liveMethodProofSchema]);
type EvidenceReference = z.infer<typeof evidenceReference>;
export type MethodReview = { status: "not-validated" | "validated"; findings: string[]; evidence: EvidenceReference[] };

/** Only bounded, non-secret files under artifacts may be used as retained pilot proof. */
async function readEvidence(root: string, ref: EvidenceReference) {
  if (path.isAbsolute(ref.path) || ref.path.split(/[\\/]/).some(p => p === "..")) throw Error("Evidence must stay within artifacts");
  const artifacts = await fs.realpath(path.join(root, "artifacts"));
  const resolved = await fs.realpath(path.join(root, ref.path));
  const relative = path.relative(artifacts, resolved);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw Error("Evidence must stay within artifacts");
  const stat = await fs.stat(resolved);
  if (!stat.isFile() || stat.size > 1_000_000) throw Error("Pilot evidence exceeds the bounded file limit");
  const bytes = await fs.readFile(resolved);
  if (createHash("sha256").update(bytes).digest("hex") !== ref.sha256) throw Error("Pilot evidence hash changed");
  return bytes.toString("utf8");
}

/** A new method is accepted only from attributable saved/reopened pilot observations,
 * not a documentation edit, upload-success message or mocked test result. */
export async function validateMethodProof(root: string, input: unknown): Promise<EvidenceReference[]> {
  const proof = methodProofSchema.parse(input);
  const end = Date.parse(proof.finishedAt), start = Date.parse(proof.startedAt);
  if (!(end >= start) || end > Date.now()) throw Error("Pilot times are invalid");
  const report = z.object({ kind: z.literal("live-ebay-import-result"), action: z.literal("Draft"),
    jobId: z.string(), rows: z.array(z.object({ sku: z.string(), draftId: z.string().regex(/^\d+$/), result: z.literal("Success") }).strict()),
  }).strict().parse(JSON.parse(await readEvidence(root, proof.importReport)));
  if (report.jobId !== proof.importJobId || report.rows.length !== proof.observations.length) throw Error("Pilot import report does not match observations");
  const seenDrafts = new Set<string>(), seenCaptures = new Set<string>(), seenSkus = new Set<string>();
  for (const observation of proof.observations) {
    const saved = (proof.version === 2 ? readbackSchema.extend({ savedItemPrice: z.null(), savedShippingAmount: z.number().nonnegative().nullable() }).strict() : readbackSchema)
      .parse(JSON.parse(await readEvidence(root, observation.savedReadback)));
    if (observedV2DraftId(saved.url) !== saved.draftId) throw Error("Saved evidence must identify the same eBay draft");
    if (Date.parse(saved.observedAt) < start || Date.parse(saved.observedAt) > end) throw Error("Saved readback is outside the pilot window");
    if (!verifyReadback(observation.expected, saved.payload) || JSON.stringify(observation.expectedPolicies) !== JSON.stringify(saved.policies)) throw Error("Required saved draft fields did not persist");
    if (seenDrafts.has(saved.draftId) || seenSkus.has(saved.payload.sku)) throw Error("Duplicate pilot draft or SKU");
    const row = report.rows.find(r => r.sku === saved.payload.sku && r.draftId === saved.draftId);
    if (!row) throw Error("Saved draft does not match the successful import row");
    seenDrafts.add(saved.draftId); seenSkus.add(saved.payload.sku);
    for (const captureId of saved.payload.captureIds) {
      if (seenCaptures.has(captureId)) throw Error("Capture appears in multiple pilot drafts");
      seenCaptures.add(captureId);
    }
  }
  if (!seenCaptures.size || (proof.version === 1 && (end - start) / 1000 / seenCaptures.size > 90)) throw Error("Pilot did not meet retained complete-listing throughput criterion");
  const repairs: EvidenceReference[] = [];
  if (proof.version === 2) {
    if (proof.fieldRepairs !== proof.repairs.length) throw Error("Every field repair must be recorded honestly with retained evidence");
    for (const repair of proof.repairs) {
      if (!seenDrafts.has(repair.draftId)) throw Error("A repair cannot change an unrelated draft");
      await readEvidence(root, repair.evidence); repairs.push(repair.evidence);
    }
  }
  return [proof.importReport, ...proof.observations.map(o => o.savedReadback), ...repairs];
}

export async function historicalMethodReview(root = process.cwd()): Promise<MethodReview> {
  const findings = [
    "Pokémon evidence supports capture mappings, grouped uploads, same-ID save/reopen and per-draft photo verification; historical photo-AI identification is superseded.",
    "The October 25 corrected Draft CSV retained identity, photos, Near mint condition and location, but shipping/payment/return policy bindings remained blank. Complete zero-repair import was not established.",
    "The retained workflow does not independently establish the Harry Potter bulk method. Historical counts are not fresh seller inventory evidence.",
  ];
  const evidence: EvidenceReference[] = [];
  for (const filename of ["docs/LISTING_WORKFLOW.md", "docs/bulk-import-proof-2026-10-25.md", "docs/card-bulk-drafts.md"]) {
    try { const bytes = await fs.readFile(path.join(root, filename)); evidence.push({ path: filename, sha256: createHash("sha256").update(bytes).digest("hex") }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") findings.push(`Historical evidence unavailable: ${filename}`); else throw error; }
  }
  const filename = path.join(root, "artifacts/card-processing-v2/method-proof.json");
  try {
    const stat = await fs.stat(filename); if (stat.size > 1_000_000) throw Error("Pilot proof exceeds bounded file limit");
    const bytes = await fs.readFile(filename);
    const proof = methodProofSchema.parse(JSON.parse(bytes.toString("utf8")));
    const pilot = await validateMethodProof(root, proof);
    findings.push(proof.version === 2
      ? `A retained live FX_LISTING pilot verified complete same-ID saved fields with ${proof.fieldRepairs} recorded field repair(s). Elapsed time is retained; no zero-repair or speed-benchmark success is implied.`
      : "A retained legacy V2 pilot meets its saved-field and throughput contract. This certifies method evidence, not current inventory clearance or publication authority.");
    evidence.push({ path: "artifacts/card-processing-v2/method-proof.json", sha256: createHash("sha256").update(bytes).digest("hex") }, ...pilot);
    return { status: "validated", findings, evidence };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") findings.push("V2 live method proof is invalid or incomplete; inspect its bound import report and full saved/reopened readbacks.");
    findings.push("Draft creation remains gated until an authorized fresh pilot demonstrates complete saved fields. Local CSV preparation is not draft creation.");
    return { status: "not-validated", findings, evidence };
  }
}

const csvCell = (value: string | number) => `"${String(value).replace(/"/g, '""')}"`;
const safe = (value: string) => !/^[\s\u0000-\u001f]*[=+@-]/.test(value) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value);

/** Draft-only candidate transport, never an upload or completeness certification.
 * The companion payloads retain capture attribution and mandatory readback fields.
 * Do not reimport a row after an intent or draft ID exists. */
export function draftCsv(input: V2Payload[], at = Date.now()): string {
  if (!input.length || input.length > 500) throw Error("Select 1 to 500 prepared draft groups");
  const payloads = input.map(p => payloadSchema.parse(p));
  const skus = new Set<string>(), captures = new Set<string>();
  for (const p of payloads) {
    if (skus.has(p.sku) || !safe(p.sku) || !safe(p.title) || /[\r\n]/.test(p.sku + p.title) || p.title.length > 80) throw Error("Unsafe, duplicate or oversized draft identity");
    if (!["183454", "261328", "183050"].includes(p.categoryId) || !/^\d+$/.test(p.conditionId) || p.quantity !== p.captureIds.length || new Set(p.captureIds).size !== p.captureIds.length) throw Error("Draft category, condition or quantity attribution is invalid");
    skus.add(p.sku);
    for (const capture of p.captureIds) { if (captures.has(capture)) throw Error("Capture cannot create more than one draft"); captures.add(capture); }
    if (p.photos[0].hash === p.photos[1].hash || p.photos.some(photo => {
      const url = new URL(photo.url);
      return url.protocol !== "https:" || url.hostname !== "i.ebayimg.com" || !!url.username || !!url.password || /[|\r\n]/.test(photo.url) || Date.parse(photo.expiresAt) < at + 86400000;
    })) throw Error("Exact upright eBay-hosted front/back photos must remain valid for 24 hours");
    for (const [name, values] of Object.entries(p.specifics)) if (!safe(name) || /[\r\n|]/.test(name) || values.some(v => !safe(v) || /[\r\n|]/.test(v))) throw Error("Unsafe item specific value");
    if (!safe(p.description) || !assessV2DescriptionFormatting(p.description).acceptable || !safe(p.conditionDescriptorName) || /[\r\n|]/.test(p.conditionDescriptorName + p.conditionDescriptorValue) || !safe(p.conditionDescriptorValue)) throw Error("Unsafe description or condition value");
  }
  const specifics = Array.from(new Set(payloads.flatMap(p => Object.keys(p.specifics)))).sort();
  const descriptors = Array.from(new Set(payloads.map(p => p.conditionDescriptorName))).sort();
  const headers = ["Action(SiteID=US|Country=US|Currency=USD|Version=1193|CC=UTF-8)", "Custom label (SKU)", "Category ID", "Title", "Price", "Quantity", "Item photo URL", "Condition ID", "Description", "Format",
    ...descriptors.map(name => `CD:${name}`), ...specifics.map(name => `C:${name}`)];
  const rows = payloads.map(p => ["Draft", p.sku, p.categoryId, p.title, "", p.quantity, p.photos.map(photo => photo.url).join("|"), p.conditionId, p.description, "FixedPrice",
    ...descriptors.map(name => p.conditionDescriptorName === name ? p.conditionDescriptorValue : ""), ...specifics.map(name => (p.specifics[name] ?? []).join("|"))]);
  return [headers, ...rows].map(row => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

/** Exact unquoted first line of the retained official US browser Draft template.
 * This is a browser-template envelope, not evidence that an upload succeeded. */
export const V2_BROWSER_DRAFT_INFO = '#INFO,Version=0.0.2,Template= eBay-draft-listings-template_US,,,,,,,,';
export function browserDraftCsv(payloads: V2Payload[], at = Date.now()): string {
  return `${V2_BROWSER_DRAFT_INFO}\r\n${draftCsv(payloads, at)}`;
}
/** Metadata-only correction: preserves the original body bytes and all fields.
 * Caller retains definitive rejection and template provenance before using it. */
export function browserDraftCsvAmendment(payloads: V2Payload[], at = Date.now()) {
  const originalBody = draftCsv(payloads, at), csv = browserDraftCsv(payloads, at);
  const sha = (text: string) => createHash('sha256').update(text).digest('hex');
  if (csv.slice(`${V2_BROWSER_DRAFT_INFO}\r\n`.length) !== originalBody) throw Error('Browser envelope changed frozen listing fields');
  return { csv, originalBodySha256: sha(originalBody), browserCsvSha256: sha(csv), metadataLine: V2_BROWSER_DRAFT_INFO,
    listingBodyUnchanged: true as const, payloadsUnchanged: true as const, newIntents: 0 as const, canPublish: false as const };
}

/** Source-bound full category exports are opt-in for new jobs. Historical frozen
 * browser CSVs retain their original bytes and transport family. */
export const V2_FULL_CATEGORY_INFO = 'Info,Version=1.0.0,Template=fx_category_template_EBAY_US';
const categoryIdSchema = z.enum(['183454', '261328', '183050']);
export const v2CsvDefaultsSchema = z.object({
  location: z.string().trim().min(1).max(300),
  paymentProfileName: z.string().trim().min(1).max(300),
  returnProfileName: z.string().trim().min(1).max(300),
  returnsAcceptedOption: z.literal('ReturnsNotAccepted'),
  evidence: evidenceReference,
}).strict();
export type V2CsvDefaults = z.infer<typeof v2CsvDefaultsSchema>;
export const v2FullTemplateDraftOptionsSchema = z.object({
  template: z.object({ categoryId: categoryIdSchema, template: evidenceReference, receipt: evidenceReference }).strict(),
  defaults: v2CsvDefaultsSchema,
}).strict();
export type V2FullTemplateDraftOptions = z.infer<typeof v2FullTemplateDraftOptionsSchema>;
export const v2FullTemplateBindingSchema = z.object({
  kind: z.literal('actual-category-template-v1'), categoryId: categoryIdSchema,
  metadataLine: z.literal(V2_FULL_CATEGORY_INFO), template: evidenceReference, receipt: evidenceReference,
  policyEvidence: evidenceReference, sourceHeaderSha256: z.string().regex(/^[a-f0-9]{64}$/),
  outputHeaderSha256: z.string().regex(/^[a-f0-9]{64}$/), defaultsSha256: z.string().regex(/^[a-f0-9]{64}$/),
  additionalSpecificHeaders: z.array(z.string()).max(300),
}).strict();
export type V2FullTemplateBinding = z.infer<typeof v2FullTemplateBindingSchema>;
export type V2FullCategoryTemplate = { categoryId: z.infer<typeof categoryIdSchema>; headers: string[];
  descriptorValues: Record<string, string[]>; source: V2FullTemplateDraftOptions['template'] };
const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function fullTemplateEvidence(root: string, raw: EvidenceReference, maximum: number) {
  const reference = evidenceReference.parse(raw);
  if (path.isAbsolute(reference.path) || reference.path.split(/[\\/]/).includes('..')) throw Error('Full template evidence must stay inside artifacts');
  const requested = path.resolve(root, reference.path), leaf = await fs.lstat(requested);
  const base = await fs.realpath(path.join(root, 'artifacts')), actual = await fs.realpath(requested), relative = path.relative(base, actual);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !leaf.isFile() || leaf.isSymbolicLink() || leaf.size > maximum) throw Error('Bounded regular full template evidence required');
  const bytes = await fs.readFile(actual);
  if (sha256(bytes) !== reference.sha256) throw Error('Full template evidence SHA changed');
  return bytes;
}
const technical = (header: string) => header.replace(/^\*/, '');
const descriptorBase = (name: string) => name.replace(/\s*-\s*\(ID:\s*\d+\)$/, '').trim();
/** Reads the actual downloaded template and its separately retained download
 * receipt. It never downloads, edits seller state, or infers another category. */
export async function readV2FullCategoryTemplate(root: string, raw: V2FullTemplateDraftOptions['template']): Promise<V2FullCategoryTemplate> {
  const source = v2FullTemplateDraftOptionsSchema.shape.template.parse(raw);
  const bytes = await fullTemplateEvidence(root, source.template, 2_000_000);
  const receipt = z.object({ source: z.literal('actual Seller Hub Get template UI'), sourcePage: z.string().url(),
    categoryId: categoryIdSchema, artifact: z.string(), sha256: z.string(), bytes: z.number().int().positive(),
    downloadedAt: z.string().datetime(), uploaded: z.literal(false) }).passthrough()
    .parse(JSON.parse((await fullTemplateEvidence(root, source.receipt, 100_000)).toString('utf8')));
  const url = new URL(receipt.sourcePage), age = Date.now() - Date.parse(receipt.downloadedAt);
  if (url.origin !== 'https://www.ebay.com' || url.pathname !== '/sh/reports/uploads' || receipt.categoryId !== source.categoryId ||
      receipt.artifact !== source.template.path || receipt.sha256 !== source.template.sha256 || receipt.bytes !== bytes.length || age < 0 || age > 7 * 86400000)
    throw Error('Actual fresh category template receipt does not bind this source');
  const rows = parseV2FeedCsv(bytes.toString('utf8'));
  if (rows[0]?.cells.join(',') !== V2_FULL_CATEGORY_INFO) throw Error('Unsupported full category template family');
  const headers = rows[1]?.cells;
  if (!headers || headers.length > 400 || new Set(headers.map(technical)).size !== headers.length || headers[0] !== '*Action(SiteID=US|Country=US|Currency=USD|Version=1193|CC=UTF-8)') throw Error('Actual technical template headers required');
  for (const name of ['CustomLabel', 'Category', 'Title', 'ConditionID', 'PicURL', 'Description', 'Format', 'StartPrice', 'Quantity', 'Location', 'ReturnsAcceptedOption', 'ReturnProfileName', 'PaymentProfileName', 'ShippingProfileName'])
    if (headers.filter(header => technical(header) === name).length !== 1) throw Error('Full category template lacks required technical header: ' + name);
  const descriptorValues: Record<string, string[]> = {};
  for (const header of headers.filter(name => name.startsWith('CD:'))) {
    const prefix = `>>> Values for Condition Descriptor column '${header}'  :`;
    const guide = rows.slice(2).flatMap(row => row.cells).find(cell => cell.startsWith(prefix));
    if (guide) descriptorValues[header] = guide.slice(prefix.length).split(';').map(value => value.trim()).filter(Boolean);
  }
  return { categoryId: source.categoryId, headers, descriptorValues, source };
}
/** Pure export: retain the full technical schema and long-form condition values.
 * Additional columns can only be factual C: specifics from the frozen payload. */
export function fullCategoryDraftCsv(input: V2Payload[], template: V2FullCategoryTemplate, rawDefaults: V2CsvDefaults, at = Date.now()) {
  draftCsv(input, at); // Reuse the existing exact-photo, formula and attribution guards.
  const defaults = v2CsvDefaultsSchema.parse(rawDefaults), payloads = input.map(payload => payloadSchema.parse(payload));
  if (payloads.some(payload => payload.categoryId !== template.categoryId)) throw Error('A full category template cannot cover another category');
  for (const value of [defaults.location, defaults.paymentProfileName, defaults.returnProfileName]) if (!safe(value) || /[\r\n|]/.test(value)) throw Error('Unsafe seller CSV defaults');
  const headers = [...template.headers], knownSpecifics = new Set(headers.filter(header => technical(header).startsWith('C:')).map(header => technical(header).slice(2)));
  const additionalSpecificHeaders = Array.from(new Set(payloads.flatMap(payload => Object.keys(payload.specifics)))).filter(name => !knownSpecifics.has(name)).sort().map(name => `C:${name}`);
  headers.push(...additionalSpecificHeaders);
  if (headers.length > 500) throw Error('Full category export exceeds bounded column count');
  const rows = payloads.map(payload => {
    if (payload.conditionId !== '4000' || descriptorBase(payload.conditionDescriptorValue) !== payload.condition) throw Error('Only the supported Near mint ungraded condition may be exported');
    const exact = `CD:${payload.conditionDescriptorName}`, matching = template.headers.filter(header => header === exact || (!/\(ID:/.test(payload.conditionDescriptorName) && descriptorBase(header.slice(3)) === payload.conditionDescriptorName));
    if (matching.length !== 1 || !matching[0].startsWith('CD:')) throw Error('Condition descriptor must bind the actual category template');
    const descriptorHeader = matching[0], allowed = template.descriptorValues[descriptorHeader];
    if (!allowed?.includes(payload.conditionDescriptorValue)) throw Error('Condition descriptor value must match actual template guidance');
    for (const required of template.headers.filter(header => header.startsWith('*C:'))) if (!payload.specifics[required.slice(3)]?.length) throw Error('Required category specific missing from prepared payload');
    const values: Record<string, string | number> = { CustomLabel: payload.sku, Category: payload.categoryId, Title: payload.title,
      ConditionID: payload.conditionId, PicURL: payload.photos.map(photo => photo.url).join('|'), Description: payload.description,
      Format: 'FixedPrice', Quantity: payload.quantity, Location: defaults.location, ReturnsAcceptedOption: defaults.returnsAcceptedOption,
      ReturnProfileName: defaults.returnProfileName, PaymentProfileName: defaults.paymentProfileName };
    return headers.map((header, index) => index === 0 ? 'Draft' : header === descriptorHeader ? payload.conditionDescriptorValue :
      technical(header).startsWith('C:') ? (payload.specifics[technical(header).slice(2)] ?? []).join('|') : values[technical(header)] ?? '');
  });
  const csv = V2_FULL_CATEGORY_INFO + '\r\n' + [headers, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
  return { csv, additionalSpecificHeaders, sourceHeaderSha256: sha256(JSON.stringify(template.headers)), outputHeaderSha256: sha256(JSON.stringify(headers)) };
}
/** Bind user-invisible trusted defaults to actual GetItem evidence, not arbitrary
 * UI strings. Price and shipping are deliberately absent from this contract. */
export async function buildV2FullTemplateDraftCsv(root: string, payloads: V2Payload[], raw: V2FullTemplateDraftOptions, at = Date.now()) {
  const options = v2FullTemplateDraftOptionsSchema.parse(raw), template = await readV2FullCategoryTemplate(root, options.template);
  const policy = JSON.parse((await fullTemplateEvidence(root, options.defaults.evidence, 1_000_000)).toString('utf8'));
  const age = Date.now() - Date.parse(policy.observedAt);
  if (policy.kind !== 'actual-seller-owned-background-policy-read' || policy.seller !== 'imaydit58' || !Number.isFinite(age) || age < 0 || age > 3600000 ||
      policy.returnsAcceptedOption !== options.defaults.returnsAcceptedOption || policy.policies?.returns !== 'No Return Accepted' ||
      policy.policies?.location !== options.defaults.location || policy.observedProfiles?.payment?.name !== options.defaults.paymentProfileName ||
      policy.observedProfiles?.returns?.name !== options.defaults.returnProfileName) throw Error('Actual fresh seller policy evidence does not bind CSV defaults');
  const exported = fullCategoryDraftCsv(payloads, template, options.defaults, at);
  const binding = v2FullTemplateBindingSchema.parse({ kind: 'actual-category-template-v1', categoryId: template.categoryId,
    metadataLine: V2_FULL_CATEGORY_INFO, template: options.template.template, receipt: options.template.receipt,
    policyEvidence: options.defaults.evidence, sourceHeaderSha256: exported.sourceHeaderSha256, outputHeaderSha256: exported.outputHeaderSha256,
    defaultsSha256: sha256(JSON.stringify(options.defaults)), additionalSpecificHeaders: exported.additionalSpecificHeaders });
  return { csv: exported.csv, binding };
}
