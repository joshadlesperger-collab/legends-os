import { buildValuation } from "./engine.ts";
import { buildEvidenceSearchPlan, EVIDENCE_SEARCH_STRATEGY_VERSION } from "./evidence-search-planner.ts";
import { getProviderStatus } from "./provider.ts";
import type { CompProviderAdapter } from "./provider.ts";
import { theCardApiProvider } from "./theCardApiProvider.ts";
import type { CompSale, EvidenceQueryAudit, ListingForComp, ProviderStatus, TelemetryCounters, ValuationResult } from "./types.ts";
import type { InternalSaleEvidence } from "../pricing-evidence-acquisition.ts";
import { createInternalSalesAdapter } from "../pricing-evidence-acquisition.ts";
import { parseCardIdentity } from "./identity.ts";

const evidenceCache = new Map<string, Promise<CompSale[]>>();
let freeRowsConsumed = 0;
const FREE_ROW_BUDGET = 3_500;

export type ManualSoldEvidence = {
  id: string; soldTitle: string; soldPrice: number; shipping: number | null; soldDate: string;
  sourceUrl: string | null; sourceItemId: string; designation: "exact" | "near" | "proxy";
};

export type ValuationSubject = ListingForComp & { subjectType: "inventory" | "seller-opportunity" };

function cloneComps(rows: CompSale[]) { return rows.map((row) => ({ ...row, attributes: { ...row.attributes } })); }

export function manualEvidenceToComp(row: ManualSoldEvidence): CompSale {
  const parsed = parseCardIdentity(row.soldTitle);
  return { compKey: `manual-${row.id}`, providerId: "operator-verified-sold", providerName: "Operator verified sold evidence", sourceItemId: row.sourceItemId, sourceUrl: row.sourceUrl, soldTitle: row.soldTitle, soldDate: row.soldDate, soldPrice: row.soldPrice, shipping: row.shipping, buyerPremium: null, totalBuyerCost: row.shipping == null ? null : row.soldPrice + row.shipping, isAuction: false, priceConfirmed: true, currency: "USD", retrievalTier: row.designation === "exact" ? "exact" : row.designation, queryStrategyVersion: "manual-research-v1", attributes: { player: parsed.player, year: parsed.year, manufacturer: parsed.manufacturer, setName: parsed.setName, cardNumber: parsed.cardNumber, rawOrGraded: parsed.rawOrGraded, gradeCompany: parsed.gradeCompany, gradeValue: parsed.gradeValue, rookie: parsed.rookie, autograph: parsed.autograph, patch: parsed.patch, parallel: parsed.parallel, variation: parsed.variation, serialNumbered: parsed.serialNumbered, printRun: parsed.printRun } };
}

function sharedEvidenceAdapter(input: { internalSales: InternalSaleEvidence[]; manualEvidence: ManualSoldEvidence[]; telemetry: TelemetryCounters; audit: EvidenceQueryAudit[] }): CompProviderAdapter {
  const internal = createInternalSalesAdapter(input.internalSales);
  return {
    providerId: "canonical-sold-evidence",
    providerName: "Legends sales + The Card API",
    async searchSoldComps(request) {
      const internalRows = await internal.searchSoldComps(request);
      const combined: CompSale[] = [...input.manualEvidence.map(manualEvidenceToComp), ...internalRows.map((row) => ({ ...row, retrievalTier: "exact" as const, queryStrategyVersion: EVIDENCE_SEARCH_STRATEGY_VERSION }))];
      if (combined.length >= 5) return combined.slice(0, request.maxResults);
      for (const step of buildEvidenceSearchPlan(request.identity)) {
        const key = `${EVIDENCE_SEARCH_STRATEGY_VERSION}|the-card-api|${request.identity.identityHash}|${step.tier}|${step.query}|${request.maxResults}`;
        const cached = evidenceCache.get(key);
        let promise = cached;
        if (!promise) {
          if (freeRowsConsumed + request.maxResults > FREE_ROW_BUDGET) {
            input.audit.push({ strategyVersion: EVIDENCE_SEARCH_STRATEGY_VERSION, tier: step.tier, query: step.query, providerId: "the-card-api", candidateCount: 0, cacheHit: false });
            break;
          }
          input.telemetry.externalProviderCalls += 1;
          promise = theCardApiProvider.searchSoldComps({ ...request, query: step.query });
          evidenceCache.set(key, promise);
          promise.catch(() => evidenceCache.delete(key));
        } else input.telemetry.cacheHits += 1;
        const rows = cloneComps(await promise);
        if (!cached) freeRowsConsumed += rows.length;
        input.audit.push({ strategyVersion: EVIDENCE_SEARCH_STRATEGY_VERSION, tier: step.tier, query: step.query, providerId: "the-card-api", candidateCount: rows.length, cacheHit: Boolean(cached) });
        for (const row of rows) combined.push({ ...row, retrievalTier: step.tier, retrievalQuery: step.query, queryStrategyVersion: EVIDENCE_SEARCH_STRATEGY_VERSION });
        if (rows.length > 0 || combined.length >= request.maxResults) break;
      }
      const seen = new Set<string>();
      return combined.filter((row) => !seen.has(row.compKey) && seen.add(row.compKey)).slice(0, request.maxResults);
    },
  };
}

export async function valueSubject(input: {
  subject: ValuationSubject;
  telemetry: TelemetryCounters;
  identityResultCache: Map<string, ValuationResult>;
  internalSales?: InternalSaleEvidence[];
  manualEvidence?: ManualSoldEvidence[];
  allowLiveProvider?: boolean;
  providerStatusOverride?: ProviderStatus;
}) {
  const audit: EvidenceQueryAudit[] = [];
  const providerStatus = input.providerStatusOverride ?? getProviderStatus();
  const adapter = sharedEvidenceAdapter({ internalSales: input.internalSales ?? [], manualEvidence: input.manualEvidence ?? [], telemetry: input.telemetry, audit });
  const built = await buildValuation({
    listing: input.subject,
    telemetry: input.telemetry,
    identityResultCache: input.identityResultCache,
    allowLiveProvider: input.allowLiveProvider,
    evidenceAdapter: adapter,
    providerStatusOverride: providerStatus,
    countsAgainstExternalBudget: false,
  });
  built.result.queryStrategyVersion = EVIDENCE_SEARCH_STRATEGY_VERSION;
  built.result.queryAudit = audit;
  return built;
}

export function clearCanonicalEvidenceCache() { evidenceCache.clear(); freeRowsConsumed = 0; }
export function freeProviderRowsConsumed() { return freeRowsConsumed; }
