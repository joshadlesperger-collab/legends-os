# Five-card comparable audit — October 25, 2026

Supersedes the initial single-comp price interpretation, not the retained model responses. No paid generation or eBay edits. All ten originals inspected; Josh #12 and Trey #58 show NBA-logo foil, Shai #35/Adou #96 RC/Trae #19 show unpatterned base artwork. Scans cannot conclusively distinguish every subtle finish; matched sold front photos support base, not a numbered or LogoFractor premium.

| Card | Variant | Unique matched listings | Delivered range | Mean | Median | Evidence check |
|---|---|---:|---:|---:|---:|---|
| Josh Giddey | LogoFractor | 3 | $3.61–$14.35 | $8.10 | $6.35 | evidence-hold |
| Trey Murphy III | LogoFractor | 2 | $1.37–$3.48 | $2.42 | $2.42 | evidence-hold |
| Shai Gilgeous-Alexander | Base | 4 | $2.00–$5.06 | $3.59 | $3.64 | evidence-hold |
| Adou Thiero | Base | 3 | $1.77–$3.36 | $2.50 | $2.36 | review-estimate |
| Trae Young | Base | 3 | $1.35–$1.99 | $1.61 | $1.50 | review-estimate |

These are a bounded research sample, not an exhaustive market census. Means use one observation per listing; the Shai listing with two sales counts once. Conditions remain unknown, with no inferred premium. All amounts are displayed USD item plus Product Research average shipping. Three observations is a minimum review sample; >2x dispersion triggers review, not automatic exclusion. The existing pricing formula was not changed. A hold applies to price selection, not to continuing unpriced draft preparation under the seller's new 30-second instruction.

## Shai finding

The original $2/free-shipping sale exists, but it was inadequate alone. Three additional photo-matched base sales: [198600265824](https://www.ebay.com/itm/198600265824) $2+$1.36 September18; [127950219193](https://www.ebay.com/itm/127950219193) $3.14+$0.78 October10; [127983583332](https://www.ebay.com/itm/127983583332) $3.99+$1.07 August7. Including original [128110919846](https://www.ebay.com/itm/128110919846), sample mean delivered $3.585 and median $3.64. This supports revisiting the prior estimate, not inventing a high price. Wider base-titled auction results were visible but not photo-verified and are excluded from this bounded calculation. No final Shai asking price is approved.

Seller-history check: current active search 'Shai Cactus' returned0; Oct25 active export and 2025/2026 YTD order title searches found no exact Shai Cactus match. This is scoped title evidence, not proof no historical listing ever existed. Your regular Chrome Shai #141 order [127814062711](https://www.ebay.com/itm/127814062711) records $14.49+$1.95 April19,2026: different card, not a valid #35 comp. Trey active [128127665799](https://www.ebay.com/itm/128127665799) is Aqua Shimmer /199 at $4.95, not this LogoFractor. Historical order exports include statuses not independently confirmed as completed/paid; no buyer contact data enters the report.

## Other cards

Josh has wide auction/fixed-price dispersion: $3.61, $6.35 and $14.35 delivered. The single low sale hid that uncertainty. Trey has only two verified LogoFractor observations: $1.37 and $3.48; more model votes cannot fill the missing evidence. Adou and Trae remain low-value in the observed samples. The existing item floor plus $1.49 shipping would exceed both sample means; retain economics-review flags. A Trae back-only preview was excluded because it cannot establish the front parallel. Full per-sale dates, links, matching screenshots and exclusions are in multi-comp-audit.json.

## Implemented correction

Harness pricing runs now include a separate pricingEvidence result. Listing comparison rows have eligibleForPriceHandoff independent of model ready. Missing provenance, variant checks, known shipping, raw single-card status, dates, duplicates, insufficient observations and large dispersion cannot be cleared by model agreement. Legacy single-comp packets fail this evidence check even when arithmetic accuracy is100%. Original evidence is preserved. This is benchmark/handoff protection, not a deployment or a rewrite of approved prices. CAPA benchmark-shared-comp-bias enters monitoring; sustained live effectiveness remains unproven.

Validation:22 focused tests passed, including the mocked harness returning arithmetic success with evidence hold. npm run build passed. No new LLM spending.

Queue integration gap: pricing-context/preflight reject cactus-five IDs as unknown; these benchmark captures were never registered in the card queue. No fabricated stage completion. The next instruction authorizes 30-second pricing followed by unpriced drafts; its durable task will implement that path separately.
