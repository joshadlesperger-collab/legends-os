import { identitySchema, type V2Identity, type V2State } from "./card-processing-v2.ts";

/** Verified flat definitions enrich independently observed cards. They never identify a
 * new capture, price it, transfer a physical serial, or establish its condition. */
export type VerifiedDefinitionReuse = {
  identity: V2Identity;
  enrichedFields: string[];
  source: {
    kind: "verified-card-definitions";
    definitions: Array<{ key: string; evidence: string; verifiedAt: string; photoHashes: string[] }>;
  };
};

const normalize = (value: string) => value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
const unknown = (value: string) => !normalize(value) || /^(?:unknown|unsure|uncertain|unreadable|illegible|unidentified|not known|not available|n\/a|na|none|null|undefined|\?+)$/.test(normalize(value));
const fields = ["name", "year", "manufacturer", "product", "number", "categoryId", "language", "variant", "artwork", "sportOrGame", "team"] as const;

// Deliberately small: only immutable product/card facts can transfer between
// exact variants. Condition, autograph, price, offers, serial and Features may
// depend on the physical copy and are never added from another capture.
const allowedFields: Record<V2Identity["categoryId"], readonly string[]> = {
  "183454": ["Card Type", "Rarity", "Finish", "Illustrator", "Stage", "HP", "Attribute/MTG:Color", "Creature/Monster Type", "Attack/Power", "Defense/Toughness", "Cost"],
  "261328": ["League"],
  "183050": ["Genre", "Movie", "TV Show", "Illustrator"],
};

function serialRun(serial: string): string | null {
  if (!serial.trim()) return "unnumbered";
  const match = /^(\d+)\s*\/\s*(\d+)$/.exec(serial.trim());
  if (!match) return null;
  const numerator = Number(match[1]), denominator = Number(match[2]);
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || numerator < 1 || denominator < numerator) return null;
  return `numbered:${denominator}`;
}

function eligible(identity: V2Identity): boolean {
  return !identity.graded && !identity.damage && serialRun(identity.serial) !== null
    && fields.every(field => field === "team" && !identity.team.trim() || !unknown(identity[field]));
}

function matching(left: V2Identity, right: V2Identity): boolean {
  return fields.every(field => normalize(left[field]) === normalize(right[field]))
    && serialRun(left.serial) === serialRun(right.serial);
}

function comparable(values: string[]): string | null {
  if (!values.length || values.some(unknown)) return null;
  return JSON.stringify(Array.from(new Set(values.map(normalize))).sort());
}

/** Detect contradictory identity specifics even when the listing exporter would
 * otherwise overwrite them with top-level identity fields. */
function coreSpecificsConsistent(i: V2Identity): boolean {
  const bound: Record<string, string[]> = {
    Manufacturer: [i.manufacturer], Set: [i.product], "Card Number": [i.number], Language: [i.language], Graded: ["No"],
    ...(i.categoryId === "261328" ? { Sport: [i.sportOrGame], "Player/Athlete": [i.name], Season: [i.year], ...(i.team ? { Team: [i.team] } : {}) }
      : { Character: [i.name], "Year Manufactured": [i.year], ...(i.categoryId === "183454" ? { Game: [i.sportOrGame] } : { Franchise: [i.sportOrGame] }) }),
    ...(i.variant !== "Base" ? { "Parallel/Variety": [i.variant] } : {}),
  };
  const byName = new Map(Object.entries(bound).map(([name, values]) => [normalize(name), comparable(values)]));
  return Object.entries(i.specifics).every(([name, values]) => !byName.has(normalize(name)) || comparable(values) === byName.get(normalize(name)));
}

/** Match only complete, independently observed core identity. Verified definition
 * dates retain their original provenance; the pricing freshness window does not
 * apply to immutable card facts. Conflicting definitions fail closed. */
export function findVerifiedDefinition(state: V2State, observedIdentity: V2Identity): VerifiedDefinitionReuse | null {
  const parsed = identitySchema.safeParse(observedIdentity);
  if (!parsed.success || !eligible(parsed.data) || !coreSpecificsConsistent(parsed.data)) return null;
  const observed = parsed.data;
  const allowed = new Map(allowedFields[observed.categoryId].map(name => [normalize(name), name]));
  const facts = new Map<string, { values: string[]; comparison: string }>();
  const definitions: VerifiedDefinitionReuse["source"]["definitions"] = [];

  for (const [key, entry] of Object.entries(state.knowledge).sort(([a], [b]) => a.localeCompare(b))) {
    const candidate = identitySchema.safeParse(entry.identity);
    if (!candidate.success || !eligible(candidate.data) || !matching(observed, candidate.data)) continue;
    // The repository contains saved/reopened readback provenance, not model-only findings.
    const at = Date.parse(entry.verifiedAt);
    if (!entry.evidence.trim() || !Number.isFinite(at) || at > Date.now()
      || entry.photoHashes.length !== 2 || new Set(entry.photoHashes).size !== 2
      || entry.photoHashes.some(hash => !/^[a-f0-9]{64}$/.test(hash))) continue;
    if (!coreSpecificsConsistent(candidate.data)) return null;

    let used = false;
    for (const [rawName, values] of Object.entries(candidate.data.specifics)) {
      const name = allowed.get(normalize(rawName));
      if (!name) continue;
      const comparison = comparable(values);
      if (comparison === null) continue;
      const existing = facts.get(name);
      if (existing && existing.comparison !== comparison) return null;
      if (!existing) facts.set(name, { values: [...values], comparison });
      used = true;
    }
    if (used) definitions.push({ key, evidence: entry.evidence, verifiedAt: entry.verifiedAt, photoHashes: [...entry.photoHashes] });
  }

  if (!facts.size) return null;
  const identity = structuredClone(observed);
  const enrichedFields: string[] = [];
  for (const [name, fact] of Array.from(facts.entries())) {
    const present = Object.entries(observed.specifics).filter(([rawName]) => normalize(rawName) === normalize(name));
    if (present.some(([, values]) => comparable(values) !== fact.comparison)) return null;
    if (!present.length) { identity.specifics[name] = [...fact.values]; enrichedFields.push(name); }
  }
  if (!enrichedFields.length) return null;
  return { identity, enrichedFields: enrichedFields.sort(), source: { kind: "verified-card-definitions", definitions } };
}
