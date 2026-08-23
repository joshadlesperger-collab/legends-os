-- Persist adaptive time-slice progress inside the fixed logical order window.
-- Existing logical jobs retain their window but initialize a fresh first slice,
-- allowing valid commerce rows to be replayed through idempotent provider keys.
ALTER TABLE "SyncJob"
  ADD COLUMN "orderSliceStart" TIMESTAMP(3),
  ADD COLUMN "orderSliceEnd" TIMESTAMP(3),
  ADD COLUMN "orderSliceTotal" INTEGER,
  ADD COLUMN "orderCompletedCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "orderCompletedSlices" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "orderSliceRestartCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "orderSliceSplitCount" INTEGER NOT NULL DEFAULT 0;
