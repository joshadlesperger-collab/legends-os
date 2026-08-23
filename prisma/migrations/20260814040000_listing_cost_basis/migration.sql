-- Optional user-entered per-unit cost basis. These values support transparent
-- known-cost margin analysis but are not treated as complete accounting profit.
CREATE TABLE "ListingCostBasis" (
  "id" TEXT NOT NULL,
  "listingId" TEXT NOT NULL,
  "currency" VARCHAR(3) NOT NULL DEFAULT 'USD',
  "unitAcquisitionCost" DECIMAL(12,2),
  "unitGradingCost" DECIMAL(12,2),
  "unitSuppliesCost" DECIMAL(12,2),
  "unitOutboundPostageCost" DECIMAL(12,2),
  "unitOtherCost" DECIMAL(12,2),
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ListingCostBasis_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ListingCostBasis_listingId_key" ON "ListingCostBasis"("listingId");

ALTER TABLE "ListingCostBasis" ADD CONSTRAINT "ListingCostBasis_listingId_fkey"
  FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE CASCADE ON UPDATE CASCADE;
