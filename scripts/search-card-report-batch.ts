import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { parseSellerReport, searchSellerReportBatch, type SellerReportSource } from "../lib/card-report-batch-search.ts";
import { readSellerReports } from "./stage-seller-reports.mjs";
const packetSchema = z.object({ targets: z.array(z.object({ id: z.string().min(1), name: z.string().min(1), year: z.string().min(1), product: z.string().min(1), number: z.string().min(1), variant: z.string().min(1), serial: z.string(), skuAliases: z.array(z.string()).optional() }).strict()).min(1).max(100),
  sources: z.array(z.object({ path: z.string().min(1), kind: z.enum(["active", "orders"]) }).strict()).min(1).max(20).optional(), manifest: z.string().min(1).optional() }).strict().refine(p => Boolean(p.sources) !== Boolean(p.manifest), "Choose explicit sources or canonical manifest");
async function main() {
  const [packetFile, outputFile] = process.argv.slice(2); if (!packetFile || !outputFile) throw Error("Provide an explicit target/source packet and a new output artifact path");
  const output = path.resolve(outputFile), artifacts = path.resolve("artifacts"); if (!output.startsWith(`${artifacts}${path.sep}`)) throw Error("Output must remain inside artifacts");
  const started = performance.now(), packet = packetSchema.parse(JSON.parse(await fs.readFile(packetFile, "utf8"))), sources: SellerReportSource[] = [];
  if (packet.manifest) sources.push(...await readSellerReports(process.cwd(), packet.manifest));
  for (const input of packet.sources ?? []) {
    const before = await fs.stat(input.path); if (!before.isFile() || before.size > 50_000_000) throw Error("Source exceeds bounded file limits");
    const bytes = await fs.readFile(input.path), after = await fs.stat(input.path); if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw Error("Report source changed while reading");
    sources.push({ path: path.resolve(input.path), kind: input.kind, sha256: createHash("sha256").update(bytes).digest("hex"), modifiedAt: before.mtime.toISOString(), rows: parseSellerReport(bytes.toString("utf8"), input.kind) });
  }
  const report = { ...searchSellerReportBatch(packet.targets, sources), measuredLocalScanMs: performance.now() - started, externalCalls: 0, queueWrites: 0 };
  await fs.mkdir(path.dirname(output), { recursive: true }); await fs.writeFile(output, JSON.stringify(report, null, 2), { flag: "wx" });
  console.log(JSON.stringify({ output: outputFile, selectedCards: report.targets.length, uniqueSources: report.uniqueSourcesScanned, sourceRowsScanned: report.sourceRowsScanned, measuredLocalScanMs: report.measuredLocalScanMs, candidates: report.targets.map(t => ({ id: t.target.id, count: t.candidateCount })), externalCalls: 0, queueWrites: 0 }));
}
main().catch(() => { console.error("Read-only report batch search stopped; verify the explicit files and schema. No source or queue was changed."); process.exitCode = 1; });
