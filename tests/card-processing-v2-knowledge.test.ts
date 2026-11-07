import test from "node:test";
import assert from "node:assert/strict";
import { emptyV2State, type V2Identity, type V2State } from "../lib/card-processing-v2.ts";
import { findVerifiedDefinition } from "../lib/card-processing-v2-knowledge.ts";

const hash = (letter: string) => letter.repeat(64);
const at = "2026-10-30T00:00:00.000Z";
function identity(overrides: Partial<V2Identity> = {}): V2Identity {
  return { name: "Pikachu", year: "2025", manufacturer: "Pokemon", product: "Journey Together", number: "35", categoryId: "183454",
    language: "English", variant: "Base", artwork: "Pikachu standing with blue sky", sportOrGame: "Pokemon TCG", team: "", serial: "",
    graded: false, damage: false, specifics: {}, ...overrides };
}
function add(state: V2State, key = "definition-a", i = identity({ specifics: { "Card Type": ["Pokemon"], Rarity: ["Common"] } })) {
  state.knowledge[key] = { identity: i, photoHashes: [hash("a"), hash("b")], verifiedAt: at, evidence: `artifacts/v2-pilot/${key}-saved-readback.json` };
}

test("a distinct physical capture reuses exact verified immutable facts without an image-hash match", () => {
  const state = emptyV2State(); add(state);
  const observed = identity(); const before = structuredClone({ state, observed });
  const result = findVerifiedDefinition(state, observed);
  assert.ok(result);
  assert.deepEqual(result.identity.specifics, { "Card Type": ["Pokemon"], Rarity: ["Common"] });
  assert.deepEqual(result.enrichedFields, ["Card Type", "Rarity"]);
  assert.equal(result.source.definitions[0].evidence, "artifacts/v2-pilot/definition-a-saved-readback.json");
  assert.deepEqual({ state, observed }, before, "lookup must never mutate the observed capture or verified repository");
});

test("normalization tolerates spacing/case while preserving target observed identity and serial", () => {
  const state = emptyV2State(); add(state, "serial-source", identity({ variant: "Gold", serial: "001/099", specifics: { Rarity: ["Rare"] } }));
  const observed = identity({ name: " PIKACHU ", product: "Journey   Together", variant: "gold", serial: "086/99" });
  const result = findVerifiedDefinition(state, observed);
  assert.ok(result);
  assert.equal(result.identity.serial, "086/99");
  assert.equal(result.identity.name, "PIKACHU");
  assert.equal(result.identity.product, "Journey   Together");
  assert.equal(result.identity.variant, "gold");
  assert.deepEqual(result.identity.specifics, { Rarity: ["Rare"] });
});

test("different variant, artwork, year, number, language, product, category, name, manufacturer, game or team never reuse", () => {
  const state = emptyV2State(); add(state);
  const differences: Partial<V2Identity>[] = [
    { variant: "Reverse Holo" }, { artwork: "Pikachu alternate artwork" }, { year: "2024" }, { number: "36" }, { language: "Japanese" },
    { product: "Surging Sparks" }, { categoryId: "183050" }, { name: "Raichu" }, { manufacturer: "Wizards" }, { sportOrGame: "Other CCG" }, { team: "Printed team" },
  ];
  for (const difference of differences) assert.equal(findVerifiedDefinition(state, identity(difference)), null, JSON.stringify(difference));
});

test("full serial stays copy-specific, and missing serial or another print run cannot borrow facts", () => {
  const state = emptyV2State(); add(state, "numbered", identity({ serial: "1/99", specifics: { Rarity: ["Rare"] } }));
  assert.equal(findVerifiedDefinition(state, identity()), null);
  for (const serial of ["/99", "0/99", "100/99", "1/49", "unknown"]) assert.equal(findVerifiedDefinition(state, identity({ serial })), null);
  assert.equal(findVerifiedDefinition(state, identity({ serial: "98/99" }))?.identity.serial, "98/99");
});

test("unknown identity and condition exceptions cannot be resolved by knowledge enrichment", () => {
  const state = emptyV2State(); add(state);
  for (const field of ["name", "year", "manufacturer", "product", "number", "language", "variant", "artwork", "sportOrGame"] as const) {
    assert.equal(findVerifiedDefinition(state, identity({ [field]: "Unknown" })), null, field);
  }
  assert.equal(findVerifiedDefinition(state, identity({ graded: true })), null);
  assert.equal(findVerifiedDefinition(state, identity({ damage: true })), null);
  state.knowledge["definition-a"].identity.damage = true;
  assert.equal(findVerifiedDefinition(state, identity()), null);
});

test("conflicting verified definitions fail closed instead of choosing the newest", () => {
  const state = emptyV2State(); add(state);
  add(state, "definition-b", identity({ specifics: { Rarity: ["Rare"] } }));
  assert.equal(findVerifiedDefinition(state, identity()), null);
  state.knowledge["definition-b"].identity.specifics = { rarity: [" COMMON "] };
  assert.ok(findVerifiedDefinition(state, identity()), "equivalent normalized facts are not a conflict");
});

test("observed specifics are never overwritten or silently contradicted", () => {
  const state = emptyV2State(); add(state);
  assert.equal(findVerifiedDefinition(state, identity({ specifics: { Rarity: ["Rare"] } })), null);
  assert.equal(findVerifiedDefinition(state, identity({ specifics: { Rarity: ["Common"], rarity: ["Rare"] } })), null);
  const matching = findVerifiedDefinition(state, identity({ specifics: { rarity: ["common"], "Seller Note": ["Observed on this copy"] } }));
  assert.ok(matching);
  assert.deepEqual(matching.identity.specifics.rarity, ["common"]);
  assert.deepEqual(matching.identity.specifics["Seller Note"], ["Observed on this copy"]);
  assert.deepEqual(matching.enrichedFields, ["Card Type"]);
});

test("core identity specifics conflicts fail before optional fields transfer", () => {
  const state = emptyV2State(); add(state);
  assert.equal(findVerifiedDefinition(state, identity({ specifics: { Character: ["Raichu"] } })), null);
  state.knowledge["definition-a"].identity.specifics.Character = ["Raichu"];
  assert.equal(findVerifiedDefinition(state, identity()), null);
});

test("only category-specific immutable allowlisted facts transfer", () => {
  const state = emptyV2State();
  add(state, "ccg", identity({ specifics: { Rarity: ["Common"], Price: ["$999"], Condition: ["Mint"], Serial: ["1/99"], Features: ["First on Print"], Autographed: ["Yes"], League: ["NFL"] } }));
  assert.deepEqual(findVerifiedDefinition(state, identity())?.identity.specifics, { Rarity: ["Common"] });
  const sports = identity({ name: "Jalen Williams", categoryId: "261328", sportOrGame: "Basketball", team: "Oklahoma City Thunder" });
  add(state, "sports", { ...sports, specifics: { League: ["NBA"], Rarity: ["Rare"] } });
  assert.deepEqual(findVerifiedDefinition(state, sports)?.identity.specifics, { League: ["NBA"] });
  const nonSport = identity({ name: "Harry Potter", categoryId: "183050", sportOrGame: "Harry Potter" });
  add(state, "non-sport", { ...nonSport, specifics: { Movie: ["Harry Potter"], League: ["NBA"] } });
  assert.deepEqual(findVerifiedDefinition(state, nonSport)?.identity.specifics, { Movie: ["Harry Potter"] });
});

test("malformed/future/no-evidence records and model-only unknown facts do not enrich", () => {
  for (const mutate of [
    (state: V2State) => { state.knowledge["definition-a"].evidence = ""; },
    (state: V2State) => { state.knowledge["definition-a"].verifiedAt = "2099-01-01T00:00:00.000Z"; },
    (state: V2State) => { state.knowledge["definition-a"].photoHashes = [hash("a"), hash("a")]; },
    (state: V2State) => { state.knowledge["definition-a"].identity.specifics = { Rarity: ["Unknown"] }; },
  ]) { const state = emptyV2State(); add(state); mutate(state); assert.equal(findVerifiedDefinition(state, identity()), null); }
});

test("old verified immutable facts retain original provenance and do not inherit pricing expiry", () => {
  const state = emptyV2State(); add(state);
  state.knowledge["definition-a"].verifiedAt = "2020-01-01T00:00:00.000Z";
  assert.equal(findVerifiedDefinition(state, identity())?.source.definitions[0].verifiedAt, "2020-01-01T00:00:00.000Z");
});

test("merging complementary exact verified definitions retains every contributing source", () => {
  const state = emptyV2State();
  add(state, "rarity", identity({ specifics: { Rarity: ["Common"] } }));
  add(state, "type", identity({ specifics: { "Card Type": ["Pokemon"] } }));
  const result = findVerifiedDefinition(state, identity());
  assert.ok(result);
  assert.equal(result.source.definitions.length, 2);
  assert.deepEqual(result.enrichedFields, ["Card Type", "Rarity"]);
  assert.equal(findVerifiedDefinition(state, result.identity), null, "already retained facts need no repeated enrichment event");
});
