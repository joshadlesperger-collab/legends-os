-- Preserve the source and import audit trail for verified cost-basis values.
-- Existing values remain labeled manual; no financial values are inferred.
ALTER TABLE "ListingCostBasis"
  ADD COLUMN "source" TEXT NOT NULL DEFAULT 'manual',
  ADD COLUMN "sourceReference" TEXT,
  ADD COLUMN "enteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "importBatchId" TEXT;

CREATE TABLE "CostBasisImportBatch" (
  "id" TEXT NOT NULL,
  "sourceFileName" TEXT,
  "suppliedRows" INTEGER NOT NULL,
  "appliedRows" INTEGER NOT NULL,
  "summary" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CostBasisImportBatch_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ListingCostBasis_importBatchId_idx" ON "ListingCostBasis"("importBatchId");

ALTER TABLE "ListingCostBasis" ADD CONSTRAINT "ListingCostBasis_importBatchId_fkey"
  FOREIGN KEY ("importBatchId") REFERENCES "CostBasisImportBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
