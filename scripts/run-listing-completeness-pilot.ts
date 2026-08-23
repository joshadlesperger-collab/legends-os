import { loadEnvConfig } from "@next/env";
delete process.env.DATABASE_URL;
loadEnvConfig(process.cwd(), true);

async function main() {
const { prisma } = await import("../lib/prisma.ts");
const { loadListingCompleteness } = await import("../lib/listing-completeness-data.ts");
const { executeListingCompletenessCandidate, selectPilotAssessments, LISTING_COMPLETENESS_PILOT_APPROVAL } = await import("../lib/listing-completeness-pilot.ts");
if (!process.argv.includes("--execute-approved-production-canary")) throw new Error("Missing explicit approved production-canary command flag");
const operatorId = "operator-approved-weekend-completeness-pilot";
const data = await loadListingCompleteness();
const cohort = selectPilotAssessments(data.assessments, 100);
const outcomes: Array<{ itemId: string; title: string; status: string; executionId?: string; error?: string }> = [];
async function runRange(rows: typeof cohort) {
  for (const assessment of rows) {
    try {
      const execution = await executeListingCompletenessCandidate({ assessment, operatorId, approvalMarker: LISTING_COMPLETENESS_PILOT_APPROVAL });
      outcomes.push({ itemId: assessment.ebayItemId, title: assessment.title, status: execution.status, executionId: execution.id });
      if (execution.status !== "verified") return false;
    } catch (error) {
      outcomes.push({ itemId: assessment.ebayItemId, title: assessment.title, status: "failed", error: error instanceof Error ? error.message : "Unknown failure" });
      return false;
    }
  }
  return true;
}

const canary = cohort.slice(0, 10);
const canaryClean = canary.length === 10 && await runRange(canary);
if (canaryClean) await runRange(cohort.slice(10));
const executionIds = outcomes.flatMap(row => row.executionId ? [row.executionId] : []);
const audit = await prisma.ebayActionExecution.findMany({ where: { id: { in: executionIds } }, include: { events: { orderBy: { sequence: "asc" } } }, orderBy: { createdAt: "asc" } });
console.log(JSON.stringify({ policy: LISTING_COMPLETENESS_PILOT_APPROVAL, interventionStartedAt: audit[0]?.createdAt ?? null, selected: cohort.length, canarySize: canary.length, canaryClean, remainingExecuted: canaryClean ? Math.max(0, outcomes.length - 10) : 0, outcomes, audit: audit.map(row => ({ id: row.id, itemId: row.oldEbayItemId, status: row.status, createdAt: row.createdAt, verifiedAt: row.providerVerifiedAt, events: row.events.map(event => ({ sequence: event.sequence, type: event.type, at: event.createdAt, snapshot: event.snapshot })) })) }, null, 2));
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
