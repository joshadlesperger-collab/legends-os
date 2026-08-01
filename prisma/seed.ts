import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const account = await prisma.account.create({
    data: {
      name: "Legends Demo",
      plan: "beta",
    },
  });

  const store = await prisma.store.create({
    data: {
      accountId: account.id,
      ebaySellerUsername: "cards_hq_01",
      isActive: true,
      lastSyncAt: new Date(),
    },
  });

  const listing = await prisma.listing.create({
    data: {
      storeId: store.id,
      ebayItemId: "123456789",
      title: "2022 Bowman Chrome Julio Rodriguez",
      description: "RC Refractor",
      currentPrice: 22.0,
      quantity: 1,
      quantitySold: 0,
      condition: "NM-MT",
      listingStatus: "active",
      listingFormat: "FixedPrice",
      startTime: new Date(Date.now() - 48 * 24 * 60 * 60 * 1000),
      watchers: 2,
      views: 34,
      imageUrls: ["https://example.com/image.jpg"],
      lastSyncedAt: new Date(),
    },
  });

  await prisma.listingSnapshot.create({
    data: {
      listingId: listing.id,
      storeId: store.id,
      currentPrice: 22.0,
      quantity: 1,
      quantitySold: 0,
      watchers: 2,
      views: 34,
      listingStatus: "active",
      source: "manual",
    },
  });

  await prisma.listingScore.create({
    data: {
      listingId: listing.id,
      scoreRunId: "placeholder-run",
      healthScore: 42,
      opportunityScore: 91,
      healthFactors: { stale: true, lowViews: true },
      opportunityFactors: { highDemand: true, aboveComp: true },
    },
  });

  await prisma.recommendation.create({
    data: {
      listingId: listing.id,
      storeId: store.id,
      type: "lower-price",
      suggestedPrice: 17.99,
      reason: "3 comps sold in 7 days at $17-19; you are at $22.",
      expectedProfitImpact: 45.0,
      confidence: 92,
    },
  });

  await prisma.recommendation.create({
    data: {
      listingId: listing.id,
      storeId: store.id,
      type: "hold",
      reason: "Healthy views-to-watcher ratio indicates this listing should remain priced as-is.",
      expectedProfitImpact: 0.0,
      confidence: 71,
    },
  });

  await prisma.scoreConfig.create({
    data: {
      accountId: account.id,
      healthWeights: {
        views: 0.3,
        watchers: 0.3,
        daysListed: 0.2,
        sales: 0.2,
      },
      opportunityWeights: {
        demand: 0.4,
        compGap: 0.4,
        seasonality: 0.2,
      },
      priceDropRules: { minDaysListed: 30, minViews: 20 },
      relistRules: { staleDays: 90, minWatchers: 0 },
    },
  });

  console.log("Seed data created for account:", account.id);
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
