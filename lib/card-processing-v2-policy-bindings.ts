import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { digest } from "./card-processing-v2.ts";
import { observedV2PolicyName } from "./card-processing-v2-observation-values.ts";

const text = z.string().trim().min(1).max(500), hash = z.string().regex(/^[a-f0-9]{64}$/);
const reference = z.object({ path: text, sha256: hash }).strict();
const id = z.union([z.string().regex(/^\d+$/), z.number().int().positive().safe()]).transform(String);
const catalogSchema = z.object({ at: z.string().datetime(), source: z.literal("fresh seller-owned active item read for established policy/location only"), itemId: z.string().regex(/^\d+$/), seller: z.literal("imaydit58"), location: text, country: z.literal("US"), returnPolicy: text,
  policies: z.object({ SellerShippingProfile: z.object({ ShippingProfileID: id, ShippingProfileName: text }).strict(),
    SellerReturnProfile: z.object({ ReturnProfileID: id, ReturnProfileName: text }).strict(),
    SellerPaymentProfile: z.object({ PaymentProfileID: id, PaymentProfileName: text }).strict(),
  }).strict(),
}).strict();
export const v2PolicyCatalogBindingSchema = z.object({ source: z.literal("fresh-seller-catalog-by-unique-visible-name"), seller: z.literal("imaydit58"), type: z.enum(["payment", "returns", "shipping"]),
  policyId: z.string().regex(/^\d+$/), policyName: text, observedAt: z.string().datetime(), evidence: reference, selectedLabelHash: hash, optionNamesHash: hash,
}).strict();
type Kind = "payment" | "returns" | "shipping";
export type V2PolicyCatalogBinding = z.infer<typeof v2PolicyCatalogBindingSchema>;
export type V2VerifiedPolicyCatalog = { seller: "imaydit58"; observedAt: string; itemId: string; location: string; returnPolicy: string;
  evidence: z.infer<typeof reference>; profiles: Record<Kind, { id: string; name: string }> };
const verified = new WeakSet<object>();
function fresh(at: string) { const age = Date.now() - Date.parse(at); if (!Number.isFinite(age) || age < 0 || age > 3600000) throw Error("Fresh seller policy evidence within sixty minutes is required"); }
function assertVerified(catalog: V2VerifiedPolicyCatalog) { if (!verified.has(catalog)) throw Error("Policy IDs require a hash-validated seller catalog, not expected values"); fresh(catalog.observedAt); }

/** Reads only an exact retained seller-owned GetItem policy observation. The
 * returned IDs are catalog evidence; they never become invented DOM values. */
export async function loadV2PolicyCatalog(root: string, rawReference: unknown): Promise<V2VerifiedPolicyCatalog> {
  const proof = reference.parse(rawReference);
  if (path.isAbsolute(proof.path) || proof.path.split(/[\\/]/).includes("..")) throw Error("Policy catalog evidence must remain under artifacts");
  const base = await fs.realpath(path.join(root, "artifacts")), file = await fs.realpath(path.join(root, proof.path)), relative = path.relative(base, file);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw Error("Policy catalog evidence must remain under artifacts");
  const stat = await fs.stat(file); if (!stat.isFile() || stat.size > 1000000) throw Error("Policy catalog evidence exceeds its bounded size");
  const bytes = await fs.readFile(file); if (createHash("sha256").update(bytes).digest("hex") !== proof.sha256) throw Error("Policy catalog evidence changed");
  const parsed = catalogSchema.parse(JSON.parse(bytes.toString("utf8"))); fresh(parsed.at);
  const profiles = { payment: Object.freeze({ id: parsed.policies.SellerPaymentProfile.PaymentProfileID, name: parsed.policies.SellerPaymentProfile.PaymentProfileName }),
    returns: Object.freeze({ id: parsed.policies.SellerReturnProfile.ReturnProfileID, name: parsed.policies.SellerReturnProfile.ReturnProfileName }),
    shipping: Object.freeze({ id: parsed.policies.SellerShippingProfile.ShippingProfileID, name: parsed.policies.SellerShippingProfile.ShippingProfileName }) };
  const result = Object.freeze({ seller: parsed.seller, observedAt: parsed.at, itemId: parsed.itemId, location: parsed.location, returnPolicy: parsed.returnPolicy, evidence: Object.freeze(proof), profiles: Object.freeze(profiles) });
  verified.add(result); return result;
}

export function bindV2PolicyFromCatalog(catalog: V2VerifiedPolicyCatalog, type: Kind, selectedLabel: string, allVisibleOptionLabels: readonly string[]): V2PolicyCatalogBinding {
  assertVerified(catalog); const profile = catalog.profiles[type], name = observedV2PolicyName(selectedLabel);
  if (!allVisibleOptionLabels.length || allVisibleOptionLabels.length > 200 || name !== profile.name || allVisibleOptionLabels.map(observedV2PolicyName).filter(option => option === name).length !== 1) throw Error("The actual selected policy must uniquely match the fresh catalog profile name");
  const embeddedId = /\((\d+)\)$/.exec(name)?.[1]; if (embeddedId && embeddedId !== profile.id) throw Error("Catalog policy name and ID contradict each other");
  return v2PolicyCatalogBindingSchema.parse({ source: "fresh-seller-catalog-by-unique-visible-name", seller: catalog.seller, type, policyId: profile.id, policyName: profile.name,
    observedAt: catalog.observedAt, evidence: catalog.evidence, selectedLabelHash: digest(selectedLabel.trim()), optionNamesHash: digest(allVisibleOptionLabels.map(observedV2PolicyName).sort()) });
}

export function validateV2PolicyCatalogBinding(catalog: V2VerifiedPolicyCatalog | undefined, raw: V2PolicyCatalogBinding, type: Kind, label: string, options: readonly string[]) {
  if (!catalog) throw Error("A separately validated fresh policy catalog is required");
  const expected = bindV2PolicyFromCatalog(catalog, type, label, options);
  if (digest(v2PolicyCatalogBindingSchema.parse(raw)) !== digest(expected)) throw Error("Policy catalog binding does not match the actual selected option and source");
  return expected.policyId;
}

/** This alias is deliberately seller-policy-specific, not generic removal of
 * parenthesized IDs. All raw labels and catalog provenance remain retained. */
export function canonicalV2ReturnPolicyName(catalog: V2VerifiedPolicyCatalog | undefined, label: string, policyId: string) {
  if (label === "No Return Accepted") return label;
  if (!catalog) throw Error("The suffixed return policy requires fresh seller catalog evidence");
  assertVerified(catalog);
  if (policyId !== "248164940010" || catalog.profiles.returns.id !== policyId || catalog.profiles.returns.name !== label || label !== "No Return Accepted (248164940010)" || catalog.returnPolicy !== "ReturnsNotAccepted") throw Error("Return policy is not the exact verified no-return binding");
  return "No Return Accepted";
}
