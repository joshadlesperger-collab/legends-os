import { readFile, writeFile } from "node:fs/promises";
import { validateCatalog } from "../lib/card-knowledge.ts";
import { prepareMarketObservationImport, importMarketObservations, mergeMarketPackets } from "../lib/market-observation-import.ts";
async function main() {
  const paths = process.argv.slice(2).filter(arg => !arg.startsWith("--"));
  const packets = await Promise.all((paths.length ? paths : ["artifacts/knowledge-graph/saved-html-test.json"]).map(async path => JSON.parse(await readFile(path, "utf8"))));
  const packet = packets.length === 1 ? packets[0] : mergeMarketPackets(packets);
  const catalog = validateCatalog(JSON.parse(await readFile("data/card-catalog/topps-chrome-basketball-2025-26.json", "utf8")));
  const plan = prepareMarketObservationImport(packet, catalog);
  await writeFile("artifacts/knowledge-graph/all-market-observations-import-plan.json", JSON.stringify(plan, null, 2));
  if (!process.argv.includes("--apply")) { console.log(JSON.stringify({ status: "prepared-not-imported", ...plan.counts })); return; }
  if (!process.argv.includes("--approved-database-import")) throw Error("Explicit import approval required");
  if (!process.env.DATABASE_URL) { console.log(JSON.stringify({ status: "blocked-database-access", ...plan.counts, databaseImported: false })); process.exitCode = 2; return; }
  const { PrismaClient } = await import("@prisma/client");
  const client = new PrismaClient();
  try { console.log(JSON.stringify(await importMarketObservations(client, packet, catalog))); }
  finally { await client.$disconnect(); }
}
main().catch(() => { console.error("Market import failed. Check packet, database access and existing knowledge tables. No credentials logged; no migration attempted."); process.exitCode = 1; });
