-- Extend the durable Listing archive with authoritative eBay provenance and
-- checkpoint exact-identity recovery attempts. Existing listing identity and
-- commerce rows are preserved unchanged.
ALTER TABLE "Listing"
  ADD COLUMN "itemSpecifics" JSONB,
  ADD COLUMN "authoritativeSource" TEXT,
  ADD COLUMN "authoritativeObservedAt" TIMESTAMP(3),
  ADD COLUMN "relistedToEbayItemId" TEXT;

CREATE TABLE "HistoricalListingRecovery" (
  "id" TEXT NOT NULL,
  "storeId" TEXT NOT NULL,
  "ebayItemId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "lastAttemptAt" TIMESTAMP(3),
  "recoveredListingId" TEXT,
  "errorCode" TEXT,
  "errorMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "HistoricalListingRecovery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "HistoricalListingRecovery_recoveredListingId_key" ON "HistoricalListingRecovery"("recoveredListingId");
CREATE UNIQUE INDEX "HistoricalListingRecovery_storeId_ebayItemId_key" ON "HistoricalListingRecovery"("storeId", "ebayItemId");
CREATE INDEX "HistoricalListingRecovery_status_lastAttemptAt_idx" ON "HistoricalListingRecovery"("status", "lastAttemptAt");
CREATE INDEX "HistoricalListingRecovery_storeId_status_idx" ON "HistoricalListingRecovery"("storeId", "status");

ALTER TABLE "HistoricalListingRecovery" ADD CONSTRAINT "HistoricalListingRecovery_storeId_fkey"
  FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "HistoricalListingRecovery" ADD CONSTRAINT "HistoricalListingRecovery_recoveredListingId_fkey"
  FOREIGN KEY ("recoveredListingId") REFERENCES "Listing"("id") ON DELETE SET NULL ON UPDATE CASCADE;
