export type CostComponents = { acquisition: number | null; grading: number | null; supplies: number | null; postage: number | null; other: number | null };

const finite = (value: number | null | undefined) => value != null && Number.isFinite(value) && value >= 0 ? value : null;
const round2 = (value: number) => Math.round(value * 100) / 100;

export function summarizeKnownCost(costs: CostComponents) {
  const entries = Object.entries(costs).map(([name, value]) => [name, finite(value)] as const);
  const known = entries.filter(([, value]) => value != null);
  return { knownUnitCost: known.length ? round2(known.reduce((sum, [, value]) => sum + value!, 0)) : null, knownComponents: known.map(([name]) => name), missingComponents: entries.filter(([, value]) => value == null).map(([name]) => name), complete: known.length === entries.length };
}

export function allocateSellerProceeds(input: { orderSellerProceeds: number | null; orderGross: number; lineGross: number }) {
  const proceeds = finite(input.orderSellerProceeds);
  if (proceeds == null || input.orderGross <= 0 || input.lineGross < 0) return null;
  return round2(proceeds * Math.min(1, input.lineGross / input.orderGross));
}

export function calculateKnownCostEconomics(input: { quantity: number; lineGross: number; allocatedSellerProceeds: number | null; refundAmount?: number; cancelled?: boolean; costs: CostComponents }) {
  const unit = summarizeKnownCost(input.costs);
  const quantity = Math.max(0, Math.floor(input.quantity));
  if (input.cancelled || quantity === 0 || unit.knownUnitCost == null) return { ...unit, basis: input.allocatedSellerProceeds == null ? "gross-sale" as const : "seller-proceeds" as const, knownCost: null, investedCost: null, netBasis: null, knownCostMargin: null, knownCostMarginPct: null, roi: null };
  const knownCost = round2(unit.knownUnitCost * quantity);
  const refund = Math.max(0, finite(input.refundAmount) ?? 0);
  const basis = input.allocatedSellerProceeds == null ? "gross-sale" as const : "seller-proceeds" as const;
  const netBasis = round2(Math.max(0, (input.allocatedSellerProceeds ?? input.lineGross) - refund));
  const margin = round2(netBasis - knownCost);
  const investedUnit = (finite(input.costs.acquisition) ?? 0) + (finite(input.costs.grading) ?? 0);
  const invested = round2(investedUnit * quantity);
  return { ...unit, basis, knownCost, investedCost: invested > 0 ? invested : null, netBasis, knownCostMargin: margin, knownCostMarginPct: netBasis > 0 ? round2(margin * 100 / netBasis) : null, roi: invested > 0 ? round2(margin * 100 / invested) : null };
}

export function calculateKnownCapital(input: { quantity: number; costs: CostComponents; listedAt: Date | null; now?: Date }) {
  const summary = summarizeKnownCost(input.costs); const quantity = Math.max(0, Math.floor(input.quantity)); const now = input.now ?? new Date(); const ageDays = input.listedAt ? Math.max(0, Math.floor((now.getTime() - input.listedAt.getTime()) / 86_400_000)) : null;
  return { ...summary, knownCapital: summary.knownUnitCost == null ? null : round2(summary.knownUnitCost * quantity), ageDays, ageBand: ageDays == null ? "unknown" : ageDays > 180 ? "180+" : ageDays > 90 ? "91-180" : ageDays > 60 ? "61-90" : ageDays > 30 ? "31-60" : "0-30" };
}
