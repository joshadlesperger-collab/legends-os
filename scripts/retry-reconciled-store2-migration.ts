import nextEnv from "@next/env";
const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd(), true);

import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.ts";
import { addFixedPriceItemXml, callTradingApi, getActiveListings, getItem, getValidAccessToken, type EbayListingItem } from "../lib/ebay.ts";
import { getBrowseItemByLegacyId, getEbayApplicationAccessToken } from "../lib/ebay-browse.ts";
import { createListingOnceWithMandatorySkuRecovery } from "../lib/ebay-listing-migration.ts";

const SOURCE_ID = "358847683279";
const SKU = `MIG-${SOURCE_ID}`;
const EXECUTION_ID = "cmt7xueag008hio2gbpbb9jo5";
const POLICY = { payment: "248164941010", returns: "248164940010", shipping: "248164775010" };
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const esc = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
const currentPrice = (item: EbayListingItem) => { const raw = item.SellingStatus?.CurrentPrice; return Number(raw && typeof raw === "object" ? raw["#text"] : raw); };
const itemImages = (item: EbayListingItem) => { const raw = item.PictureDetails?.PictureURL; return raw ? (Array.isArray(raw) ? raw : [raw]) : []; };

async function appendEvent(type: string, snapshot: unknown) {
  const latest = await prisma.ebayActionExecutionEvent.findFirst({ where: { executionId: EXECUTION_ID }, orderBy: { sequence: "desc" }, select: { sequence: true } });
  await prisma.ebayActionExecutionEvent.create({ data: { executionId: EXECUTION_ID, sequence: (latest?.sequence ?? 0) + 1, type, snapshot: json(snapshot) } });
}

async function main() {
  if (!process.argv.includes("--execute-governed-retry")) throw new Error("Explicit governed retry flag is required");
  const execution = await prisma.ebayActionExecution.findUnique({ where: { id: EXECUTION_ID }, include: { listing: true, decision: true, events: { orderBy: { sequence: "desc" } } } });
  if (!execution || execution.oldEbayItemId !== SOURCE_ID || execution.status !== "failed") throw new Error("Retry execution is not in the expected failed state");
  if (execution.newEbayItemId) throw new Error("Retry prohibited: execution already has a destination Item ID");
  const zeroEvent = execution.events.find((event) => event.type === "destination_sku_reconciled_zero_safe_retry");
  if (!zeroEvent || Date.now() - zeroEvent.createdAt.getTime() > 15 * 60_000) throw new Error("Fresh zero-match SKU reconciliation is required before retry");

  const store = await prisma.store.findUnique({ where: { id: execution.storeId } });
  if (!store || !store.isActive || store.connectionStatus !== "connected") throw new Error("Destination store is not actively connected");
  const [{ accessToken }, browseToken] = await Promise.all([getValidAccessToken(store, { forceRefresh: true }), getEbayApplicationAccessToken()]);
  const proposed = execution.proposedState as Record<string, unknown>;
  const decisionEvidence = execution.decision.evidenceSnapshot as Record<string, any>;
  const images = decisionEvidence?.browse?.images as string[];
  const specifics = proposed.specifics as Array<{ name: string; value: string }>;
  if (!Array.isArray(images) || images.length !== Number(proposed.imageCount) || !Array.isArray(specifics)) throw new Error("Approved payload evidence is incomplete");

  const browse = await getBrowseItemByLegacyId(browseToken, SOURCE_ID);
  if (browse.seller?.username?.toLowerCase() !== "imaydir582" || browse.title !== proposed.title || Number(browse.price?.value) !== Number(proposed.price) || Number(browse.estimatedAvailabilities?.[0]?.estimatedAvailableQuantity) !== Number(proposed.quantity)) throw new Error("Source state changed since approved payload");

  const description = `${proposed.title}. ${proposed.condition}. You will receive the item shown in the listing photos.`;
  const itemXml = `<Item><SKU>${SKU}</SKU><Title>${esc(String(proposed.title))}</Title><Description>${esc(description)}</Description><PrimaryCategory><CategoryID>${proposed.categoryId}</CategoryID></PrimaryCategory><StartPrice currencyID="USD">${Number(proposed.price).toFixed(2)}</StartPrice><Quantity>${proposed.quantity}</Quantity><ConditionID>4000</ConditionID><ConditionDescriptors><ConditionDescriptor><Name>40001</Name><Value>400010</Value></ConditionDescriptor></ConditionDescriptors><Country>US</Country><Currency>USD</Currency><DispatchTimeMax>2</DispatchTimeMax><ListingDuration>GTC</ListingDuration><ListingType>FixedPriceItem</ListingType><Location>Waxahachie, Texas</Location><PostalCode>75167</PostalCode><PictureDetails>${images.map((url) => `<PictureURL>${esc(url)}</PictureURL>`).join("")}</PictureDetails><ItemSpecifics>${specifics.map((specific) => `<NameValueList><Name>${esc(specific.name)}</Name><Value>${esc(specific.value)}</Value></NameValueList>`).join("")}</ItemSpecifics><SellerProfiles><SellerPaymentProfile><PaymentProfileID>${POLICY.payment}</PaymentProfileID></SellerPaymentProfile><SellerReturnProfile><ReturnProfileID>${POLICY.returns}</ReturnProfileID></SellerReturnProfile><SellerShippingProfile><ShippingProfileID>${POLICY.shipping}</ShippingProfileID></SellerShippingProfile></SellerProfiles><Site>US</Site></Item>`;
  await callTradingApi({ callName: "VerifyAddFixedPriceItem", siteId: 0, accessToken, xmlBody: `<VerifyAddFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">${itemXml}</VerifyAddFixedPriceItemRequest>` });
  await appendEvent("governed_retry_started_after_zero_sku_reconciliation", { sku: SKU, sourceItemId: SOURCE_ID, zeroReconciliationEventId: zeroEvent.id, sourceUntouched: true });
  await prisma.ebayActionExecution.update({ where: { id: EXECUTION_ID }, data: { status: "executing" } });

  try {
    const resolution = await createListingOnceWithMandatorySkuRecovery({
      createOnce: () => addFixedPriceItemXml(accessToken, itemXml),
      getByItemId: (itemId) => getItem(accessToken, itemId),
      findActiveBySku: async (sku) => { const found: EbayListingItem[] = []; for await (const page of getActiveListings(accessToken)) found.push(...page.filter((item) => String(item.SKU ?? "") === sku)); return found; },
    }, SKU);
    const verified = await getItem(accessToken, resolution.itemId);
    const differences: string[] = [];
    if (verified.Title !== proposed.title) differences.push("title");
    if (Math.abs(currentPrice(verified) - Number(proposed.price)) > 0.005) differences.push("price");
    if (Number(verified.QuantityAvailable) !== Number(proposed.quantity) && Number(verified.Quantity) !== Number(proposed.quantity)) differences.push("quantity");
    if (String(verified.PrimaryCategory?.CategoryID ?? "") !== String(proposed.categoryId)) differences.push("category");
    if (itemImages(verified).length !== images.length) differences.push("images");
    if (differences.length) throw new Error(`Provider reconciliation differences: ${differences.join(", ")}`);
    await prisma.$transaction([
      prisma.listing.update({ where: { id: execution.listingId }, data: { ebayItemId: resolution.itemId, listingStatus: "active", title: verified.Title, currentPrice: currentPrice(verified), quantity: Number(proposed.quantity), categoryId: String(proposed.categoryId), condition: verified.ConditionDisplayName ?? execution.listing.condition, imageUrls: itemImages(verified), authoritativeSource: "store2-migration-provider-verified", authoritativeObservedAt: new Date(), lastSyncedAt: new Date() } }),
      prisma.ebayActionExecution.update({ where: { id: EXECUTION_ID }, data: { status: "verified", newEbayItemId: resolution.itemId, providerVerifiedAt: new Date() } }),
    ]);
    await appendEvent("provider_verified_after_governed_retry", { sourceItemId: SOURCE_ID, destinationItemId: resolution.itemId, resolution: resolution.resolution, differences: [], sourceUntouched: true });
    console.log(JSON.stringify({ sourceItemId: SOURCE_ID, destinationItemId: resolution.itemId, resolution: resolution.resolution, status: "verified", differences: [], sourceStoreMutations: 0, executionId: EXECUTION_ID }, null, 2));
  } catch (error) {
    await appendEvent("governed_retry_failed", { message: error instanceof Error ? error.message : String(error), automaticRetryProhibited: true });
    await prisma.ebayActionExecution.update({ where: { id: EXECUTION_ID }, data: { status: "failed" } });
    throw error;
  }
}

main().finally(() => prisma.$disconnect()).catch((error) => { console.error(error instanceof Error ? error.stack ?? error.message : error); process.exitCode = 1; });
