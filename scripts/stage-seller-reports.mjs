import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parseSellerReport } from "../lib/card-report-batch-search.ts";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
async function immutable(filename, bytes) {
  try { const out = await fs.open(filename, "wx"); try { await out.writeFile(bytes); await out.sync(); } finally { await out.close(); } return true; }
  catch (error) { if (error.code !== "EEXIST") throw error; if (sha(await fs.readFile(filename)) !== sha(bytes)) throw Error("Immutable seller report/index conflict; existing bytes were preserved"); return false; }
}
/** Explicit local staging only. Raw CSVs remain private/ignored; index rows have
 * no buyer/contact/order/tracking fields and no raw transaction identifiers. */
export async function stageSellerReports(root, packet) {
  if (packet?.seller !== "imaydit58" || !Array.isArray(packet.sources) || !packet.sources.length || packet.sources.length > 20) throw Error("Explicit bounded seller/source packet required");
  const ignores = await fs.readFile(path.join(root, ".gitignore"), "utf8");
  if (!ignores.split(/\r?\n/).includes("/reports/ebay/")) throw Error("Private report directory must be explicitly git-ignored before staging");
  const base = path.join(root, "reports/ebay/imaydit58"); await fs.mkdir(base, { recursive: true });
  const baseReal = await fs.realpath(base), intended = path.relative(await fs.realpath(root), baseReal);
  if (intended !== path.join("reports", "ebay", "imaydit58")) throw Error("Private report directory must not escape the repository");
  const lock = await fs.open(path.join(base, "stage.lock"), "wx");
  try {
    let previous = { version: 1, seller: "imaydit58", sources: [] };
    try { previous = JSON.parse(await fs.readFile(path.join(base, "latest.json"), "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (previous.version !== 1 || previous.seller !== "imaydit58" || !Array.isArray(previous.sources)) throw Error("Existing seller report manifest is invalid");
    const staged = [];
    for (const input of packet.sources) {
      if (!["active", "orders"].includes(input.kind) || !/^\d{4}-\d{2}-\d{2}$/.test(input.exportDate) || !/^[a-z0-9-]{1,80}$/.test(input.coverage) || !/\.csv$/i.test(input.path)) throw Error("Source requires kind, explicit export-date, coverage label and CSV path");
      const source = path.resolve(root, input.path), before = await fs.stat(source); if (!before.isFile() || before.size > 50_000_000) throw Error("Report exceeds bounded size");
      const bytes = await fs.readFile(source), after = await fs.stat(source);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw Error("Seller source changed during stable read");
      const rows = parseSellerReport(bytes.toString("utf8"), input.kind), hash = sha(bytes), directory = path.join(base, input.exportDate); await fs.mkdir(directory, { recursive: true });
      const raw = path.join(directory, `${input.kind}-${hash}.csv`), index = path.join(directory, `${input.kind}-${hash}.index.json`);
      const indexBytes = Buffer.from(JSON.stringify({ version: 1, seller: "imaydit58", sourceSha256: hash, kind: input.kind,
        rows: rows.map(row => ({ ...row, transactionKey: row.transactionKey ? sha(`${row.itemId}:${row.transactionKey}`) : null })) }, null, 2));
      await immutable(raw, bytes); await immutable(index, indexBytes);
      const record = { kind: input.kind, coverage: input.coverage, exportDate: input.exportDate, sourceOriginalPath: source,
        sourceModifiedAt: before.mtime.toISOString(), reportGeneratedAt: input.reportGeneratedAt ?? null,
        rawPath: path.relative(root, raw).replace(/\\/g, "/"), sha256: hash, bytes: bytes.length,
        indexPath: path.relative(root, index).replace(/\\/g, "/"), indexSha256: sha(indexBytes), rows: rows.length,
        sourceDateMeaning: "Original source modification/export date retained; staging/index time is not a fresh live observation", freshLiveObservation: false };
      staged.push(record);
    }
    const sources = [...previous.sources];
    for (const record of staged) {
      const same = sources.findIndex(s => s.kind === record.kind && s.coverage === record.coverage);
      if (same < 0) sources.push(record);
      else if (record.exportDate >= sources[same].exportDate) sources[same] = record;
    }
    const manifest = { version: 1, seller: "imaydit58", updatedAt: new Date().toISOString(), privateLocalOnly: true, freshLiveObservation: false, sources };
    const tmp = path.join(base, `latest-${randomUUID()}.tmp`), out = await fs.open(tmp, "wx");
    try { await out.writeFile(JSON.stringify(manifest, null, 2)); await out.sync(); } finally { await out.close(); }
    await fs.rename(tmp, path.join(base, "latest.json")); return { manifest: "reports/ebay/imaydit58/latest.json", staged, sourceWrites: 0, queueWrites: 0, externalCalls: 0 };
  } finally { await lock.close(); await fs.unlink(path.join(base, "stage.lock")); }
}
/** Read only verified canonical indexes; preserve original timestamps, never copy mtimes. */
export async function readSellerReports(root, manifestFile = "reports/ebay/imaydit58/latest.json") {
  const base = await fs.realpath(path.join(root, "reports/ebay/imaydit58"));
  async function bounded(filename) {
    const resolved = await fs.realpath(path.resolve(root, filename));
    const relative = path.relative(base, resolved);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw Error("Report reference escapes private seller storage");
    const stat = await fs.stat(resolved); if (stat.size > 50_000_000) throw Error("Report reference exceeds bounds");
    return fs.readFile(resolved);
  }
  const manifest = JSON.parse((await bounded(manifestFile)).toString("utf8"));
  if (manifest.version !== 1 || manifest.seller !== "imaydit58" || !Array.isArray(manifest.sources) || manifest.sources.length > 20) throw Error("Invalid report manifest");
  const sources = [];
  for (const source of manifest.sources) {
    const raw = await bounded(source.rawPath), bytes = await bounded(source.indexPath);
    if (sha(raw) !== source.sha256 || sha(bytes) !== source.indexSha256) throw Error("Canonical seller evidence hash mismatch");
    const index = JSON.parse(bytes.toString("utf8"));
    if (index.version !== 1 || index.seller !== "imaydit58" || index.sourceSha256 !== source.sha256 || index.kind !== source.kind || !Array.isArray(index.rows) || index.rows.length !== source.rows) throw Error("Canonical seller index binding mismatch");
    sources.push({ path: source.rawPath, sha256: source.sha256, modifiedAt: source.sourceModifiedAt, kind: source.kind, rows: index.rows });
  }
  return sources;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const packet = process.argv[2];
  if (!packet) { console.error("Provide a reviewed explicit source packet; staging never downloads or imports queue state."); process.exitCode = 1; }
  else stageSellerReports(process.cwd(), JSON.parse(await fs.readFile(packet, "utf8"))).then(result => console.log(JSON.stringify(result))).catch(() => { console.error("Private report staging stopped; source files and queues were preserved."); process.exitCode = 1; });
}
