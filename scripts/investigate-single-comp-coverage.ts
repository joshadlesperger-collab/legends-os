import { prisma } from "../lib/prisma.ts";
import { parseCardIdentity } from "../lib/comp-validation/identity.ts";
import { buildValuation, createTelemetry } from "../lib/comp-validation/engine.ts";
import { mapSaleToComp } from "../lib/comp-validation/theCardApiProvider.ts";
import type { CompProviderAdapter } from "../lib/comp-validation/provider.ts";
import type { ValuationResult } from "../lib/comp-validation/types.ts";
import { MONITORED_SELLERS } from "../lib/seller-registry.ts";

function valuation(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = (value as Record<string, unknown>).singleValuation;
  return row && typeof row === "object" && !Array.isArray(row) ? row as Record<string, unknown> : null;
}

function researchQuery(title: string) {
  const clean = title.replace(/\s*\[[^\]]*$/g, "").replace(/\b(?:baseball|basketball|football|hockey|card|cards)\b/gi, " ").replace(/\s+/g, " ").trim();
  const id = parseCardIdentity(clean);
  const terms = [id.player ? `"${id.player}"` : null, id.year, id.setName ? `"${id.setName}"` : id.manufacturer, id.cardNumber ? `#${id.cardNumber}` : null, id.parallel && id.parallel !== "chrome" ? `"${id.parallel}"` : null, id.autograph ? "(auto,autograph)" : null, id.patch ? "(patch,jersey,relic)" : null, id.printRun ? `/${id.printRun}` : null, "-(lot,lots,reprint)"].filter(Boolean);
  return terms.join(" ").slice(0, 180);
}

async function main() {
  const key = process.env.THE_CARD_API_KEY;
  if (!key) throw new Error("THE_CARD_API_KEY is missing");
  const run = await prisma.sellerOpportunityRun.findFirst({ where: { seller: MONITORED_SELLERS[0].ebayUserId }, orderBy: { collectedAt: "desc" }, include: { auctions: { where: { kind: "single" }, orderBy: { ebayItemId: "asc" } } } });
  if (!run) throw new Error("No seller run found");
  let rateLimit: string | null = null, rateRemaining: string | null = null, coverageFrom: string | null = null, coverageTo: string | null = null;
  const queryByListing = new Map<string, string>();
  const adapter: CompProviderAdapter = { providerId: "the-card-api", providerName: "The Card API improved eBay query experiment", async searchSoldComps({ identity, listingTitle, maxResults }) {
    const q = researchQuery(listingTitle); queryByListing.set(listingTitle, q);
    const params = new URLSearchParams({ q, platform: "ebay", limit: String(Math.min(40, maxResults)), sort: "date_desc", graded: String(identity.rawOrGraded === "graded") });
    if (identity.gradeCompany) params.set("grader", identity.gradeCompany);
    if (identity.gradeValue != null) params.set("grade", String(identity.gradeValue));
    const response = await fetch(`https://thecardapi.com/api/v1/market/sales?${params}`, { headers: { "x-market-api-key": key } });
    if (!response.ok) throw new Error(`provider ${response.status}: ${(await response.text()).slice(0, 160)}`);
    rateLimit = response.headers.get("x-ratelimit-limit"); rateRemaining = response.headers.get("x-ratelimit-remaining");
    const body = await response.json() as { data?: Array<Parameters<typeof mapSaleToComp>[0]["sale"]>; meta?: { coverage_date_from?: string; coverage_date_to?: string } };
    coverageFrom = body.meta?.coverage_date_from ?? coverageFrom; coverageTo = body.meta?.coverage_date_to ?? coverageTo;
    return (body.data ?? []).map(sale => mapSaleToComp({ sale, identity, providerName: "The Card API" })).filter((sale): sale is NonNullable<typeof sale> => sale != null).slice(0, maxResults);
  }};
  const telemetry = createTelemetry(); const cache = new Map<string, ValuationResult>(); const results = [];
  for (const auction of run.auctions) {
    const { result } = await buildValuation({ listing: { id: auction.id, storeId: `seller:${auction.seller}`, title: auction.title, currentPrice: Number(auction.currentBid), quantity: 1, quantitySold: 0, views: 0, watchers: 0, listingFormat: "AUCTION", condition: null, listingQuality: null }, telemetry, identityResultCache: cache, evidenceAdapter: adapter, countsAgainstExternalBudget: true });
    results.push({ ebayItemId: auction.ebayItemId, title: auction.title, query: queryByListing.get(auction.title), value: result.recommendedPrice, confidence: result.confidenceScore >= 75 && result.exactMatchCount >= 2 ? "High" : result.confidenceScore >= 55 && result.exactMatchCount + result.nearExactMatchCount >= 2 ? "Medium" : "Low", accepted: result.acceptedCompCount, exact: result.exactMatchCount, near: result.nearExactMatchCount, acceptedEvidence: result.comps.filter(comp => comp.inclusionStatus === "accepted").slice(0, 12).map(comp => ({ title: comp.soldTitle, price: comp.soldPrice, date: comp.soldDate, tier: comp.matchTier, url: comp.sourceUrl })) });
  }
  const v1 = run.auctions.map(row => valuation(row.itemSpecifics));
  const counts = (values: Array<string | undefined>) => Object.fromEntries(values.reduce((map, value) => map.set(value ?? "unknown", (map.get(value ?? "unknown") ?? 0) + 1), new Map<string, number>()));
  console.log(JSON.stringify({ runId: run.id, cards: run.auctions.length, v1Valued: v1.filter(row => row?.estimatedMarketValue != null).length, experimentValued: results.filter(row => row.value != null).length, experimentConfidence: counts(results.map(row => row.confidence)), telemetry, providerWindow: { coverageFrom, coverageTo, rateLimit, rateRemaining }, newlyValued: results.filter((row, index) => row.value != null && v1[index]?.estimatedMarketValue == null).slice(0, 20), stillUnvaluedSample: results.filter(row => row.value == null).slice(0, 10) }, null, 2));
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
