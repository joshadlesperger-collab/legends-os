import test from "node:test";
import assert from "node:assert/strict";
import { createV2PlaywrightDraftReadbackDriver, type V2DOMControl, type V2DOMSnapshot, type V2ReadbackPage } from "../lib/card-processing-v2-browser-driver.ts";

const hash = (character: string) => character.repeat(64);
const evidence = { path: "artifacts/v2-driver-tests/actual-upload-receipt.json", sha256: hash("a") };
function control(label: string, value: string, selectedLabel?: string): V2DOMControl {
  return { locator: `#${label.replace(/\W/g, "-")}`, labels: [label], value, visible: true, kind: selectedLabel ? "select" : "input",
    selectedOptions: selectedLabel ? [{ value, label: selectedLabel }] : [], inSpecifics: false };
}
function snapshot(): V2DOMSnapshot {
  const descriptorId = { ...control("conditionDescriptorId", "40001"), visible: false, kind: "hidden" as const, visibleBinding: { locator: "#Card-Condition", label: "Near mint or better" } };
  return { controls: [control("Title", "ACTUAL DOM TITLE"), control("Custom label (SKU)", "ACTUAL-SKU"), control("Category", "183454", "CCG Individual Cards"), control("Quantity", "1"),
    control("Condition", "4000", "Ungraded"), descriptorId, control("Card Condition", "400010", "Near mint or better"), control("Description", "Actual DOM description"),
    control("Price", ""), control("Shipping cost", "0.00"), control("Payment policy", "111", "Actual payment policy"), control("Return policy", "222", "No Return Accepted"),
    control("Shipping policy", "333", "Actual shipping policy"), control("Item location", "Actual location"), { ...control("Game", "Pokemon TCG", "Pokemon TCG"), inSpecifics: true }],
    sellers: [{ locator: "#seller-username", value: "imaydit58" }], savedStatus: [{ locator: "#save-status", value: "Draft saved" }],
    specificsSections: 1, photoSections: 1, photos: [{ locator: "#actual-front", url: "https://i.ebayimg.com/images/g/front123/s-l500.webp" }, { locator: "#actual-back", url: "https://i.ebayimg.com/images/g/back456/s-l225.jpg" }],
    issueSummaryObserved: true, errors: [] };
}
function pageFor(dom: V2DOMSnapshot, observedUrl?: string) {
  const navigations: string[] = []; let url = "about:blank";
  const page = { goto: async (next: string) => { navigations.push(next); url = observedUrl ?? next; }, url: () => url,
    locator: (selector: string) => { assert.equal(selector, "body"); return { evaluate: async (callback: (...args: unknown[]) => unknown) => { assert.equal(callback.name, "collectV2EditorDOM"); return structuredClone(dom); } }; },
  } as unknown as V2ReadbackPage;
  return { page, navigations };
}
const options = {
  loadHostedOriginalEvidence: async () => [{ url: "https://i.ebayimg.com/images/g/front123/s-l1600.jpg", originalHash: hash("b"), uprightReviewed: true as const, evidence },
    { url: "https://i.ebayimg.com/images/g/back456/s-l1600.jpg", originalHash: hash("c"), uprightReviewed: true as const, evidence }],
  readDescriptionProvenance: async (draftId: string, description: string) => { assert.equal(draftId, "5431234567890"); assert.equal(description, "Actual DOM description"); return { source: "factual" as const, evidence }; },
};

test("concrete injected driver reopens only the owned ID and records actual DOM values without an expected payload", async () => {
  const { page, navigations } = pageFor(snapshot());
  const observation = await createV2PlaywrightDraftReadbackDriver(page, options).readReopenedDraft("5431234567890") as { title: { value: string }; sku: { value: string }; condition: { descriptorId: { value: string; visible: boolean } }; save: { basis: string } };
  assert.deepEqual(navigations, ["https://www.ebay.com/sl/sell?draft_id=5431234567890", "https://www.ebay.com/sl/sell?draft_id=5431234567890"]);
  assert.equal(observation.title.value, "ACTUAL DOM TITLE"); assert.equal(observation.sku.value, "ACTUAL-SKU");
  assert.equal(observation.condition.descriptorId.value, "40001"); assert.equal(observation.condition.descriptorId.visible, false);
  assert.equal(observation.save.basis, "observed-saved-status-before-reopen");
});

test("missing or ambiguous real controls and missing media provenance stop the read-only driver", async () => {
  for (const mutate of [(dom: V2DOMSnapshot) => { dom.controls = dom.controls.filter(c => !c.labels.includes("Title")); },
    (dom: V2DOMSnapshot) => { dom.controls.push(control("Listing title", "Conflicting actual title")); },
    (dom: V2DOMSnapshot) => { dom.issueSummaryObserved = false; }]) {
    const dom = snapshot(); mutate(dom); const { page } = pageFor(dom);
    await assert.rejects(createV2PlaywrightDraftReadbackDriver(page, options).readReopenedDraft("5431234567890"), /independently|unique|readable|Exactly/);
  }
  const { page } = pageFor(snapshot());
  await assert.rejects(createV2PlaywrightDraftReadbackDriver(page, { ...options, loadHostedOriginalEvidence: async () => [] }).readReopenedDraft("5431234567890"), /orientation receipt/);
});

test("read-only driver accepts the actual canonical editor redirect without accepting an ambiguous ID", async () => {
  const { page } = pageFor(snapshot(), "https://www.ebay.com/lstng?draftId=5431234567890");
  const observed = await createV2PlaywrightDraftReadbackDriver(page, options).readReopenedDraft("5431234567890") as { url: string; draftId: { value: string } };
  assert.equal(observed.url, "https://www.ebay.com/lstng?draftId=5431234567890"); assert.equal(observed.draftId.value, "5431234567890");
  const ambiguous = pageFor(snapshot(), "https://www.ebay.com/lstng?draftId=5431234567890&draft_id=999");
  await assert.rejects(createV2PlaywrightDraftReadbackDriver(ambiguous.page, options).readReopenedDraft("5431234567890"), /exact owned/);
});
