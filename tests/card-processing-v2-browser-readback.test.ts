import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { loadV2PolicyCatalog, bindV2PolicyFromCatalog } from "../lib/card-processing-v2-policy-bindings.ts";
import { payloadSchema, type V2Payload } from "../lib/card-processing-v2.ts";
import { v2SavedDraftSchema } from "../lib/card-processing-v2-draft-lifecycle.ts";
import {
  attachV2SavedDraftEvidence, normalizedEbayImageResource, parseV2DraftEditorReadback, readV2SavedDraftFromBrowser,
  V2BrowserReadbackError, type V2BrowserReadbackContext, type V2DraftEditorObservation,
} from "../lib/card-processing-v2-browser-readback.ts";

const hash = (letter: string) => letter.repeat(64);
const reference = { path: "artifacts/v2-tests/actual-browser-observation.json", sha256: hash("c") };
const field = (value: string, readMethod: V2DraftEditorObservation["title"]["readMethod"] = "input-value") => ({ locator: `visible-control:${value || "blank"}`, visible: true as const, readMethod, value });
const selectedPolicy = (label: string, id: string) => ({ label: field(label, "selected-option-label"), id: field(id, "selected-option-value") });
function expected(): V2Payload {
  return payloadSchema.parse({ sku: "V2-test-001", captureIds: [hash("a"), hash("b")], title: "2025 Journey Together Pikachu #35", categoryId: "183454",
    specifics: { Game: ["Pokémon TCG"], Character: ["Pikachu"], "Card Number": ["35"], Language: ["English"] }, quantity: 2,
    photos: [{ hash: hash("d"), url: "https://i.ebayimg.com/images/g/frontABC/s-l1600.jpg", expiresAt: new Date(Date.now() + 86400000 * 3).toISOString(), upright: true },
      { hash: hash("e"), url: "https://i.ebayimg.com/images/g/backXYZ/s-l1600.jpg", expiresAt: new Date(Date.now() + 86400000 * 3).toISOString(), upright: true }],
    conditionId: "4000", conditionDescriptorName: "Card Condition - (ID: 40001)", conditionDescriptorValue: "Near mint or better - (ID: 400010)",
    condition: "Near mint or better", description: "The pictured card. Near mint or better.", descriptionSource: "factual", pricing: "unpriced-grok-pending" });
}
function context(): V2BrowserReadbackContext {
  return { draftId: "5431234567890", expected: expected(), requiredAspects: ["Game", "Character", "Card Number", "Language"],
    expectedPolicies: { payment: "eBay Managed Payments", returns: "No Return Accepted", shipping: "Card Factory – Free Envelope Only", location: "Tucson, Arizona 85701", pricingShippingUnresolved: true } };
}
function observed(): V2DraftEditorObservation {
  return { kind: "observed-reopened-ebay-draft-editor", driver: "playwright-visible-dom", url: "https://www.ebay.com/sl/sell?draft_id=5431234567890",
    observedAt: new Date(Date.now() - 1000).toISOString(), seller: field("imaydit58", "inner-text"), draftId: field("5431234567890", "inner-text"),
    save: { status: field("Draft saved", "inner-text"), savedAt: new Date(Date.now() - 5000).toISOString(), reopenedAt: new Date(Date.now() - 3000).toISOString(), basis: "observed-saved-status-before-reopen" },
    title: field("2025 Journey Together Pikachu #35"), sku: field("V2-test-001"), categoryId: field("183454", "selected-option-value"), quantity: field("2"),
    specificsComplete: true, specifics: [
      { name: field("Game", "inner-text"), values: [field("Pokémon TCG", "selected-option-label")] },
      { name: field("Character", "inner-text"), values: [field("Pikachu", "selected-option-label")] },
      { name: field("Card Number", "inner-text"), values: [field("35")] },
      { name: field("Language", "inner-text"), values: [field("English", "selected-option-label")] },
    ], condition: { id: field("4000", "selected-option-value"), label: field("Ungraded", "selected-option-label"), descriptorId: field("40001", "selected-option-value"),
      descriptorName: field("Card Condition", "inner-text"), valueId: field("400010", "selected-option-value"), valueName: field("Near mint or better", "selected-option-label") },
    description: field("The pictured card. Near mint or better.", "inner-text"), descriptionProvenance: { source: "factual", evidence: reference },
    itemPrice: field(""), shippingAmount: field("0.00"), policies: { payment: selectedPolicy("eBay Managed Payments", "248164941010"), returns: selectedPolicy("No Return Accepted", "248164940010"), shipping: selectedPolicy("Card Factory – Free Envelope Only", "248164942010"), location: field("Tucson, Arizona 85701") },
    photosComplete: true, photos: [{ url: field("https://i.ebayimg.com/images/g/frontABC/s-l500.webp?set_id=880000500F", "rendered-image-src"), renderOrder: 0, uprightObserved: true, visualEvidence: reference,
      orientation: { source: "bound-hosted-original-review", resourceId: "frontABC", originalHash: hash("d"), evidence: reference } },
      { url: field("https://i.ebayimg.com/images/g/backXYZ/s-l225.jpg", "rendered-image-src"), renderOrder: 1, uprightObserved: true, visualEvidence: reference,
        orientation: { source: "bound-hosted-original-review", resourceId: "backXYZ", originalHash: hash("e"), evidence: reference } }],
    issueSummaryObserved: true, editorErrors: [] };
}
function rejects(mutate: (observation: V2DraftEditorObservation) => void, code: string, useContext = context()) {
  const raw = observed(); mutate(raw);
  assert.throws(() => parseV2DraftEditorReadback(raw, useContext), error => error instanceof V2BrowserReadbackError && error.code === code);
}

test("constructs readback from independent actual controls and preserves selected IDs/raw rendered photo URLs", () => {
  const ctx = context(), raw = observed();
  const result = parseV2DraftEditorReadback(raw, ctx);
  assert.deepEqual(result.readback.payload, ctx.expected);
  assert.equal(result.readback.savedItemPrice, null); assert.equal(result.readback.savedShippingAmount, 0);
  assert.equal(result.observation.policies.payment.id!.value, "248164941010");
  assert.equal(result.photoBindings[0].renderedUrl, "https://i.ebayimg.com/images/g/frontABC/s-l500.webp?set_id=880000500F");
  assert.equal(result.photoBindings[0].originalHash, hash("d"));
  const saved = attachV2SavedDraftEvidence(result.readback, reference);
  assert.equal(v2SavedDraftSchema.parse(saved).draftId, ctx.draftId);
  assert.notEqual(result.readback.payload, ctx.expected, "readback cannot be an alias to the expected payload");
});

test("driver receives only existing draft ID and absence never pretends to be a connected browser", async () => {
  const calls: unknown[] = [];
  const result = await readV2SavedDraftFromBrowser({ kind: "playwright-visible-dom", readReopenedDraft: async (...args) => { calls.push(args); return observed(); } }, context());
  assert.equal(result.readback.seller, "imaydit58"); assert.deepEqual(calls, [["5431234567890"]]);
  await assert.rejects(readV2SavedDraftFromBrowser(undefined, context()), error => error instanceof V2BrowserReadbackError && error.code === "DRIVER_UNAVAILABLE");
  await assert.rejects(readV2SavedDraftFromBrowser({ kind: "cua-observed-native", readReopenedDraft: async () => observed() }, context()), /provenance/);
});

test("wrong seller, URL ID, ambiguous query and missing actual save/reopen fail closed", () => {
  rejects(raw => { raw.seller.value = "another-seller"; }, "SELLER_MISMATCH");
  rejects(raw => { raw.url = "https://www.ebay.com/sl/sell?draft_id=999"; }, "DRAFT_MISMATCH");
  rejects(raw => { raw.url += "&draft_id=5431234567890"; }, "DRAFT_MISMATCH");
  rejects(raw => { raw.url = "https://www.ebay.com.evil.test/sl/sell?draft_id=5431234567890"; }, "DRAFT_MISMATCH");
  rejects(raw => { raw.save.status.value = "Saving…"; }, "REOPEN_REQUIRED");
  rejects(raw => { raw.save.savedAt = new Date().toISOString(); }, "REOPEN_REQUIRED");
});

test("canonical camel-case draft URLs pass while duplicate or conflicting aliases remain rejected", () => {
  const raw = observed(); raw.url = "https://www.ebay.com/lstng?draftId=5431234567890";
  assert.equal(parseV2DraftEditorReadback(raw, context()).readback.draftId, "5431234567890");
  for (const suffix of ["&draft_id=5431234567890", "&draft_id=999", "&draftId=5431234567890"]) rejects(value => { value.url = raw.url + suffix; }, "DRAFT_MISMATCH");
});

test("actual wrong persisted values cannot be replaced by expected title, SKU, category or quantity", () => {
  for (const name of ["title", "sku", "categoryId", "quantity"] as const) rejects(raw => { raw[name].value = "wrong"; }, "FIELDS_MISMATCH");
  rejects(raw => { raw.title.readMethod = "inner-text"; }, "UNSUPPORTED_EDITOR");
});

test("all expected/required specifics are read and inherited contradictory identity chips are rejected", () => {
  rejects(raw => { raw.specifics = raw.specifics.filter(s => s.name.value !== "Language"); }, "SPECIFICS_MISMATCH");
  rejects(raw => { raw.specifics[1].values[0].value = "Raichu"; }, "SPECIFICS_MISMATCH");
  rejects(raw => { raw.specifics[1].values.push(field("Raichu", "selected-option-label")); }, "SPECIFICS_MISMATCH");
  rejects(raw => { raw.specifics.push({ name: field("Player/Athlete", "inner-text"), values: [field("Michael Jordan")] }); }, "SPECIFICS_MISMATCH");
  rejects(raw => { raw.specifics.push({ name: field(" character ", "inner-text"), values: [field("Pikachu")] }); }, "SPECIFICS_MISMATCH");
  const ctx = context(); ctx.requiredAspects.push("Card Type");
  rejects(() => undefined, "SPECIFICS_MISMATCH", ctx);
});

test("actual condition IDs and description are observed instead of echoed from category/payload", () => {
  rejects(raw => { raw.condition.valueId.value = "400011"; }, "CONDITION_MISMATCH");
  rejects(raw => { raw.condition.valueName.value = "Excellent"; }, "CONDITION_MISMATCH");
  rejects(raw => { raw.condition.descriptorId.readMethod = "inner-text"; }, "CONDITION_MISMATCH");
  rejects(raw => { raw.description.value = "Another card description"; }, "DESCRIPTION_MISMATCH");
  rejects(raw => { raw.descriptionProvenance.source = "ebay-ai-reviewed"; }, "DESCRIPTION_MISMATCH");
});

test("blank price is established only from actual input value; zero and retained suggestions are not blank", () => {
  for (const value of ["0", "0.00", "1.49", "Suggested $2.00"]) rejects(raw => { raw.itemPrice.value = value; }, "PRICE_NOT_BLANK");
  rejects(raw => { raw.itemPrice.readMethod = "inner-text"; }, "UNSUPPORTED_EDITOR");
  const raw = observed(), ctx = context(); raw.shippingAmount.value = ""; raw.policies.shipping = selectedPolicy("", "");
  ctx.expectedPolicies!.shipping = null;
  const result = parseV2DraftEditorReadback(raw, ctx);
  assert.equal(result.readback.savedShippingAmount, null); assert.equal(result.readback.policies.shipping, null);
});

test("policy labels, actual selected IDs, location and shipping amounts cannot be inferred from defaults", () => {
  rejects(raw => { raw.policies.payment.id!.value = ""; }, "POLICIES_MISMATCH");
  rejects(raw => { raw.policies.returns.label.value = "30 day returns"; }, "POLICIES_MISMATCH");
  rejects(raw => { raw.policies.location.value = ""; }, "POLICIES_MISMATCH");
  rejects(raw => { raw.policies.location.value = "Different seller city"; }, "POLICIES_MISMATCH");
  rejects(raw => { raw.shippingAmount.value = "Calculated / varies"; }, "POLICIES_MISMATCH");
});

test("policy usage counts are presentation only and independently selected numeric IDs stay bound", () => {
  const raw = observed(), ctx = context();
  raw.policies.payment = selectedPolicy("eBay Managed Payments (248164941010) [7590 listings]", "248164941010");
  raw.policies.returns = selectedPolicy("No Return Accepted (6368 listings)", "248164940010");
  raw.policies.shipping = selectedPolicy("PWE - $1.95 (875 listings)", "248164773010");
  ctx.expectedPolicies!.payment = "eBay Managed Payments (248164941010)"; ctx.expectedPolicies!.shipping = "PWE - $1.95";
  ctx.expectedPolicyIds = { payment: "248164941010", returns: "248164940010", shipping: "248164773010" };
  const parsed = parseV2DraftEditorReadback(raw, ctx);
  assert.equal(parsed.readback.policies.payment, "eBay Managed Payments (248164941010)"); assert.equal(parsed.readback.policies.shipping, "PWE - $1.95");
  assert.equal(parsed.observation.policies.payment.label.value, "eBay Managed Payments (248164941010) [7590 listings]", "the exact observed label remains retained");
  const wrongId = structuredClone(raw); wrongId.policies.shipping.id!.value = "123";
  assert.throws(() => parseV2DraftEditorReadback(wrongId, ctx), error => error instanceof V2BrowserReadbackError && error.code === "POLICIES_MISMATCH");
  const labelOnly = structuredClone(raw); labelOnly.policies.shipping.id!.value = "PWE - $1.95";
  assert.throws(() => parseV2DraftEditorReadback(labelOnly, ctx), error => error instanceof V2BrowserReadbackError && error.code === "POLICIES_MISMATCH");
  const contradictory = structuredClone(raw); contradictory.policies.payment.label.value = "eBay Managed Payments (999) [7590 listings]";
  assert.throws(() => parseV2DraftEditorReadback(contradictory, ctx), error => error instanceof V2BrowserReadbackError && error.code === "POLICIES_MISMATCH");
});

test("native selected labels use explicit fresh-catalog provenance without invented numeric DOM values", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "v2-native-policy-readback-"));
  try {
    await fs.mkdir(path.join(root, "artifacts")); const source = { at: new Date().toISOString(), source: "fresh seller-owned active item read for established policy/location only", itemId: "128169129237", seller: "imaydit58", location: "Waxahachie, Texas", country: "US", returnPolicy: "ReturnsNotAccepted", policies: {
      SellerPaymentProfile: { PaymentProfileID: 248164941010, PaymentProfileName: "eBay Managed Payments (248164941010)" }, SellerReturnProfile: { ReturnProfileID: 248164940010, ReturnProfileName: "No Return Accepted (248164940010)" }, SellerShippingProfile: { ShippingProfileID: 248164773010, ShippingProfileName: "PWE - $1.95" },
    } }, bytes = JSON.stringify(source), proof = { path: "artifacts/current-policy-location.json", sha256: createHash("sha256").update(bytes).digest("hex") };
    await fs.writeFile(path.join(root, proof.path), bytes);
    const catalog = await loadV2PolicyCatalog(root, proof), raw = observed(), ctx = context(); ctx.policyCatalog = catalog;
    ctx.expectedPolicyIds = { payment: "248164941010", returns: "248164940010", shipping: "248164773010" };
    ctx.expectedPolicies = { payment: "eBay Managed Payments (248164941010)", returns: "No Return Accepted", shipping: "PWE - $1.95", location: "Waxahachie, Texas", pricingShippingUnresolved: true };
    raw.policies.location.value = "Waxahachie, Texas";
    const selected = { payment: "eBay Managed Payments (248164941010) [7590 listings]", returns: "No Return Accepted (248164940010) (6368 listings)", shipping: "PWE - $1.95 (875 listings)" };
    for (const type of ["payment", "returns", "shipping"] as const) {
      const options = [selected[type], `Another ${type} policy (12 listings)`];
      raw.policies[type] = { label: field(selected[type], "inner-text"), options: options.map(option => field(option, "inner-text")), catalogBinding: bindV2PolicyFromCatalog(catalog, type, selected[type], options) };
    }
    const result = parseV2DraftEditorReadback(raw, ctx);
    assert.equal(result.readback.policies.returns, "No Return Accepted"); assert.equal(result.readback.policies.shipping, "PWE - $1.95");
    assert.equal(result.observation.policies.shipping.id, undefined, "no numeric ID was claimed as observed in the native DOM");
    assert.equal(result.observation.policies.shipping.catalogBinding!.policyId, "248164773010"); assert.deepEqual(result.observation.policies.shipping.catalogBinding!.evidence, proof);
    const noCatalog = { ...ctx, policyCatalog: undefined };
    assert.throws(() => parseV2DraftEditorReadback(raw, noCatalog), error => error instanceof V2BrowserReadbackError && error.code === "POLICIES_MISMATCH");
    const wrongLabel = structuredClone(raw); wrongLabel.policies.shipping.label.value = "Another shipping policy (12 listings)";
    assert.throws(() => parseV2DraftEditorReadback(wrongLabel, ctx), error => error instanceof V2BrowserReadbackError && error.code === "POLICIES_MISMATCH");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("EPS resources normalize thumbnail sizes but reject another original, reversed order and other hosts", () => {
  assert.equal(normalizedEbayImageResource("https://i.ebayimg.com/images/g/frontABC/s-l140.webp"), "frontABC");
  for (const url of ["https://i.ebayimg.com.evil.test/images/g/frontABC/s-l500.jpg", "http://i.ebayimg.com/images/g/frontABC/s-l500.jpg", "https://i.ebayimg.com/private/frontABC.jpg", "https://user:secret@i.ebayimg.com/images/g/frontABC/s-l500.jpg"]) assert.equal(normalizedEbayImageResource(url), null);
  rejects(raw => { raw.photos[0].url.value = "https://i.ebayimg.com/images/g/notTheOriginal/s-l500.jpg"; }, "PHOTOS_MISMATCH");
  rejects(raw => { [raw.photos[0].renderOrder, raw.photos[1].renderOrder] = [1, 0]; }, "PHOTOS_MISMATCH");
  rejects(raw => { raw.photos[0].url.value = raw.photos[1].url.value; }, "PHOTOS_MISMATCH");
});

test("actual editor errors remain visible in schema output and unsupported/missing fields produce no verification", () => {
  const raw = observed(); raw.editorErrors = [field("Select a shipping policy", "inner-text")];
  assert.deepEqual(parseV2DraftEditorReadback(raw, context()).readback.editorErrors, ["Select a shipping policy"]);
  const missing: unknown = { ...observed(), itemPrice: undefined };
  assert.throws(() => parseV2DraftEditorReadback(missing, context()), /incomplete or unsupported/);
  assert.throws(() => parseV2DraftEditorReadback({ ...observed(), cookies: "forbidden-private-data" }, context()), /incomplete or unsupported/);
});

test("mismatch errors retain only the validated independent observation for a durable exception checkpoint", () => {
  const raw = observed(); raw.title.value = "Actual persisted incorrect title";
  try { parseV2DraftEditorReadback(raw, context()); assert.fail("Expected a mismatch"); }
  catch (error) { assert.ok(error instanceof V2BrowserReadbackError); assert.equal(error.observation?.title.value, "Actual persisted incorrect title"); }
});
