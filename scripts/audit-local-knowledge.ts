import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { validateCatalog, catalogGraph } from "../lib/card-knowledge.ts";
import { summarySchema } from "../lib/card-recovery-summary.ts";
import { validatedJsonReader } from "../lib/validated-json-cache.ts";

async function main() {
const root = "artifacts/knowledge-graph";
const out = `${root}/local-audit-${Date.now()}`;
mkdirSync(out, { recursive: true });
const paths = [`${root}/recovered-records.json`, `${root}/recovery-summary.json`, `${root}/recovered/legends-pricing.sqlite`, "data/card-catalog/topps-chrome-basketball-2025-26.json"];
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const fingerprint = (path: string) => { try { return hash(path); } catch { return null; } };
const before = paths.map(fingerprint);
const results: Record<string, unknown> = {};
const exceptions: { stage: string; error: string }[] = [];
async function stage(name: string, work: () => unknown | Promise<unknown>) {
  try { results[name] = await work(); } catch (error) { exceptions.push({ stage: name, error: error instanceof Error ? error.message : "failed" }); }
}
await stage("catalog", () => {
  const catalog = validateCatalog(JSON.parse(readFileSync(paths[3], "utf8")));
  let edges = 0;
  for (const section of Array.from(new Set(catalog.cards.map(c => c.section)))) {
    const graph = catalogGraph(catalog, "", section);
    const ids = new Set(graph.nodes.map(n => n.id));
    assert.ok(graph.edges.every(e => ids.has(e.from) && ids.has(e.to) && ids.has(e.sourceId)));
    edges += graph.edges.length;
  }
  return { cards: catalog.cards.length, sources: catalog.sources.length, unresolved: catalog.unresolved.length, checkedBoundedGraphEdges: edges, fullCatalogProvenanceValidated: true };
});
await stage("recoveredGraph", () => {
  const snapshot = JSON.parse(readFileSync(paths[0], "utf8"));
  const summary = summarySchema.parse(JSON.parse(readFileSync(paths[1], "utf8")));
  const t = snapshot.tables as Record<string, Record<string, unknown>[]>;
  const keys: Record<string, string> = { source_records: "card_id", card_variants: "variant_id", inventory: "card_id", evidence_summaries: "evidence_id", price_recommendations: "recommendation_id", listing_records: "card_id", pilot: "card_id" };
  const findings: string[] = [];
  for (const [table, rows] of Object.entries(t)) {
    if (rows.length !== summary.counts[table]) findings.push(`${table}: summary count mismatch`);
    if (keys[table] && new Set(rows.map(r => r[keys[table]])).size !== rows.length) findings.push(`${table}: duplicate primary keys`);
  }
  const cards = new Set(t.source_records.map(r => r.card_id));
  const variants = new Set(t.card_variants.map(r => r.variant_id));
  const evidence = new Map(t.evidence_summaries.map(r => [r.evidence_id, r.card_id]));
  let checkedReferences = 0;
  for (const [table, rows] of Object.entries(t)) for (const row of rows) {
    if (table !== "source_records" && row.card_id !== undefined) { checkedReferences++; if (!cards.has(row.card_id)) findings.push(`${table}: orphan card`); }
    if (table === "inventory") { checkedReferences++; if (!variants.has(row.variant_id)) findings.push("inventory: orphan variant"); }
    if (table === "price_recommendations") { checkedReferences++; if (evidence.get(row.evidence_id) !== row.card_id) findings.push("recommendation: mismatched evidence"); }
  }
  if (snapshot.sourceSha256 !== before[2] || summary.sourceSha256 !== before[2]) findings.push("source SQLite fingerprint mismatch");
  return { counts: summary.counts, checkedReferences, findings, databaseApplied: summary.databaseApplied, liveStatusVerified: summary.liveStatusVerified };
});
await stage("sqlite", () => {
  // Isolate unsupported runtimes to this stage; repository types target Node 20.
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
  const db = new DatabaseSync(paths[2], { readOnly: true });
  try { return { integrity: db.prepare("PRAGMA integrity_check").all(), foreignKeyViolations: db.prepare("PRAGMA foreign_key_check").all() }; }
  finally { db.close(); }
});
await stage("summaryPerformance", async () => {
  const baseline = async () => summarySchema.parse(JSON.parse(await readFile(paths[1], "utf8")));
  const cached = validatedJsonReader(paths[1], raw => summarySchema.parse(raw));
  assert.deepEqual(await baseline(), await cached());
  for (let i = 0; i < 30; i++) { await baseline(); await cached(); }
  const measure = async (fn: typeof baseline) => {
    const started = performance.now(); for (let i = 0; i < 200; i++) await fn();
    return (performance.now() - started) / 200;
  };
  const a: number[] = [], b: number[] = [];
  for (let i = 0; i < 7; i++) {
    if (i % 2) { b.push(await measure(cached)); a.push(await measure(baseline)); }
    else { a.push(await measure(baseline)); b.push(await measure(cached)); }
  }
  const median = (values: number[]) => [...values].sort((x,y) => x-y)[Math.floor(values.length/2)];
  return { scope: "warm local summary read+parse+validation, not end-to-end card processing", iterationsPerRound: 200, baselineMs: a, cachedMs: b, baselineMedianMs: median(a), cachedMedianMs: median(b), speedup: median(a)/median(b), equivalent: true };
});
assert.deepEqual(paths.map(fingerprint), before, "Audit must preserve source bytes");
const report = { createdAt: new Date().toISOString(), paidCalls: 0, sourceFilesUnchanged: true, results, exceptions };
writeFileSync(`${out}/report.json`, JSON.stringify(report, null, 2), { flag: "wx" });
console.log(JSON.stringify({ out, ...report }, null, 2));
}
main().catch(() => { console.error("Local audit failed; no source mutation requested."); process.exitCode = 1; });
