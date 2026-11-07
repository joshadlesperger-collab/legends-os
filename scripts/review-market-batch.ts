import { readFile, writeFile } from "node:fs/promises";
import { reviewMarketBatch } from "../lib/card-market-review.ts";
import { validateCatalog } from "../lib/card-knowledge.ts";
const input = "artifacts/knowledge-graph/ebay-page-review-2026-10-23.json";
const output = "artifacts/knowledge-graph/market-review.json";
async function main() {
const start = performance.now();
const catalog = validateCatalog(JSON.parse(await readFile("data/card-catalog/topps-chrome-basketball-2025-26.json", "utf8")));
const result = reviewMarketBatch(JSON.parse(await readFile(input, "utf8")), catalog);
await writeFile(output, JSON.stringify({ ...result, analyzedAt: new Date().toISOString(), analysisMilliseconds: Math.round(performance.now() - start) }, null, 2));
console.log(JSON.stringify({ ...result.summary, verifiedComps: result.verifiedComps, databaseImported: false, output }, null, 2));
}
main().catch(() => { console.error("Market review failed; inspect the local source packet and catalog."); process.exitCode = 1; });
