import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  caseDisagreements, compareIdentityFields, normalizeUsage, parseBenchmarkCases,
  recommendRouting, runModelBenchmark, saveBenchmarkReport, type BenchmarkCase,
} from "../lib/ai-benchmark.ts";

const PNG = "data:image/png;base64," + Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4, 5]).toString("base64");
const ENV_KEYS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "XAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "AI_MODEL_COSTS"];

/** Env must stay patched until an async callback finishes; a synchronous finally would restore
 * keys at the first await and silently flip later benchmark runs to "skipped". */
async function withEnv(patch: Record<string, string | undefined>, fn: () => unknown | Promise<unknown>) {
  const saved = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
  try { return await fn(); } finally {
    for (const key of ENV_KEYS) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  }
}

const identity = (year: number) => ({
  sport: "Baseball", player: "Test Player", year, manufacturer: "Topps", set: null, cardNumber: "1",
  team: null, parallel: null, serialNumber: null, numberedTo: null, rookie: null, autograph: null, graded: null, grade: null,
});
const recognitionOutput = (year: number) => ({ pairMatches: true, frontImageIndex: "0", identity: identity(year), warnings: [], approach: "Matched front name and back card number text." });
const pricingOutput = (target: number) => ({ targetBuyerTotal: target, shipping: 2, approach: "Averaged matching NM comps including known shipping.", warnings: [] });

const recognitionCase: BenchmarkCase = { kind: "recognition", id: "r1", images: [PNG, PNG], expected: { pairMatches: true, identity: { player: "Test Player", year: 2025, manufacturer: "Topps" } } };
const pricingCase: BenchmarkCase = { kind: "pricing", id: "p1", evidence: { comps: [{ item: 10, shipping: 2 }] }, baseline: { buyerTotal: 12.49, shipping: 2 } };

function scriptedGenerate(script: Record<string, unknown[]>, captured?: Record<string, unknown>[]) {
  return async (options: Record<string, unknown>) => {
    captured?.push(options);
    const provider = String((options.model as { provider?: string }).provider ?? "");
    const key = provider.startsWith("openai") ? "openai" : provider.startsWith("anthropic") ? "anthropic" : provider.startsWith("google") ? "google" : "xai";
    const output = script[key]?.shift();
    if (output instanceof Error) throw output;
    return { output, usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 } };
  };
}

test("head-to-head run measures accuracy, latency, tokens, cost and disagreement", async () => { await withEnv({
  OPENAI_API_KEY: "test", ANTHROPIC_API_KEY: "test", GOOGLE_GENERATIVE_AI_API_KEY: "test",
}, async () => {
  const captured: Record<string, unknown>[] = [];
  const report = await runModelBenchmark({
    cases: [recognitionCase, pricingCase],
    providers: ["openai", "anthropic", "google"],
    models: { anthropic: "claude-haiku-4-5" },
    generate: scriptedGenerate({
      openai: [recognitionOutput(2025), pricingOutput(12)],
      anthropic: [recognitionOutput(2024), pricingOutput(13.9)],
      google: [recognitionOutput(2025), pricingOutput(12)],
    }, captured),
  });
  assert.equal(report.runs.length, 6);
  assert.ok(report.runs.every(run => run.status === "ok"));
  assert.ok(report.runs.filter(run=>run.task==='pricing').every(run=>run.pricingEvidence?.marketPriceSupported===false));
  assert.match(report.note,/NOT independent market valuation/);

  const openaiRecognition = report.runs.find(run => run.caseId === "r1" && run.provider === "openai")!;
  assert.equal(openaiRecognition.accuracy, 1);
  assert.equal(typeof openaiRecognition.latencyMs, "number");
  assert.equal(openaiRecognition.costEstimated, false); // unknown model rate: never fabricated
  assert.equal(openaiRecognition.approach, "Matched front name and back card number text.");

  const anthropicRecognition = report.runs.find(run => run.caseId === "r1" && run.provider === "anthropic")!;
  assert.equal(anthropicRecognition.accuracy, 0.75);
  assert.deepEqual(anthropicRecognition.mismatchedFields, ["year"]);

  const anthropicPricing = report.runs.find(run => run.caseId === "p1" && run.provider === "anthropic")!;
  assert.equal(anthropicPricing.disagreement, true);
  assert.equal(anthropicPricing.accuracy, 0);

  const googleRecognition = report.runs.find(run => run.caseId === "r1" && run.provider === "google")!;
  assert.equal(googleRecognition.model, "gemini-2.5-flash");
  assert.equal(googleRecognition.accuracy, 1);
  assert.equal(googleRecognition.approach, "Matched front name and back card number text.");
  const googlePricing = report.runs.find(run => run.caseId === "p1" && run.provider === "google")!;
  assert.equal(googlePricing.disagreement, false);
  assert.equal(googlePricing.accuracy, 1);

  const summary = Object.fromEntries(report.summary.map(row => [`${row.task}:${row.provider}`, row]));
  assert.equal(summary["recognition:openai"].meanAccuracy, 1);
  assert.equal(summary["recognition:anthropic"].inputTokens, 100);
  assert.equal(summary["recognition:anthropic"].costUsd, 0.00035); // 100 in @ $1 + 50 out @ $5 per 1M
  assert.equal(summary["recognition:anthropic"].costComplete, true);
  assert.equal(summary["recognition:openai"].costComplete, false);
  assert.equal(summary["recognition:google"].costUsd, 0.000155); // 100 in @ $0.30 + 50 out @ $2.50 per 1M
  assert.equal(summary["recognition:google"].costComplete, true);

  const disagreement = report.caseDisagreements.find(row => row.caseId === "r1")!;
  assert.deepEqual(disagreement.fields, ["year"]);
  assert.deepEqual(report.caseDisagreements.find(row => row.caseId === "p1")!.fields, ["targetBuyerTotal"]);

  const recognitionRecommendation = report.recommendations.find(row => row.task === "recognition")!;
  assert.equal(recognitionRecommendation.recommendedProvider, "google"); // unknown cost cannot win as zero
  assert.equal(recognitionRecommendation.applied, false);
  assert.equal(report.advisoryOnly, true);

  // Identical inputs across providers: same system prompt and same messages for the same case.
  assert.deepEqual(captured[0].messages, captured[1].messages);
  assert.deepEqual(captured[0].messages, captured[2].messages);
  assert.equal(captured[0].system, captured[1].system);
  assert.equal(captured[0].system, captured[2].system);
  assert.deepEqual((captured[0].providerOptions as { openai: { store: boolean } }).openai.store, false);
  assert.equal(captured[1].providerOptions, undefined);
  assert.equal(captured[2].providerOptions, undefined);
}); });

test("schema failures, call errors and unconfigured providers are isolated statuses", async () => { await withEnv({
  OPENAI_API_KEY: "test",
}, async () => {
  const report = await runModelBenchmark({
    cases: [recognitionCase, pricingCase],
    providers: ["openai", "xai"],
    generate: scriptedGenerate({ openai: [{ broken: true }, new Error("provider unavailable")] }),
  });
  const byRun = Object.fromEntries(report.runs.map(run => [`${run.caseId}:${run.provider}`, run]));
  assert.equal(byRun["r1:openai"].status, "schema-failure");
  assert.equal(byRun["p1:openai"].status, "error");
  assert.match(byRun["p1:openai"].failures.join(" "), /provider unavailable/);
  assert.equal(byRun["r1:xai"].status, "skipped");
  assert.match(byRun["r1:xai"].failures.join(" "), /XAI_API_KEY/);
  const openaiSummary = report.summary.find(row => row.task === "recognition" && row.provider === "openai")!;
  assert.equal(openaiSummary.schemaFailures, 1);
  assert.equal(report.recommendations.find(row => row.task === "recognition")!.recommendedProvider, null);
}); });

test("reports save locally without image payloads and stay advisory", async () => { await withEnv({
  OPENAI_API_KEY: "test",
}, async () => {
  const report = await runModelBenchmark({
    cases: [pricingCase], providers: ["openai"],
    generate: scriptedGenerate({ openai: [pricingOutput(12)] }),
  });
  const dir = mkdtempSync(join(tmpdir(), "model-benchmark-"));
  const file = saveBenchmarkReport(report, dir);
  const saved = readFileSync(file, "utf8");
  assert.deepEqual(JSON.parse(saved).summary, report.summary);
  assert.ok(existsSync(join(dir, "latest.json")));
  assert.ok(!saved.includes("data:image"));
  assert.match(saved, /legends-model-benchmark-v1/);
  assert.equal(JSON.parse(saved).recommendations[0].applied, false);
  const secondReport={...report,note:"Second report with the same timestamp"};
  const secondFile=saveBenchmarkReport(secondReport,dir);
  assert.notEqual(secondFile,file);
  assert.equal(readFileSync(file,"utf8"),saved);
  assert.equal(JSON.parse(readFileSync(secondFile,"utf8")).note,secondReport.note);
  assert.equal(JSON.parse(readFileSync(join(dir,"latest.json"),"utf8")).note,secondReport.note);
}); });

test("case files parse as an array or wrapped object and reject bad entries", () => {
  assert.equal(parseBenchmarkCases([pricingCase]).cases.length, 1);
  assert.equal(parseBenchmarkCases({ schema: "v1", cases: [recognitionCase] }).cases.length, 1);
  assert.throws(() => parseBenchmarkCases({ cases: [] }), /non-empty/);
  assert.throws(() => parseBenchmarkCases([{ kind: "pricing", id: "x" }]), /Invalid benchmark case 0/);
  assert.throws(() => parseBenchmarkCases([{ kind: "other", id: "x" }]), /Invalid benchmark case 0/);
});

test("usage normalization and identity comparison tolerate provider shape drift", () => {
  assert.deepEqual(normalizeUsage({ inputTokens: 3, outputTokens: 4 }), { inputTokens: 3, outputTokens: 4, totalTokens: 7 });
  assert.deepEqual(normalizeUsage({ promptTokens: 3, completionTokens: 4, totalTokens: 9 })!.totalTokens, 9);
  assert.equal(normalizeUsage("junk"), null);
  const comparison = compareIdentityFields({ player: "  TEST Player ", year: 2025, set: null }, { player: "test player", year: 2025, set: undefined });
  assert.equal(comparison.accuracy, 1);
  assert.equal(compareIdentityFields({ year: 2025 }, { year: 2024 }).mismatchedFields[0], "year");
});

test("routing recommendations rank accuracy, then cost, then latency", () => {
  const recommendations = recommendRouting([
    { task: "recognition", provider: "anthropic", runs: 2, ok: 2, schemaFailures: 0, validationFailures: 0, errors: 0, skipped: 0, meanLatencyMs: 100, inputTokens: 0, outputTokens: 0, costUsd: 0.1, costComplete: true, meanAccuracy: 0.9, disagreements: 0 },
    { task: "recognition", provider: "openai", runs: 2, ok: 2, schemaFailures: 0, validationFailures: 0, errors: 0, skipped: 0, meanLatencyMs: 50, inputTokens: 0, outputTokens: 0, costUsd: 0.1, costComplete: true, meanAccuracy: 0.9, disagreements: 0 },
  ]);
  assert.equal(recommendations[0].recommendedProvider, "openai");
  assert.equal(recommendations[0].currentDefault, "openai");
  assert.equal(recommendations[0].applied, false);
  assert.equal(recommendations[1].recommendedProvider, null);
});

test("weak evidence is scored as a hold without inventing a price", async () => { await withEnv({ OPENAI_API_KEY: "test" }, async () => {
  const cases: BenchmarkCase[] = [{ kind: "pricing", id: "held", evidence: { shipping: null }, expectedHold: true }];
  const report = await runModelBenchmark({ cases, providers: ["openai"], generate: async () => ({
    output: { hold: true, targetBuyerTotal: null, shipping: null, approach: "Shipping evidence is missing.", warnings: ["Unknown source shipping"] },
    usage: { inputTokens: 10, outputTokens: 10 },
  }) });
  assert.equal(report.runs[0].accuracy, 1);
  assert.equal(report.runs[0].buyerTotal, null);
  const bad = await runModelBenchmark({ cases, providers: ["openai"], generate: async () => ({
    output: { hold: false, targetBuyerTotal: 10, shipping: 0, approach: "Guessed.", warnings: [] }, usage: { inputTokens: 10, outputTokens: 10 },
  }) });
  assert.equal(bad.runs[0].status, "validation-failure");
  assert.equal(bad.runs[0].accuracy, 0);
}); });

test("five-card four-provider mock preserves all forty attempts after independent failures",async()=>{await withEnv({OPENAI_API_KEY:"test",ANTHROPIC_API_KEY:"test",XAI_API_KEY:"test",GOOGLE_GENERATIVE_AI_API_KEY:"test"},async()=>{
 const cases=Array.from({length:5},(_,i)=>[{...recognitionCase,id:`r${i}`},{...pricingCase,id:`p${i}`}]).flat();
 const outputs=()=>Array.from({length:5},()=>[recognitionOutput(2025),pricingOutput(12)]).flat();
 const script:Record<string,unknown[]>={openai:outputs(),anthropic:outputs(),xai:outputs(),google:outputs()};
 script.openai[0]=new Error("mock provider unavailable");script.google[0]={invalid:true};
 const captured:Record<string,unknown>[]=[];
 const report=await runModelBenchmark({cases,providers:["openai","anthropic","xai","google"],generate:scriptedGenerate(script,captured)});
 assert.equal(captured.length,40);assert.equal(report.runs.length,40);
 assert.equal(new Set(report.runs.map(r=>`${r.caseId}:${r.provider}`)).size,40);
 assert.equal(report.runs.filter(r=>r.status==="error").length,1);
 assert.equal(report.runs.filter(r=>r.status==="schema-failure").length,1);
 assert.equal(report.runs.filter(r=>r.status==="ok").length,38);
 assert.ok(captured.every(c=>c.maxRetries===0));
});});

test("ambiguous benchmark plans fail before any generation",async()=>{
 assert.throws(()=>parseBenchmarkCases([recognitionCase,{...pricingCase,id:recognitionCase.id}]),/IDs must be unique/);
 let calls=0;const generate=async()=>{calls++;return {output:pricingOutput(12)}};
 await assert.rejects(runModelBenchmark({cases:[pricingCase],providers:["openai","openai"],generate}),/providers.*unique/);
 await assert.rejects(runModelBenchmark({cases:[pricingCase],providers:[],generate}),/providers.*non-empty/);
 await assert.rejects(runModelBenchmark({cases:[recognitionCase,{...pricingCase,id:recognitionCase.id}],providers:["openai"],generate}),/IDs must be unique/);
 assert.equal(calls,0);
});
