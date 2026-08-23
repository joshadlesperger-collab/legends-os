/*
  Warnings:

  - A unique constraint covering the columns `[storeId,ebayItemId]` on the table `Listing` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Store" ADD COLUMN     "connectionStatus" TEXT NOT NULL DEFAULT 'pending',
ADD COLUMN     "marketplace" TEXT;

-- CreateTable
CREATE TABLE "ApiErrorLog" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "apiName" TEXT NOT NULL,
    "errorCode" TEXT,
    "message" TEXT NOT NULL,
    "requestBody" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiErrorLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Listing_storeId_ebayItemId_key" ON "Listing"("storeId", "ebayItemId");

-- AddForeignKey
ALTER TABLE "ApiErrorLog" ADD CONSTRAINT "ApiErrorLog_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
