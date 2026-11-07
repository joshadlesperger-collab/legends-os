import test from "node:test";
import assert from "node:assert/strict";
import {
  AI_PROVIDERS, configuredProviders, createLanguageModel, defaultModelFor, isAiProvider,
  providerConfigured, providerKeyEnv, providerOptionsFor, providerStatus, resolveAiProvider,
} from "../lib/ai-providers.ts";

const ENV_KEYS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "XAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "AI_PROVIDER",
  "CARD_RECOGNITION_PROVIDER", "CARD_PRICING_PROVIDER", "CARD_RECOGNITION_MODEL",
  "OPENAI_MODEL", "ANTHROPIC_MODEL", "XAI_MODEL", "GOOGLE_MODEL", "MODEL_API_KEY", "META_MODEL"];

function withEnv(patch: Record<string, string | undefined>, fn: () => void) {
  const saved = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
  try { fn(); } finally {
    for (const key of ENV_KEYS) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  }
}

test("openai is the default provider for every task", () => withEnv({}, () => {
  assert.equal(resolveAiProvider("recognition"), "openai");
  assert.equal(resolveAiProvider("pricing"), "openai");
}));

test("routing precedence: explicit > task env > AI_PROVIDER > default", () => withEnv({
  AI_PROVIDER: "anthropic", CARD_RECOGNITION_PROVIDER: "xai",
}, () => {
  assert.equal(resolveAiProvider("pricing"), "anthropic");
  assert.equal(resolveAiProvider("recognition"), "xai");
  assert.equal(resolveAiProvider("recognition", " Anthropic "), "anthropic");
  assert.equal(resolveAiProvider("pricing", "openai"), "openai");
  assert.throws(() => resolveAiProvider("pricing", "other"), /Unknown AI provider/);
}));

test("model defaults with CARD_RECOGNITION_MODEL back-compatibility", () => withEnv({}, () => {
  assert.equal(defaultModelFor("openai", "recognition"), "gpt-6.1-sol");
  assert.equal(defaultModelFor("openai", "pricing"), "gpt-6.1-sol");
  assert.equal(defaultModelFor("anthropic", "recognition"), "claude-sonnet-4-5");
  assert.equal(defaultModelFor("xai", "pricing"), "grok-4");
  assert.equal(defaultModelFor("google", "recognition"), "gemini-2.5-flash");
  withEnv({ CARD_RECOGNITION_MODEL: "legacy-model", OPENAI_MODEL: "pricing-model", ANTHROPIC_MODEL: "claude-x", XAI_MODEL: "grok-x", GOOGLE_MODEL: "gemini-x" }, () => {
    assert.equal(defaultModelFor("openai", "recognition"), "legacy-model");
    assert.equal(defaultModelFor("openai", "pricing"), "pricing-model");
    assert.equal(defaultModelFor("anthropic", "pricing"), "claude-x");
    assert.equal(defaultModelFor("xai", "recognition"), "grok-x");
    assert.equal(defaultModelFor("google", "pricing"), "gemini-x");
  });
}));

test("openai keeps no-storage low-reasoning options; other providers get none", () => {
  assert.deepEqual(providerOptionsFor("openai"), { openai: { store: false, reasoningEffort: "low", reasoningSummary: null } });
  assert.equal(providerOptionsFor("anthropic"), undefined);
  assert.equal(providerOptionsFor("xai"), undefined);
  assert.equal(providerOptionsFor("google"), undefined);
});

test("status exposes configuration booleans only, never credential values", () => withEnv({
  ANTHROPIC_API_KEY: "sk-test-secret-value",
}, () => {
  const status = providerStatus();
  assert.equal(status.anthropic.configured, true);
  assert.equal(status.openai.configured, false);
  assert.equal(status.anthropic.keyEnv, "ANTHROPIC_API_KEY");
  assert.ok(!JSON.stringify(status).includes("sk-test-secret-value"));
  assert.deepEqual(configuredProviders(), ["anthropic"]);
  assert.equal(providerConfigured("xai"), false);
  assert.equal(providerConfigured("google"), false);
  assert.equal(providerKeyEnv("xai"), "XAI_API_KEY");
  assert.equal(providerKeyEnv("google"), "GOOGLE_GENERATIVE_AI_API_KEY");
}));

test("createLanguageModel builds each installed provider and guards missing keys", () => withEnv({
  OPENAI_API_KEY: "test", ANTHROPIC_API_KEY: "test", XAI_API_KEY: "test", GOOGLE_GENERATIVE_AI_API_KEY: "test", MODEL_API_KEY: "test",
}, () => {
  for (const provider of AI_PROVIDERS) {
    const model = createLanguageModel(provider, `test-${provider}-model`, "recognition");
    assert.equal((model as unknown as { modelId: string }).modelId, `test-${provider}-model`);
  }
  withEnv({ OPENAI_API_KEY: undefined }, () => {
    assert.throws(() => createLanguageModel("openai"), /OPENAI_API_KEY/);
  });
}));

test("isAiProvider validates the supported provider set", () => {
  for (const provider of AI_PROVIDERS) assert.equal(isAiProvider(provider), true);
  assert.equal(isAiProvider("mistral"), false);
  assert.equal(isAiProvider(undefined), false);
});


test("Meta Responses adapter sends bounded image/schema requests without storage", async () => {
  const { generateText, Output } = await import("ai");
  const { z } = await import("zod");
  const saved = process.env.MODEL_API_KEY;
  process.env.MODEL_API_KEY = "mock-meta-key";
  let calls = 0;
  try {
    assert.equal(defaultModelFor("meta", "recognition", {}), "muse-spark-1.3");
    const model = createLanguageModel("meta", "muse-spark-1.3", "recognition", async (url, init) => {
      calls++;
      assert.equal(String(url), "https://api.meta.ai/v1/responses");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer mock-meta-key");
      const body = JSON.parse(String(init?.body));
      assert.equal(body.store, false);
      assert.equal(body.max_output_tokens, 128);
      assert.equal(body.text.format.type, "json_schema");
      assert.ok(JSON.stringify(body.input).includes("input_image"));
      return Response.json({id:"resp_mock",object:"response",created_at:1714502400,status:"completed",model:"muse-spark-1.3",
        output:[{id:"msg_mock",type:"message",role:"assistant",status:"completed",content:[{type:"output_text",text:'{"name":"Scyther"}',annotations:[]}]}],
        usage:{input_tokens:100,output_tokens:20,total_tokens:120,output_tokens_details:{reasoning_tokens:5}}});
    });
    const result = await generateText({model, maxRetries:0, maxOutputTokens:128, providerOptions:providerOptionsFor("meta"),
      output:Output.object({schema:z.object({name:z.string()})}),
      messages:[{role:"user",content:[{type:"text",text:"Identify"},{type:"image",image:new Uint8Array([1,2,3]),mediaType:"image/png"}]}]});
    assert.equal(result.output.name, "Scyther");
    assert.equal(result.usage.inputTokens, 100);
    assert.equal(result.usage.outputTokens, 20);
    assert.equal(calls, 1);
  } finally { if (saved === undefined) delete process.env.MODEL_API_KEY; else process.env.MODEL_API_KEY = saved; }
});
