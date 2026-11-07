import nextEnv from "@next/env";
import { readFileSync } from "node:fs";
import { parseBenchmarkCases, runModelBenchmark, saveBenchmarkReport } from "../lib/ai-benchmark.ts";
import { configuredProviders, isAiProvider, providerStatus, type AiProvider } from "../lib/ai-providers.ts";
import { BenchmarkBudget, type BenchmarkBound } from "../lib/ai-benchmark-budget.ts";

function argValue(args: string[], flag: string) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

/** Local head-to-head model benchmark. Dry-run by default: prints the plan and provider status
 * without any network calls. Pass --run to execute live calls, bounded to the listed cases only.
 * No database, eBay or deployment access; results save locally under artifacts/model-benchmark. */
async function main() {
  nextEnv.loadEnvConfig(process.cwd());
  const args = process.argv.slice(2);
  const casesPath = argValue(args, "--cases");
  if (!casesPath) throw new Error("Usage: npm run models:benchmark -- --cases FILE [--task recognition|pricing] [--providers openai,anthropic,xai,google,meta] [--limit N] [--out DIR] [--run]");
  let { cases } = parseBenchmarkCases(JSON.parse(readFileSync(casesPath, "utf8")));
  const task = argValue(args, "--task");
  if (task !== undefined) {
    if (task !== "recognition" && task !== "pricing") throw new Error("--task must be recognition or pricing.");
    cases = cases.filter(entry => entry.kind === task);
  }
  const limit = Number(argValue(args, "--limit") ?? "0");
  if (limit > 0) cases = cases.slice(0, limit);
  if (cases.length === 0) throw new Error("No benchmark cases selected.");
  const providersArg = argValue(args, "--providers");
  const providers = (providersArg ?? "openai,anthropic,xai,google").split(",").map(value => {
    const normalized = value.trim().toLowerCase();
    if (!isAiProvider(normalized)) throw new Error(`Unknown provider "${value}". Supported: openai, anthropic, xai, google, meta.`);
    return normalized as AiProvider;
  });
  if (!args.includes("--run")) {
    console.log(JSON.stringify({
      mode: "dry-run", cases: cases.map(entry => ({ id: entry.id, kind: entry.kind })),
      plannedProviders: providers ?? (configuredProviders().length ? configuredProviders() : ["openai"]),
      providers: providerStatus(),
      hint: "Pass --run to execute live provider calls. Calls are sequential and bounded to the listed cases only.",
    }, null, 2));
    return;
  }
  const boundsPath = argValue(args, "--bounds");
  if (!boundsPath) throw Error("Live run requires --bounds FILE with reviewed provider/model billing upper bounds.");
  const bounds = JSON.parse(readFileSync(boundsPath, "utf8")) as BenchmarkBound[];
  const prior = argValue(args, "--prior-spend-usd");
  // Fixed path shared across all providers, task filters, output directories and reruns.
  const phase = argValue(args, "--phase") ?? "initial";
  if (phase !== "initial" && phase !== "retest") throw Error("--phase must be initial or retest.");
  const budget = new BenchmarkBudget("artifacts/model-benchmark/spending-ledger.jsonl", prior === undefined ? undefined : Number(prior), phase);
  try {
  const report = await runModelBenchmark({ cases, providers, budget, bounds });
  const saved = saveBenchmarkReport(report, argValue(args, "--out") ?? "artifacts/model-benchmark");
  console.log(JSON.stringify({
    saved, budget: report.budget, summary: report.summary, caseDisagreements: report.caseDisagreements,
    recommendations: report.recommendations, note: report.note,
  }, null, 2));
  } finally { budget.close(); }
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
