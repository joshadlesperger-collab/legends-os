import { createHash, randomUUID } from "node:crypto";
import {assessBenchmarkPriceEvidence} from './benchmark-price-evidence.ts';
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { generateText, Output } from "ai";
import { recognitionSchema, validateRecognitionImages } from "./card-recognition.ts";
import { RECOGNITION_SYSTEM_PROMPT, recognitionUserMessage } from "./card-recognition-provider.ts";
import {
  PRICING_AGENT_SYSTEM_PROMPT, PRICING_DISAGREEMENT_TOLERANCE, pricingAgentUserMessage,
  pricingProposalSchema, pricingGenerationSchema, validatePricingProposal, type GenerateFn,
} from "./card-pricing-agent.ts";
import {
  configuredProviders, createLanguageModel, defaultModelFor, providerConfigured,
  providerKeyEnv, providerOptionsFor, type AiProvider, type AiTask,
} from "./ai-providers.ts";
import { estimateModelCostUsd, type ModelUsage } from "./ai-model-pricing.ts";
import { BenchmarkBudget, singleRequestFetch, validateBenchmarkBound, type BenchmarkBound } from "./ai-benchmark-budget.ts";
import {AuthorizedFiveCardRun,safeBenchmarkFailure} from './ai-benchmark-authorized-run.ts';

/** Head-to-head benchmark for card identification and pricing. Every provider receives identical
 * inputs, evidence, schemas and repository rules. Results are local evidence only: routing
 * recommendations are advisory and never modify production routing, pricing rules or approvals. */
export const BENCHMARK_SCHEMA = "legends-model-benchmark-v1";

/** Recognition schema plus a bounded self-reported approach field. Never request chain-of-thought. */
export const recognitionBenchmarkSchema = recognitionSchema.extend({ approach: z.string().min(1).max(280) });
export const heldPricingBenchmarkSchema = z.object({
  hold: z.boolean(), targetBuyerTotal: z.number().positive().nullable(), shipping: z.number().nonnegative().nullable(),
  approach: z.string().min(1).max(280), warnings: z.array(z.string().max(300)).max(20),
});

export const RECOGNITION_BENCHMARK_SYSTEM_PROMPT = `${RECOGNITION_SYSTEM_PROMPT} For benchmark evaluation only, also fill the "approach" field with at most 40 words naming the observable photo evidence used. Never output private reasoning, internal deliberation or chain-of-thought.`;

const recognitionCaseSchema = z.object({
  kind: z.literal("recognition"), id: z.string().min(1).max(120),
  images: z.array(z.string()).length(2),
  expected: z.object({
    pairMatches: z.boolean().optional(), frontImageIndex: z.enum(["0", "1", "unknown"]).optional(),
    identity: z.record(z.string(), z.unknown()).optional(),
  }).optional(),
});
const pricingCaseSchema = z.object({
  kind: z.literal("pricing"), id: z.string().min(1).max(120),
  evidence: z.unknown(),
  baseline: z.object({ buyerTotal: z.number().positive().max(1_000_000), shipping: z.number().min(0).max(1_000_000) }).optional(),
  expectedHold: z.boolean().optional(),
});
export const benchmarkCaseSchema = z.discriminatedUnion("kind", [recognitionCaseSchema, pricingCaseSchema]);
export type BenchmarkCase = z.infer<typeof benchmarkCaseSchema>;

/** Parse a case file: either a bare array or { schema, cases: [...] }. Throws with issue detail. */
export function parseBenchmarkCases(data: unknown): { cases: BenchmarkCase[] } {
  const raw = Array.isArray(data) ? data : (data as { cases?: unknown } | null)?.cases;
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("Benchmark case file must contain a non-empty cases array.");
  const ids=new Set<string>();
  return {
    cases: raw.map((entry, index) => {
      const parsed = benchmarkCaseSchema.safeParse(entry);
      if (!parsed.success) throw new Error(`Invalid benchmark case ${index}: ${parsed.error.issues.map(issue => `${issue.path.join(".")} ${issue.message}`).join("; ")}`);
      if (parsed.data.kind === "pricing" && !parsed.data.baseline && !parsed.data.expectedHold) throw Error("Pricing case requires a validated baseline or expectedHold.");
      if(ids.has(parsed.data.id))throw Error("Benchmark case IDs must be unique across all tasks.");
      ids.add(parsed.data.id);
      return parsed.data;
    }),
  };
}

export function normalizeUsage(usage: unknown): ModelUsage | null {
  if (typeof usage !== "object" || usage === null) return null;
  const u = usage as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const inputTokens = num(u.inputTokens) ?? num(u.promptTokens);
  const outputTokens = num(u.outputTokens) ?? num(u.completionTokens);
  const totalTokens = num(u.totalTokens) ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null);
  if (inputTokens === null && outputTokens === null && totalTokens === null) return null;
  return { inputTokens, outputTokens, totalTokens };
}

function normalizedField(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") { const trimmed = value.trim().toLowerCase(); return trimmed === "" ? null : trimmed; }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

export function compareIdentityFields(expected: Record<string, unknown>, actual: Record<string, unknown>) {
  let matched = 0; const mismatchedFields: string[] = [];
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (expectedValue === undefined) continue;
    if (normalizedField(expectedValue) === normalizedField(actual[key])) matched++;
    else mismatchedFields.push(key);
  }
  const compared = matched + mismatchedFields.length;
  return { matched, compared, accuracy: compared ? matched / compared : null, mismatchedFields };
}

export type BenchmarkRun = {
  pricingEvidence?:ReturnType<typeof assessBenchmarkPriceEvidence>;
  caseId: string; task: AiTask; provider: AiProvider; model: string;
  status: "ok" | "schema-failure" | "validation-failure" | "error" | "skipped";
  latencyMs: number | null; usage: ModelUsage | null; costUsd: number | null; costEstimated: boolean;
  accuracy: number | null; mismatchedFields: string[]; relativeBuyerTotalDiff: number | null;
  disagreement: boolean | null; buyerTotal: number | null;
  fields: Record<string, string | null> | null; approach: string | null; warnings: string[]; failures: string[];
};

export type BenchmarkOptions = {
  cases: BenchmarkCase[];
  providers?: AiProvider[];
  models?: Partial<Record<AiProvider, string>>;
  generate?: GenerateFn;
  timeoutMs?: number;
  budget?: BenchmarkBudget;
  bounds?: BenchmarkBound[];
  authorizedFiveCardRun?: AuthorizedFiveCardRun;
};

const elapsed = (started: number) => Math.round((performance.now() - started) * 10) / 10;

async function runOne(benchmarkCase: BenchmarkCase, provider: AiProvider, options: BenchmarkOptions, skipReason?:string): Promise<BenchmarkRun> {
  const task = benchmarkCase.kind;
  const model = options.models?.[provider]?.trim() || defaultModelFor(provider, task);
  const run: BenchmarkRun = {
    ...(task==='pricing'?{pricingEvidence:assessBenchmarkPriceEvidence(benchmarkCase.kind==='pricing'?benchmarkCase.evidence:null)}:{}),
    caseId: benchmarkCase.id, task, provider, model, status: "ok",
    latencyMs: null, usage: null, costUsd: null, costEstimated: false,
    accuracy: null, mismatchedFields: [], relativeBuyerTotalDiff: null, disagreement: null,
    buyerTotal: null, fields: null, approach: null, warnings: [], failures: [],
  };
  if(skipReason)return {...run,status:"skipped",failures:[skipReason]};
  if (!providerConfigured(provider)) return { ...run, status: "skipped", failures: [`${providerKeyEnv(provider)} is not set`] };
  const implementation = options.generate ?? (generateText as unknown as GenerateFn);
  const generate: GenerateFn = async args => {
    if(options.authorizedFiveCardRun){
      const journal=options.authorizedFiveCardRun;
      const key=journal.begin(benchmarkCase.id,provider,model);
      try {const result=await implementation(args);journal.append({event:'result',key,output:result.output,usage:normalizeUsage(result.usage)});return result;}
      catch(error) {const diagnostic=safeBenchmarkFailure(error);journal.append({event:'failure',key,diagnostic});throw Error(`Provider call failed (${diagnostic.category}, HTTP ${diagnostic.httpStatus??'unknown'}); evidence retained; no automatic retry`);}
    }
    if (!options.budget) return implementation(args); // mocked calls only; live checked at entry
    const bound = options.bounds?.find(b => b.provider === provider && b.model === model);
    if (!bound) throw Error("Missing verified cost bound; no call sent.");
    const reservation = options.budget.reserve(bound, provider, model, Number(args.maxOutputTokens));
    try {
      const result = await implementation(args);
      run.costUsd = options.budget.settle(reservation, normalizeUsage(result.usage));
      run.costEstimated = true;
      return result;
    } catch {
      options.budget.stop();
      throw Error("Provider call or accounting failed; reservation retained, no retry, batch stopped.");
    }
  };
  const started = performance.now();
  try {
    const requestBound = options.bounds?.find(b => b.provider === provider && b.model === model);
    const languageModel = createLanguageModel(provider, model, task, options.budget ? singleRequestFetch(fetch, requestBound?.maxRequestBytes ?? 0) : options.authorizedFiveCardRun ? singleRequestFetch(fetch,20_000_000) : undefined);
    const providerOptions = providerOptionsFor(provider);
    const shared = {
      model: languageModel, maxRetries: 0,
      abortSignal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
      ...(providerOptions ? { providerOptions } : {}),
    };
    if (benchmarkCase.kind === "recognition") {
      const previews = validateRecognitionImages(benchmarkCase.images);
      const result = await generate({
        ...shared, output: Output.object({ schema: recognitionBenchmarkSchema }),
        system: RECOGNITION_BENCHMARK_SYSTEM_PROMPT, messages: [recognitionUserMessage(previews)], maxOutputTokens: 2500,
      });
      run.latencyMs = elapsed(started);
      run.usage = normalizeUsage(result.usage);
      const parsed = recognitionBenchmarkSchema.safeParse(result.output);
      if (!parsed.success) { run.status = "schema-failure"; run.failures.push("Output failed recognition schema validation"); }
      else {
        run.approach = parsed.data.approach;
        run.warnings = parsed.data.warnings;
        run.fields = Object.fromEntries(Object.entries({ pairMatches: parsed.data.pairMatches, frontImageIndex: parsed.data.frontImageIndex, ...parsed.data.identity }).map(([k, v]) => [k, normalizedField(v)]));
        if (benchmarkCase.expected) {
          const comparison = compareIdentityFields(
            Object.fromEntries(Object.entries({ pairMatches: benchmarkCase.expected.pairMatches, frontImageIndex: benchmarkCase.expected.frontImageIndex, ...benchmarkCase.expected.identity }).filter(([, v]) => v !== undefined)),
            { pairMatches: parsed.data.pairMatches, frontImageIndex: parsed.data.frontImageIndex, ...parsed.data.identity } as Record<string, unknown>);
          run.accuracy = comparison.accuracy;
          run.mismatchedFields = comparison.mismatchedFields;
        }
      }
    } else {
      const result = await generate({
        ...shared, output: benchmarkCase.expectedHold ? Output.object({ schema: heldPricingBenchmarkSchema }) : Output.object({ schema: pricingGenerationSchema }),
        system: PRICING_AGENT_SYSTEM_PROMPT + (benchmarkCase.expectedHold ? " For this evidence-sufficiency evaluation, also return hold. When the evidence cannot support a price, return hold:true with null targetBuyerTotal and null shipping; do not invent amounts." : ""), messages: [{ role: "user", content: pricingAgentUserMessage(benchmarkCase.evidence) }], maxOutputTokens: 1200,
      });
      run.latencyMs = elapsed(started);
      run.usage = normalizeUsage(result.usage);
      if (benchmarkCase.expectedHold) {
        const held = heldPricingBenchmarkSchema.safeParse(result.output);
        if (!held.success) { run.status = "schema-failure"; run.failures.push("Output failed hold schema validation"); }
        else {
          run.approach = held.data.approach; run.warnings = held.data.warnings;
          const correct = held.data.hold && held.data.targetBuyerTotal === null && held.data.shipping === null && held.data.warnings.length > 0;
          run.accuracy = correct ? 1 : 0; run.disagreement = !correct;
          if (!correct) { run.status = "validation-failure"; run.failures.push("Unsupported price: evidence requires a hold."); }
        }
      } else {
      const parsed = pricingProposalSchema.safeParse(result.output);
      if (!parsed.success) { run.status = "schema-failure"; run.failures.push("Output failed pricing proposal schema validation"); }
      else {
        run.approach = parsed.data.approach;
        run.warnings = parsed.data.warnings;
        const validation = validatePricingProposal(parsed.data, benchmarkCase.baseline);
        run.relativeBuyerTotalDiff = validation.relativeBuyerTotalDiff;
        run.disagreement = validation.disagreement;
        run.buyerTotal = validation.candidate?.buyerTotal ?? null;
        if (!validation.valid) { run.status = "validation-failure"; run.failures.push(...validation.failures); }
        else if (validation.disagreement !== null) run.accuracy = validation.disagreement ? 0 : 1;
      }
      }
    }
    const cost = estimateModelCostUsd(model, run.usage);
    if (!options.budget) { run.costUsd = cost; run.costEstimated = cost !== null; }
  } catch (error) {
    run.latencyMs = elapsed(started);
    run.status = "error";
    run.failures.push(String(error instanceof Error ? error.message : error).slice(0, 300));
  }
  return run;
}

export type TaskProviderSummary = {
  task: AiTask; provider: AiProvider; runs: number; ok: number; schemaFailures: number;
  validationFailures: number; errors: number; skipped: number;
  meanLatencyMs: number | null; inputTokens: number; outputTokens: number;
  costUsd: number; costComplete: boolean; meanAccuracy: number | null; disagreements: number;
};

export function summarizeRuns(runs: BenchmarkRun[]): TaskProviderSummary[] {
  const groups = new Map<string, BenchmarkRun[]>();
  for (const run of runs) {
    const key = `${run.task}:${run.provider}`;
    groups.set(key, [...(groups.get(key) ?? []), run]);
  }
  return Array.from(groups.entries()).map(([key, group]) => {
    const okRuns = group.filter(run => run.status === "ok");
    const latencies = group.map(run => run.latencyMs).filter((v): v is number => v !== null);
    const accuracies = group.map(run => run.accuracy ?? (["schema-failure", "validation-failure", "error"].includes(run.status) ? 0 : null)).filter((v): v is number => v !== null);
    const [task, provider] = key.split(":") as [AiTask, AiProvider];
    return {
      task, provider, runs: group.length, ok: okRuns.length,
      schemaFailures: group.filter(run => run.status === "schema-failure").length,
      validationFailures: group.filter(run => run.status === "validation-failure").length,
      errors: group.filter(run => run.status === "error").length,
      skipped: group.filter(run => run.status === "skipped").length,
      meanLatencyMs: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length * 10) / 10 : null,
      inputTokens: group.reduce((n, run) => n + (run.usage?.inputTokens ?? 0), 0),
      outputTokens: group.reduce((n, run) => n + (run.usage?.outputTokens ?? 0), 0),
      costUsd: Math.round(group.reduce((n, run) => n + (run.costUsd ?? 0), 0) * 1e6) / 1e6,
      costComplete: group.length > 0 && group.every(run => run.costEstimated),
      meanAccuracy: accuracies.length ? Math.round(accuracies.reduce((a, b) => a + b, 0) / accuracies.length * 1000) / 1000 : null,
      disagreements: okRuns.filter(run => run.disagreement === true || run.mismatchedFields.length > 0).length,
    };
  });
}

export type CaseDisagreement = { caseId: string; task: AiTask; fields: string[]; buyerTotalSpread: number | null };

/** Cross-model disagreement per case: identity fields where ok runs differ, or buyer-total spread beyond tolerance. */
export function caseDisagreements(cases: BenchmarkCase[], runs: BenchmarkRun[]): CaseDisagreement[] {
  return cases.map(benchmarkCase => {
    const okRuns = runs.filter(run => run.caseId === benchmarkCase.id && run.status === "ok");
    if (benchmarkCase.kind === "recognition") {
      const fields = new Set<string>();
      for (const run of okRuns) for (const key of Object.keys(run.fields ?? {})) {
        const values = new Set(okRuns.map(other => other.fields?.[key] ?? null));
        if (values.size > 1) fields.add(key);
      }
      return { caseId: benchmarkCase.id, task: benchmarkCase.kind, fields: Array.from(fields).sort(), buyerTotalSpread: null };
    }
    const totals = okRuns.map(run => run.buyerTotal).filter((v): v is number => v !== null);
    const spread = totals.length > 1 ? (Math.max(...totals) - Math.min(...totals)) / Math.min(...totals) : null;
    return { caseId: benchmarkCase.id, task: benchmarkCase.kind, fields: spread !== null && spread > PRICING_DISAGREEMENT_TOLERANCE ? ["targetBuyerTotal"] : [], buyerTotalSpread: spread };
  });
}

export type RoutingRecommendation = {
  task: AiTask; recommendedProvider: AiProvider | null; currentDefault: "openai";
  sampleSize: number; rationale: string[]; applied: false;
};

/** Advisory only: ranks providers by accuracy, then estimated cost, then latency. Never applied automatically. */
export function recommendRouting(summary: TaskProviderSummary[]): RoutingRecommendation[] {
  const format = (value: number | null, suffix = "") => (value === null ? "n/a" : `${value}${suffix}`);
  return (["recognition", "pricing"] as AiTask[]).map(task => {
    const rows = summary.filter(row => row.task === task && row.ok === row.runs && row.ok > 0 && row.costComplete && row.meanAccuracy !== null);
    if (rows.length === 0) return { task, recommendedProvider: null, currentDefault: "openai" as const, sampleSize: 0, rationale: ["No successful runs; keep the current default."], applied: false as const };
    const ranked = [...rows].sort((a, b) =>
      (b.meanAccuracy ?? -1) - (a.meanAccuracy ?? -1) ||
      (a.costUsd ?? Infinity) - (b.costUsd ?? Infinity) ||
      (a.meanLatencyMs ?? Infinity) - (b.meanLatencyMs ?? Infinity));
    const rationale = ranked.map(row =>
      `${row.provider}: mean accuracy ${format(row.meanAccuracy)}, mean latency ${format(row.meanLatencyMs, "ms")}, est. cost $${format(row.costUsd)}${row.costComplete ? "" : " (incomplete rate data)"}, validation failures ${row.schemaFailures + row.validationFailures}, disagreements ${row.disagreements} across ${row.ok} ok run(s)`);
    return { task, recommendedProvider: ranked[0].provider, currentDefault: "openai" as const, sampleSize: ranked[0].ok, rationale, applied: false as const };
  });
}

export type BenchmarkReport = {
  budget?: ReturnType<BenchmarkBudget["snapshot"]>;
  schema: typeof BENCHMARK_SCHEMA; createdAt: string; advisoryOnly: true;
  providers: { requested: AiProvider[] };
  cases: Array<{ id: string; kind: AiTask; images?: { sha256: string; bytes: number }[]; evidence?: unknown; baseline?: unknown }>;
  runs: BenchmarkRun[];
  summary: TaskProviderSummary[];
  caseDisagreements: CaseDisagreement[];
  recommendations: RoutingRecommendation[];
  note: string;
};

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export async function runModelBenchmark(options: BenchmarkOptions): Promise<BenchmarkReport> {
  const providers = options.providers ?? (configuredProviders().length ? configuredProviders() : ["openai"]);
  if(!providers.length||new Set(providers).size!==providers.length)throw Error("Benchmark providers must be non-empty and unique.");
  if(new Set(options.cases.map(c=>c.id)).size!==options.cases.length)throw Error("Benchmark case IDs must be unique across all tasks.");
  if (!options.generate) {
    if (!options.budget && !options.authorizedFiveCardRun) throw Error("Live benchmark requires a durable $5 spending guard or the explicit five-card authorization journal.");
    if (providers.some(provider => !providerConfigured(provider))) throw Error("All requested provider credentials must be configured before any live call.");
  }
  // Budgeted mocks exercise the same whole-batch gate as live execution.
  if (options.budget) {
    const plannedCalls = [];
    for (const provider of providers) for (const benchmarkCase of options.cases) {
      const model = options.models?.[provider]?.trim() || defaultModelFor(provider, benchmarkCase.kind);
      const outputLimit = benchmarkCase.kind === "recognition" ? 2500 : 1200;
      const bound = validateBenchmarkBound(options.bounds?.find(b => b.provider === provider && b.model === model), provider, model, outputLimit);
      plannedCalls.push({ bound, provider, model, outputLimit });
    }
    options.budget.assertPlanAffordable(plannedCalls);
  }
  const runs: BenchmarkRun[] = [];
  // Sequential case-major order: bounded calls, deterministic ordering, no parallelism surprises.
  let budgetStopReason:string|undefined;
  for (const benchmarkCase of options.cases) for (const provider of providers) {
    const run = await runOne(benchmarkCase, provider, options,budgetStopReason);
    runs.push(run);
    if (options.budget && (run.status === "error" || options.budget.snapshot().stopped))
      budgetStopReason="Not attempted: budget guard stopped paid execution; reconcile the failed call and spending before another live run.";
  }
  const summary = summarizeRuns(runs);
  return {
    schema: BENCHMARK_SCHEMA, createdAt: new Date().toISOString(), advisoryOnly: true,
    providers: { requested: providers },
    cases: options.cases.map(benchmarkCase => benchmarkCase.kind === "recognition"
      ? { id: benchmarkCase.id, kind: benchmarkCase.kind, images: benchmarkCase.images.map(image => ({ sha256: sha256(image), bytes: image.length })) }
      : { id: benchmarkCase.id, kind: benchmarkCase.kind, evidence: benchmarkCase.evidence, baseline: benchmarkCase.baseline }),
    runs, summary, ...(options.budget ? { budget: options.budget.snapshot() } : {}),
    caseDisagreements: caseDisagreements(options.cases, runs),
    recommendations: recommendRouting(summary),
    note: "Pricing accuracy/disagreement measure arithmetic against supplied baselines, NOT independent market valuation. Consult each run.pricingEvidence before any price handoff; model agreement cannot clear evidence holds. Local benchmark only; production routing, pricing rules, approvals and eBay listings are unchanged.",
  };
}

/** Persist a report under artifacts/model-benchmark (or an explicit directory). Returns the file path. */
export function saveBenchmarkReport(report: BenchmarkReport, dir = "artifacts/model-benchmark"): string {
  mkdirSync(dir, { recursive: true });
  // Timestamp collisions and retries must never overwrite an earlier evidence report.
  const file = join(dir, `model-benchmark-${report.createdAt.replace(/[:.]/g, "-")}-${randomUUID()}.json`);
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  writeFileSync(join(dir, "latest.json"), `${JSON.stringify(report, null, 2)}\n`);
  return file;
}
