-- CreateTable
CREATE TABLE "KnowledgeProduct" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "season" TEXT NOT NULL,
    "printedYear" INTEGER NOT NULL,
    "manufacturer" TEXT NOT NULL,
    "sport" TEXT NOT NULL,
    "productUrl" TEXT NOT NULL,
    "catalogDigest" TEXT NOT NULL,

    CONSTRAINT "KnowledgeProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeSource" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "retrievedAt" TIMESTAMP(3) NOT NULL,
    "publisher" TEXT NOT NULL,

    CONSTRAINT "KnowledgeSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeSubject" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "KnowledgeSubject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeEntry" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "section" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "cardNumber" TEXT NOT NULL,
    "team" TEXT,
    "rookie" BOOLEAN NOT NULL,
    "sourceId" TEXT NOT NULL,
    "sourcePage" INTEGER NOT NULL,
    "raw" TEXT NOT NULL,

    CONSTRAINT "KnowledgeEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeOdds" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "raw" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "sourcePage" INTEGER NOT NULL,
    "ratios" JSONB NOT NULL,
    "formatMapping" TEXT NOT NULL DEFAULT 'requires-review',

    CONSTRAINT "KnowledgeOdds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeVariant" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "parallel" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "finish" TEXT NOT NULL,
    "numbering" TEXT NOT NULL,
    "printRun" INTEGER,
    "reviewStatus" TEXT NOT NULL DEFAULT 'requires-review',
    "evidence" JSONB NOT NULL,

    CONSTRAINT "KnowledgeVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeObservation" (
    "id" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "soldAt" TIMESTAMP(3),
    "observedAt" TIMESTAMP(3) NOT NULL,
    "itemPrice" DECIMAL(12,2) NOT NULL,
    "buyerShipping" DECIMAL(12,2),
    "currency" VARCHAR(3) NOT NULL,
    "condition" TEXT NOT NULL,
    "identityVerified" BOOLEAN NOT NULL DEFAULT false,
    "conditionVerified" BOOLEAN NOT NULL DEFAULT false,
    "ownPurchase" BOOLEAN NOT NULL DEFAULT false,
    "hiddenPrice" BOOLEAN NOT NULL DEFAULT false,
    "evidence" JSONB NOT NULL,

    CONSTRAINT "KnowledgeObservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeReviewItem" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "page" INTEGER NOT NULL,
    "raw" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'requires-review',

    CONSTRAINT "KnowledgeReviewItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeImport" (
    "id" TEXT NOT NULL,
    "sourceSha256" TEXT NOT NULL,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recordCounts" JSONB NOT NULL,

    CONSTRAINT "KnowledgeImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeLegacyRecord" (
    "id" TEXT NOT NULL,
    "importId" TEXT NOT NULL,
    "sourceTable" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "raw" JSONB NOT NULL,
    "reviewStatus" TEXT NOT NULL DEFAULT 'historical-unvalidated',

    CONSTRAINT "KnowledgeLegacyRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "KnowledgeProduct_sport_season_manufacturer_idx" ON "KnowledgeProduct"("sport", "season", "manufacturer");

-- CreateIndex
CREATE INDEX "KnowledgeSource_productId_idx" ON "KnowledgeSource"("productId");

-- CreateIndex
CREATE INDEX "KnowledgeSubject_name_idx" ON "KnowledgeSubject"("name");

-- CreateIndex
CREATE INDEX "KnowledgeEntry_subjectId_productId_idx" ON "KnowledgeEntry"("subjectId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeEntry_productId_section_cardNumber_key" ON "KnowledgeEntry"("productId", "section", "cardNumber");

-- CreateIndex
CREATE INDEX "KnowledgeOdds_productId_idx" ON "KnowledgeOdds"("productId");

-- CreateIndex
CREATE INDEX "KnowledgeVariant_entryId_parallel_idx" ON "KnowledgeVariant"("entryId", "parallel");

-- CreateIndex
CREATE INDEX "KnowledgeObservation_variantId_soldAt_idx" ON "KnowledgeObservation"("variantId", "soldAt");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeObservation_provider_saleId_key" ON "KnowledgeObservation"("provider", "saleId");

-- CreateIndex
CREATE INDEX "KnowledgeReviewItem_productId_status_idx" ON "KnowledgeReviewItem"("productId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeImport_sourceSha256_key" ON "KnowledgeImport"("sourceSha256");

-- CreateIndex
CREATE INDEX "KnowledgeLegacyRecord_sourceTable_sourceKey_idx" ON "KnowledgeLegacyRecord"("sourceTable", "sourceKey");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeLegacyRecord_importId_sourceTable_sourceKey_key" ON "KnowledgeLegacyRecord"("importId", "sourceTable", "sourceKey");

-- AddForeignKey
ALTER TABLE "KnowledgeSource" ADD CONSTRAINT "KnowledgeSource_productId_fkey" FOREIGN KEY ("productId") REFERENCES "KnowledgeProduct"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeEntry" ADD CONSTRAINT "KnowledgeEntry_productId_fkey" FOREIGN KEY ("productId") REFERENCES "KnowledgeProduct"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeEntry" ADD CONSTRAINT "KnowledgeEntry_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "KnowledgeSubject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeEntry" ADD CONSTRAINT "KnowledgeEntry_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "KnowledgeSource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeOdds" ADD CONSTRAINT "KnowledgeOdds_productId_fkey" FOREIGN KEY ("productId") REFERENCES "KnowledgeProduct"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeOdds" ADD CONSTRAINT "KnowledgeOdds_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "KnowledgeSource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeVariant" ADD CONSTRAINT "KnowledgeVariant_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "KnowledgeEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeObservation" ADD CONSTRAINT "KnowledgeObservation_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "KnowledgeVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeReviewItem" ADD CONSTRAINT "KnowledgeReviewItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "KnowledgeProduct"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeLegacyRecord" ADD CONSTRAINT "KnowledgeLegacyRecord_importId_fkey" FOREIGN KEY ("importId") REFERENCES "KnowledgeImport"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
