import type { CardIdentity, EvidenceSearchTier } from "./types.ts";

export const EVIDENCE_SEARCH_STRATEGY_VERSION = "exact-first-v2";

export type EvidenceSearchStep = {
  tier: EvidenceSearchTier;
  query: string;
};

function quoted(value: string | null | undefined) {
  const normalized = (value ?? "").replace(/["()]/g, " ").replace(/\s+/g, " ").trim();
  return normalized ? `"${normalized}"` : null;
}

function unique(parts: Array<string | null>) {
  return Array.from(new Set(parts.filter((part): part is string => Boolean(part)))).join(" ").slice(0, 180);
}

function serialTier(identity: CardIdentity) {
  return identity.printRun != null ? `/${identity.printRun}` : identity.serialNumbered ? "numbered" : null;
}

function variationTerm(value: string | null) {
  if (!value) return null;
  return quoted(value.replace(/^subset:/, "").replace(/^topps-50-50:/, "").replaceAll(":", " "));
}

export function buildEvidenceSearchPlan(identity: CardIdentity): EvidenceSearchStep[] {
  const player = quoted(identity.player);
  const product = quoted(identity.setName ?? identity.manufacturer);
  const exact = unique([
    identity.year == null ? null : String(identity.year), player, product,
    identity.cardNumber ? `#${identity.cardNumber}` : null,
    variationTerm(identity.variation), quoted(identity.parallel), serialTier(identity),
    identity.autograph ? "auto" : null, identity.patch ? "patch" : null,
    identity.rawOrGraded === "graded" ? identity.gradeCompany : null,
    identity.gradeValue == null ? null : String(identity.gradeValue), "-(lot,lots,reprint)",
  ]);
  const near = unique([
    identity.year == null ? null : String(identity.year), player, product,
    identity.cardNumber ? `#${identity.cardNumber}` : null,
    variationTerm(identity.variation), quoted(identity.parallel), serialTier(identity), "-(lot,lots,reprint)",
  ]);
  const proxy = unique([
    identity.year == null ? null : String(identity.year), player, product,
    identity.cardNumber ? `#${identity.cardNumber}` : null, "-(lot,lots,reprint)",
  ]);
  const steps: EvidenceSearchStep[] = [];
  for (const step of [{ tier: "exact" as const, query: exact }, { tier: "near" as const, query: near }, { tier: "proxy" as const, query: proxy }]) {
    if (step.query.length >= 4 && !steps.some((existing) => existing.query === step.query)) steps.push(step);
  }
  return steps;
}
