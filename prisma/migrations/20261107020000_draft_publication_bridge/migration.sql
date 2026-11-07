-- Durable selected-draft handoff; no inventory or existing rows are modified.
BEGIN;
CREATE TABLE "V2DraftPublicationJob" (
 "id" TEXT NOT NULL, "operatorId" VARCHAR(200) NOT NULL, "seller" VARCHAR(50) NOT NULL,
 "requestKey" VARCHAR(250) NOT NULL, "scopeHash" VARCHAR(64) NOT NULL, "reportId" VARCHAR(200) NOT NULL,
 "selection" JSONB NOT NULL, "status" VARCHAR(40) NOT NULL DEFAULT 'QUEUED', "phase" VARCHAR(80) NOT NULL DEFAULT 'queued',
 "workerId" TEXT, "leaseToken" TEXT, "leaseExpiresAt" TIMESTAMP(3), "publicationAttemptedAt" TIMESTAMP(3),
 "progress" JSONB, "result" JSONB, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMP(3) NOT NULL, "completedAt" TIMESTAMP(3), CONSTRAINT "V2DraftPublicationJob_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "V2DraftPublicationJob_requestKey_key" ON "V2DraftPublicationJob"("requestKey");
CREATE INDEX "V2DraftPublicationJob_operatorId_seller_status_createdAt_idx" ON "V2DraftPublicationJob"("operatorId","seller","status","createdAt");
CREATE TABLE "V2DraftPublicationItem" (
 "id" TEXT NOT NULL, "jobId" TEXT NOT NULL, "seller" VARCHAR(50) NOT NULL, "draftId" VARCHAR(25) NOT NULL,
 "status" VARCHAR(40) NOT NULL DEFAULT 'QUEUED', "liveItemId" VARCHAR(25), "result" JSONB,
 CONSTRAINT "V2DraftPublicationItem_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "V2DraftPublicationItem_seller_draftId_key" ON "V2DraftPublicationItem"("seller","draftId");
CREATE INDEX "V2DraftPublicationItem_jobId_idx" ON "V2DraftPublicationItem"("jobId");
ALTER TABLE "V2DraftPublicationItem" ADD CONSTRAINT "V2DraftPublicationItem_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "V2DraftPublicationJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TABLE "V2DraftPublisherHeartbeat" (
 "workerId" TEXT NOT NULL, "operatorId" VARCHAR(200) NOT NULL, "seller" VARCHAR(50) NOT NULL,
 "version" VARCHAR(80) NOT NULL, "status" VARCHAR(40) NOT NULL, "sellerObservedAt" TIMESTAMP(3),
 "seenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "V2DraftPublisherHeartbeat_pkey" PRIMARY KEY ("workerId")
);
CREATE INDEX "V2DraftPublisherHeartbeat_operatorId_status_seenAt_idx" ON "V2DraftPublisherHeartbeat"("operatorId","status","seenAt");
COMMIT;
