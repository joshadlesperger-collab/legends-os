import catalogData from "../data/card-catalog/topps-chrome-basketball-2025-26.json";
import { validateCatalog } from "./card-knowledge.ts";
import { validatedJsonReader } from "./validated-json-cache.ts";
import { summarySchema } from "./card-recovery-summary.ts";

export const cardCatalog = validateCatalog(catalogData);
const readRecoverySummary = validatedJsonReader("artifacts/knowledge-graph/recovery-summary.json", raw => summarySchema.parse(raw));
export async function recoverySummary() {
  try {
    return { state: "available" as const, summary: await readRecoverySummary() };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "unavailable" as const, summary: null };
    return { state: "invalid" as const, summary: null };
  }
}
