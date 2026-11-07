import { z } from "zod";
import { generateText, Output, type LanguageModel } from "ai";
import { candidatePrice } from "./card-price-policy.ts";
import { providerOptionsFor, type AiProvider } from "./ai-providers.ts";

/** Benchmark-only pricing proposal contract. The shared policy module (candidatePrice) stays
 * authoritative for the final item price; models only propose a target buyer total and listing
 * shipping from identical evidence. Proposals are comparison-only: never approved, never written
 * to eBay, and never applied to production pricing rules. */
export const pricingProposalSchema = z.object({
  targetBuyerTotal: z.number().positive().max(1_000_000),
  shipping: z.number().min(0).max(1_000_000),
  approach: z.string().min(1).max(280),
  warnings: z.array(z.string().max(300)).max(20).default([]),
});
export type PricingProposal = z.infer<typeof pricingProposalSchema>;
/** Provider wire schema must require every property for strict structured output. */
export const pricingGenerationSchema=pricingProposalSchema.extend({warnings:z.array(z.string().max(300)).max(20)});

/** Relative buyer-total difference above which a model proposal disagrees with the deterministic baseline. */
export const PRICING_DISAGREEMENT_TOLERANCE = 0.05;

export const PRICING_AGENT_SYSTEM_PROMPT = [
  "You estimate an eBay Buy It Now target buyer total for a raw sports card from supplied comparable-sale evidence.",
  "Rules: the target buyer total is each comp's condition-adjusted item price plus that comp's known shipping, averaged across comps; never add an automatic buffer or markup.",
  "Condition normalization toward Near mint or better multiplies the item portion only: Excellent +10%, Very good +25%; unknown source condition receives no premium.",
  "An approved related-print-run estimate scales the adjusted source buyer total by source print run divided by target print run.",
  "Exclude own exact-serial acquisitions, graded, lot, undisclosed-price, wrong-identity and stale sales. Never invent serials, condition grades or currency conversions.",
  "If any comp shipping is unknown the buyer total cannot be reconstructed; say so in warnings instead of guessing.",
  "The platform computes the final item price from your target buyer total: proposed listing shipping is subtracted once, the item rounds to a .49/.95 ending (nearest at or below $3 with ties down, upward above $3) and a $1.49 item floor is enforced.",
  "Output JSON only: targetBuyerTotal, shipping (your proposed listing shipping), approach and warnings.",
  "In \"approach\", state in at most 40 words which observable evidence drove your estimate. Never output private reasoning, internal deliberation or chain-of-thought.",
].join(" ");

export function pricingAgentUserMessage(evidence: unknown): string {
  return `Evidence (JSON):\n${JSON.stringify(evidence, null, 2)}\nPropose targetBuyerTotal and shipping for this card using only the evidence above. Flag every gap in warnings.`;
}

export type PricingValidation = {
  valid: boolean; failures: string[]; candidate: ReturnType<typeof candidatePrice> | null;
  relativeBuyerTotalDiff: number | null; disagreement: boolean | null;
};

/** Validate a model proposal against repository pricing rules. The deterministic baseline buyer
 * total comes from the existing validated pricing pipeline; proposals never replace it. */
export function validatePricingProposal(proposal: PricingProposal, baseline?: { buyerTotal: number } | null): PricingValidation {
  const failures: string[] = [];
  let candidate: ReturnType<typeof candidatePrice> | null = null;
  try { candidate = candidatePrice(proposal.targetBuyerTotal, proposal.shipping); }
  catch (error) { failures.push(error instanceof Error ? error.message : "Policy validation failed"); }
  let relativeBuyerTotalDiff: number | null = null;
  let disagreement: boolean | null = null;
  if (candidate && baseline && Number.isFinite(baseline.buyerTotal) && baseline.buyerTotal > 0) {
    relativeBuyerTotalDiff = Math.abs(candidate.buyerTotal - baseline.buyerTotal) / baseline.buyerTotal;
    disagreement = relativeBuyerTotalDiff > PRICING_DISAGREEMENT_TOLERANCE;
  }
  return { valid: failures.length === 0, failures, candidate, relativeBuyerTotalDiff, disagreement };
}

export type GenerateResult = { output?: unknown; usage?: unknown };
export type GenerateFn = (options: Record<string, unknown>) => Promise<GenerateResult>;

/** Run one schema-constrained pricing proposal. `generate` is injectable so tests never touch the network. */
export async function proposePriceWithModel(
  model: LanguageModel, evidence: unknown,
  deps?: { generate?: GenerateFn; abortSignal?: AbortSignal; provider?: AiProvider },
): Promise<{ proposal: PricingProposal; usage: unknown }> {
  const generate = deps?.generate ?? (generateText as unknown as GenerateFn);
  const options = providerOptionsFor(deps?.provider ?? "openai");
  const result = await generate({
    model,
    output: Output.object({ schema: pricingGenerationSchema }),
    system: PRICING_AGENT_SYSTEM_PROMPT,
    messages: [{ role: "user", content: pricingAgentUserMessage(evidence) }],
    maxOutputTokens: 1200, maxRetries: 0,
    abortSignal: deps?.abortSignal ?? AbortSignal.timeout(60_000),
    ...(options ? { providerOptions: options } : {}),
  });
  return { proposal: pricingProposalSchema.parse(result.output), usage: result.usage };
}
