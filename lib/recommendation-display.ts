export function formatRecommendationMoney(value: string | number | null | undefined) {
  if (value == null || value === "") return "No reliable price recommendation";
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return "No reliable price recommendation";
  return `$${amount.toFixed(2)}`;
}
