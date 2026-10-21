import fs from "node:fs/promises";
import path from "node:path";
import { loadCardBacklog } from "../lib/card-backlog-store.ts";

async function main() {
const snapshot = await loadCardBacklog();
const directory = path.resolve("artifacts/card-backlog");
await fs.mkdir(directory, { recursive: true });
await fs.writeFile(path.join(directory, "snapshot.json"), JSON.stringify(snapshot, null, 2));
await fs.writeFile(path.join(directory, "audit.json"), JSON.stringify({ asOf: snapshot.asOf, counts: snapshot.counts,
  scan: { ...snapshot.scan, unmatched: snapshot.scan.unmatched.length }, sources: snapshot.sources, warnings: snapshot.warnings,
  unresolved: snapshot.cards.filter(c => c.issues.length).map(c => ({ id: c.id, aliases: c.aliases, issues: c.issues })) }, null, 2));
console.log(JSON.stringify({ asOf: snapshot.asOf, counts: snapshot.counts,
  scan: { ...snapshot.scan, unmatched: snapshot.scan.unmatched.length }, warnings: snapshot.warnings,
  snapshot: "artifacts/card-backlog/snapshot.json", audit: "artifacts/card-backlog/audit.json" }, null, 2));
}
main().catch(() => { console.error("Backlog audit failed; previous evidence preserved."); process.exitCode = 1; });
