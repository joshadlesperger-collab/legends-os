-- AlterTable
ALTER TABLE "SaleEvent" DROP CONSTRAINT "SaleEvent_listingId_fkey";
ALTER TABLE "SaleEvent" ADD COLUMN "currency" VARCHAR(3), ADD COLUMN "orderLineId" TEXT,
ADD COLUMN "provider" TEXT, ADD COLUMN "providerEventId" TEXT,
ADD COLUMN "status" TEXT NOT NULL DEFAULT 'confirmed', ALTER COLUMN "listingId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Store" ADD COLUMN "orderAccessStatus" TEXT NOT NULL DEFAULT 'requires_reauth',
ADD COLUMN "orderSyncCheckpoint" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "SyncJob" (
  "id" TEXT NOT NULL, "storeId" TEXT NOT NULL, "syncRunId" TEXT, "type" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending', "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 3, "scheduledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMP(3), "completedAt" TIMESTAMP(3), "progress" INTEGER NOT NULL DEFAULT 0,
  "errorMessage" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "SyncJob_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EbayOrder" (
  "id" TEXT NOT NULL, "storeId" TEXT NOT NULL, "providerOrderId" TEXT NOT NULL,
  "creationDate" TIMESTAMP(3) NOT NULL, "lastModifiedDate" TIMESTAMP(3) NOT NULL,
  "orderPaymentStatus" TEXT NOT NULL, "orderFulfillmentStatus" TEXT NOT NULL,
  "cancelStatus" TEXT NOT NULL, "marketplace" TEXT, "currency" VARCHAR(3) NOT NULL,
  "priceSubtotal" DECIMAL(12,2), "deliveryCost" DECIMAL(12,2), "priceDiscount" DECIMAL(12,2),
  "deliveryDiscount" DECIMAL(12,2), "tax" DECIMAL(12,2), "total" DECIMAL(12,2),
  "totalDueSeller" DECIMAL(12,2), "totalMarketplaceFee" DECIMAL(12,2),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EbayOrder_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EbayOrderLine" (
  "id" TEXT NOT NULL, "orderId" TEXT NOT NULL, "storeId" TEXT NOT NULL, "listingId" TEXT,
  "providerLineItemId" TEXT NOT NULL, "ebayItemId" TEXT, "sku" TEXT, "title" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL, "currency" VARCHAR(3) NOT NULL, "lineItemCost" DECIMAL(12,2) NOT NULL,
  "total" DECIMAL(12,2), "deliveryCost" DECIMAL(12,2), "discount" DECIMAL(12,2), "tax" DECIMAL(12,2),
  "fulfillmentStatus" TEXT, "marketplace" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "EbayOrderLine_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EbayRefund" (
  "id" TEXT NOT NULL, "storeId" TEXT NOT NULL, "orderId" TEXT NOT NULL, "orderLineId" TEXT,
  "providerRefundId" TEXT NOT NULL, "status" TEXT NOT NULL, "amount" DECIMAL(12,2),
  "currency" VARCHAR(3), "refundDate" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "EbayRefund_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SyncJob_status_scheduledAt_idx" ON "SyncJob"("status", "scheduledAt");
CREATE INDEX "SyncJob_storeId_type_status_idx" ON "SyncJob"("storeId", "type", "status");
CREATE INDEX "EbayOrder_storeId_lastModifiedDate_idx" ON "EbayOrder"("storeId", "lastModifiedDate");
CREATE UNIQUE INDEX "EbayOrder_storeId_providerOrderId_key" ON "EbayOrder"("storeId", "providerOrderId");
CREATE INDEX "EbayOrderLine_storeId_ebayItemId_idx" ON "EbayOrderLine"("storeId", "ebayItemId");
CREATE UNIQUE INDEX "EbayOrderLine_storeId_providerLineItemId_key" ON "EbayOrderLine"("storeId", "providerLineItemId");
CREATE UNIQUE INDEX "EbayRefund_storeId_providerRefundId_key" ON "EbayRefund"("storeId", "providerRefundId");
CREATE UNIQUE INDEX "SaleEvent_orderLineId_key" ON "SaleEvent"("orderLineId");
CREATE UNIQUE INDEX "SaleEvent_provider_providerEventId_key" ON "SaleEvent"("provider", "providerEventId");

ALTER TABLE "SaleEvent" ADD CONSTRAINT "SaleEvent_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SaleEvent" ADD CONSTRAINT "SaleEvent_orderLineId_fkey" FOREIGN KEY ("orderLineId") REFERENCES "EbayOrderLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SyncJob" ADD CONSTRAINT "SyncJob_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EbayOrder" ADD CONSTRAINT "EbayOrder_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EbayOrderLine" ADD CONSTRAINT "EbayOrderLine_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "EbayOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EbayOrderLine" ADD CONSTRAINT "EbayOrderLine_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EbayOrderLine" ADD CONSTRAINT "EbayOrderLine_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "EbayRefund" ADD CONSTRAINT "EbayRefund_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EbayRefund" ADD CONSTRAINT "EbayRefund_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "EbayOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EbayRefund" ADD CONSTRAINT "EbayRefund_orderLineId_fkey" FOREIGN KEY ("orderLineId") REFERENCES "EbayOrderLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;
