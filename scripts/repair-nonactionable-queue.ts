import { prisma } from "../lib/prisma.ts";
import { isActionablePricingRecommendation } from "../lib/recommendation-queue.ts";

const apply = process.argv.includes("--apply");

async function main() {
  const pending = await prisma.actionQueue.findMany({
    where: { status: "pending" },
    select: {
      id: true,
      recommendation: { select: { type: true, suggestedPrice: true, confidence: true } },
    },
  });
  const invalid = pending.filter((row) => !isActionablePricingRecommendation(row.recommendation));
  const byType = Object.fromEntries(
    Array.from(new Set(invalid.map((row) => row.recommendation.type))).sort().map((type) => [
      type,
      invalid.filter((row) => row.recommendation.type === type).length,
    ])
  );
  const summary = { mode: apply ? "apply" : "dry-run", pendingQueueRows: pending.length, nonActionableToInvalidate: invalid.length, byType };

  if (apply && invalid.length > 0) {
    await prisma.actionQueue.updateMany({
      where: { id: { in: invalid.map((row) => row.id) }, status: "pending" },
      data: { status: "invalidated" },
    });
  }
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }).finally(async () => prisma.$disconnect());
