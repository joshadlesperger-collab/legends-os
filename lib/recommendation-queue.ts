export const ACTIONABLE_PRICING_TYPES = ["raise-price", "lower-price"] as const;

export function isActionablePricingRecommendation(input: {
  type: string;
  suggestedPrice: unknown;
  confidence: number | null;
}) {
  const price = Number(input.suggestedPrice);
  return (
    ACTIONABLE_PRICING_TYPES.includes(input.type as (typeof ACTIONABLE_PRICING_TYPES)[number]) &&
    Number.isFinite(price) &&
    price > 0 &&
    (input.confidence ?? 0) >= 60
  );
}
