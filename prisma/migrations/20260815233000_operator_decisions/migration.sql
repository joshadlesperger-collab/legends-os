CREATE TABLE "OperatorDecision" (
  "id" TEXT NOT NULL,
  "listingId" TEXT NOT NULL,
  "operatorId" TEXT NOT NULL,
  "recommendedAction" TEXT NOT NULL,
  "decision" TEXT NOT NULL,
  "operatorAdjustedValue" DECIMAL(10,2),
  "beforeState" JSONB NOT NULL,
  "evidenceSnapshot" JSONB NOT NULL,
  "observationWindowDays" INTEGER NOT NULL,
  "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OperatorDecision_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OutcomeObservation" (
  "id" TEXT NOT NULL,
  "decisionId" TEXT NOT NULL,
  "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "windowDays" INTEGER NOT NULL,
  "saleOccurred" BOOLEAN,
  "timeToSaleDays" INTEGER,
  "salePrice" DECIMAL(10,2),
  "quantitySold" INTEGER,
  "viewsChange" INTEGER,
  "watchersChange" INTEGER,
  "knownMargin" DECIMAL(12,2),
  "evidenceSnapshot" JSONB NOT NULL,
  CONSTRAINT "OutcomeObservation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OperatorDecision_operatorId_decidedAt_idx" ON "OperatorDecision"("operatorId", "decidedAt");
CREATE INDEX "OperatorDecision_listingId_decidedAt_idx" ON "OperatorDecision"("listingId", "decidedAt");
CREATE UNIQUE INDEX "OutcomeObservation_decisionId_windowDays_key" ON "OutcomeObservation"("decisionId", "windowDays");
CREATE INDEX "OutcomeObservation_observedAt_idx" ON "OutcomeObservation"("observedAt");
ALTER TABLE "OperatorDecision" ADD CONSTRAINT "OperatorDecision_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OutcomeObservation" ADD CONSTRAINT "OutcomeObservation_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "OperatorDecision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
