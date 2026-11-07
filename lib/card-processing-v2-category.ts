import { createHash } from "node:crypto";
import { z } from "zod";
import { categorySchema, type V2Category, type V2Identity } from "./card-processing-v2.ts";

export const V2_CATEGORY_IDS = ["183454", "261328", "183050"] as const;
export const V2_CATEGORY_METADATA_DOCS = {
  conditions: "https://developer.ebay.com/api-docs/master/sell/metadata/openapi/3/sell_metadata_v1_oas3.json",
  aspects: "https://developer.ebay.com/api-docs/commerce/taxonomy/resources/category_tree/methods/getItemAspectsForCategory",
};
type CategoryId = V2Identity["categoryId"];
const text = z.string().trim().min(1).max(300);
const numericId = z.string().regex(/^\d+$/);
const normalize = (value: string) => value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
const resourceSchema = z.object({ categoryTreeId: numericId, categoryTreeVersion: z.string().optional() }).passthrough();
const aspectSchema = z.object({
  localizedAspectName: text,
  aspectConstraint: z.object({ aspectRequired: z.boolean(), aspectMode: z.enum(["FREE_TEXT", "SELECTION_ONLY"]).optional() }).passthrough(),
  aspectValues: z.array(z.object({ localizedValue: text }).passthrough()).max(20000).optional(),
}).passthrough();
const aspectsSchema = z.object({ aspects: z.array(z.preprocess(raw => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const aspect = raw as Record<string, unknown>, constraint = aspect.aspectConstraint;
  // FREE_TEXT suggestions are advisory and never become an exclusive allowed
  // list. Real sports metadata supplies 29,797 player suggestions; don't reject
  // a usable category or parse that unused catalogue. The bounded raw response
  // remains in acquisition evidence. Selection-only values retain strict limits.
  if (constraint && typeof constraint === "object" && !Array.isArray(constraint)
    && (constraint as Record<string, unknown>).aspectMode === "FREE_TEXT"
    && (aspect.aspectValues === undefined || Array.isArray(aspect.aspectValues))) return { ...aspect, aspectValues: undefined };
  return raw;
}, aspectSchema)).min(1).max(300) }).passthrough();
const descriptorSchema = z.object({
  conditionDescriptorId: numericId, conditionDescriptorName: text,
  conditionDescriptorHelpText: z.string().max(10000).optional(),
  conditionDescriptorConstraint: z.object({
    usage: z.string().optional(), mode: z.string().optional(), cardinality: z.string().optional(),
    applicableToConditionDescriptorIds: z.array(numericId).optional(),
  }).passthrough().optional(),
  conditionDescriptorValues: z.array(z.object({
    conditionDescriptorValueId: numericId, conditionDescriptorValueName: text,
    conditionDescriptorValueHelpText: z.string().max(10000).optional(),
    conditionDescriptorValueConstraints: z.array(z.object({
      applicableToConditionDescriptorId: numericId.optional(), applicableToConditionDescriptorValueIds: z.array(numericId).optional(),
    }).passthrough()).optional(),
  }).passthrough()).max(5000).optional(),
}).passthrough();
const policiesSchema = z.object({
  itemConditionPolicies: z.array(z.object({
    categoryId: numericId, categoryTreeId: numericId, itemConditionRequired: z.boolean(),
    itemConditions: z.array(z.object({
      conditionId: numericId, conditionDescription: text, conditionHelpText: z.string().max(10000).optional(),
      usage: z.string().optional(), conditionDescriptors: z.array(descriptorSchema).max(100).optional(),
    }).passthrough()).max(100),
  }).passthrough()).max(50),
  warnings: z.array(z.unknown()).optional(),
}).passthrough();

export type V2CategoryMetadataEvidence = {
  resource: "category-tree" | "category-aspects" | "condition-policies";
  url: string; observedAt: string; sha256: string; body: unknown;
};
export type V2CategoryCapability = {
  categoryId: CategoryId; status: "ready" | "blocked"; detail: string;
  conditionHelpText?: string; descriptorId?: string; descriptorValueId?: string;
  diagnostic?: { phase: "category-aspects"; code: "READ_FAILED" | "SCHEMA_INVALID" | "UNSUPPORTED_CONTRACT"; httpStatus?: number; paths?: string[] };
};
export type V2CategoryAcquisition = {
  observedAt: string; categories: V2Category[]; capabilities: V2CategoryCapability[];
  evidence: V2CategoryMetadataEvidence[];
};
export class V2CategoryReadError extends Error {
  readonly httpStatus: number | null;
  constructor(httpStatus: number | null) { super(httpStatus === null ? "eBay metadata read failed safely." : `eBay metadata read returned HTTP ${httpStatus}.`); this.httpStatus = httpStatus; }
}

/** Read only bounded official metadata. No user-supplied URL, implicit redirect,
 * automatic retry, token persistence or external mutation is supported. */
async function readMetadata(url: string, token: string, fetcher: typeof fetch, resource: V2CategoryMetadataEvidence["resource"]): Promise<V2CategoryMetadataEvidence> {
  let response: Response;
  try { response = await fetcher(url, { method: "GET", headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Accept-Language": "en-US", "X-EBAY-C-MARKETPLACE-ID": "EBAY_US" }, redirect: "error", signal: AbortSignal.timeout(30000) }); }
  catch { throw new V2CategoryReadError(null); }
  if (!response.ok) throw new V2CategoryReadError(response.status);
  const maximum = 8_000_000;
  if (Number(response.headers.get("content-length") || 0) > maximum || !response.body) throw new V2CategoryReadError(null);
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) { const next = await reader.read(); if (next.done) break; length += next.value.byteLength; if (length > maximum) { await reader.cancel(); throw new V2CategoryReadError(null); } chunks.push(next.value); }
  } catch { throw new V2CategoryReadError(null); } finally { reader.releaseLock(); }
  const bytes = Buffer.concat(chunks);
  let body: unknown;
  try { body = JSON.parse(bytes.toString("utf8")); } catch { throw new V2CategoryReadError(null); }
  return { resource, url, observedAt: new Date().toISOString(), sha256: createHash("sha256").update(bytes).digest("hex"), body };
}

/** Adapt exact official metadata to V2's single raw-card condition contract.
 * Unsupported dependencies or extra required descriptors are held, never guessed. */
export function categoryFromMetadata(categoryId: CategoryId, treeId: string, aspectsInput: unknown, policiesInput: unknown, observedAt: string): { category: V2Category; capability: V2CategoryCapability } {
  if (!V2_CATEGORY_IDS.includes(categoryId) || !/^\d+$/.test(treeId) || !Number.isFinite(Date.parse(observedAt)) || Date.parse(observedAt) > Date.now()) throw Error("Invalid metadata observation binding.");
  const aspects = aspectsSchema.parse(aspectsInput).aspects, policies = policiesSchema.parse(policiesInput);
  if (new Set(aspects.map(a => normalize(a.localizedAspectName))).size !== aspects.length) throw Error("Category metadata has ambiguous duplicate aspect names.");
  const matchingPolicies = policies.itemConditionPolicies.filter(p => p.categoryId === categoryId && p.categoryTreeId === treeId);
  if (matchingPolicies.length !== 1) throw Error("Exact category condition policy was not returned uniquely.");
  const raw = matchingPolicies[0].itemConditions.filter(c => normalize(c.conditionDescription) === "ungraded" && c.usage !== "RESTRICTED");
  if (raw.length !== 1) throw Error("A unique unrestricted Ungraded condition is required.");
  const descriptors = raw[0].conditionDescriptors ?? [];
  const matches = descriptors.filter(d => normalize(d.conditionDescriptorName) === "card condition");
  if (matches.length !== 1) throw Error("A unique Card Condition descriptor is required.");
  const descriptor = matches[0], constraints = descriptor.conditionDescriptorConstraint;
  if (constraints?.mode && constraints.mode !== "SELECTION_ONLY" || constraints?.cardinality && constraints.cardinality !== "SINGLE"
    || constraints?.applicableToConditionDescriptorIds?.length
    || descriptors.some(d => d !== descriptor && d.conditionDescriptorConstraint?.usage === "REQUIRED")) throw Error("Raw condition requires unsupported additional fields or descriptor dependencies.");
  const values = (descriptor.conditionDescriptorValues ?? []).filter(v => normalize(v.conditionDescriptorValueName) === "near mint or better");
  if (values.length !== 1 || values[0].conditionDescriptorValueConstraints?.some(c => c.applicableToConditionDescriptorId || c.applicableToConditionDescriptorValueIds?.length)) throw Error("A unique independent Near mint or better descriptor value is required.");
  const value = values[0], requiredAspects = aspects.filter(a => a.aspectConstraint.aspectRequired).map(a => a.localizedAspectName);
  if (!requiredAspects.length) throw Error("Category response did not establish required item specifics.");
  const allowedValues: Record<string, string[]> = {};
  for (const aspect of aspects) {
    // Suggested FREE_TEXT values are not an exclusive allowed list.
    if (aspect.aspectConstraint.aspectMode !== "SELECTION_ONLY") continue;
    const supported = Array.from(new Set((aspect.aspectValues ?? []).map(v => v.localizedValue)));
    if (aspect.aspectConstraint.aspectRequired && !supported.length) throw Error("Required selection-only aspect has no supported values.");
    if (supported.length) allowedValues[aspect.localizedAspectName] = supported;
  }
  const category = categorySchema.parse({ categoryId, source: "Live eBay US Taxonomy and Metadata APIs", observedAt,
    requiredAspects, allowedValues, conditionId: raw[0].conditionId,
    conditionDescriptorName: `${descriptor.conditionDescriptorName} - (ID: ${descriptor.conditionDescriptorId})`,
    conditionDescriptorValue: `${value.conditionDescriptorValueName} - (ID: ${value.conditionDescriptorValueId})`, conditionLabel: "Near mint or better" });
  return { category, capability: { categoryId, status: "ready", detail: "Current category specifics and raw Near mint condition were read from eBay.",
    conditionHelpText: value.conditionDescriptorValueHelpText || raw[0].conditionHelpText,
    descriptorId: descriptor.conditionDescriptorId, descriptorValueId: value.conditionDescriptorValueId } };
}

/** One fresh tree read, one category-scoped conditions read, and at most one
 * aspects read per requested category. A bad category does not erase good ones. */
export async function fetchV2Categories(accessToken: string, categoryIds: readonly CategoryId[] = V2_CATEGORY_IDS, options: { fetcher?: typeof fetch } = {}): Promise<V2CategoryAcquisition> {
  const ids = Array.from(new Set(categoryIds));
  if (!accessToken.trim() || !ids.length || ids.length > 3 || ids.some(id => !V2_CATEGORY_IDS.includes(id))) throw Error("A supported seller token and one to three exact V2 categories are required.");
  const fetcher = options.fetcher ?? fetch;
  const result: V2CategoryAcquisition = { observedAt: new Date().toISOString(), categories: [], capabilities: [], evidence: [] };
  let tree: z.infer<typeof resourceSchema>, policies: V2CategoryMetadataEvidence;
  try {
    const treeEvidence = await readMetadata("https://api.ebay.com/commerce/taxonomy/v1/get_default_category_tree_id?marketplace_id=EBAY_US", accessToken, fetcher, "category-tree");
    tree = resourceSchema.parse(treeEvidence.body); result.evidence.push(treeEvidence);
    policies = await readMetadata(`https://api.ebay.com/sell/metadata/v1/marketplace/EBAY_US/get_item_condition_policies?filter=${encodeURIComponent(`categoryIds:{${ids.join("|")}}`)}`, accessToken, fetcher, "condition-policies");
    result.evidence.push(policies); policiesSchema.parse(policies.body);
  } catch (error) {
    const detail = error instanceof V2CategoryReadError && [401, 403].includes(error.httpStatus ?? 0)
      ? "Seller OAuth cannot read category metadata. Restore the supported seller connection; no listing changed."
      : "Current eBay category/condition metadata could not be read and validated. No condition IDs were inferred.";
    result.capabilities = ids.map(categoryId => ({ categoryId, status: "blocked", detail })); return result;
  }
  const reads = await Promise.all(ids.map(async categoryId => {
    let evidence: V2CategoryMetadataEvidence | undefined;
    try {
      evidence = await readMetadata(`https://api.ebay.com/commerce/taxonomy/v1/category_tree/${encodeURIComponent(tree.categoryTreeId)}/get_item_aspects_for_category?category_id=${categoryId}`, accessToken, fetcher, "category-aspects");
      return { evidence, prepared: categoryFromMetadata(categoryId, tree.categoryTreeId, evidence.body, policies.body, evidence.observedAt) };
    } catch (error) {
      const diagnostic: NonNullable<V2CategoryCapability["diagnostic"]> = error instanceof V2CategoryReadError
        ? { phase: "category-aspects", code: "READ_FAILED", ...(error.httpStatus !== null ? { httpStatus: error.httpStatus } : {}) }
        : error instanceof z.ZodError ? { phase: "category-aspects", code: "SCHEMA_INVALID", paths: error.issues.slice(0, 20).map(issue => issue.path.join(".")) }
          : { phase: "category-aspects", code: "UNSUPPORTED_CONTRACT" };
      return { evidence, failure: { categoryId, status: "blocked" as const, detail: "Exact category specifics or supported raw condition could not be validated. Other categories remain available.", diagnostic } };
    }
  }));
  for (const read of reads) {
    if (read.evidence) result.evidence.push(read.evidence);
    if (read.prepared) { result.categories.push(read.prepared.category); result.capabilities.push(read.prepared.capability); }
    else if (read.failure) result.capabilities.push(read.failure);
  }
  result.observedAt = new Date().toISOString(); return result;
}
