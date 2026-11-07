/** Estimated USD list prices per 1M tokens, used only for benchmark cost comparison.
 * Operators must verify current provider pricing. Override or extend entries with
 * AI_MODEL_COSTS='{"model-id":{"inputPer1MTokens":3,"outputPer1MTokens":15}}'.
 * Unknown models return null rather than an invented price. */
export type ModelCostRate = { inputPer1MTokens: number; outputPer1MTokens: number };

const DEFAULT_RATES: Record<string, ModelCostRate> = {
  "muse-spark-1.3": { inputPer1MTokens: 1.25, outputPer1MTokens: 4.25 },
  "claude-sonnet-4-5": { inputPer1MTokens: 3, outputPer1MTokens: 15 },
  "claude-haiku-4-5": { inputPer1MTokens: 1, outputPer1MTokens: 5 },
  "claude-opus-4-1": { inputPer1MTokens: 15, outputPer1MTokens: 75 },
  "grok-4": { inputPer1MTokens: 3, outputPer1MTokens: 15 },
  "grok-4-fast": { inputPer1MTokens: 0.2, outputPer1MTokens: 0.5 },
  "grok-3-mini": { inputPer1MTokens: 0.3, outputPer1MTokens: 0.5 },
  "gemini-2.5-pro": { inputPer1MTokens: 1.25, outputPer1MTokens: 10 },
  "gemini-2.5-flash": { inputPer1MTokens: 0.3, outputPer1MTokens: 2.5 },
  "gemini-2.5-flash-lite": { inputPer1MTokens: 0.1, outputPer1MTokens: 0.4 },
};

function validRate(value: unknown): value is ModelCostRate {
  if (typeof value !== "object" || value === null) return false;
  const rate = value as Record<string, unknown>;
  return Number.isFinite(rate.inputPer1MTokens) && (rate.inputPer1MTokens as number) >= 0
    && Number.isFinite(rate.outputPer1MTokens) && (rate.outputPer1MTokens as number) >= 0;
}

export function modelCostOverrides(env: NodeJS.ProcessEnv = process.env): Record<string, ModelCostRate> {
  const raw = env.AI_MODEL_COSTS;
  if (!raw?.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const entries = Object.entries(parsed as Record<string, unknown>).filter((entry): entry is [string, ModelCostRate] => validRate(entry[1]));
    return Object.fromEntries(entries);
  } catch { return {}; }
}

/** Exact match first (overrides beat defaults), then longest table-key prefix for dated model IDs. */
export function modelCostRate(model: string, env: NodeJS.ProcessEnv = process.env): ModelCostRate | null {
  const overrides = modelCostOverrides(env);
  if (overrides[model]) return overrides[model];
  if (DEFAULT_RATES[model]) return DEFAULT_RATES[model];
  const table = { ...DEFAULT_RATES, ...overrides };
  const prefix = Object.keys(table).filter(key => model.startsWith(key)).sort((a, b) => b.length - a.length)[0];
  return prefix ? table[prefix] : null;
}

export type ModelUsage = { inputTokens?: number | null; outputTokens?: number | null; totalTokens?: number | null };

/** Estimated cost in USD, or null when the rate or token counts are unknown. */
export function estimateModelCostUsd(model: string, usage: ModelUsage | null | undefined, env: NodeJS.ProcessEnv = process.env): number | null {
  const rate = modelCostRate(model, env);
  const input = usage?.inputTokens, output = usage?.outputTokens;
  if (!rate || typeof input !== "number" || !Number.isFinite(input) || typeof output !== "number" || !Number.isFinite(output)) return null;
  return Math.round((input / 1_000_000 * rate.inputPer1MTokens + output / 1_000_000 * rate.outputPer1MTokens) * 1e6) / 1e6;
}
