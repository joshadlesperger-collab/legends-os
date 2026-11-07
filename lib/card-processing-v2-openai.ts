import { z } from "zod";
import { identificationSchema, identitySchema, type V2Identification } from "./card-processing-v2.ts";

// OpenAI strict structured outputs require closed object keys. Dynamic category
// names cross the provider boundary as closed {name, values} entries, then normalize.
const wireIdentity = identitySchema.omit({ specifics: true }).extend({
  specifics: z.array(z.object({ name: z.string().trim().min(1).max(200), values: z.array(z.string().trim().min(1).max(300)).min(1).max(20) }).strict()).max(80),
}).strict();
export const openAiIdentificationSchema = identificationSchema.omit({ identity: true }).extend({ identity: wireIdentity.nullable() }).strict();

export function normalizeOpenAiIdentification(raw: unknown): V2Identification {
  const finding = openAiIdentificationSchema.parse(raw);
  if (!finding.identity) return identificationSchema.parse(finding);
  const names = finding.identity.specifics.map(s => s.name.normalize("NFKC").toLowerCase());
  if (new Set(names).size !== names.length || finding.identity.specifics.some(s => ["__proto__", "prototype", "constructor"].includes(s.name.toLowerCase()))) throw Error("Conflicting or unsafe category-specific names require identity review.");
  return identificationSchema.parse({ ...finding, identity: { ...finding.identity, specifics: Object.fromEntries(finding.identity.specifics.map(s => [s.name, s.values])) } });
}
