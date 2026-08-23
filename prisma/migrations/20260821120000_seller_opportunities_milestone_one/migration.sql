CREATE TABLE "SellerOpportunityRun" (
    "id" TEXT NOT NULL,
    "seller" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "collectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "itemCount" INTEGER NOT NULL,
    "singleCount" INTEGER NOT NULL,
    "lotCount" INTEGER NOT NULL,
    CONSTRAINT "SellerOpportunityRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SellerOpportunityAuction" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "seller" TEXT NOT NULL,
    "ebayItemId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "listingUrl" TEXT NOT NULL,
    "currentBid" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "bidCount" INTEGER NOT NULL DEFAULT 0,
    "endTime" TIMESTAMP(3) NOT NULL,
    "estimatedCards" INTEGER,
    "imageUrl" TEXT,
    "categoryName" TEXT,
    "itemSpecifics" JSONB,
    "classificationReason" TEXT NOT NULL,
    CONSTRAINT "SellerOpportunityAuction_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SellerOpportunityRun_seller_collectedAt_idx" ON "SellerOpportunityRun"("seller", "collectedAt");
CREATE UNIQUE INDEX "SellerOpportunityAuction_runId_ebayItemId_key" ON "SellerOpportunityAuction"("runId", "ebayItemId");
CREATE INDEX "SellerOpportunityAuction_runId_kind_endTime_idx" ON "SellerOpportunityAuction"("runId", "kind", "endTime");
CREATE INDEX "SellerOpportunityAuction_seller_ebayItemId_idx" ON "SellerOpportunityAuction"("seller", "ebayItemId");
ALTER TABLE "SellerOpportunityAuction" ADD CONSTRAINT "SellerOpportunityAuction_runId_fkey" FOREIGN KEY ("runId") REFERENCES "SellerOpportunityRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
