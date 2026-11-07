import { parseCsv } from "./cost-basis-import.ts";

export type SellerReportTarget = { id: string; name: string; year: string; product: string; number: string; variant: string; serial: string; skuAliases?: string[] };
export type SellerReportRow = { rowNumber: number; itemId: string; title: string; sku: string; quantity: string | null; itemPrice: string | null;
  shipping: string | null; currency: string | null; condition: string | null; saleDate: string | null; transactionKey: string | null };
export type SellerReportSource = { path: string; sha256: string; modifiedAt: string; kind: "active" | "orders"; rows: SellerReportRow[] };
const marks = new RegExp("\\p{M}", "gu");
export const normalizeReportText = (text: string) => text.normalize("NFKD").replace(marks, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const nullable = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;

/** Project only listing evidence. Buyer/address/contact, order IDs, payment and
 * tracking data are deliberately excluded before any result can be persisted. */
export function parseSellerReport(text: string, kind: "active" | "orders"): SellerReportRow[] {
  if (Buffer.byteLength(text, "utf8") > 50_000_000) throw Error("Seller report exceeds the bounded 50 MB local limit");
  text = text.replace(/^\uFEFF/, "");
  let offset = 0;
  if (kind === "orders") {
    const header = /(?:^|\r?\n)("?Sales Record Number"?,)/i.exec(text); if (!header) throw Error("Orders report header is missing");
    offset = text.slice(0, header.index).split(/\r?\n/).length - 1; text = text.slice(header.index).replace(/^\r?\n/, "");
  }
  const rows = parseCsv(text) as unknown as Record<string, string | number>[];
  if (rows.length > 100000) throw Error("Seller report exceeds the bounded row limit");
  return rows.flatMap(row => {
    const itemId = nullable(row.item_number), title = nullable(kind === "active" ? row.title : row.item_title);
    if (!itemId || !title || !/^\d+$/.test(itemId)) return [];
    const descriptor = Object.entries(row).find(([name, value]) => name.includes("card_condition") && nullable(value));
    return [{ rowNumber: Number(row.rowNumber) + offset, itemId, title, sku: String(kind === "active" ? row["custom_label_(sku)"] ?? "" : row.custom_label ?? ""),
      quantity: nullable(kind === "active" ? row.available_quantity : row.quantity), itemPrice: nullable(kind === "active" ? row.current_price : row.sold_for),
      shipping: kind === "orders" ? nullable(row.shipping_and_handling) : null, currency: nullable(row.currency),
      condition: descriptor ? String(descriptor[1]) : nullable(row.condition), saleDate: kind === "orders" ? nullable(row.sale_date) : null,
      // Transient only: staging hashes this key; public batch output excludes it.
      transactionKey: kind === "orders" ? nullable(row.transaction_id) : null }];
  });
}
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function serialStatus(title: string, target: string) {
  const own = /^(\d+)\s*\/\s*(\d+)$/.exec(target), observed = Array.from(title.matchAll(/\b(\d+)\s*\/\s*(\d+)\b/g));
  if (!own || !observed.length) { const denominator = /\/\s*(\d+)\b/.exec(title); return denominator ? own && Number(denominator[1]) !== Number(own[2]) ? "different-print-run" : "denominator-only" : "unmentioned"; }
  return observed.some(m => Number(m[1]) === Number(own[1]) && Number(m[2]) === Number(own[2])) ? "same-full-serial" : "different-full-serial";
}

/** One pass per immutable report version, matching every selected identity
 * together. Name/SKU matches are candidates, never proof of price or stock. */
export function searchSellerReportBatch(targets: SellerReportTarget[], sources: SellerReportSource[], now = Date.now()) {
  if (!targets.length || targets.length > 100 || new Set(targets.map(t => t.id)).size !== targets.length || targets.some(t => !t.name.trim())) throw Error("Select 1 to 100 distinct named card targets");
  const duplicateSources: { path: string; duplicateOf: string; sha256: string }[] = [], unique: SellerReportSource[] = [];
  for (const source of sources) {
    if (!/^[a-f0-9]{64}$/.test(source.sha256) || !Number.isFinite(Date.parse(source.modifiedAt))) throw Error("Report source hash/date is invalid");
    const prior = unique.find(s => s.sha256 === source.sha256 && s.kind === source.kind);
    if (prior) duplicateSources.push({ path: source.path, duplicateOf: prior.path, sha256: source.sha256 }); else unique.push(source);
  }
  const compiled = targets.map(target => ({ target, name: normalizeReportText(target.name), product: normalizeReportText(target.product).split(" ").filter(Boolean),
    number: new RegExp(`(?:^|[#\\s])${escape(target.number)}(?=$|[^\\d/])`, "i"), matches: [] as Array<Record<string, unknown>>, seenTransactions: new Set<string>() }));
  let scannedRows = 0;
  for (const source of unique) for (const row of source.rows) {
    scannedRows++; const title = normalizeReportText(row.title);
    for (const c of compiled) {
      const nameMatched = (` ${title} `).includes(` ${c.name} `), skuMatched = Boolean(row.sku && c.target.skuAliases?.includes(row.sku));
      if (!nameMatched && !skuMatched) continue;
      // Exact transaction IDs deduplicate overlapping order windows, without
      // conflating separate same-day sales that merely share amount/title.
      const transaction = source.kind === "orders" && row.transactionKey ? `${row.itemId}:${row.transactionKey}` : null;
      if (transaction && c.seenTransactions.has(transaction)) continue; if (transaction) c.seenTransactions.add(transaction);
      const productMatched = c.product.every(token => (` ${title} `).includes(` ${token} `)), fullSeasonMatched = title.includes(normalizeReportText(c.target.year)), numberMatched = c.number.test(row.title), variantMatched = (` ${title} `).includes(` ${normalizeReportText(c.target.variant)} `);
      const serial = serialStatus(row.title, c.target.serial), ageMs = now - Date.parse(source.modifiedAt), saleTimestamp = row.saleDate ? Date.parse(row.saleDate) : NaN;
      const flags = [!productMatched && "product-unverified-or-different", !fullSeasonMatched && "full-season-unverified-or-different", !numberMatched && "card-number-unverified-or-different", !variantMatched && "variant-unverified-or-different",
        serial === "different-full-serial" && "different-physical-serial", serial === "different-print-run" && "different-print-run", ["unmentioned", "denominator-only"].includes(serial) && "full-serial-unverified", !row.condition && "condition-unknown", row.shipping === null && "shipping-unknown",
        source.kind === "active" && (ageMs < 0 || ageMs > 3600000) && "active-snapshot-stale", source.kind === "orders" && !Number.isFinite(saleTimestamp) && "sale-date-unverified",
        source.kind === "orders" && Number.isFinite(saleTimestamp) && (now - saleTimestamp > 90 * 86400000 || saleTimestamp > now) && "outside-current-90-day-window", "language-not-independently-observed", "original-photos-not-in-report"].filter(Boolean);
      c.matches.push({ source: source.path, sourceSha256: source.sha256, kind: source.kind, rowNumber: row.rowNumber, itemId: row.itemId, title: row.title, sku: row.sku,
        quantity: row.quantity, itemPrice: row.itemPrice, shipping: row.shipping, currency: row.currency, condition: row.condition, saleDate: row.saleDate,
        match: { nameMatched, skuMatched, productMatched, fullSeasonMatched, numberMatched, variantMatched, serial }, flags,
        disposition: "candidate-only", grantsInventoryClearance: false, validatedPrice: false });
    }
  }
  return { version: 1, generatedAt: new Date(now).toISOString(), sourceRowsScanned: scannedRows, uniqueSourcesScanned: unique.length, duplicateSources,
    sources: unique.map(({ rows, ...source }) => ({ ...source, rows: rows.length, activeRefreshRequired: source.kind === "active" && (now - Date.parse(source.modifiedAt) > 3600000 || Date.parse(source.modifiedAt) > now),
      saleDateRange: source.kind === "orders" ? { earliest: [...rows.map(r => r.saleDate).filter((v): v is string => !!v && Number.isFinite(Date.parse(v)))].sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null,
        latest: [...rows.map(r => r.saleDate).filter((v): v is string => !!v && Number.isFinite(Date.parse(v)))].sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null } : null })),
    targets: compiled.map(c => ({ target: c.target, candidateCount: c.matches.length, matches: c.matches, outcome: c.matches.length ? "potential-matches-require-review" : "no-name-or-exact-sku-candidate-in-selected-reports" })),
    limitations: ["Read-only offline evidence; no import, price proposal, draft/scheduled clearance, external call or photo move.", "File mtime/export date and index build time are distinct; neither is a fresh live seller observation.", "Orders do not establish uncancelled/unrefunded sales or disposition of every physical copy.", "Unknown sold condition/shipping/language is never filled from the owned-card default."] };
}
