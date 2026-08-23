-- Retain seller SKU on listing history and persist conservative order-line
-- reconciliation decisions for automatic and operator-reviewed attribution.
ALTER TABLE "Listing" ADD COLUMN "sku" TEXT;

CREATE INDEX "Listing_storeId_sku_idx" ON "Listing"("storeId", "sku");

CREATE TABLE "OrderLineReconciliation" (
  "id" TEXT NOT NULL,
  "orderLineId" TEXT NOT NULL,
  "candidateListingId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'unresolved',
  "matchTier" TEXT,
  "confidence" INTEGER,
  "reasons" JSONB NOT NULL,
  "reviewedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OrderLineReconciliation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OrderLineReconciliation_orderLineId_key" ON "OrderLineReconciliation"("orderLineId");
CREATE INDEX "OrderLineReconciliation_status_confidence_idx" ON "OrderLineReconciliation"("status", "confidence");
CREATE INDEX "OrderLineReconciliation_candidateListingId_idx" ON "OrderLineReconciliation"("candidateListingId");

ALTER TABLE "OrderLineReconciliation" ADD CONSTRAINT "OrderLineReconciliation_orderLineId_fkey"
  FOREIGN KEY ("orderLineId") REFERENCES "EbayOrderLine"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderLineReconciliation" ADD CONSTRAINT "OrderLineReconciliation_candidateListingId_fkey"
  FOREIGN KEY ("candidateListingId") REFERENCES "Listing"("id") ON DELETE SET NULL ON UPDATE CASCADE;
