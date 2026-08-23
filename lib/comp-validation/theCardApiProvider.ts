import type { CompProviderAdapter } from "./provider.ts";
import type { CardIdentity, CompSale } from "./types.ts";
import { parseCardIdentity } from "./identity.ts";

type TheCardApiSale = {
  id: string;
  platform?: string | null;
  listing_type?: string | null;
  title?: string | null;
  sale_date?: string | null;
  sold_at?: string | null;
  price?: number | null;
  sale_price?: number | null;
  price_confirmed?: boolean | null;
  currency?: string | null;
  listing_url?: string | null;
  grade?: string | null;
  grader?: string | null;
  grading_company?: string | null;
  condition?: string | null;
  player?: string | null;
  manufacturer?: string | null;
  card_set?: string | null;
  card_number?: string | null;
  print_run?: number | null;
  shipping_price?: number | null;
  category?: string | null;
  year?: number | string | null;
};

type TheCardApiResponse = {
  data?: TheCardApiSale[];
  pagination?: {
    has_more?: boolean;
    next_cursor?: string | null;
  };
};

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function boolFromString(text: string | null | undefined, value: string) {
  if (!text) return false;
  return text.toLowerCase().includes(value.toLowerCase());
}

export function buildSearchQuery(identity: CardIdentity, listingTitle: string) {
  const stopwords = new Set([
    "auto", "autograph", "autographed", "card", "cards", "rookie", "rc", "ssp", "sp", "pop", "bookend",
    "refractor", "prizm", "chrome", "foil", "wave", "mojo", "sparkle", "sapphire", "parallel", "insert",
    "gold", "silver", "black", "white", "blue", "red", "green", "orange", "purple", "aqua", "pink",
    "psa", "bgs", "sgc", "cgc", "mint", "gem", "graded", "first", "1st", "on", "print", "number",
  ]);
  const cleaned = listingTitle
    .replace(/#\s*[a-z0-9-]+/gi, " ")
    .replace(/\b\d+\s*\/\s*\d+\b/g, " ")
    .replace(/\b(?:psa|bgs|sgc|cgc)\s*\d{1,2}(?:\.5)?\b/gi, " ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const tokens = cleaned.split(/\s+/).filter((token) => token.length > 1 && !stopwords.has(token));
  const selected: string[] = [];
  for (const token of tokens) {
    if (!selected.includes(token)) selected.push(token);
    if (selected.length === 7) break;
  }
  if (identity.cardNumber && !selected.includes(identity.cardNumber.toLowerCase())) selected.push(identity.cardNumber.toLowerCase());
  return selected.join(" ").slice(0, 100) || listingTitle.slice(0, 100);
}

function normalizeSoldDate(sale: TheCardApiSale): string | null {
  if (sale.sold_at && sale.sold_at.trim()) return sale.sold_at;
  if (sale.sale_date && sale.sale_date.trim()) return `${sale.sale_date}T00:00:00Z`;
  return null;
}

function normalizeGradedStatus(sale: TheCardApiSale): "raw" | "graded" {
  if (sale.grader || sale.grade || sale.grading_company) return "graded";
  return "raw";
}

function normalizeVariation(sale: TheCardApiSale) {
  if (toNumber(sale.print_run) != null) return "serial-numbered";
  return parseCardIdentity(sale.title ?? "").variation;
}

function normalizeParallel(sale: TheCardApiSale) {
  const title = sale.title ?? "";
  if (boolFromString(title, "refractor")) return "refractor";
  if (boolFromString(title, "prizm")) return "prizm";
  if (boolFromString(title, "xfractor")) return "xfractor";
  return parseCardIdentity(title).parallel;
}

function normalizeRookie(sale: TheCardApiSale) {
  const title = sale.title ?? "";
  const hasFeatureRookie = boolFromString(title, "rookie") || boolFromString(title, " rc ");
  return hasFeatureRookie;
}

export function mapSaleToComp(input: { sale: TheCardApiSale; identity: CardIdentity; providerName: string }): CompSale | null {
  const { sale, identity, providerName } = input;
  const soldPrice = toNumber(sale.sale_price ?? sale.price);
  const soldDate = normalizeSoldDate(sale);
  const currency = (sale.currency ?? "USD").toUpperCase();
  if (soldPrice == null || soldPrice <= 0 || !soldDate || !Number.isFinite(Date.parse(soldDate)) || currency !== "USD" || sale.price_confirmed === false) return null;

  const shipping = toNumber(sale.shipping_price);
  const totalBuyerCost = shipping == null ? null : soldPrice + shipping;
  const printRun = toNumber(sale.print_run);
  const parsed = parseCardIdentity(sale.title ?? "");

  return {
    compKey: `${sale.platform ?? "unknown"}-${sale.id}`,
    providerId: "the-card-api",
    providerName,
    sourceItemId: sale.id,
    sourceUrl: sale.listing_url ?? null,
    soldTitle: sale.title ?? "Untitled Sale",
    soldDate,
    soldPrice,
    shipping,
    buyerPremium: null,
    totalBuyerCost,
    isAuction: (sale.listing_type ?? "").toLowerCase() === "auction",
    priceConfirmed: true,
    currency,
    attributes: {
      player: sale.player ?? parsed.player,
      year: toNumber(sale.year) ?? parsed.year,
      manufacturer: sale.manufacturer ?? parsed.manufacturer,
      setName: sale.card_set ?? parsed.setName,
      cardNumber: sale.card_number ?? parsed.cardNumber,
      rawOrGraded: normalizeGradedStatus(sale),
      gradeCompany: sale.grader ?? sale.grading_company ?? parsed.gradeCompany,
      gradeValue: toNumber(sale.grade),
      rookie: normalizeRookie(sale),
      autograph: boolFromString(sale.title, "auto") || boolFromString(sale.title, "autograph"),
      patch: boolFromString(sale.title, "patch") || boolFromString(sale.title, "jersey"),
      parallel: normalizeParallel(sale),
      variation: normalizeVariation(sale),
      serialNumbered: printRun != null || parsed.serialNumbered,
      printRun,
    },
  };
}

export const theCardApiProvider: CompProviderAdapter = {
  providerId: "the-card-api",
  providerName: "The Card API",
  async searchSoldComps({ identity, listingTitle, maxResults, query: queryOverride }) {
    const apiKey = process.env.THE_CARD_API_KEY;
    if (!apiKey) {
      throw new Error("THE_CARD_API_KEY is missing");
    }

    const baseUrl = "https://thecardapi.com/api/v1/market/sales";
    const query = queryOverride?.trim() || buildSearchQuery(identity, listingTitle);

    const limit = Math.max(1, Math.min(maxResults, 200));

    const params = new URLSearchParams({
      q: query,
      limit: String(limit),
      sort: "date_desc",
    });

    if (identity.rawOrGraded === "graded") {
      params.set("graded", "true");
      if (identity.gradeCompany) params.set("grader", identity.gradeCompany);
      if (identity.gradeValue != null) params.set("grade", String(identity.gradeValue));
    } else {
      params.set("graded", "false");
    }

    const response = await fetch(`${baseUrl}?${params.toString()}`, {
      method: "GET",
      headers: {
        "x-market-api-key": apiKey,
      },
      cache: "no-store",
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`The Card API request failed (${response.status}): ${body.slice(0, 300)}`);
    }

    const json = (await response.json()) as TheCardApiResponse;
    const sales = Array.isArray(json.data) ? json.data : [];

    const mapped = sales
      .map((sale) => mapSaleToComp({ sale, identity, providerName: "The Card API" }))
      .filter((sale): sale is CompSale => sale != null);

    return mapped.slice(0, maxResults);
  },
};
