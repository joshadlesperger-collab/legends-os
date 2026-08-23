import nextEnv from "@next/env";
const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd(), true);

import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.ts";
import { getValidAccessToken } from "../lib/ebay.ts";
import { getEbayApplicationAccessToken, getBrowseItemByLegacyId, type EbayBrowseItem } from "../lib/ebay-browse.ts";
import { ebayGetJson } from "../lib/ebay-readonly.ts";
import { bulkCreateAdsByListingId, getAdvertisingEligibility, getCampaignAdvertisingContext, type BulkCreateAdResult } from "../lib/ebay-marketing.ts";

const CAMPAIGN_ID = "135950457010";
const RATE = "5.0";
const OPERATOR_ID = "operator-approved-promoted-coverage-2026-08-23";
const APPROVED_IDS = `128036977254 128037210854 127954345162 127895622852 127901999224 128018340661 128018361748 128018366543 128018366560 128018366573 128018366576 128018366577 128018366579 128018366581 128018366582 128018366587 128018366597 128018366618 128018366636 128018366637 128018366638 128018366642 128018366647 128018366648 128018366649 128018366650 128018366653 128018366665 128018366678 128018366682 128018366685 128018366688 128018366690 128018372218 128018372223 128018372241 128018372261 128018372279 128018372280 128018372282 128018372283 128018372285 128018372286 128018372289 128018372290 128018372292 128018372293 128018372294 128018372295 128018372296 128018372297 128018372299 128018372300 128018372302 128018372303 128018372304 128018372305 128018372322 128018372331 128018372336 128018372342 128018372343 128018372344 128018372346 128018372347 128018372348 128018372350 128018372351 128018372352 128018372356 128018372357 128018372358 128018372359 128018372360 128018372361 128018372362 128018372363 128018372364 128018372365 128018372367 128018372368 128018372370 128018372384 128018372386 128018372387 128018372388 128018372389 128018372390 128018377248 128018377289 128018377316 128018377338 128018377339 128018377340 128018377341 128018377342 128018377344 128018377345 128018377346 128018377347 128018377348 128018377349 128018377350 128018377352 128018377353 128018377379 128018377380 128018377384 128018377398 128018377401 128018377402 128018377403 128018377405 128018377416 128018377426 128018377440 128018386330 128018386331 128018386332 128018386449 128018386455 128018386456 128018386494 128018386520 128018390292 128018390307 128018390309 128018390344 128018390346 128018390348 128018390349 128018390350 128018390353 128018390396 128026862317 128026867652 128026906603 128026929744 128026950395 128027337928 128027434588 128033619376 128035363638 128035398727 128035408440 128035454128 128036987424 128036990229 128036991375 128037000704 128038304631 128038406448 128012783326 128020098816`.split(" ");
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function listingState(item: EbayBrowseItem) {
  return {
    title: item.title,
    price: Number(item.price?.value),
    quantity: Number(item.estimatedAvailabilities?.[0]?.estimatedAvailableQuantity),
    categoryId: item.categoryId ?? null,
    condition: item.condition ?? null,
    images: [item.image?.imageUrl, ...(item.additionalImages ?? []).map((image) => image.imageUrl)].filter(Boolean),
    aspects: (item.localizedAspects ?? []).map((aspect) => [aspect.name ?? "", aspect.value ?? ""]).sort((a, b) => a[0].localeCompare(b[0])),
  };
}

async function appendEvent(executionId: string, type: string, snapshot: unknown) {
  const latest = await prisma.ebayActionExecutionEvent.findFirst({ where: { executionId }, orderBy: { sequence: "desc" }, select: { sequence: true } });
  await prisma.ebayActionExecutionEvent.create({ data: { executionId, sequence: (latest?.sequence ?? 0) + 1, type, snapshot: json(snapshot) } });
}

async function marketingReadback(accessToken: string, eligibility: { eligible: boolean | null; programStatus: string | null; observedAt: string }, expectedIds: string[]) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const result = await getCampaignAdvertisingContext(accessToken, eligibility);
    if (attempt === 3 || expectedIds.every((id) => result.contexts.get(id)?.campaignId === CAMPAIGN_ID && result.contexts.get(id)?.adRate === 5)) return result;
    await sleep(2_000);
  }
  throw new Error("Marketing readback unavailable");
}

async function main() {
  if (!process.argv.includes("--execute-approved-154")) throw new Error("Explicit approved execution flag required");
  if (APPROVED_IDS.length !== 154 || new Set(APPROVED_IDS).size !== 154) throw new Error("Approved population identity check failed");
  const store = await prisma.store.findFirst({ where: { isActive: true, connectionStatus: "connected" } });
  if (!store) throw new Error("No connected Store #1");
  const [{ accessToken }, browseToken] = await Promise.all([getValidAccessToken(store), getEbayApplicationAccessToken()]);
  const eligibility = await getAdvertisingEligibility(accessToken);
  if (eligibility.eligible !== true || eligibility.programStatus !== "ELIGIBLE") throw new Error("Seller advertising eligibility is not ELIGIBLE");
  const campaign = await ebayGetJson<{ campaignId?: string; campaignStatus?: string; fundingStrategy?: { fundingModel?: string; adRateStrategy?: string } }>("marketing-campaign", `/sell/marketing/v1/ad_campaign/${CAMPAIGN_ID}`, accessToken);
  if (campaign.campaignId !== CAMPAIGN_ID || campaign.campaignStatus !== "RUNNING") throw new Error("Approved campaign is not RUNNING");
  if (campaign.fundingStrategy?.fundingModel && campaign.fundingStrategy.fundingModel !== "COST_PER_SALE") throw new Error("Approved campaign is not a supported CPS campaign");
  const beforeMarketing = await getCampaignAdvertisingContext(accessToken, eligibility);
  const listings = await prisma.listing.findMany({ where: { storeId: store.id, ebayItemId: { in: APPROVED_IDS }, listingStatus: "active" } });
  const byItemId = new Map(listings.map((listing) => [listing.ebayItemId, listing]));
  const candidates: Array<{ listing: (typeof listings)[number]; before: EbayBrowseItem; executionId: string }> = [];
  const skipped: Array<{ itemId: string; reason: string }> = [];
  for (const itemId of APPROVED_IDS) {
    const listing = byItemId.get(itemId);
    if (!listing) { skipped.push({ itemId, reason: "not active in authoritative inventory" }); continue; }
    if (listing.authoritativeSource?.includes("migration") && Date.now() - (listing.authoritativeObservedAt ?? listing.lastSyncedAt).getTime() < 72 * 3_600_000) { skipped.push({ itemId, reason: "newly migrated / expected lag" }); continue; }
    if (beforeMarketing.contexts.has(itemId)) { skipped.push({ itemId, reason: "ad appeared before execution" }); continue; }
    try {
      const before = await getBrowseItemByLegacyId(browseToken, itemId);
      if (!before.buyingOptions?.includes("FIXED_PRICE") || before.estimatedAvailabilities?.[0]?.estimatedAvailabilityStatus !== "IN_STOCK" || Number(before.estimatedAvailabilities?.[0]?.estimatedAvailableQuantity) < 1) throw new Error("listing is not active fixed-price inventory");
      if (before.title !== listing.title || Number(before.price?.value) !== Number(listing.currentPrice) || before.categoryId !== listing.categoryId) throw new Error("live listing state differs from reviewed state");
      const decision = await prisma.operatorDecision.create({ data: { listingId: listing.id, operatorId: OPERATOR_ID, recommendedAction: "INCREASE ADS", doctrineVersion: "promoted-coverage-v1", decision: "follow_recommendation", beforeState: json({ listing: listingState(before), advertising: null }), evidenceSnapshot: json({ approvedPopulation: 154, campaign, eligibility, marketingObservedAt: beforeMarketing.defaultContext.observedAt }), observationWindowDays: 14 } });
      const execution = await prisma.ebayActionExecution.create({ data: { listingId: listing.id, storeId: store.id, decisionId: decision.id, operatorId: OPERATOR_ID, action: "CREATE_PROMOTED_AD", doctrineVersion: "promoted-coverage-v1", idempotencyKey: `promoted-coverage:${CAMPAIGN_ID}:${itemId}:5.0`, oldEbayItemId: itemId, beforeState: json({ listing: listingState(before), advertising: null }), proposedState: json({ campaignId: CAMPAIGN_ID, bidPercentage: RATE }), evidenceSnapshot: json({ eligibility, campaign }) } });
      await appendEvent(execution.id, "approved_and_preflight_verified", { itemId, before: listingState(before), campaignId: CAMPAIGN_ID, rate: RATE });
      await prisma.ebayActionExecution.update({ where: { id: execution.id }, data: { status: "executing" } });
      candidates.push({ listing, before, executionId: execution.id });
    } catch (error) { skipped.push({ itemId, reason: error instanceof Error ? error.message : String(error) }); }
  }

  const results: Array<{ itemId: string; status: string; adId?: string; error?: string; executionId?: string }> = [];
  async function executeBatch(batch: typeof candidates) {
    let provider: BulkCreateAdResult[] = [];
    let providerError: string | null = null;
    try { provider = await bulkCreateAdsByListingId(accessToken, CAMPAIGN_ID, batch.map((row) => row.listing.ebayItemId), RATE); }
    catch (error) { providerError = error instanceof Error ? error.message : String(error); }
    const providerById = new Map(provider.map((row) => [row.listingId, row]));
    const afterMarketing = await marketingReadback(accessToken, eligibility, batch.map((row) => row.listing.ebayItemId));
    for (const row of batch) {
      const itemId = row.listing.ebayItemId, response = providerById.get(itemId), context = afterMarketing.contexts.get(itemId), adCount = afterMarketing.listingAdCounts.get(itemId) ?? 0;
      await appendEvent(row.executionId, "provider_result", { response: response ?? null, topLevelError: providerError });
      try {
        if (!context?.adId || context.campaignId !== CAMPAIGN_ID || context.adRate !== 5 || adCount !== 1) throw new Error(response?.errors.map((error) => error.message).join("; ") || providerError || "Promoted ad did not reconcile exactly");
        const after = await getBrowseItemByLegacyId(browseToken, itemId);
        if (JSON.stringify(listingState(after)) !== JSON.stringify(listingState(row.before))) throw new Error("Unintended underlying listing-state change detected");
        await prisma.ebayActionExecution.update({ where: { id: row.executionId }, data: { status: "verified", providerVerifiedAt: new Date() } });
        await appendEvent(row.executionId, "provider_verified", { itemId, adId: context.adId, campaignId: context.campaignId, adRate: context.adRate, adCount, afterListing: listingState(after), unintendedChanges: [] });
        results.push({ itemId, status: "verified", adId: context.adId, executionId: row.executionId });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await prisma.ebayActionExecution.update({ where: { id: row.executionId }, data: { status: "failed" } });
        await appendEvent(row.executionId, "execution_failed", { itemId, message, automaticRetryProhibited: true });
        results.push({ itemId, status: "failed", error: message, executionId: row.executionId });
      }
    }
  }

  const canary = candidates.slice(0, 10);
  if (canary.length !== 10) { console.log(JSON.stringify({ initialApproved: 154, freshEligible: candidates.length, skipped, writesPerformed: 0, store2Mutations: 0 }, null, 2)); throw new Error(`Fail closed: only ${canary.length} canary candidates passed fresh preflight`); }
  await executeBatch(canary);
  const canaryResults = results.slice();
  if (canaryResults.some((row) => row.status !== "verified")) {
    console.log(JSON.stringify({ initialApproved: 154, freshEligible: candidates.length, skipped, canary: canaryResults, rolloutStopped: true, store2Mutations: 0 }, null, 2));
    return;
  }
  await executeBatch(candidates.slice(10));
  const finalMarketing = await getCampaignAdvertisingContext(accessToken, eligibility);
  console.log(JSON.stringify({ initialApproved: 154, freshEligible: candidates.length, canary: { attempted: 10, verified: 10 }, totalVerified: results.filter((row) => row.status === "verified").length, failed: results.filter((row) => row.status === "failed"), skipped, duplicateAds: results.filter((row) => row.status === "verified" && (finalMarketing.listingAdCounts.get(row.itemId) ?? 0) !== 1).length, exactFivePercent: results.filter((row) => row.status === "verified" && finalMarketing.contexts.get(row.itemId)?.adRate === 5).length, unintendedListingChanges: results.filter((row) => row.error?.includes("Unintended")).length, results, promotedActiveAfter: listings.length - skipped.filter((row) => row.reason === "ad appeared before execution").length, store2Mutations: 0 }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => prisma.$disconnect());
