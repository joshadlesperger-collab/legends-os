import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { analyzeParallel, estimateParallel, parallelPacketSchema } from "../lib/card-parallel.ts";

async function main() {
  const [command, file, ...args] = process.argv.slice(2);
  if (!["plan", "apply"].includes(command) || !file) throw Error("Use plan|apply PACKET.json [--entry ENTRY_ID] [--approved-database-import]");
  const packet = parallelPacketSchema.parse(JSON.parse(await readFile(file, "utf8")));
  const result = analyzeParallel(packet);
  const entryFlag = args.indexOf("--entry");
  if (entryFlag >= 0 && !args[entryFlag+1]) throw Error("Missing entry ID");
  const estimate = entryFlag >= 0 ? estimateParallel(packet, args[entryFlag+1]) : null;
  const id = createHash("sha256").update(JSON.stringify({ packet, entryId: entryFlag >= 0 ? args[entryFlag+1] : null, method: result.method, day: result.asOf.slice(0,10) })).digest("hex");
  const report = { id, result, estimate, databaseApplied: false };
  await mkdir("artifacts/knowledge-graph/parallel-studies", { recursive: true });
  await writeFile(`artifacts/knowledge-graph/parallel-studies/${id}.json`, JSON.stringify(report,null,2)+"\n");
  if (command === "apply") {
    if (!args.includes("--approved-database-import")) throw Error("Explicit database import approval required");
    const { PrismaClient } = await import("@prisma/client");
    const client = new PrismaClient();
    try {
      await client.knowledgeParallelStudy.upsert({ where: { id }, update: {}, create: {
        id, productId: result.scope.productId, section: result.scope.section,
        baseline: result.scope.baseline.parallel, target: result.scope.target.parallel, condition: result.scope.condition,
        currency: result.scope.currency, method: result.method, status: result.status, playerCount: result.playerCount,
        saleCount: result.saleCount, multiplier: result.multiplier, ratioLow: result.ratioLow, ratioHigh: result.ratioHigh, confidence: result.confidence,
        asOf: new Date(result.asOf), expiresAt: new Date(result.expiresAt), packet,
        result: { analysis: result, entryId: entryFlag >= 0 ? args[entryFlag+1] : null, estimate },
      } });
      report.databaseApplied = true;
    } finally { await client.$disconnect(); }
    await writeFile(`artifacts/knowledge-graph/parallel-studies/${id}.json`, JSON.stringify(report,null,2)+"\n");
  }
  console.log(JSON.stringify({ id, databaseApplied: report.databaseApplied, status: result.status, players: result.playerCount, sales: result.saleCount, multiplier: result.multiplier, blockers: result.blockers, estimate },null,2));
}
main().catch(() => { console.error("Parallel study failed. Check packet format, migration readiness and explicit import approval. Credentials are not logged."); process.exitCode=1; });
