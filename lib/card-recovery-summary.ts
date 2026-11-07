import { z } from "zod";
export const summarySchema = z.object({
  version: z.literal(1), recoveredAt: z.string(), sourceSha256: z.string(),
  counts: z.object({ source_records: z.number().int().nonnegative(), card_variants: z.number().int().nonnegative(), market_observations: z.number().int().nonnegative() }).catchall(z.number().int().nonnegative()),
  productGroups: z.array(z.object({ season: z.string(), product: z.string(), candidateVariants: z.number().int() })),
  databaseApplied: z.literal(false), liveStatusVerified: z.literal(false), limitations: z.array(z.string()),
});
