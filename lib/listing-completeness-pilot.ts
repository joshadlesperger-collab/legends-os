import { Prisma, type EbayActionExecution } from "@prisma/client";
import { prisma } from "./prisma.ts";
import { getCategoryAspects } from "./ebay-taxonomy.ts";
import { getEbayUser, getItem, getValidAccessToken, reviseFixedPriceItemSpecifics, type EbayItemSpecific, type EbayListingItem } from "./ebay.ts";
import { assessListingCompleteness, type FieldProposal, type ListingCompletenessAssessment } from "./listing-completeness-agent.ts";

export const LISTING_COMPLETENESS_PILOT_VERSION = "weekend-completeness-pilot-v1.0.0";
export const LISTING_COMPLETENESS_PILOT_APPROVAL = "weekend-canary-2026-08-22";
const ALLOWED_EXACT_FIELDS = new Set(["Sport", "Manufacturer", "Card Number"]);
const exactName = (left: string, right: string) => left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0;
const allowedPatch = (patch: FieldProposal) => Boolean(patch.targetAspect) && (ALLOWED_EXACT_FIELDS.has(patch.targetAspect!) || patch.semanticFamily === "year");

type PilotProvider = {
  getItem: typeof getItem;
  getEbayUser: typeof getEbayUser;
  getCategoryAspects: typeof getCategoryAspects;
  reviseItemSpecifics: typeof reviseFixedPriceItemSpecifics;
};
export const listingCompletenessPilotProvider: PilotProvider = { getItem, getEbayUser, getCategoryAspects, reviseItemSpecifics: reviseFixedPriceItemSpecifics };
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const specifics = (item: EbayListingItem): EbayItemSpecific[] => {
  const raw = item.ItemSpecifics?.NameValueList;
  return (raw == null ? [] : Array.isArray(raw) ? raw : [raw]).flatMap(row => {
    const name = row.Name?.trim();
    const values = (Array.isArray(row.Value) ? row.Value : row.Value == null ? [] : [row.Value]).map(value => String(value).trim()).filter(Boolean);
    return name && values.length ? [{ Name: name, Value: values }] : [];
  });
};
const normalizedSpecifics = (rows: EbayItemSpecific[]) => Object.fromEntries(rows.map(row => [row.Name, [...row.Value]]));
const providerPrice = (item: EbayListingItem) => { const value = item.SellingStatus?.CurrentPrice; return Number(value && typeof value === "object" ? value["#text"] : value); };
const immutableListingState = (item: EbayListingItem) => ({ itemId: String(item.ItemID), title: item.Title, description: item.Description ?? null, categoryId: item.PrimaryCategory?.CategoryID == null ? null : String(item.PrimaryCategory.CategoryID), listingType: item.ListingType ?? null, condition: item.ConditionDisplayName ?? null, price: providerPrice(item), quantity: Number(item.Quantity), images: Array.isArray(item.PictureDetails?.PictureURL) ? item.PictureDetails?.PictureURL : item.PictureDetails?.PictureURL ? [item.PictureDetails.PictureURL] : [], itemSpecifics: normalizedSpecifics(specifics(item)) });
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => [key, canonical(nested)])) : value;
const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const withoutFields = (state: ReturnType<typeof immutableListingState>, fields: string[]) => ({ ...state, itemSpecifics: Object.fromEntries(Object.entries(state.itemSpecifics).filter(([name]) => !fields.some(field => exactName(field, name)))) });
const active = (item: EbayListingItem) => String(item.SellingStatus?.ListingStatus ?? "").toLocaleLowerCase() === "active";

export function selectPilotAssessments(assessments: ListingCompletenessAssessment[], limit = 100) {
  return assessments.filter(assessment => assessment.disposition === "AUTO-FIX" && assessment.authoritative && Boolean(assessment.categoryId) && assessment.categoryRequirements.available && assessment.conflicts.length === 0 && assessment.malformedFields.length === 0 && assessment.proposedPatch.length > 0 && assessment.proposedPatch.every(patch => allowedPatch(patch) && patch.disposition === "AUTO-FIX" && patch.confidence >= 99 && patch.before === null)).slice(0, limit);
}

async function appendEvent(executionId: string, type: string, snapshot: unknown) {
  const latest = await prisma.ebayActionExecutionEvent.findFirst({ where: { executionId }, orderBy: { sequence: "desc" }, select: { sequence: true } });
  return prisma.ebayActionExecutionEvent.create({ data: { executionId, sequence: (latest?.sequence ?? 0) + 1, type, snapshot: json(snapshot) } });
}

async function executionRecord(assessment: ListingCompletenessAssessment, storeId: string, operatorId: string, liveBefore: unknown) {
  const decision = await prisma.operatorDecision.create({ data: { listingId: assessment.listingId, operatorId, recommendedAction: "LISTING_COMPLETENESS", doctrineVersion: LISTING_COMPLETENESS_PILOT_VERSION, decision: "approved_weekend_canary", beforeState: json(liveBefore), evidenceSnapshot: json({ assessment, approvalBoundary: LISTING_COMPLETENESS_PILOT_APPROVAL }), observationWindowDays: 30 } });
  const execution = await prisma.ebayActionExecution.create({ data: { listingId: assessment.listingId, storeId, decisionId: decision.id, operatorId, action: "LISTING_COMPLETENESS", doctrineVersion: LISTING_COMPLETENESS_PILOT_VERSION, idempotencyKey: `${LISTING_COMPLETENESS_PILOT_APPROVAL}:${assessment.ebayItemId}`, oldEbayItemId: assessment.ebayItemId, beforeState: json(liveBefore), proposedState: json(assessment.proposedPatch), evidenceSnapshot: json({ assessment, interventionAt: new Date().toISOString() }) } });
  await appendEvent(execution.id, "approved", { policy: LISTING_COMPLETENESS_PILOT_VERSION, patch: assessment.proposedPatch });
  return execution;
}

async function mark(execution: EbayActionExecution, status: string, event: string, snapshot: unknown) {
  await appendEvent(execution.id, event, snapshot);
  return prisma.ebayActionExecution.update({ where: { id: execution.id }, data: { status, ...(status === "verified" ? { providerVerifiedAt: new Date() } : {}) } });
}

export async function executeListingCompletenessCandidate(input: { assessment: ListingCompletenessAssessment; operatorId: string; approvalMarker: string; provider?: PilotProvider }) {
  if (input.approvalMarker !== LISTING_COMPLETENESS_PILOT_APPROVAL) throw new Error("The exact governed pilot approval marker is required");
  const provider = input.provider ?? listingCompletenessPilotProvider;
  const listing = await prisma.listing.findUniqueOrThrow({ where: { id: input.assessment.listingId }, include: { store: true } });
  const prior = await prisma.ebayActionExecution.findUnique({ where: { idempotencyKey: `${LISTING_COMPLETENESS_PILOT_APPROVAL}:${listing.ebayItemId}` } });
  if (prior) return prior;
  const { accessToken } = await getValidAccessToken(listing.store);
  const seller = await provider.getEbayUser(accessToken);
  if (!listing.store.ebaySellerUsername || seller.userId.localeCompare(listing.store.ebaySellerUsername, undefined, { sensitivity: "accent" }) !== 0) throw new Error("Authenticated provider seller identity does not match the connected store");
  const beforeItem = await provider.getItem(accessToken, listing.ebayItemId);
  const before = immutableListingState(beforeItem);
  let execution = await executionRecord(input.assessment, listing.storeId, input.operatorId, before);
  try {
    if (!active(beforeItem)) return mark(execution, "skipped", "preflight_skipped", { reason: "Listing is not active" });
    if (before.listingType !== "FixedPriceItem") return mark(execution, "skipped", "preflight_skipped", { reason: "Only FixedPriceItem is supported by this canary" });
    if (before.categoryId !== input.assessment.categoryId) return mark(execution, "skipped", "preflight_skipped", { reason: "Authoritative category changed" });
    const categoryAspects = await provider.getCategoryAspects(accessToken, before.categoryId!);
    const refreshed = assessListingCompleteness({ listingId: listing.id, ebayItemId: listing.ebayItemId, title: beforeItem.Title, categoryId: before.categoryId, itemSpecifics: before.itemSpecifics, authoritativeSource: "ebay-trading-get-item", authoritativeObservedAt: new Date(), aspects: categoryAspects });
    const original = input.assessment.proposedPatch;
    const patches = refreshed.proposedPatch.filter(patch => allowedPatch(patch) && patch.disposition === "AUTO-FIX" && patch.confidence >= 99 && patch.before === null && original.some(old => old.targetAspect === patch.targetAspect && old.proposed === patch.proposed));
    if (!patches.length || patches.length !== original.length || refreshed.conflicts.length || refreshed.malformedFields.length) return mark(execution, "skipped", "preflight_skipped", { reason: "Live deterministic proposal no longer exactly matches the approved proposal", refreshed });
    const currentSpecifics = specifics(beforeItem);
    for (const patch of patches) if (currentSpecifics.some(row => exactName(patch.targetAspect!, row.Name))) return mark(execution, "skipped", "preflight_skipped", { reason: `${patch.targetAspect} is no longer missing` });
    const payload = [...currentSpecifics, ...patches.map((patch: FieldProposal) => { const aspect = categoryAspects.find(row => exactName(patch.targetAspect!, row.name)); if (!aspect) throw new Error(`${patch.targetAspect} is absent from current Taxonomy`); if (aspect.allowedValues.length && !aspect.allowedValues.some(value => value.localeCompare(patch.proposed, undefined, { sensitivity: "accent" }) === 0)) throw new Error(`${patch.targetAspect} no longer conforms to current Taxonomy`); return { Name: aspect.name, Value: [patch.proposed] }; })];
    await appendEvent(execution.id, "server_revalidated", { seller: seller.userId, before, patch: patches, taxonomyCategoryId: before.categoryId, payloadBehavior: "complete ItemSpecifics replacement preserving all unrelated values" });
    execution = await prisma.ebayActionExecution.update({ where: { id: execution.id }, data: { status: "executing", proposedState: json({ patch: patches, fullReplacementPayload: normalizedSpecifics(payload) }) } });
    const providerResult = await provider.reviseItemSpecifics(accessToken, listing.ebayItemId, payload, execution.idempotencyKey);
    await appendEvent(execution.id, "provider_accepted", providerResult);
    const afterItem = await provider.getItem(accessToken, listing.ebayItemId);
    const after = immutableListingState(afterItem);
    for (const patch of patches) {
      const received = Object.entries(after.itemSpecifics).find(([name]) => exactName(patch.targetAspect!, name))?.[1];
      if (!received?.some(value => value.localeCompare(patch.proposed, undefined, { sensitivity: "accent" }) === 0)) throw new Error(`Provider reconciliation did not return ${patch.targetAspect}=${patch.proposed}`);
    }
    const intendedFields = patches.map(patch => patch.targetAspect!);
    if (!same(withoutFields(before, intendedFields), withoutFields(after, intendedFields))) throw new Error("Unintended provider mutation detected while applying approved item-specific patches");
    await appendEvent(execution.id, "provider_verified", { before, after, intendedPatch: patches, unintendedChanges: [] });
    await prisma.listing.update({ where: { id: listing.id }, data: { itemSpecifics: json(after.itemSpecifics), authoritativeSource: "ebay-trading-get-item", authoritativeObservedAt: new Date(), lastSyncedAt: new Date() } });
    return prisma.ebayActionExecution.update({ where: { id: execution.id }, data: { status: "verified", providerVerifiedAt: new Date() } });
  } catch (error) {
    await mark(execution, "failed", "execution_failed", { message: error instanceof Error ? error.message : "Provider action failed" });
    throw error;
  }
}
