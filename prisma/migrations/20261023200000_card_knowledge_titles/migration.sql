ALTER TABLE "KnowledgeProduct" ADD COLUMN "titlePolicyVersion" TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE "KnowledgeEntry" ADD COLUMN "playerName" TEXT NOT NULL DEFAULT '';
ALTER TABLE "KnowledgeEntry" ADD COLUMN "recommendedEbayTitle" VARCHAR(80) NOT NULL DEFAULT '';
ALTER TABLE "KnowledgeEntry" ADD COLUMN "titleNeedsReview" BOOLEAN NOT NULL DEFAULT true;
