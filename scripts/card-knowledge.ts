import { readFile, mkdir, writeFile } from "node:fs/promises";
import { validateCatalog, searchCatalog, catalogGraph } from "../lib/card-knowledge.ts";
import { catalogDigest, importCardCatalog, importLegacyKnowledge, prepareLegacyImport, reconcileLegacyEntries } from "../lib/card-knowledge-import.ts";
import { KNOWLEDGE_TITLE_POLICY, recommendedEbayTitle } from "../lib/card-knowledge-title.ts";

async function main() {
const args = process.argv.slice(2), command = args[0] ?? "status";
const catalog = validateCatalog(JSON.parse(await readFile("data/card-catalog/topps-chrome-basketball-2025-26.json", "utf8")));
if (command === "search") {
  console.log(JSON.stringify(searchCatalog(catalog, args.slice(1).join(" ")), null, 2));
} else if (command === "graph") {
  console.log(JSON.stringify(catalogGraph(catalog, args.slice(1).join(" ")), null, 2));
} else if (["status", "plan", "apply", "apply-catalog"].includes(command)) {
  let recovery: unknown;
  try { recovery = JSON.parse(await readFile("artifacts/knowledge-graph/recovered-records.json", "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const legacy = recovery ? prepareLegacyImport(recovery) : null;
  const links = recovery ? reconcileLegacyEntries(catalog, recovery) : [];
  const plan = { product: catalog.product, catalogDigest: catalogDigest(catalog), checklistEntries: catalog.cards.length,
    subjects: new Set(catalog.cards.map(c => c.subjectId)).size, oddsRows: catalog.odds.length,
    reviewItems: catalog.unresolved.length, titlePolicy: KNOWLEDGE_TITLE_POLICY, titles: catalog.cards.map(c => ({ entryId: c.id, playerName: c.player, recommendedEbayTitle: recommendedEbayTitle(catalog.product, c) })), legacyRecords: legacy?.records.length ?? null,
    legacyCounts: legacy?.counts ?? null, legacyChecklistLinks: { candidates: links.filter(l => l.status === "candidate").length, held: links.filter(l => l.status !== "candidate").length }, databaseApplied: false, requiresMigrationApproval: true,
    limitations: catalog.limitations, sources: catalog.sources };
  if (command === "plan") {
    await mkdir("artifacts/knowledge-graph", { recursive: true });
    await writeFile("artifacts/knowledge-graph/import-plan.json", JSON.stringify(plan, null, 2) + "\n");
    await writeFile("artifacts/knowledge-graph/checklist-link-proposals.json", JSON.stringify(links, null, 2) + "\n");
  }
  if (command === "apply" || command === "apply-catalog") {
    if (!args.includes("--approved-database-import")) throw Error("Explicit database-import approval is required. Review cards:knowledge plan first.");
    const { PrismaClient } = await import("@prisma/client");
    const client = new PrismaClient();
    try {
      console.log(JSON.stringify(await importCardCatalog(client, catalog)));
      if (command === "apply" && recovery) console.log(JSON.stringify(await importLegacyKnowledge(client, recovery)));
    } finally { await client.$disconnect(); }
  } else console.log(JSON.stringify(plan, null, 2));
} else throw Error("Use status, plan, search QUERY, graph QUERY, or apply-catalog --approved-database-import (only after explicit approval).");
}
main().catch(() => { console.error("Knowledge command failed. Validate the catalog and recovery inputs; apply also requires explicit approval and the approved database migration. No credentials are logged."); process.exitCode = 1; });
