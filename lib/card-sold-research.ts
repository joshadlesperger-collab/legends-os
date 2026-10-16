import { canonicalCardKey, generateTitle, type CardIdentity } from "./card-listing-factory.ts";
import type { SoldComp } from "./card-pricing-review.ts";

export const SOLD_RESEARCH_UNCONFIGURED_MESSAGE = "No sold-data API is configured. Use Research eBay sold listings for browser-assisted research; no API subscription is needed for that workflow.";

const norm = (value: unknown) => String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const hasWords = (title: string, value: string) => norm(value).split(" ").filter(Boolean).every(word => (` ${norm(title)} `).includes(` ${word} `));
export function filterFactorySoldRows(identity: CardIdentity, rows: unknown[], today = new Date().toISOString().slice(0, 10)) {
  const comps: SoldComp[] = []; const excluded: { title: string; reason: string }[] = []; const seen = new Set<string>();
  for (const candidate of rows.slice(0, 25)) {
    const row = candidate && typeof candidate === "object" ? candidate as Record<string, unknown> : {};
    const title = typeof row.title === "string" ? row.title.slice(0, 300) : "Untitled sale";
    const reject = (reason: string) => excluded.push({ title, reason });
    if (row.price_confirmed !== true || row.currency !== "USD") { reject("Price is not explicitly confirmed in USD."); continue; }
    const explicitFields = [[row.player, identity.player], [row.year, identity.year], [row.manufacturer, identity.manufacturer], [row.card_set, identity.set], [row.card_number, identity.cardNumber]];
    if (explicitFields.some(([observed, expected]) => observed != null && norm(observed) !== norm(expected))) { reject("Provider identity fields conflict with the card."); continue; }
    if (![identity.player, String(identity.year), identity.manufacturer, identity.set, identity.parallel ?? ""].every(part => !part || hasWords(title, part)) ||
      (norm(row.card_number) !== norm(identity.cardNumber) && !norm(title).split(" ").includes(norm(identity.cardNumber)))) { reject("Missing or conflicting card identity / exact parallel."); continue; }
    const graded = !!(row.grader || row.grading_company || row.grade || /\b(?:psa|bgs|sgc|cgc)\b/i.test(title));
    if (graded !== !!identity.graded || (graded && (!identity.grade || !hasWords(`${row.grader ?? row.grading_company ?? ""} ${row.grade ?? ""}`, identity.grade)))) { reject("Grading does not match."); continue; }
    const isAuto = /\bauto(?:graph(?:ed)?)?\b/i.test(title); const isRookie = /\b(?:rookie|rc)\b/i.test(title);
    if (isAuto !== !!identity.autograph || isRookie !== !!identity.rookie || /\b(?:lot|reprint|digital|custom)\b/i.test(title)) { reject("Autograph / rookie status or listing type differs."); continue; }
    const printRun = typeof row.print_run === "number" ? row.print_run : Number(/\/\s*(\d+)\b/.exec(title)?.[1]) || undefined;
    const titleRun = Number(/\/\s*(\d+)\b/.exec(title)?.[1]) || undefined;
    if ((identity.numberedTo ?? undefined) !== printRun || (titleRun !== undefined && titleRun !== printRun)) { reject("Print run differs or cannot be established."); continue; }
    if (identity.condition && norm(row.condition) !== norm(identity.condition)) { reject("Condition cannot be matched."); continue; }
    const price = row.sale_price ?? row.price; const shipping = row.shipping_price;
    if (typeof price !== "number" || !Number.isFinite(price) || price <= 0 || price > 1_000_000 || typeof shipping !== "number" || !Number.isFinite(shipping) || shipping < 0 || shipping > 1_000_000 || Math.abs(price*100-Math.round(price*100)) > 0.000001 || Math.abs(shipping*100-Math.round(shipping*100)) > 0.000001) { reject("Sold price or shipping is missing or invalid."); continue; }
    let source: URL;
    try { source = new URL(String(row.listing_url)); if (source.protocol !== "https:" || source.username || source.password) throw new Error(); source.hash = ""; } catch { reject("Missing safe source link."); continue; }
    // Tracking parameters do not turn the same sale into a second comp.
    source.search = "";
    const key = String(row.id ?? source.href);
    if (seen.has(key) || seen.has(source.href)) { reject("Duplicate sale."); continue; }
    const date = typeof row.sold_at === "string" ? row.sold_at : typeof row.sale_date === "string" ? row.sale_date : "";
    const stamp = Date.parse(date); const soldDate = Number.isFinite(stamp) ? new Date(stamp).toISOString().slice(0,10) : "";
    const age = (Date.parse(today) - Date.parse(soldDate))/86400000;
    if (!Number.isFinite(age) || age < 0 || age > 90 || !/^\d{4}-\d{2}-\d{2}/.test(date) || date.slice(0,10) !== soldDate) { reject("Sale date is missing, invalid, future or older than 90 days."); continue; }
    seen.add(key); seen.add(source.href);
    comps.push({ id: `the-card-api:${key}`, sourceUrl: source.href, soldDate, itemPrice: price, shipping, notes: `The Card API confirmed sale: ${title}`, verified: true, identityKey: canonicalCardKey(identity) });
  }
  return { comps, excluded };
}

export async function researchFactorySoldComps(identity: CardIdentity, signal?: AbortSignal) {
  if (!process.env.THE_CARD_API_KEY) return { status: "not-configured" as const, comps: [], excluded: [], message: SOLD_RESEARCH_UNCONFIGURED_MESSAGE };
  const params = new URLSearchParams({ q: generateTitle(identity).slice(0, 100), limit: "25", sort: "date_desc", graded: String(!!identity.graded) });
  const response = await fetch(`https://thecardapi.com/api/v1/market/sales?${params}`, { headers: { "x-market-api-key": process.env.THE_CARD_API_KEY }, cache: "no-store", signal: signal ?? AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error("Authorized sold-data provider lookup failed.");
  const data = await response.json();
  const result = filterFactorySoldRows(identity, Array.isArray(data.data) ? data.data : []);
  return { status: result.comps.length ? "ready" as const : "no-exact-evidence" as const, ...result,
    message: result.comps.length ? "Exact matching confirmed sales imported automatically; review the proposed price and shipping." : "No exact, fresh, confirmed sales with known shipping were returned. Price held for review." };
}
