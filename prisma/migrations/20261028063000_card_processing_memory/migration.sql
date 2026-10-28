-- Additive card-processing memory tables. REVIEW ONLY; not applied to production.
CREATE TABLE "CardProcessingJob" (
 "id" TEXT NOT NULL,
 "accountId" TEXT NOT NULL,
 "cardId" TEXT NOT NULL,
 "stage" TEXT NOT NULL,
 "status" TEXT NOT NULL,
 "version" INTEGER NOT NULL DEFAULT 0,
 "evidenceRef" TEXT,
 "draftId" TEXT,
 "verifiedAt" TIMESTAMP(3),
 "holdReason" TEXT,
 "updatedAt" TIMESTAMP(3) NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "CardProcessingJob_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CardProcessingJob_accountId_cardId_key" ON "CardProcessingJob"("accountId","cardId");
CREATE INDEX "CardProcessingJob_accountId_status_stage_idx" ON "CardProcessingJob"("accountId","status","stage");
CREATE TABLE "CardProcessingEvent" (
 "id" TEXT NOT NULL,
 "jobId" TEXT NOT NULL,
 "eventId" TEXT NOT NULL,
 "stage" TEXT NOT NULL,
 "status" TEXT NOT NULL,
 "occurredAt" TIMESTAMP(3) NOT NULL,
 "evidenceRef" TEXT,
 "draftId" TEXT,
 "verifiedAt" TIMESTAMP(3),
 "holdReason" TEXT,
 CONSTRAINT "CardProcessingEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CardProcessingEvent_jobId_eventId_key" ON "CardProcessingEvent"("jobId","eventId");
CREATE INDEX "CardProcessingEvent_jobId_occurredAt_idx" ON "CardProcessingEvent"("jobId","occurredAt");
ALTER TABLE "CardProcessingEvent" ADD CONSTRAINT "CardProcessingEvent_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "CardProcessingJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
