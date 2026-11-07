import type { generateText, LanguageModel } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createXai } from "@ai-sdk/xai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";

/** The AI SDK does not re-export its ProviderOptions type; derive it from generateText. */
export type AiProviderOptions = Parameters<typeof generateText>[0]["providerOptions"];

/** Configurable multi-provider router. OpenAI remains the default provider; Claude (Anthropic),
 * Grok (xAI) and Gemini (Google) are opt-in per task. Keys are read only from OPENAI_API_KEY,
 * ANTHROPIC_API_KEY, XAI_API_KEY and GOOGLE_GENERATIVE_AI_API_KEY by the provider SDKs; values
 * are never logged or returned here. Meta uses MODEL_API_KEY via the Responses adapter. */
export const AI_PROVIDERS = ["openai", "anthropic", "xai", "google", "meta"] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];
export type AiTask = "recognition" | "pricing";

const PROVIDER_KEY_ENV: Record<AiProvider, string> = { openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY", xai: "XAI_API_KEY", google: "GOOGLE_GENERATIVE_AI_API_KEY", meta: "MODEL_API_KEY" };
const PROVIDER_MODEL_ENV: Record<AiProvider, string> = { openai: "OPENAI_MODEL", anthropic: "ANTHROPIC_MODEL", xai: "XAI_MODEL", google: "GOOGLE_MODEL", meta: "META_MODEL" };
const TASK_PROVIDER_ENV: Record<AiTask, string> = { recognition: "CARD_RECOGNITION_PROVIDER", pricing: "CARD_PRICING_PROVIDER" };
/** Fallback models used only when neither an explicit model nor an environment override is set. */
const DEFAULT_MODEL: Record<AiProvider, string> = { openai: "gpt-6.1-sol", anthropic: "claude-sonnet-4-5", xai: "grok-4", google: "gemini-2.5-flash", meta: "muse-spark-1.3" };

export function isAiProvider(value: unknown): value is AiProvider {
  return typeof value === "string" && (AI_PROVIDERS as readonly string[]).includes(value);
}

/** Resolution order: explicit argument, task-specific env, global AI_PROVIDER, then "openai". */
export function resolveAiProvider(task: AiTask, explicit?: string | null): AiProvider {
  const candidate = explicit ?? process.env[TASK_PROVIDER_ENV[task]] ?? process.env.AI_PROVIDER;
  if (candidate === undefined || candidate === null || candidate.trim() === "") return "openai";
  const normalized = candidate.trim().toLowerCase();
  if (!isAiProvider(normalized)) throw new Error(`Unknown AI provider "${candidate}". Supported: ${AI_PROVIDERS.join(", ")}.`);
  return normalized;
}

export function providerKeyEnv(provider: AiProvider): string {
  return PROVIDER_KEY_ENV[provider];
}

export function providerConfigured(provider: AiProvider, env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env[PROVIDER_KEY_ENV[provider]]?.trim());
}

export function configuredProviders(env: NodeJS.ProcessEnv = process.env): AiProvider[] {
  return AI_PROVIDERS.filter(provider => providerConfigured(provider, env));
}

/** Model resolution keeps CARD_RECOGNITION_MODEL working for the existing OpenAI recognition route. */
export function defaultModelFor(provider: AiProvider, task: AiTask, env: NodeJS.ProcessEnv = process.env): string {
  const legacy = provider === "openai" && task === "recognition" ? env.CARD_RECOGNITION_MODEL?.trim() : undefined;
  return legacy || env[PROVIDER_MODEL_ENV[provider]]?.trim() || DEFAULT_MODEL[provider];
}

/** Build the language model for a provider. Throws a configuration error naming only the env var. */
export function createLanguageModel(provider: AiProvider, modelId?: string, task: AiTask = "recognition", fetchOverride?: typeof fetch): LanguageModel {
  if (!providerConfigured(provider)) throw new Error(`AI provider "${provider}" is not configured (${PROVIDER_KEY_ENV[provider]}).`);
  const model = modelId?.trim() || defaultModelFor(provider, task);
  switch (provider) {
    case "meta": return createOpenAI({ name: "meta", baseURL: "https://api.meta.ai/v1", apiKey: process.env.MODEL_API_KEY, fetch: fetchOverride }).responses(model);
    case "openai": return createOpenAI({ fetch: fetchOverride }).responses(model);
    // The anthropic/xai/google packages ship a slightly newer provider-spec type than the top-level
    // ai package declares (an extra "interrupted" finish reason). Runtime-compatible; cast at the boundary.
    case "anthropic": return createAnthropic({ fetch: fetchOverride })(model) as unknown as LanguageModel;
    case "xai": return createXai({ fetch: fetchOverride })(model) as unknown as LanguageModel;
    case "google": return createGoogleGenerativeAI({ fetch: fetchOverride })(model) as unknown as LanguageModel;
  }
}

/** Provider-specific call options. OpenAI keeps the existing no-storage, low-reasoning contract.
 * Claude, Grok and Gemini receive no reasoning controls, so no private reasoning is requested or stored. */
export function providerOptionsFor(provider: AiProvider): AiProviderOptions {
  // The installed OpenAI Responses adapter reads options from its openai namespace.
  if (provider === "meta") return { openai: { store: false, reasoningEffort: "low", reasoningSummary: null } };
  return provider === "openai" ? { openai: { store: false, reasoningEffort: "low", reasoningSummary: null } } : undefined;
}

/** Configuration booleans only; never exposes credential values. */
export function providerStatus(env: NodeJS.ProcessEnv = process.env): Record<AiProvider, { configured: boolean; keyEnv: string; defaultModels: Record<AiTask, string> }> {
  return Object.fromEntries(AI_PROVIDERS.map(provider => [provider, {
    configured: providerConfigured(provider, env),
    keyEnv: PROVIDER_KEY_ENV[provider],
    defaultModels: { recognition: defaultModelFor(provider, "recognition", env), pricing: defaultModelFor(provider, "pricing", env) },
  }])) as Record<AiProvider, { configured: boolean; keyEnv: string; defaultModels: Record<AiTask, string> }>;
}
