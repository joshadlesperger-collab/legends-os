import nextEnv from "@next/env";
const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd(), true);

import { prisma } from "../lib/prisma.ts";
import { getValidAccessToken } from "../lib/ebay.ts";
import { getAdvertisingEligibility, getCampaignAdvertisingContext } from "../lib/ebay-marketing.ts";

const DAY = 86_400_000;

async function main() {
  const store = await prisma.store.findFirst({ where: { isActive: true, connectionStatus: "connected" } });
  if (!store) throw new Error("No connected Store #1");
  const listings = await prisma.listing.findMany({
    where: { storeId: store.id, listingStatus: "active" },
    select: { ebayItemId: true, title: true, currentPrice: true, categoryId: true, listingFormat: true, startTime: true, createdAt: true, authoritativeObservedAt: true, lastSyncedAt: true, authoritativeSource: true },
  });
  const { accessToken } = await getValidAccessToken(store);
  const eligibility = await getAdvertisingEligibility(accessToken);
  const marketing = await getCampaignAdvertisingContext(accessToken, eligibility);
  const now = new Date();
  const represented = listings.filter((listing) => marketing.contexts.has(listing.ebayItemId));
  const missing = listings.filter((listing) => !marketing.contexts.has(listing.ebayItemId));
  const classified = missing.map((listing) => {
    const observedAt = listing.authoritativeObservedAt ?? listing.lastSyncedAt;
    const listedAt = listing.startTime ?? listing.createdAt;
    const ageDays = Math.max(0, Math.floor((now.getTime() - listedAt.getTime()) / DAY));
    const observedAgeHours = (now.getTime() - observedAt.getTime()) / 3_600_000;
    const newlyListed = ageDays < 2 || (listing.authoritativeSource?.includes("migration") && observedAgeHours <= 72);
    let reason = "unknown";
    if (newlyListed) reason = "newly listed / expected lag";
    else if (!/fixed/i.test(listing.listingFormat ?? "")) reason = "unsupported listing/category";
    else if (!listing.categoryId || observedAgeHours > 168) reason = "provider/data reconciliation issue";
    else if (eligibility.eligible === true) reason = "eligible but genuinely not promoted";
    else if (eligibility.eligible === false) reason = "advertising ineligible";
    return { itemId: listing.ebayItemId, title: listing.title, price: Number(listing.currentPrice), ageDays, category: listing.categoryId, listingFormat: listing.listingFormat, advertisingEligibility: eligibility.programStatus, reason, authoritativeObservedAt: observedAt.toISOString(), authoritativeSource: listing.authoritativeSource };
  });
  const rates = new Map<number, number>();
  for (const listing of represented) {
    const rate = marketing.contexts.get(listing.ebayItemId)?.adRate;
    if (rate != null) rates.set(rate, (rates.get(rate) ?? 0) + 1);
  }
  const reasons = Object.fromEntries(Array.from(new Set(classified.map((row) => row.reason))).map((reason) => [reason, classified.filter((row) => row.reason === reason).length]));
  const campaignDistribution = new Map<string, { campaignId: string; campaignName: string | null; campaignStatus: string | null; representedActive: number; rates: Record<string, number> }>();
  for (const listing of represented) {
    const context = marketing.contexts.get(listing.ebayItemId);
    if (!context?.campaignId) continue;
    const current = campaignDistribution.get(context.campaignId) ?? { campaignId: context.campaignId, campaignName: context.campaignName, campaignStatus: context.campaignStatus, representedActive: 0, rates: {} };
    current.representedActive += 1;
    const rate = String(context.adRate ?? "unknown");
    current.rates[rate] = (current.rates[rate] ?? 0) + 1;
    campaignDistribution.set(context.campaignId, current);
  }
  if (process.argv.includes("--approval-batch")) {
    console.log(JSON.stringify({ checkedAt: now.toISOString(), activeListings: listings.length, marketingRepresentedActive: represented.length, activeWithoutAd: missing.length, sellerAdvertisingEligibility: eligibility, currentAdRateDistribution: Object.fromEntries(Array.from(rates).sort((a,b)=>a[0]-b[0])), campaignDistribution: Array.from(campaignDistribution.values()).sort((a,b)=>b.representedActive-a.representedActive), reasons, approvalBatch: classified.filter((row) => row.reason === "eligible but genuinely not promoted") }, null, 2));
    return;
  }
  if (process.argv.includes("--ids-only")) {
    console.log(JSON.stringify(classified.filter((row) => row.reason === "eligible but genuinely not promoted").map((row) => row.itemId)));
    return;
  }
  console.log(JSON.stringify({ checkedAt: now.toISOString(), activeListings: listings.length, marketingRepresentedActive: represented.length, activeWithoutAd: missing.length, sellerAdvertisingEligibility: eligibility, currentAdRateDistribution: Object.fromEntries(Array.from(rates).sort((a,b)=>a[0]-b[0])), reasons, eligibleUnpromoted: classified.filter((row) => row.reason === "eligible but genuinely not promoted"), allMissing: classified }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => prisma.$disconnect());
