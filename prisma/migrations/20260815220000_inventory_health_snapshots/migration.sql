-- Forward-only aggregate Inventory Health history. No historical scores are inferred.
CREATE TABLE "InventoryHealthSnapshot" (
  "id" TEXT NOT NULL,
  "snapshotDate" DATE NOT NULL,
  "listingWeightedHealth" INTEGER NOT NULL,
  "economicallyWeightedHealth" INTEGER NOT NULL,
  "activeListings" INTEGER NOT NULL,
  "listedExposure" DECIMAL(14,2) NOT NULL,
  "states" JSONB NOT NULL,
  "pareto" JSONB NOT NULL,
  "velocity" JSONB NOT NULL,
  "saleLikelihood" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InventoryHealthSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "InventoryHealthSnapshot_snapshotDate_key" ON "InventoryHealthSnapshot"("snapshotDate");
CREATE INDEX "InventoryHealthSnapshot_createdAt_idx" ON "InventoryHealthSnapshot"("createdAt");
