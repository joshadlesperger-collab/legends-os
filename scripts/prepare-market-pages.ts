import { readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { validateCatalog } from "../lib/card-knowledge.ts";
import { prepareMarketObservationImport } from "../lib/market-observation-import.ts";

// Keep each snapshot's provenance; the unique index is not another sale or import.
async function main() {
const started = performance.now();
const paths = process.argv.slice(2);
if (!paths.length) throw Error("Pass saved HTML extraction JSON paths");
const catalog = validateCatalog(JSON.parse(await readFile("data/card-catalog/topps-chrome-basketball-2025-26.json", "utf8")));
const listings = new Map<string, { observations: unknown[]; fingerprints: Set<string>; matched: boolean; uncertain: boolean }>();
const sources = [];
for (const path of paths) {
  const packet = JSON.parse(await readFile(path, "utf8"));
  const plan = prepareMarketObservationImport(packet, catalog);
  const planPath = path.replace(/\.json$/, "-import-plan.json");
  if (planPath === path) throw Error("Expected JSON input path");
  await writeFile(planPath, JSON.stringify(plan, null, 2));
  sources.push({ path, planPath, sourceSha256: packet.sourceSha256, extractionSeconds: packet.extractionSeconds, ...plan.counts });
  for (const record of plan.records) {
    const row = record.raw;
    const entry = listings.get(record.sourceKey) ?? { observations: [], fingerprints: new Set<string>(), matched: false, uncertain: false };
    entry.observations.push(row);
    entry.fingerprints.add(JSON.stringify([row.title, row.soldDateText, row.displayedPrices, row.displayedShippingCents, row.priceStatus]));
    entry.matched ||= !!row.proposedChecklistEntryId;
    entry.uncertain ||= row.priceStatus !== "displayed_auction_result";
    listings.set(record.sourceKey, entry);
  }
}
const rows = Array.from(listings).map(([observationKey, entry]) => ({ observationKey, observations: entry.observations, conflictingSnapshots: entry.fingerprints.size > 1, pricingEligible: false }));
const summary = {
  sources, totalObservations: sources.reduce((n, s) => n + s.marketObservations, 0),
  uniqueListings: listings.size,
  duplicateObservations: sources.reduce((n, s) => n + s.marketObservations, 0) - listings.size,
  titleMatches: Array.from(listings.values()).filter(e => e.matched && e.fingerprints.size === 1).length,
  uncertainPrices: Array.from(listings.values()).filter(e => e.uncertain).length,
  conflictingSnapshots: rows.filter(r => r.conflictingSnapshots).length,
  preparationSeconds: Number(((performance.now() - started) / 1000).toFixed(3)),
  databaseImported: false,
};
await writeFile("artifacts/knowledge-graph/saved-pages-index.json", JSON.stringify({ summary, rows }, null, 2));
console.log(JSON.stringify(summary, null, 2));

}
main().catch(() => { console.error("Saved page preparation failed; no database writes attempted."); process.exitCode = 1; });
