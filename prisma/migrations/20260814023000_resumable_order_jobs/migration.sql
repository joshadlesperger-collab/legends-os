-- Persist a fixed eBay order window, page cursor, and execution lease on SyncJob.
-- Existing jobs intentionally receive NULL window bounds so recovery can safely
-- initialize a new window and idempotently replay already imported provider IDs.
ALTER TABLE "SyncJob"
  ADD COLUMN "failureCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "orderWindowStart" TIMESTAMP(3),
  ADD COLUMN "orderWindowEnd" TIMESTAMP(3),
  ADD COLUMN "orderNextOffset" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "orderTotal" INTEGER,
  ADD COLUMN "leaseToken" TEXT,
  ADD COLUMN "leaseExpiresAt" TIMESTAMP(3),
  ADD COLUMN "heartbeatAt" TIMESTAMP(3);

CREATE INDEX "SyncJob_status_leaseExpiresAt_idx"
  ON "SyncJob"("status", "leaseExpiresAt");
