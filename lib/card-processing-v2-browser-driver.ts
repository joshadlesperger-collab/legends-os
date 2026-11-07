import type { Page } from "playwright-core";
import { observedV2DraftId } from "./card-processing-v2-observation-values.ts";
import {
  normalizedEbayImageResource, V2BrowserReadbackError, v2DraftEditorObservationSchema,
  type V2DraftEditorObservation, type V2SavedDraftBrowserDriver,
} from "./card-processing-v2-browser-readback.ts";

type Field = V2DraftEditorObservation["title"];
type Reference = V2DraftEditorObservation["descriptionProvenance"]["evidence"];
export type V2HostedOriginalEvidence = { url: string; originalHash: string; uprightReviewed: true; evidence: Reference };
export type V2DOMControl = {
  locator: string; labels: string[]; value: string; visible: boolean;
  kind: "input" | "textarea" | "select" | "richtext" | "hidden";
  selectedOptions: Array<{ value: string; label: string }>;
  visibleBinding?: { locator: string; label: string };
  inSpecifics: boolean;
};
export type V2DOMSnapshot = {
  controls: V2DOMControl[];
  sellers: Array<{ locator: string; value: string }>;
  savedStatus: Array<{ locator: string; value: string }>;
  specificsSections: number; photoSections: number;
  photos: Array<{ locator: string; url: string }>;
  issueSummaryObserved: boolean; errors: Array<{ locator: string; value: string }>;
};
/** The concrete Page is injected by the caller's dedicated persistent browser.
 * This module never launches a browser, reads cookies, evaluates application JS
 * state, or calls eBay's private draft endpoints. */
export type V2ReadbackPage = Pick<Page, "goto" | "url" | "locator">;
export type V2PlaywrightDriverOptions = {
  loadHostedOriginalEvidence(): Promise<V2HostedOriginalEvidence[]>;
  readDescriptionProvenance(draftId: string, actualDescription: string): Promise<V2DraftEditorObservation["descriptionProvenance"]>;
};

/** Runs in the browser and reads rendered form DOM only. Hidden numeric IDs are
 * restricted to known listing field names and must bind to an actual visible
 * selected control label nearby. Passwords, CSRF inputs and arbitrary hidden
 * fields are intentionally never collected. */
export function collectV2EditorDOM(body: HTMLElement | SVGElement): V2DOMSnapshot {
  const visible = (element: Element) => {
    const style = window.getComputedStyle(element), box = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
  };
  const text = (element: Element) => (element as HTMLElement).innerText?.trim() || element.textContent?.trim() || "";
  const locator = (element: Element) => {
    if (element.id) return `#${CSS.escape(element.id)}`;
    const parts: string[] = []; let node: Element | null = element;
    while (node && node !== body && parts.length < 7) {
      const parent: Element | null = node.parentElement;
      const index = parent ? Array.from(parent.children).indexOf(node) + 1 : 1;
      parts.unshift(`${node.tagName.toLowerCase()}:nth-child(${index})`); node = parent;
    }
    return `body > ${parts.join(" > ")}`;
  };
  const labels = (element: Element) => {
    const result: string[] = [];
    const associated = (element as HTMLInputElement).labels;
    if (associated) for (const label of Array.from(associated)) if (text(label)) result.push(text(label));
    const aria = element.getAttribute("aria-label"); if (aria?.trim()) result.push(aria.trim());
    for (const id of (element.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean)) {
      const label = document.getElementById(id); if (label && text(label)) result.push(text(label));
    }
    return Array.from(new Set(result));
  };
  const sections = (label: string, selectors: string) => {
    const found = Array.from(body.querySelectorAll(selectors)).filter(element => {
      if (!visible(element)) return false;
      const aria = element.getAttribute("aria-label")?.trim().toLowerCase();
      const heading = element.querySelector("h1,h2,h3,h4,legend");
      return aria === label || !!heading && text(heading).toLowerCase() === label || /data-testid=|#/.test(selectors) && !["SECTION", "FIELDSET"].includes(element.tagName);
    });
    return found.filter(element => !found.some(other => other !== element && element.contains(other)));
  };
  const specificSections = sections("item specifics", '[aria-label="Item specifics"],[data-testid="item-specifics"],[data-testid="item-specifics-section"],section,fieldset');
  const photoSections = sections("photos", '[aria-label="Photos"],[data-testid="photos-section"],[data-testid="photo-manager"],[data-testid="picture-uploader"],#pictureUploadView,#photo-uploader,section,fieldset');
  const controls: V2DOMControl[] = [];
  const hiddenIds = /^(?:categoryId|categoryid|primaryCategoryId|conditionId|conditionDescriptorId|conditionDescriptorValueId|paymentPolicyId|returnPolicyId|shippingPolicyId|paymentProfileId|returnProfileId|shippingProfileId)$/;
  for (const element of Array.from(body.querySelectorAll("input,textarea,select,[contenteditable=true],iframe[title]"))) {
    const isHidden = element.tagName === "INPUT" && (element as HTMLInputElement).type === "hidden";
    if (element.tagName === "INPUT" && (element as HTMLInputElement).type === "password") continue;
    if (isHidden && !hiddenIds.test(element.getAttribute("name") || element.id)) continue;
    if (!isHidden && !visible(element)) continue;
    let elementLabels = labels(element), binding: V2DOMControl["visibleBinding"];
    if (isHidden) {
      let group = element.parentElement;
      for (let depth = 0; group && depth < 4 && !binding; depth++, group = group.parentElement) {
        const choice = Array.from(group.querySelectorAll('select,[role="combobox"],button[aria-haspopup="listbox"]')).find(visible);
        if (!choice) continue;
        const choiceLabels = labels(choice);
        const selected = choice.tagName === "SELECT" ? (choice as HTMLSelectElement).selectedOptions[0]?.label || "" : text(choice);
        if (!choiceLabels.length || !selected) continue;
        binding = { locator: locator(choice), label: selected }; elementLabels = [...choiceLabels, element.getAttribute("name") || element.id];
      }
      if (!binding) continue;
    }
    let value = "", kind: V2DOMControl["kind"] = isHidden ? "hidden" : element.tagName === "SELECT" ? "select" : element.tagName === "TEXTAREA" ? "textarea" : "input";
    if (element.tagName === "IFRAME") {
      if (!/^(?:item )?description$/i.test(element.getAttribute("title")?.trim() || "")) continue;
      try { value = (element as HTMLIFrameElement).contentDocument?.body?.innerText?.trim() || ""; } catch { continue; }
      if (!value) continue; kind = "richtext"; elementLabels = [element.getAttribute("title")!];
    } else if (element.getAttribute("contenteditable") === "true") { value = text(element); kind = "richtext"; }
    else value = (element as HTMLInputElement).value;
    if (value.length > 20000 || !elementLabels.length) continue;
    controls.push({ locator: locator(element), labels: elementLabels, value, visible: !isHidden, kind,
      selectedOptions: element.tagName === "SELECT" ? Array.from((element as HTMLSelectElement).selectedOptions).map(option => ({ value: option.value, label: option.label })) : [],
      ...(binding ? { visibleBinding: binding } : {}), inSpecifics: specificSections.some(section => section.contains(element)) });
  }
  const readTexts = (selectors: string) => Array.from(body.querySelectorAll(selectors)).filter(visible).map(element => ({ locator: locator(element), value: text(element) })).filter(row => !!row.value);
  const sellers = readTexts('[data-testid="seller-username"],[data-testid="account-username"],#gh-ug-user,#gh-ug-username,[aria-label="Seller username"]');
  const savedStatus = readTexts('[role="status"],[data-testid="save-status"],[data-testid="draft-save-status"]').filter(row => /^(?:draft\s+)?saved(?:\s+(?:at|on)\s+.+)?$/i.test(row.value));
  const issues = Array.from(body.querySelectorAll('[data-testid="listing-issues"],[data-testid="validation-summary"],[aria-label="Listing issues"],[aria-label="Errors"]')).filter(visible);
  const errors = issues.flatMap(summary => Array.from(summary.querySelectorAll('[role="alert"],li,[data-testid="listing-error"]')).filter(visible)
    .map(element => ({ locator: locator(element), value: text(element) })).filter(row => !!row.value));
  const photos = photoSections.flatMap(section => Array.from(section.querySelectorAll("img")).filter(element => visible(element) && element.getBoundingClientRect().width >= 25 && element.getBoundingClientRect().height >= 25)
    .map(element => ({ locator: locator(element), url: (element as HTMLImageElement).currentSrc || (element as HTMLImageElement).src })));
  return { controls, sellers, savedStatus, specificsSections: specificSections.length, photoSections: photoSections.length, photos,
    issueSummaryObserved: issues.length === 1, errors };
}

const normalize = (value: string) => value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
const fail = (message: string): never => { throw new V2BrowserReadbackError("UNSUPPORTED_EDITOR", message); };
function findControl(snapshot: V2DOMSnapshot, alternatives: string[], inSpecifics = false) {
  const aliases = new Set(alternatives.map(normalize));
  const found = snapshot.controls.filter(control => control.inSpecifics === inSpecifics && control.labels.some(label => aliases.has(normalize(label))));
  if (found.length !== 1) fail(`Exactly one independently observed editor control is required for ${alternatives[0]}.`);
  return found[0];
}
function valueField(control: V2DOMControl): Field {
  return { locator: control.locator, visible: control.visible, readMethod: control.kind === "select" ? "selected-option-value" : control.kind === "richtext" ? "inner-text" : "input-value",
    value: control.value, ...(control.visibleBinding ? { visibleBinding: control.visibleBinding } : {}) };
}
function labelField(control: V2DOMControl): Field {
  if (control.kind === "select") {
    if (control.selectedOptions.length !== 1) fail("A unique actual selected option is required.");
    return { locator: `${control.locator} > option:checked`, visible: true, readMethod: "selected-option-label", value: control.selectedOptions[0].label };
  }
  if (control.visibleBinding) return { locator: control.visibleBinding.locator, visible: true, readMethod: "inner-text", value: control.visibleBinding.label };
  return fail("A visible actual selected label must accompany each condition or policy ID.");
}
function textField(rows: Array<{ locator: string; value: string }>, purpose: string): Field {
  if (!rows.length || new Set(rows.map(row => row.value)).size !== 1) fail(`A unique visible ${purpose} observation is required.`);
  return { ...rows[0], visible: true, readMethod: "inner-text" };
}

/** Concrete, read-only driver. Selector support is deliberately finite: labeled
 * native inputs/selects, actual numeric hidden form IDs linked to visible choices,
 * and documented public DOM sections. A changed/custom unsupported editor blocks
 * instead of falling back to expected fields or private application endpoints. */
export function createV2PlaywrightDraftReadbackDriver(page: V2ReadbackPage, options: V2PlaywrightDriverOptions): V2SavedDraftBrowserDriver {
  return { kind: "playwright-visible-dom", async readReopenedDraft(draftId: string) {
    if (!/^\d+$/.test(draftId)) fail("A numeric existing owned draft ID is required.");
    if (!options?.loadHostedOriginalEvidence || !options.readDescriptionProvenance) fail("Independent media orientation and description provenance adapters are not connected.");
    const url = `https://www.ebay.com/sl/sell?draft_id=${draftId}`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    const first = await page.locator("body").evaluate(collectV2EditorDOM);
    textField(first.savedStatus, "saved draft status"); const savedAt = new Date().toISOString();
    // The second full navigation reads persisted editor controls; no Save, edit,
    // upload, publish or private API call is performed by this readback driver.
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }); const reopenedAt = new Date().toISOString();
    const snapshot = await page.locator("body").evaluate(collectV2EditorDOM);
    if (snapshot.specificsSections !== 1 || snapshot.photoSections !== 1 || !snapshot.issueSummaryObserved) fail("The actual specifics, photos and issue-summary sections must each be independently readable.");
    const c = (aliases: string[]) => findControl(snapshot, aliases);
    const title = valueField(c(["Title", "Listing title"])), sku = valueField(c(["Custom label (SKU)", "Custom label", "SKU"]));
    const categoryId = valueField(c(["Category", "Category ID", "categoryId", "primaryCategoryId"]));
    const quantity = valueField(c(["Quantity", "Available quantity"]));
    const conditionControl = c(["Condition", "Condition type", "conditionId"]), conditionId = valueField(conditionControl), conditionLabel = labelField(conditionControl);
    const descriptorControl = c(["Card Condition descriptor ID", "conditionDescriptorId"]), valueControl = c(["Card Condition", "Card condition", "conditionDescriptorValueId"]);
    const descriptorId = valueField(descriptorControl), descriptorName = { locator: `${valueControl.locator}:associated-label`, visible: true as const, readMethod: "inner-text" as const,
      value: valueControl.labels.find(label => normalize(label) === "card condition") || fail("Actual Card Condition label is missing.") };
    const valueId = valueField(valueControl), valueName = labelField(valueControl);
    const description = valueField(c(["Description", "Item description"]));
    const actualSpecifics = snapshot.controls.filter(control => control.inSpecifics);
    const specifics = actualSpecifics.map(control => {
      if (!control.visible || control.kind === "hidden") fail("Unsupported item-specific control needs an actual visible value reader.");
      const name = control.labels[0];
      const values = control.kind === "select" ? control.selectedOptions.filter(option => option.value !== "").map(option => ({ locator: `${control.locator} > option:checked`, visible: true as const, readMethod: "selected-option-label" as const, value: option.label })) : [valueField(control)];
      return { name: { locator: `${control.locator}:associated-label`, visible: true as const, readMethod: "inner-text" as const, value: name }, values };
    });
    const policy = (aliases: string[]) => { const control = c(aliases); return { id: valueField(control), label: labelField(control) }; };
    const media = await options.loadHostedOriginalEvidence();
    if (snapshot.photos.length !== 2) fail("Exactly two actual rendered photo resources are required.");
    const photos = snapshot.photos.map((photo, renderOrder) => {
      const resourceId = normalizedEbayImageResource(photo.url);
      const matches = media.filter(item => item.uprightReviewed && resourceId && normalizedEbayImageResource(item.url) === resourceId);
      if (!resourceId || matches.length !== 1) fail("Rendered photos require a unique independent hosted-original hash and orientation receipt.");
      const bound = matches[0];
      return { url: { locator: photo.locator, visible: true as const, readMethod: "rendered-image-src" as const, value: photo.url }, renderOrder, uprightObserved: true as const, visualEvidence: bound.evidence,
        orientation: { source: "bound-hosted-original-review" as const, resourceId, originalHash: bound.originalHash, evidence: bound.evidence } };
    });
    const observedUrl = page.url(), activeId = observedV2DraftId(observedUrl);
    if (activeId !== draftId) fail("Browser did not reopen the exact owned eBay draft URL.");
    return v2DraftEditorObservationSchema.parse({ kind: "observed-reopened-ebay-draft-editor", driver: "playwright-visible-dom", url: observedUrl, observedAt: new Date().toISOString(),
      seller: textField(snapshot.sellers, "signed-in seller username"),
      draftId: { locator: "browser-address-bar:draft-id", visible: true, readMethod: "inner-text", value: activeId },
      save: { status: textField(snapshot.savedStatus, "saved draft status"), savedAt, reopenedAt, basis: "observed-saved-status-before-reopen" },
      title, sku, categoryId, quantity, specificsComplete: true, specifics,
      condition: { id: conditionId, label: conditionLabel, descriptorId, descriptorName, valueId, valueName }, description,
      descriptionProvenance: await options.readDescriptionProvenance(draftId, description.value),
      itemPrice: valueField(c(["Price", "Item price", "Buy It Now price"])), shippingAmount: valueField(c(["Shipping cost", "Shipping amount", "Buyer pays"])),
      policies: { payment: policy(["Payment policy", "Payment profile", "paymentPolicyId", "paymentProfileId"]), returns: policy(["Return policy", "Return profile", "returnPolicyId", "returnProfileId"]),
        shipping: policy(["Shipping policy", "Shipping profile", "shippingPolicyId", "shippingProfileId"]), location: valueField(c(["Item location", "Location"])) },
      photosComplete: true, photos, issueSummaryObserved: true, editorErrors: snapshot.errors.map(row => ({ ...row, visible: true, readMethod: "inner-text" })),
    });
  } };
}
