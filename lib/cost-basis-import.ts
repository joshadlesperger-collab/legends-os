export const COST_FIELDS = ["acquisition_cost", "grading_cost", "supplies", "postage", "other_cost"] as const;
export type CostImportRow = { rowNumber: number; listing_id?: string; ebay_item_id?: string; sku?: string; acquisition_cost?: string; grading_cost?: string; supplies?: string; postage?: string; other_cost?: string; notes?: string };

export function parseCsv(text: string): CostImportRow[] {
  const records: string[][] = []; let row: string[] = []; let value = ""; let quoted = false;
  for (let i = 0; i < text.length; i++) { const char = text[i]; if (char === '"') { if (quoted && text[i + 1] === '"') { value += '"'; i++; } else quoted = !quoted; } else if (char === "," && !quoted) { row.push(value); value = ""; } else if ((char === "\n" || char === "\r") && !quoted) { if (char === "\r" && text[i + 1] === "\n") i++; row.push(value); if (row.some((cell) => cell.trim())) records.push(row); row = []; value = ""; } else value += char; }
  row.push(value); if (row.some((cell) => cell.trim())) records.push(row);
  if (!records.length) return [];
  const headers = records[0].map((header) => header.trim().toLowerCase().replace(/\s+/g, "_"));
  return records.slice(1).map((cells, index) => Object.fromEntries([["rowNumber", index + 2], ...headers.map((header, column) => [header, cells[column]?.trim() ?? ""])])) as CostImportRow[];
}

export function parseOptionalMoney(value: string | undefined) {
  if (value == null || value.trim() === "") return null;
  const parsed = Number(value); return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed * 100) / 100 : undefined;
}

export function validateCostRow(row: CostImportRow) {
  const errors: string[] = [];
  if (!row.listing_id && !row.ebay_item_id && !row.sku) errors.push("Provide listing_id, ebay_item_id, or sku");
  for (const field of COST_FIELDS) if (parseOptionalMoney(row[field]) === undefined) errors.push(`${field} must be a non-negative number`);
  if ((row.notes ?? "").length > 500) errors.push("notes exceeds 500 characters");
  return errors;
}
