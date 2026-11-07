import { readFile, writeFile, mkdir } from "node:fs/promises";
import { validateCatalog } from "../lib/card-knowledge.ts";
import { prepareSellerEvidence, buildSellerRelationships } from "../lib/card-parallel-intake.ts";
import { collectSellerSales, loadSellerReviews } from "../lib/card-parallel-sales-store.ts";

async function main() {
  const [command, snapshotFile, reviewFile] = process.argv.slice(2);
  if (!["collect", "analyze"].includes(command)) throw Error("Use collect or analyze SNAPSHOT.json [REVIEWS.json]");
  const folder = "artifacts/knowledge-graph";
  await mkdir(folder, { recursive: true });
  let snapshot;
  if (command === "collect") {
    if (!process.env.DATABASE_URL) throw Error("Database connection unavailable; no sales collected");
    const { PrismaClient } = await import("@prisma/client");
    const client = new PrismaClient();
    try { snapshot = await collectSellerSales(client); } finally { await client.$disconnect(); }
    await writeFile(`${folder}/seller-sales.json`, JSON.stringify(snapshot, null, 2) + "\n");
  } else {
    if (!snapshotFile) throw Error("Snapshot required");
    snapshot = JSON.parse(await readFile(snapshotFile, "utf8"));
  }
  const catalog = validateCatalog(JSON.parse(await readFile("data/card-catalog/topps-chrome-basketball-2025-26.json", "utf8")));
  const reviews = reviewFile ? JSON.parse(await readFile(reviewFile, "utf8")) : await loadSellerReviews();
  const evidence = prepareSellerEvidence(snapshot, reviews, catalog);
  const relationships = buildSellerRelationships(evidence.accepted);
  await writeFile(`${folder}/seller-sale-review-candidates.json`, JSON.stringify({ version: 1, instruction: "Suggestions are not verification. Complete reviews in seller-sale-reviews.json after inspecting original evidence; preserve prior reviews.", candidates: evidence.rows.map(r => ({ key: r.key, fingerprint: r.fingerprint, title: r.title, suggestions: r.suggestions, blockers: r.blockers })) }, null, 2) + "\n");
  await writeFile(`${folder}/seller-parallel-coverage.json`, JSON.stringify({ ...evidence, relationships, databaseApplied: false }, null, 2) + "\n");
  console.log(JSON.stringify({ candidates: evidence.rows.length, verifiedSales: evidence.accepted.length, held: evidence.heldCount, relationships: relationships.length, truncated: evidence.truncated, databaseApplied: false }));
}
main().catch(() => { console.error("Seller evidence intake failed: check database availability or snapshot/review schema. No credentials or buyer data logged; no database writes performed."); process.exitCode = 1; });
