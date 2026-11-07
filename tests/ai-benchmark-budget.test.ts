import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BenchmarkBudget, singleRequestFetch, type BenchmarkBound } from "../lib/ai-benchmark-budget.ts";
import { runModelBenchmark } from "../lib/ai-benchmark.ts";

const bound: BenchmarkBound = { provider: "openai", model: "mock", inputTokens: 1000, outputTokens: 2500, maxRequestBytes: 1000000,
  inputUsdPerMillion: 100, outputUsdPerMillion: 100, source: "https://example.com/test-only",
  justification: "Synthetic test bounds only; never authorize a live provider with these values.",
  expiresAt: "2099-01-01T00:00:00.000Z", allBillableTokensBounded: true };
const file = () => join(mkdtempSync(join(tmpdir(), "benchmark-budget-")), "ledger.jsonl");
test("whole-plan preflight includes prior spending and never reserves or permits a partial over-budget batch", () => {
  const budget = new BenchmarkBudget(file(), .1);
  const call = { bound, provider: "openai", model: "mock", outputLimit: 1200 };
  assert.deepEqual(budget.assertPlanAffordable([call, call]), { calls: 2, maximumUsd: .7 });
  assert.throws(() => budget.assertPlanAffordable([call, call, call]), /Entire benchmark plan/);
  assert.equal(budget.snapshot().reservedUsd, .1);
  const id = budget.reserve(bound, "openai", "mock", 1200);
  assert.throws(() => budget.assertPlanAffordable([call]), /unresolved/);
  budget.settle(id, {inputTokens: 1, outputTokens: 1});
  assert.throws(() => budget.assertPlanAffordable([call, call]), /Entire benchmark plan/);
  budget.close();
});
test("transport blocks SDK continuations, redirects and hidden retries", async () => {
  let calls = 0;
  const transport = singleRequestFetch(async (_input, init) => { calls++; assert.equal(init?.redirect, "error"); return new Response("{}"); });
  await transport("https://example.com", { body: "{}" });
  assert.throws(() => transport("https://example.com", { body: "{}" }), /Additional provider HTTP request blocked/);
  assert.equal(calls, 1);
  const capped = singleRequestFetch(async () => { calls++; return new Response("{}"); }, 2);
  assert.throws(() => capped("https://example.com", { body: "large" }), /outside/);
  assert.equal(calls, 1);
});
test("reservations are cumulative across providers and restarts, never refunded", () => {
  const path = file(); let budget = new BenchmarkBudget(path, .3);
  const a = budget.reserve(bound, "openai", "mock", 1200);
  budget.settle(a, { inputTokens: 1, outputTokens: 1 }); budget.close();
  budget = new BenchmarkBudget(path);
  const other = { ...bound, provider: "google" as const };
  const b = budget.reserve(other, "google", "mock", 1200);
  budget.settle(b, { inputTokens: 1, outputTokens: 1 });
  assert.equal(budget.snapshot().remainingUsd, 0);
  assert.throws(() => budget.reserve(bound, "openai", "mock", 1200), /budget/);
  budget.close();
});
test("invalid bounds and unknown prior spend fail closed", () => {
  assert.throws(() => new BenchmarkBudget(file()), /prior spending/);
  const budget = new BenchmarkBudget(file(), 0);
  for (const invalid of [{ ...bound, inputUsdPerMillion: NaN }, { ...bound, outputTokens: 100 },
    { ...bound, expiresAt: "2000-01-01T00:00:00.000Z" }, { ...bound, model: "different" }])
    assert.throws(() => budget.reserve(invalid, "openai", "mock", 1200));
  assert.equal(budget.snapshot().reservedUsd, 0); budget.close();
});
test("exclusive locking, unresolved calls and corrupted journals block resume", () => {
  const path = file(); let budget = new BenchmarkBudget(path, 0);
  assert.throws(() => new BenchmarkBudget(path));
  budget.reserve(bound, "openai", "mock", 1200); budget.close();
  budget = new BenchmarkBudget(path);
  assert.throws(() => budget.reserve(bound, "openai", "mock", 1200), /unresolved/); budget.close();
  appendFileSync(path, '{"partial":');
  assert.throws(() => new BenchmarkBudget(path));
});
test("missing, negative, excessive and inconsistent usage stop the entire budget", () => {
  for (const usage of [null, { inputTokens: -1, outputTokens: 1 }, { inputTokens: 1001, outputTokens: 1 },
    { inputTokens: 1, outputTokens: 1, totalTokens: 10 }]) {
    const budget = new BenchmarkBudget(file(), 0); const id = budget.reserve(bound, "openai", "mock", 1200);
    assert.throws(() => budget.settle(id, usage), /usage/);
    assert.equal(budget.snapshot().reservedUsd, .35); assert.equal(budget.snapshot().stopped, true); budget.close();
  }
});
test("live library entry cannot bypass the guard", async () => {
  await assert.rejects(runModelBenchmark({ cases: [] }), /spending guard/);
});

test("runner rejects an unaffordable complete batch before invoking even a mocked provider", async () => {
  const budget = new BenchmarkBudget(file(), 0); let calls = 0;
  try {
    await assert.rejects(runModelBenchmark({ providers: ["openai"], models: {openai:"mock"}, budget, bounds:[bound],
      cases:[1,2,3].map(id=>({kind:"pricing",id:String(id),evidence:{},baseline:{buyerTotal:10,shipping:0}})),
      generate:async()=>{calls++;throw Error("Must not execute");} }), /Entire benchmark plan/);
    assert.equal(calls,0);assert.equal(budget.snapshot().reservedUsd,0);
    assert.equal(budget.snapshot().stopped,false);
  } finally {budget.close();}
});

test("overnight phase caps survive restarts and protect the three-dollar reserve", () => {
  const path = file();
  const dollarBound = { ...bound, inputTokens: 7500 }; // $1 reservation
  for (const phase of ["initial", "retest"] as const) {
    const budget = new BenchmarkBudget(path, 0, phase);
    const id = budget.reserve(dollarBound, "openai", "mock", 1200);
    budget.settle(id, { inputTokens: 1, outputTokens: 1 });
    assert.throws(() => budget.reserve(bound, "openai", "mock", 1200), /budget/);
    budget.close();
  }
  for (const phase of ["initial", "retest"] as const) {
    const budget = new BenchmarkBudget(path, 0, phase);
    assert.equal(budget.snapshot().reservedUsd, 2);
    assert.equal(budget.snapshot().remainingUsd, 0);
    assert.equal(budget.snapshot().protectedReserveUsd, 3);
    assert.throws(() => budget.reserve(bound, "openai", "mock", 1200), /budget/);
    budget.close();
  }
});

test("historical spend cannot be bypassed by selecting retest", () => {
  const path = file();
  for (const phase of ["initial", "retest"] as const) {
    const budget = new BenchmarkBudget(path, 1, phase);
    assert.throws(() => budget.reserve(bound, "openai", "mock", 1200), /budget/);
    budget.close();
  }
});
test("mocked provider failure sends one call, disables retries, retains reservation and stops", async () => {
  const prior = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = "test";
  const budget = new BenchmarkBudget(file(), 0); let calls = 0;
  try {
    const report = await runModelBenchmark({ providers: ["openai"], models: { openai: "mock" }, budget, bounds: [bound],
      cases: [1, 2].map(id => ({ kind: "pricing", id: String(id), evidence: {}, baseline: { buyerTotal: 10, shipping: 0 } })),
      generate: async args => { calls++; assert.equal(args.maxRetries, 0); throw Error("sensitive provider response"); } });
    assert.equal(calls, 1); assert.equal(report.runs.length, 2); assert.equal(report.budget?.stopped, true);
    assert.equal(report.runs[0].status,"error");
    assert.equal(report.runs[1].caseId,"2");assert.equal(report.runs[1].status,"skipped");
    assert.match(report.runs[1].failures.join(" "),/budget guard stopped/);
    assert.equal(report.runs[1].usage,null);assert.equal(report.runs[1].latencyMs,null);
    assert.equal(report.budget?.reservedUsd, .35); assert.ok(!JSON.stringify(report).includes("sensitive provider response"));
  } finally { budget.close(); if (prior === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prior; }
});


test("Meta shares existing reservations and cannot reset provider budget", () => {
  const path = file();
  let budget = new BenchmarkBudget(path, .3);
  const first = budget.reserve(bound, "openai", "mock", 1200);
  budget.settle(first, {inputTokens:1,outputTokens:1}); budget.close();
  budget = new BenchmarkBudget(path);
  const meta = {...bound,provider:"meta" as const,model:"muse-spark-1.3"};
  const id = budget.reserve(meta, "meta", meta.model, 1200);
  budget.settle(id, {inputTokens:1,outputTokens:1});
  assert.equal(budget.snapshot().reservedUsd, 1);
  assert.equal(budget.snapshot().billingGuarantee, false);
  assert.throws(() => budget.reserve(meta,"meta",meta.model,1200), /budget/);
  budget.close();
});
