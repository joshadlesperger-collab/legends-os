import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { openAiIdentificationSchema, normalizeOpenAiIdentification } from "../lib/card-processing-v2-openai.ts";

const sample = () => ({ pairMatches: true, frontImageIndex: "0", upright: true, warnings: [], identity: {
  name: "Pikachu", year: "2023", manufacturer: "Pokemon", product: "151", number: "025", categoryId: "183454", language: "English", variant: "Base", artwork: "standard", sportOrGame: "Pokemon", team: "", serial: "", graded: false, damage: false,
  specifics: [{ name: "Rarity", values: ["Common"] }, { name: "Card Type", values: ["Pokemon"] }],
} });
test("production wire schema contains only closed objects without dynamic additionalProperties", () => {
  const schema = z.toJSONSchema(openAiIdentificationSchema);
  const visit = (value: unknown) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== "object") return;
    const node = value as Record<string, unknown>;
    if (node.type === "object") { assert.equal(node.additionalProperties, false); assert.deepEqual(new Set(node.required as string[]), new Set(Object.keys(node.properties as object))); }
    for (const child of Object.values(node)) visit(child);
  };
  visit(schema);
});
test("wire category specifics normalize to the internal exact identity record", () => {
  const result = normalizeOpenAiIdentification(sample());
  assert.deepEqual(result.identity?.specifics, { Rarity: ["Common"], "Card Type": ["Pokemon"] });
  assert.equal(result.identity?.name, "Pikachu"); assert.equal(result.frontImageIndex, "0");
});
test("wire uncertainty remains null and does not invent required identity", () => {
  const result = normalizeOpenAiIdentification({ ...sample(), identity: null, warnings: ["Card number unreadable"] });
  assert.equal(result.identity, null); assert.deepEqual(result.warnings, ["Card number unreadable"]);
});
test("duplicate normalized specifics and prototype names cannot overwrite verified facts", () => {
  const duplicate = sample(); duplicate.identity.specifics.push({ name: " rarity ", values: ["Rare"] });
  assert.throws(() => normalizeOpenAiIdentification(duplicate), /Conflicting/);
  const unsafe = sample(); unsafe.identity.specifics.push({ name: "__proto__", values: ["bad"] });
  assert.throws(() => normalizeOpenAiIdentification(unsafe), /unsafe/);
});
test("production wire refuses price, arbitrary identity fields and dictionary specifics", () => {
  assert.throws(() => normalizeOpenAiIdentification({ ...sample(), price: 3 }));
  const arbitrary = sample(); assert.throws(() => normalizeOpenAiIdentification({ ...arbitrary, identity: { ...arbitrary.identity, invented: true } }));
  assert.throws(() => normalizeOpenAiIdentification({ ...arbitrary, identity: { ...arbitrary.identity, specifics: { Rarity: ["Rare"] } } }));
});
