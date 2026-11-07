import test from "node:test";
import assert from "node:assert/strict";
import { categoryFromMetadata, fetchV2Categories, V2_CATEGORY_IDS } from "../lib/card-processing-v2-category.ts";

const at = new Date(Date.now() - 1000).toISOString();
const aspects = () => ({ aspects: [
  { localizedAspectName: "Game", aspectConstraint: { aspectRequired: true, aspectMode: "SELECTION_ONLY" }, aspectValues: [{ localizedValue: "Pokémon TCG" }] },
  { localizedAspectName: "Card Number", aspectConstraint: { aspectRequired: true, aspectMode: "FREE_TEXT" }, aspectValues: [{ localizedValue: "1" }] },
  { localizedAspectName: "Set", aspectConstraint: { aspectRequired: false, aspectMode: "FREE_TEXT" }, aspectValues: [{ localizedValue: "Suggested Set" }] },
] });
function policies(categoryId: string = "183454") { return { itemConditionPolicies: [{ categoryId, categoryTreeId: "0", itemConditionRequired: false,
  itemConditions: [{ conditionId: "4000", conditionDescription: "Ungraded", conditionHelpText: "Raw trading cards", conditionDescriptors: [{
    conditionDescriptorId: "40001", conditionDescriptorName: "Card Condition", conditionDescriptorConstraint: { usage: "REQUIRED", mode: "SELECTION_ONLY", cardinality: "SINGLE" },
    conditionDescriptorValues: [{ conditionDescriptorValueId: "400010", conditionDescriptorValueName: "Near mint or better", conditionDescriptorValueHelpText: "Minor edge or corner wear." }],
  }] }] }] }; }
function fixtureFetch(calls: Array<{ url: string; init?: RequestInit }>, override?: (url: string) => Response | undefined): typeof fetch {
  return (async (input, init) => {
    const url = String(input); calls.push({ url, init });
    const custom = override?.(url); if (custom) return custom;
    if (url.includes("get_default_category_tree_id")) return Response.json({ categoryTreeId: "0", categoryTreeVersion: "127" });
    if (url.includes("get_item_condition_policies")) return Response.json({ itemConditionPolicies: V2_CATEGORY_IDS.flatMap(id => policies(id).itemConditionPolicies) });
    return Response.json(aspects());
  }) as typeof fetch;
}

test("uses exact supported condition IDs and names from official-shaped metadata", () => {
  const result = categoryFromMetadata("183454", "0", aspects(), policies(), at);
  assert.equal(result.category.conditionId, "4000");
  assert.equal(result.category.conditionDescriptorName, "Card Condition - (ID: 40001)");
  assert.equal(result.category.conditionDescriptorValue, "Near mint or better - (ID: 400010)");
  assert.deepEqual(result.category.requiredAspects, ["Game", "Card Number"]);
  assert.deepEqual(result.category.allowedValues, { Game: ["Pokémon TCG"] });
  assert.equal(result.capability.conditionHelpText, "Minor edge or corner wear.");
});

test("never substitutes known historical IDs when current response supplies a different exact ID", () => {
  const p = policies(); const raw = p.itemConditionPolicies[0].itemConditions[0]; raw.conditionId = "4999";
  raw.conditionDescriptors[0].conditionDescriptorId = "49991"; raw.conditionDescriptors[0].conditionDescriptorValues[0].conditionDescriptorValueId = "499910";
  const result = categoryFromMetadata("183454", "0", aspects(), p, at).category;
  assert.equal(result.conditionId, "4999"); assert.match(result.conditionDescriptorName, /49991/); assert.match(result.conditionDescriptorValue, /499910/);
});

test("wrong tree/category, absent descriptors, unsupported NM and duplicate results are rejected", () => {
  assert.throws(() => categoryFromMetadata("261328", "0", aspects(), policies(), at));
  assert.throws(() => categoryFromMetadata("183454", "1", aspects(), policies(), at));
  const p = policies(); p.itemConditionPolicies.push(structuredClone(p.itemConditionPolicies[0]));
  assert.throws(() => categoryFromMetadata("183454", "0", aspects(), p, at));
  const missing = policies(); missing.itemConditionPolicies[0].itemConditions[0].conditionDescriptors = [];
  assert.throws(() => categoryFromMetadata("183454", "0", aspects(), missing, at));
  const noNm = policies(); noNm.itemConditionPolicies[0].itemConditions[0].conditionDescriptors[0].conditionDescriptorValues[0].conditionDescriptorValueName = "Excellent";
  assert.throws(() => categoryFromMetadata("183454", "0", aspects(), noNm, at));
});

test("required extra descriptors, free text or descriptor dependencies cannot silently pass the single-condition contract", () => {
  const freeText = policies(); freeText.itemConditionPolicies[0].itemConditions[0].conditionDescriptors[0].conditionDescriptorConstraint.mode = "FREE_TEXT";
  assert.throws(() => categoryFromMetadata("183454", "0", aspects(), freeText, at));
  const multiple = policies(); multiple.itemConditionPolicies[0].itemConditions[0].conditionDescriptors[0].conditionDescriptorConstraint.cardinality = "MULTI";
  assert.throws(() => categoryFromMetadata("183454", "0", aspects(), multiple, at));
  const required = policies(); required.itemConditionPolicies[0].itemConditions[0].conditionDescriptors.push({ ...structuredClone(required.itemConditionPolicies[0].itemConditions[0].conditionDescriptors[0]), conditionDescriptorName: "Additional required condition" });
  assert.throws(() => categoryFromMetadata("183454", "0", aspects(), required, at));
  const dependency = policies() as ReturnType<typeof policies> & { itemConditionPolicies: Array<{ itemConditions: Array<{ conditionDescriptors: Array<{ conditionDescriptorConstraint: { applicableToConditionDescriptorIds?: string[] } }> }> }> };
  dependency.itemConditionPolicies[0].itemConditions[0].conditionDescriptors[0].conditionDescriptorConstraint.applicableToConditionDescriptorIds = ["27501"];
  assert.throws(() => categoryFromMetadata("183454", "0", aspects(), dependency, at));
});

test("duplicate aspect names, malformed required flags and missing allowed values cannot manufacture completeness", () => {
  const duplicate = aspects(); duplicate.aspects.push({ ...duplicate.aspects[0], localizedAspectName: " game " });
  assert.throws(() => categoryFromMetadata("183454", "0", duplicate, policies(), at));
  const empty = aspects(); empty.aspects[0].aspectValues = [];
  assert.throws(() => categoryFromMetadata("183454", "0", empty, policies(), at));
  assert.throws(() => categoryFromMetadata("183454", "0", { aspects: [{ localizedAspectName: "Game", aspectConstraint: {} }] }, policies(), at));
});

test("acquisition performs only bounded exact GET reads with injected OAuth and retains hashed evidence", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const result = await fetchV2Categories("test-token-never-persisted", V2_CATEGORY_IDS, { fetcher: fixtureFetch(calls) });
  assert.equal(result.categories.length, 3); assert.equal(result.evidence.length, 5); assert.equal(calls.length, 5);
  assert.ok(calls.every(c => c.init?.method === "GET" && c.init.redirect === "error" && !!c.init.signal));
  const filter = new URL(calls.find(c => c.url.includes("condition_policies"))!.url).searchParams.get("filter");
  assert.equal(filter, "categoryIds:{183454|261328|183050}");
  assert.ok(result.evidence.every(e => /^[a-f0-9]{64}$/.test(e.sha256)));
  assert.ok(!JSON.stringify(result).includes("test-token-never-persisted"));
});

test("one category failure is isolated and no historical cache is relabeled fresh", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = fixtureFetch(calls, url => url.includes("category_id=261328") ? Response.json({ error: "Unavailable" }, { status: 503 }) : undefined);
  const first = await fetchV2Categories("token", V2_CATEGORY_IDS, { fetcher });
  const second = await fetchV2Categories("token", V2_CATEGORY_IDS, { fetcher });
  assert.equal(first.categories.length, 2); assert.equal(second.categories.length, 2);
  assert.equal(first.capabilities.find(c => c.categoryId === "261328")?.status, "blocked");
  assert.equal(calls.length, 10, "fresh acquisition cannot return the old global taxonomy cache as a new observation");
});

test("failed OAuth is actionable without returning provider bodies or secrets", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const result = await fetchV2Categories("secret", ["183454"], { fetcher: fixtureFetch(calls, () => Response.json({ token: "secret", connection: "private" }, { status: 403 })) });
  assert.equal(result.categories.length, 0); assert.match(result.capabilities[0].detail, /OAuth/);
  assert.equal(calls.length, 1); assert.ok(!JSON.stringify(result).includes("secret")); assert.ok(!JSON.stringify(result).includes("private"));
});

test("invalid inputs refuse network calls and oversized metadata is held", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [], fetcher = fixtureFetch(calls);
  await assert.rejects(fetchV2Categories("", ["183454"], { fetcher }));
  await assert.rejects(fetchV2Categories("token", [] as const, { fetcher }));
  assert.equal(calls.length, 0);
  const oversized = await fetchV2Categories("token", ["183454"], { fetcher: fixtureFetch(calls, () => new Response("{}", { headers: { "content-length": "9000000" } })) });
  assert.equal(oversized.categories.length, 0); assert.equal(oversized.capabilities[0].status, "blocked");
});

test("live-sized sports FREE_TEXT catalogues do not invalidate current category requirements", () => {
  // The retained 261328 response has 29,797 player suggestions. They are not an
  // exclusive list, and only Sport is marked aspectRequired even though other
  // fields are recommended. Keep that distinction and the condition IDs exact.
  const sports = { aspects: [
    { localizedAspectName: "Sport", aspectConstraint: { aspectRequired: true, aspectMode: "FREE_TEXT", aspectUsage: "RECOMMENDED", itemToAspectCardinality: "MULTI" }, aspectValues: [{ localizedValue: "Football" }] },
    { localizedAspectName: "Player/Athlete", aspectConstraint: { aspectRequired: false, aspectMode: "FREE_TEXT", aspectUsage: "RECOMMENDED", itemToAspectCardinality: "MULTI" }, aspectValues: Array.from({ length: 29797 }, (_, index) => ({ localizedValue: `Player ${index}` })) },
    { localizedAspectName: "Card Number", aspectConstraint: { aspectRequired: false, aspectMode: "FREE_TEXT", aspectUsage: "RECOMMENDED" } },
    { localizedAspectName: "Autographed", aspectConstraint: { aspectRequired: false, aspectMode: "SELECTION_ONLY", aspectUsage: "RECOMMENDED" }, aspectValues: [{ localizedValue: "Yes" }, { localizedValue: "No" }] },
  ] };
  const result = categoryFromMetadata("261328", "0", sports, policies("261328"), at);
  assert.deepEqual(result.category.requiredAspects, ["Sport"]);
  assert.deepEqual(result.category.allowedValues, { Autographed: ["Yes", "No"] });
  assert.equal(result.category.conditionId, "4000"); assert.equal(result.capability.descriptorId, "40001"); assert.equal(result.capability.descriptorValueId, "400010");
  assert.equal(sports.aspects[1].aspectValues!.length, 29797, "adapting metadata must not mutate retained raw evidence");
});

test("large FREE_TEXT suggestions do not weaken selection-only limits or required flags", () => {
  const oversized = aspects(); oversized.aspects[0].aspectValues = Array.from({ length: 20001 }, (_, index) => ({ localizedValue: `Game ${index}` }));
  assert.throws(() => categoryFromMetadata("183454", "0", oversized, policies(), at), /20000/);
  const invalidFlag = { aspects: [{ localizedAspectName: "Sport", aspectConstraint: { aspectRequired: "true", aspectMode: "FREE_TEXT" }, aspectValues: Array.from({ length: 29797 }, () => ({ localizedValue: "Suggested sport" })) }] };
  assert.throws(() => categoryFromMetadata("261328", "0", invalidFlag, policies("261328"), at));
  const unknownMode = { aspects: [{ localizedAspectName: "Sport", aspectConstraint: { aspectRequired: true, aspectMode: "UNSUPPORTED" } }] };
  assert.throws(() => categoryFromMetadata("261328", "0", unknownMode, policies("261328"), at));
});

test("an adaptation failure retains the exact successful aspects read and safe schema paths", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const body = { aspects: [{ localizedAspectName: "Sport", aspectConstraint: { aspectMode: "FREE_TEXT" } }] };
  const result = await fetchV2Categories("test-token", ["261328"], { fetcher: fixtureFetch(calls, url => url.includes("get_item_aspects") ? Response.json(body) : undefined) });
  assert.equal(result.categories.length, 0); assert.equal(result.evidence.length, 3);
  assert.deepEqual(result.evidence.find(e => e.resource === "category-aspects")!.body, body);
  assert.equal(result.capabilities[0].diagnostic?.code, "SCHEMA_INVALID");
  assert.ok(result.capabilities[0].diagnostic!.paths!.includes("aspects.0.aspectConstraint.aspectRequired"));
  assert.ok(!JSON.stringify(result).includes("test-token"));
});

test("a failed category read reports its HTTP status without retaining an untrusted error body", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const result = await fetchV2Categories("test-token", ["261328"], { fetcher: fixtureFetch(calls, url => url.includes("get_item_aspects") ? Response.json({ token: "private-error-body" }, { status: 403 }) : undefined) });
  assert.equal(result.categories.length, 0); assert.equal(result.evidence.length, 2);
  assert.deepEqual(result.capabilities[0].diagnostic, { phase: "category-aspects", code: "READ_FAILED", httpStatus: 403 });
  assert.ok(!JSON.stringify(result).includes("private-error-body"));
});

test("successful acquisition retains the full advisory catalogue while exposing only constrained allowed values", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const body = { aspects: [
    { localizedAspectName: "Sport", aspectConstraint: { aspectRequired: true, aspectMode: "FREE_TEXT" }, aspectValues: Array.from({ length: 29797 }, (_, index) => ({ localizedValue: `Sport suggestion ${index}` })) },
  ] };
  const result = await fetchV2Categories("test-token", ["261328"], { fetcher: fixtureFetch(calls, url => url.includes("get_item_aspects") ? Response.json(body) : undefined) });
  assert.equal(result.categories.length, 1); assert.deepEqual(result.categories[0].requiredAspects, ["Sport"]); assert.deepEqual(result.categories[0].allowedValues, {});
  assert.deepEqual(result.evidence.find(e => e.resource === "category-aspects")!.body, body);
});
