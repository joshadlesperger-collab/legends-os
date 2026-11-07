import test from "node:test";
import assert from "node:assert/strict";
import { candidatePrice } from "../lib/card-price-policy.ts";
import {
  PRICING_AGENT_SYSTEM_PROMPT, pricingAgentUserMessage, pricingProposalSchema,
  proposePriceWithModel, validatePricingProposal, type PricingProposal,
} from "../lib/card-pricing-agent.ts";

const good: PricingProposal = { targetBuyerTotal: 12, shipping: 2, approach: "Averaged the two matching NM sales including shipping.", warnings: [] };

test("pricing proposal schema bounds every field", () => {
  assert.equal(pricingProposalSchema.parse({ targetBuyerTotal: 12, shipping: 2, approach: "ok" }).warnings.length, 0);
  assert.ok(!pricingProposalSchema.safeParse({ ...good, approach: "x".repeat(281) }).success);
  assert.ok(!pricingProposalSchema.safeParse({ ...good, shipping: -1 }).success);
  assert.ok(!pricingProposalSchema.safeParse({ ...good, targetBuyerTotal: 0 }).success);
  assert.ok(!pricingProposalSchema.safeParse({ targetBuyerTotal: 12, shipping: 2 }).success);
});

test("proposal validation recomputes the price through the shared policy module", () => {
  const baseline = { buyerTotal: candidatePrice(12, 2).buyerTotal };
  const result = validatePricingProposal(good, baseline);
  assert.equal(result.valid, true);
  assert.equal(result.candidate?.item, candidatePrice(12, 2).item);
  assert.equal(result.candidate?.approved, false);
  assert.equal(result.relativeBuyerTotalDiff, 0);
  assert.equal(result.disagreement, false);
});

test("buyer-total drift beyond 5% is a disagreement, never an applied price", () => {
  const baseline = { buyerTotal: candidatePrice(12, 2).buyerTotal };
  const result = validatePricingProposal({ ...good, targetBuyerTotal: 13.9 }, baseline);
  assert.equal(result.valid, true);
  assert.equal(result.disagreement, true);
  assert.ok(result.relativeBuyerTotalDiff! > 0.05);
  assert.equal(result.candidate?.canPublish, false);
});

test("policy-invalid amounts fail validation instead of being coerced", () => {
  const result = validatePricingProposal({ ...good, targetBuyerTotal: Number.NaN });
  assert.equal(result.valid, false);
  assert.equal(result.candidate, null);
  assert.ok(result.failures.length > 0);
  assert.equal(result.disagreement, null);
});

test("system prompt embeds repository rules and bans chain-of-thought", () => {
  assert.match(PRICING_AGENT_SYSTEM_PROMPT, /\$1\.49/);
  assert.match(PRICING_AGENT_SYSTEM_PROMPT, /never add an automatic buffer/i);
  assert.match(PRICING_AGENT_SYSTEM_PROMPT, /subtract/i);
  assert.match(PRICING_AGENT_SYSTEM_PROMPT, /Never output private reasoning, internal deliberation or chain-of-thought/);
  const message = pricingAgentUserMessage({ comps: [{ item: 10, shipping: 2 }] });
  assert.match(message, /"item": 10/);
});

test("proposePriceWithModel parses output and passes provider options only for openai", async () => {
  const captured: Record<string, unknown>[] = [];
  const generate = async (options: Record<string, unknown>) => { captured.push(options); return { output: good, usage: { inputTokens: 10, outputTokens: 5 } }; };
  const model = {} as never;
  const first = await proposePriceWithModel(model, { comps: [] }, { generate, provider: "openai" });
  assert.deepEqual(first.proposal, good);
  assert.deepEqual(captured[0].providerOptions, { openai: { store: false, reasoningEffort: "low", reasoningSummary: null } });
  await proposePriceWithModel(model, { comps: [] }, { generate, provider: "anthropic" });
  assert.equal(captured[1].providerOptions, undefined);
  assert.equal(captured[0].system, PRICING_AGENT_SYSTEM_PROMPT);
});

test("proposePriceWithModel surfaces schema failures", async () => {
  const generate = async () => ({ output: { targetBuyerTotal: 12 }, usage: undefined });
  await assert.rejects(() => proposePriceWithModel({} as never, {}, { generate }));
});
