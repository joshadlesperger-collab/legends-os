CREATE TABLE "EbayActionExecution" (
  "id" TEXT NOT NULL,
  "listingId" TEXT NOT NULL,
  "storeId" TEXT NOT NULL,
  "decisionId" TEXT NOT NULL,
  "operatorId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "doctrineVersion" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'approved',
  "idempotencyKey" TEXT NOT NULL,
  "oldEbayItemId" TEXT NOT NULL,
  "newEbayItemId" TEXT,
  "beforeState" JSONB NOT NULL,
  "proposedState" JSONB NOT NULL,
  "evidenceSnapshot" JSONB NOT NULL,
  "providerVerifiedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EbayActionExecution_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EbayActionExecutionEvent" (
  "id" TEXT NOT NULL,
  "executionId" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "type" TEXT NOT NULL,
  "snapshot" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EbayActionExecutionEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EbayActionExecution_decisionId_key" ON "EbayActionExecution"("decisionId");
CREATE UNIQUE INDEX "EbayActionExecution_idempotencyKey_key" ON "EbayActionExecution"("idempotencyKey");
CREATE INDEX "EbayActionExecution_status_createdAt_idx" ON "EbayActionExecution"("status", "createdAt");
CREATE INDEX "EbayActionExecution_listingId_createdAt_idx" ON "EbayActionExecution"("listingId", "createdAt");
CREATE UNIQUE INDEX "EbayActionExecutionEvent_executionId_sequence_key" ON "EbayActionExecutionEvent"("executionId", "sequence");
CREATE INDEX "EbayActionExecutionEvent_createdAt_idx" ON "EbayActionExecutionEvent"("createdAt");
ALTER TABLE "EbayActionExecution" ADD CONSTRAINT "EbayActionExecution_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EbayActionExecution" ADD CONSTRAINT "EbayActionExecution_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EbayActionExecution" ADD CONSTRAINT "EbayActionExecution_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "OperatorDecision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EbayActionExecutionEvent" ADD CONSTRAINT "EbayActionExecutionEvent_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "EbayActionExecution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
