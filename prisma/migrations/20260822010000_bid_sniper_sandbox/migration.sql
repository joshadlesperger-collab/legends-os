CREATE TABLE "ScheduledBid" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "environment" TEXT NOT NULL DEFAULT 'SANDBOX',
    "browseItemId" TEXT NOT NULL,
    "legacyItemId" TEXT,
    "listingTitle" TEXT NOT NULL,
    "buyerUserId" TEXT NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
    "auctionEndAt" TIMESTAMP(3) NOT NULL,
    "operatorMaxBid" DECIMAL(10,2) NOT NULL,
    "recommendedMaxBid" DECIMAL(10,2),
    "snipeOffsetSeconds" INTEGER NOT NULL DEFAULT 7,
    "scheduledExecutionAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "approvedBy" TEXT NOT NULL,
    "approvedAt" TIMESTAMP(3) NOT NULL,
    "armedAt" TIMESTAMP(3),
    "submittingAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "lastAttemptAt" TIMESTAMP(3),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "actualLatencyMs" INTEGER,
    "failureReason" TEXT,
    "providerResult" JSONB,
    "leaseToken" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ScheduledBid_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "ScheduledBidEvent" (
    "id" TEXT NOT NULL,
    "scheduledBidId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,
    CONSTRAINT "ScheduledBidEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ScheduledBid_idempotencyKey_key" ON "ScheduledBid"("idempotencyKey");
CREATE INDEX "ScheduledBid_status_scheduledExecutionAt_idx" ON "ScheduledBid"("status", "scheduledExecutionAt");
CREATE INDEX "ScheduledBid_opportunityId_createdAt_idx" ON "ScheduledBid"("opportunityId", "createdAt");
CREATE INDEX "ScheduledBid_status_leaseExpiresAt_idx" ON "ScheduledBid"("status", "leaseExpiresAt");
CREATE INDEX "ScheduledBidEvent_scheduledBidId_occurredAt_idx" ON "ScheduledBidEvent"("scheduledBidId", "occurredAt");
ALTER TABLE "ScheduledBid" ADD CONSTRAINT "ScheduledBid_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "SellerOpportunityAuction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ScheduledBidEvent" ADD CONSTRAINT "ScheduledBidEvent_scheduledBidId_fkey" FOREIGN KEY ("scheduledBidId") REFERENCES "ScheduledBid"("id") ON DELETE CASCADE ON UPDATE CASCADE;
