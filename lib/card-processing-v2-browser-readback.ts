import { z } from "zod";
import { digest, payloadSchema, type V2Payload } from "./card-processing-v2.ts";
import { v2DraftPoliciesSchema, v2SavedDraftSchema, type V2SavedDraft } from "./card-processing-v2-draft-lifecycle.ts";
import { observedV2DraftId, observedV2PolicyName } from "./card-processing-v2-observation-values.ts";
import { canonicalV2ReturnPolicyName, validateV2PolicyCatalogBinding, v2PolicyCatalogBindingSchema, type V2VerifiedPolicyCatalog } from "./card-processing-v2-policy-bindings.ts";
type V2DraftPolicies = z.infer<typeof v2DraftPoliciesSchema>;

const referenceSchema = z.object({ path: z.string().min(1).max(300), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
/** Each value is obtained from an actual rendered editor control or visible
 * native UI node. A label, placeholder, expected value or suggestion is not an
 * input-value observation. Locator is a CSS/role locator or an AX node reference. */
export const v2ObservedEditorFieldSchema = z.object({
  locator: z.string().min(1).max(400), visible: z.boolean(),
  visibleBinding: z.object({ locator: z.string().min(1).max(400), label: z.string().min(1).max(20000) }).strict().optional(),
  readMethod: z.enum(["input-value", "selected-option-value", "selected-option-label", "checked-value", "inner-text", "rendered-image-src"]),
  value: z.string().max(20000),
}).strict().refine(f => f.visible || !!f.visibleBinding && ["input-value", "selected-option-value"].includes(f.readMethod), "A hidden form ID must be tied to its actual visible chosen label");
const field = v2ObservedEditorFieldSchema;
const policy = z.object({ label: field, id: field.optional(), options: z.array(field).min(1).max(200).optional(), catalogBinding: v2PolicyCatalogBindingSchema.optional() }).strict()
  .refine(p => !!p.id || !!p.catalogBinding && !!p.options, "A policy needs an actual control ID or separate uniquely matched catalog evidence");
export const v2DraftEditorObservationSchema = z.object({
  kind: z.literal("observed-reopened-ebay-draft-editor"),
  driver: z.enum(["playwright-visible-dom", "cua-observed-native"]),
  url: z.string().url(), observedAt: z.string().datetime(),
  seller: field, draftId: field,
  save: z.object({ status: field, savedAt: z.string().datetime(), reopenedAt: z.string().datetime(), basis: z.enum(["visible-last-saved-timestamp", "observed-saved-status-before-reopen"]) }).strict(),
  title: field, sku: field, categoryId: field, quantity: field,
  // Enumerate ALL item-specific controls/chips, including inherited identity
  // fields. Do not omit an unexpected value just because it was not requested.
  specificsComplete: z.literal(true),
  specifics: z.array(z.object({ name: field, values: z.array(field).max(50) }).strict()).max(300),
  condition: z.object({ id: field, label: field, descriptorId: field, descriptorName: field, valueId: field, valueName: field }).strict(),
  description: field,
  // DOM text cannot prove AI authorship. This is an independently retained
  // upload/review action receipt, not a claim inferred from the expected payload.
  descriptionProvenance: z.object({ source: z.enum(["factual", "ebay-ai-reviewed"]), evidence: referenceSchema }).strict(),
  itemPrice: field, shippingAmount: field,
  policies: z.object({ payment: policy, returns: policy, shipping: policy, location: field }).strict(),
  photosComplete: z.literal(true),
  photos: z.array(z.object({ url: field, renderOrder: z.number().int().nonnegative(), uprightObserved: z.literal(true), visualEvidence: referenceSchema,
    orientation: z.object({ source: z.enum(["rendered-visual-review", "bound-hosted-original-review"]), originalHash: z.string().regex(/^[a-f0-9]{64}$/), resourceId: z.string().min(1).max(300), evidence: referenceSchema }).strict(),
  }).strict()).length(2),
  issueSummaryObserved: z.literal(true), editorErrors: z.array(field).max(100),
}).strict();
export type V2DraftEditorObservation = z.infer<typeof v2DraftEditorObservationSchema>;
export type V2SavedDraftBrowserDriver = {
  kind: V2DraftEditorObservation["driver"];
  /** Reopen/read this existing ID in a dedicated signed-in seller browser. The
   * driver receives no expected listing values, cookies or private API request.
   * Implementations must observe actual controls after reopening has finished. */
  readReopenedDraft(draftId: string): Promise<unknown>;
};
export type V2BrowserReadbackContext = {
  draftId: string; expected: V2Payload; requiredAspects: string[]; expectedPolicies?: V2DraftPolicies;
  expectedPolicyIds?: { payment: string; returns: string; shipping: string | null };
  policyCatalog?: V2VerifiedPolicyCatalog;
};
export type V2BrowserReadbackResult = {
  readback: Omit<V2SavedDraft, "evidence">;
  observation: V2DraftEditorObservation;
  photoBindings: Array<{ renderedUrl: string; resourceId: string; originalHash: string; hostedUrl: string }>;
};
export class V2BrowserReadbackError extends Error {
  readonly code: string;
  readonly observation?: V2DraftEditorObservation;
  constructor(code: string, message: string, observation?: V2DraftEditorObservation) { super(message); this.code = code; this.observation = observation; }
}
const normalized = (value: string) => value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
const numeric = (value: string) => /^\d+$/.test(value);

/** Only this known EPS resource path is normalized. Thumbnail size, extension
 * and harmless query strings may vary; another host, path or image ID cannot. */
export function normalizedEbayImageResource(value: string): string | null {
  let url: URL; try { url = new URL(value); } catch { return null; }
  if (url.protocol !== "https:" || url.hostname !== "i.ebayimg.com" || url.port || url.username || url.password || url.hash) return null;
  const match = /^\/images\/g\/([A-Za-z0-9_~=-]+)\/s-l\d+\.(?:jpe?g|png|webp)$/i.exec(url.pathname);
  return match?.[1] ?? null;
}
function fieldValue(value: z.infer<typeof field>) { return value.value.trim(); }
function policyLabel(value: z.infer<typeof policy>, optional: boolean, type: "payment" | "returns" | "shipping", context: V2BrowserReadbackContext): string | null {
  const label = observedV2PolicyName(fieldValue(value.label)), expectedId = context.expectedPolicyIds?.[type]; let id = value.id ? fieldValue(value.id) : "";
  if (!value.label.visible || !["selected-option-label", "inner-text"].includes(value.label.readMethod)) throw Error("Read actual selected policy controls.");
  if (value.id && !["selected-option-value", "input-value"].includes(value.id.readMethod)) throw Error("The actual numeric control ID needs independent value provenance.");
  if (value.catalogBinding) {
    const options = value.options ?? []; if (options.some(option => !option.visible || !["selected-option-label", "inner-text"].includes(option.readMethod))) throw Error("Read the actual visible policy options before catalog binding.");
    const catalogId = validateV2PolicyCatalogBinding(context.policyCatalog, value.catalogBinding, type, fieldValue(value.label), options.map(fieldValue));
    if (id && id !== catalogId) throw Error("Actual control value contradicts the separately matched catalog ID");
    id = catalogId;
  }
  if (!label && !id && optional && (expectedId === undefined || expectedId === null)) return null;
  if (!label || !numeric(id)) throw Error("An independently selected policy label and numeric ID are required.");
  if (expectedId !== undefined && (!expectedId || !numeric(expectedId) || expectedId !== id)) throw Error("The actual selected policy ID differs from its independently bound expected ID.");
  const embeddedId = /\((\d+)\)$/.exec(label)?.[1];
  if (embeddedId && embeddedId !== id) throw Error("The selected policy label and selected control ID contradict each other.");
  return type === "returns" ? canonicalV2ReturnPolicyName(context.policyCatalog, label, id) : label;
}
function shipping(value: z.infer<typeof field>): number | null {
  if (value.readMethod !== "input-value") throw Error("Read the actual shipping input value, not its label or suggestion.");
  const text = fieldValue(value); if (!text) return null;
  if (!/^\d+(?:\.\d{1,2})?$/.test(text) || !Number.isFinite(Number(text))) throw Error("Shipping must be an observed decimal amount or an actually blank unresolved input.");
  return Number(text);
}
const identityAspects = new Set(["sport", "game", "franchise", "player", "player/athlete", "athlete", "character", "card name", "team", "season", "year", "year manufactured", "manufacturer", "brand", "set", "product", "card number", "parallel", "parallel/variety", "variety", "language", "graded", "grade", "professional grader", "autographed", "features"]);

/** Parse observed controls first, then compare. Expected fields never populate
 * title, specifics, condition, quantity, description, policies or monetary inputs.
 * Capture IDs and photo hash/expiry attribution are bound only after observed
 * SKU/quantity and exact EPS image identity/order match their frozen manifest. */
export function parseV2DraftEditorReadback(raw: unknown, context: V2BrowserReadbackContext): V2BrowserReadbackResult {
  const parsed = v2DraftEditorObservationSchema.safeParse(raw);
  if (!parsed.success) throw new V2BrowserReadbackError("UNSUPPORTED_EDITOR", "The saved editor observation is incomplete or unsupported; no verification was produced.");
  const observation = parsed.data;
  const fail = (code: string, message: string): never => { throw new V2BrowserReadbackError(code, message, observation); };
  const expected = payloadSchema.parse(context.expected);
  if (!/^\d+$/.test(context.draftId)) fail("DRAFT_MISMATCH", "An exact existing draft ID is required.");
  if (observedV2DraftId(observation.url) !== context.draftId || fieldValue(observation.draftId) !== context.draftId) fail("DRAFT_MISMATCH", "Observed editor URL and draft control must identify the same existing draft.");
  if (fieldValue(observation.seller) !== "imaydit58") fail("SELLER_MISMATCH", "The signed-in seller must be observed as imaydit58 in this editor session.");
  const observedAt = Date.parse(observation.observedAt), reopenedAt = Date.parse(observation.save.reopenedAt), savedAt = Date.parse(observation.save.savedAt);
  if (observedAt > Date.now() || Date.now() - observedAt > 3600000 || savedAt > reopenedAt || reopenedAt > observedAt
    || observedAt - savedAt > 3600000 || !["saved", "draft saved"].includes(normalized(fieldValue(observation.save.status)))) fail("REOPEN_REQUIRED", "A fresh actual save and same-ID reopen must precede the editor readback.");
  if ([observation.title, observation.sku, observation.quantity, observation.itemPrice].some(f => !f.visible || f.readMethod !== "input-value")) fail("UNSUPPORTED_EDITOR", "Read actual visible title, SKU, quantity and price input values; placeholders and visible suggestions cannot substitute.");
  const title = observation.title.value, sku = observation.sku.value, categoryId = fieldValue(observation.categoryId), quantityValue = fieldValue(observation.quantity);
  if (title !== expected.title || sku !== expected.sku || categoryId !== expected.categoryId || !/^[1-9]\d*$/.test(quantityValue)
    || Number(quantityValue) !== expected.quantity || Number(quantityValue) !== expected.captureIds.length) fail("FIELDS_MISMATCH", "Saved title, SKU, category or physical-copy quantity differs from the frozen handoff.");
  if (observation.itemPrice.value.trim() !== "") fail("PRICE_NOT_BLANK", "The actual saved item-price input is not blank. Preserve its value and route pricing provenance to reconciliation; do not clear or reprice it to pass unpriced verification. Nonprice review may continue separately on the same draft ID.");

  const specifics: Record<string, string[]> = {};
  const actualNames = new Set<string>();
  for (const specific of observation.specifics) {
    const name = fieldValue(specific.name), key = normalized(name);
    if (!name || actualNames.has(key)) fail("SPECIFICS_MISMATCH", "Saved specifics have missing or ambiguous duplicate names.");
    actualNames.add(key);
    const values = specific.values.map(fieldValue).filter(Boolean);
    if (values.length) specifics[name] = values;
  }
  for (const required of Array.from(new Set([...context.requiredAspects, ...Object.keys(expected.specifics)]))) {
    if (!specifics[required]?.length) fail("SPECIFICS_MISMATCH", "A required or expected item specific is absent from the actual saved controls.");
  }
  for (const [name, values] of Object.entries(specifics)) {
    if (!expected.specifics[name]) {
      if (identityAspects.has(normalized(name))) fail("SPECIFICS_MISMATCH", "An unexpected inherited identity field remains in the actual saved draft.");
      fail("SPECIFICS_MISMATCH", "An additional saved item specific needs reconciliation with the frozen handoff.");
    }
    if (digest(values) !== digest(expected.specifics[name])) fail("SPECIFICS_MISMATCH", "Actual saved item-specific values contradict the frozen identity handoff.");
  }

  const condition = observation.condition, conditionId = fieldValue(condition.id), descriptorId = fieldValue(condition.descriptorId), valueId = fieldValue(condition.valueId);
  if ([condition.id, condition.descriptorId, condition.valueId].some(f => !["selected-option-value", "input-value"].includes(f.readMethod))
    || [condition.label, condition.descriptorName, condition.valueName].some(f => !["selected-option-label", "inner-text"].includes(f.readMethod))) fail("CONDITION_MISMATCH", "Condition labels and IDs must come from actual selected editor controls.");
  if (![conditionId, descriptorId, valueId].every(numeric) || normalized(fieldValue(condition.label)) !== "ungraded"
    || normalized(fieldValue(condition.valueName)) !== "near mint or better") fail("CONDITION_MISMATCH", "Read the actual supported Ungraded and Near mint condition selection with its descriptor IDs.");
  const conditionDescriptorName = `${fieldValue(condition.descriptorName)} - (ID: ${descriptorId})`;
  const conditionDescriptorValue = `${fieldValue(condition.valueName)} - (ID: ${valueId})`;
  if (conditionId !== expected.conditionId || conditionDescriptorName !== expected.conditionDescriptorName || conditionDescriptorValue !== expected.conditionDescriptorValue) fail("CONDITION_MISMATCH", "The actual saved condition descriptor differs from the verified category template.");
  const description = observation.description.value.trim(), descriptionSource = observation.descriptionProvenance.source;
  if (!description || /<[^>]*>/.test(description) || description !== expected.description || descriptionSource !== expected.descriptionSource) fail("DESCRIPTION_MISMATCH", "The actual saved description and independently retained generation/review provenance must match the handoff.");

  const photos = [...observation.photos].sort((a, b) => a.renderOrder - b.renderOrder);
  if (photos[0].renderOrder !== 0 || photos[1].renderOrder !== 1 || photos.some(p => p.url.readMethod !== "rendered-image-src")) fail("PHOTOS_MISMATCH", "Two actual rendered photos in known front/back order are required.");
  const expectedResources = expected.photos.map(p => normalizedEbayImageResource(p.url));
  if (expectedResources.some(id => !id) || new Set(expectedResources).size !== 2 || new Set(expected.photos.map(p => p.hash)).size !== 2) fail("PHOTOS_MISMATCH", "The frozen media manifest does not bind two distinct supported eBay image resources.");
  const photoBindings = photos.map((photo, index) => {
    const renderedUrl = fieldValue(photo.url), resourceId = normalizedEbayImageResource(renderedUrl);
    if (!resourceId) return fail("PHOTOS_MISMATCH", "The actual rendered photo resource is not supported.");
    if (resourceId !== expectedResources[index]) fail("PHOTOS_MISMATCH", "The actual rendered photo resource or front/back order differs from the exact original media mapping.");
    if (photo.orientation.resourceId !== resourceId || photo.orientation.originalHash !== expected.photos[index].hash) fail("PHOTOS_MISMATCH", "Photo orientation provenance is not bound to the actual rendered EPS resource and original hash.");
    return { renderedUrl, resourceId, originalHash: expected.photos[index].hash, hostedUrl: expected.photos[index].url };
  });

  let policies: V2DraftPolicies, savedShippingAmount: number | null;
  try {
    savedShippingAmount = shipping(observation.shippingAmount);
    policies = v2DraftPoliciesSchema.parse({ payment: policyLabel(observation.policies.payment, false, "payment", context), returns: policyLabel(observation.policies.returns, false, "returns", context),
      shipping: policyLabel(observation.policies.shipping, true, "shipping", context), location: fieldValue(observation.policies.location), pricingShippingUnresolved: true });
  } catch { fail("POLICIES_MISMATCH", "Actual selected policy labels/IDs, seller location and shipping input must be independently observed and supported."); }
  if (context.expectedPolicies && digest(policies!) !== digest(v2DraftPoliciesSchema.parse(context.expectedPolicies))) fail("POLICIES_MISMATCH", "The actual saved policy bindings or location differ from the fresh seller-established handoff.");
  const payload = payloadSchema.parse({ sku, captureIds: [...expected.captureIds], title, categoryId, specifics, quantity: Number(quantityValue),
    photos: photoBindings.map((binding, index) => ({ hash: binding.originalHash, url: binding.hostedUrl, expiresAt: expected.photos[index].expiresAt, upright: true })),
    conditionId, conditionDescriptorName, conditionDescriptorValue, condition: "Near mint or better", description, descriptionSource, pricing: "unpriced-grok-pending" });
  const readback = v2SavedDraftSchema.omit({ evidence: true }).parse({ kind: "saved-reopened-ebay-draft", seller: fieldValue(observation.seller), draftId: fieldValue(observation.draftId),
    url: observation.url, observedAt: observation.observedAt, payload, policies: policies!, savedItemPrice: null, savedShippingAmount: savedShippingAmount!, editorErrors: observation.editorErrors.map(fieldValue).filter(Boolean) });
  return { readback, observation, photoBindings };
}

export async function readV2SavedDraftFromBrowser(driver: V2SavedDraftBrowserDriver | undefined, context: V2BrowserReadbackContext): Promise<V2BrowserReadbackResult> {
  if (!driver) throw new V2BrowserReadbackError("DRIVER_UNAVAILABLE", "A dedicated signed-in editor readback adapter is not connected. No eBay verification was produced.");
  const raw = await driver.readReopenedDraft(context.draftId);
  const result = parseV2DraftEditorReadback(raw, context);
  if (result.observation.driver !== driver.kind) throw new V2BrowserReadbackError("UNSUPPORTED_EDITOR", "Editor observation provenance does not match the connected browser adapter.", result.observation);
  return result;
}

/** Root persists readback (without evidence) and the independent observation as
 * separate hash-bound artifacts, then attaches this exact readback-file reference.
 * The lifecycle verifier re-reads that artifact; this helper writes nothing. */
export function attachV2SavedDraftEvidence(readback: V2BrowserReadbackResult["readback"], evidence: z.infer<typeof referenceSchema>): V2SavedDraft {
  return v2SavedDraftSchema.parse({ ...readback, evidence: referenceSchema.parse(evidence) });
}
