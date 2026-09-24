import { prisma } from "../lib/prisma.ts";
import { getItem, getValidAccessToken } from "../lib/ebay.ts";
import { getAdvertisingContext } from "../lib/ebay-marketing.ts";
import {
  FREE_SHIPPING_PHASE1_ITEM_IDS,
  FREE_SHIPPING_PHASE1_VERSION,
  evaluateFreeShippingCandidate,
  freeShippingPolicies,
  getFulfillmentPolicies,
} from "../lib/free-shipping-experiment.ts";

const ARG = "--dry-run-free-shipping-phase1";

async function main() {
  if (!process.argv.includes(ARG)) throw new Error(`Explicit ${ARG} is required`);

  const listings = await prisma.listing.findMany({
    where: { ebayItemId: { in: [...FREE_SHIPPING_PHASE1_ITEM_IDS] } },
    include: { store: true },
  });
  const byItemId = new Map(listings.map(listing => [listing.ebayItemId, listing]));
  const missing = FREE_SHIPPING_PHASE1_ITEM_IDS.filter(itemId => !byItemId.has(itemId));

  const storeIds = Array.from(new Set(listings.map(listing => listing.storeId)));
  const storeState = new Map<string, {
    accessToken: string;
    adContext: Awaited<ReturnType<typeof getAdvertisingContext>>;
    freePolicies: ReturnType<typeof freeShippingPolicies>;
  }>();

  for (const storeId of storeIds) {
    const listing = listings.find(row => row.storeId === storeId);
    if (!listing) continue;
    const { accessToken } = await getValidAccessToken(listing.store);
    const [adContext, policies] = await Promise.all([
      getAdvertisingContext(accessToken),
      getFulfillmentPolicies(accessToken),
    ]);
    storeState.set(storeId, { accessToken, adContext, freePolicies: freeShippingPolicies(policies) });
  }

  const rows = [];
  for (const itemId of FREE_SHIPPING_PHASE1_ITEM_IDS) {
    const listing = byItemId.get(itemId);
    if (!listing) {
      rows.push({ itemId, ready: false, blockers: ["Listing is missing from Legends OS"], title: null });
      continue;
    }
    const state = storeState.get(listing.storeId);
    if (!state) {
      rows.push({ itemId, ready: false, blockers: ["Store credentials could not be loaded"], title: listing.title });
      continue;
    }

    try {
      const live = await getItem(state.accessToken, itemId);
      const ad = state.adContext.contexts.get(itemId) ?? state.adContext.defaultContext;
      rows.push(evaluateFreeShippingCandidate({
        itemId,
        item: live,
        persistedTitle: listing.title,
        persistedPrice: Number(listing.currentPrice),
        adRate: ad.adRate,
      }));
    } catch (error) {
      rows.push({
        itemId,
        title: listing.title,
        ready: false,
        blockers: [error instanceof Error ? error.message : String(error)],
      });
    }
  }

  const freePolicyCandidates = Array.from(storeState.entries()).map(([storeId, state]) => ({
    storeId,
    policies: state.freePolicies.map(policy => ({
      fulfillmentPolicyId: policy.fulfillmentPolicyId ?? null,
      name: policy.name ?? null,
      handlingTime: policy.handlingTime ?? null,
    })),
  }));

  const ready = rows.filter(row => row.ready).length;
  const blocked = rows.length - ready;
  console.log(JSON.stringify({
    experiment: FREE_SHIPPING_PHASE1_VERSION,
    mode: "DRY_RUN_ONLY",
    providerWrites: false,
    selected: FREE_SHIPPING_PHASE1_ITEM_IDS.length,
    persistedListingsFound: listings.length,
    missing,
    ready,
    blocked,
    freePolicyCandidates,
    rows,
    nextGate: "No listing mutation is authorized. A specific free-shipping fulfillment policy and explicit production batch approval are required before execution tooling may write.",
  }, null, 2));
}

main()
  .finally(() => prisma.$disconnect())
  .catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
