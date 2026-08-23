export type OpportunityKind = "single" | "lot";

export function classifySellerListing(title: string): { kind: OpportunityKind; reason: string; estimatedCards: number | null } {
  const normalized = title.replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();
  const upper = normalized.toUpperCase();
  const countPatterns = [
    /\b(\d{1,4})\s*[X×]\s*(?:CARD|PCS?|COP(?:Y|IES))\b/i,
    /\b(\d{1,4})[- ]CARD\b/i,
    /\bLOT\s+OF\s+(\d{1,4})\b/i,
    /\b(\d{1,4})\s+(?:SPORTS?\s+)?CARDS?\s+LOTS?\b/i,
  ];
  const estimatedCards = countPatterns.map((pattern) => normalized.match(pattern)).find(Boolean)?.[1];
  const explicitNotLot = /\bNOT\s+(?:A\s+)?LOT\b/.test(upper);
  const lotToken = /\bLOTS?\b/.test(upper) && !/\bLOT\s*(?:#|NO\.?|NUMBER)\s*[A-Z0-9-]+\b/.test(upper);
  const quantitySignal = countPatterns.some((pattern) => pattern.test(normalized));
  const multiCardSignal = /\b(?:COLLECTION|BULK)\b/.test(upper) || /\b(?:CARD|ROOKIE|INSERT|REFRACTOR|PARALLEL)S\b/.test(upper);
  if (!explicitNotLot && (lotToken || quantitySignal || multiCardSignal)) {
    const reason = quantitySignal ? "Explicit multi-card quantity" : lotToken ? "Explicit lot wording" : "Plural multi-card wording";
    return { kind: "lot", reason, estimatedCards: estimatedCards ? Number(estimatedCards) : null };
  }
  return { kind: "single", reason: explicitNotLot ? "Title explicitly excludes a lot" : "No reliable lot signal", estimatedCards: null };
}
