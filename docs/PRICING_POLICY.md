# Pricing policy reconciliation — 2026-10-21

Policy reference: `pricing-hard-floor-2026-10-21-v5`. This document distinguishes confirmed workflow instructions from pricing choices still requiring source reconciliation. It is not a claim of runtime enforcement.

## Current workflow requirements

- Preserve identification, comp research, and estimates already completed. Reuse valid evidence rather than restarting all research.
- Supply a price estimate with low, medium, or high confidence and a stated evidence basis. Unknown information stays unknown.
- Record item price, buyer shipping, and buyer total separately; never present them interchangeably.
- A provisional estimate may proceed to draft preparation with its review requirement preserved in the internal manifest. Pricing uncertainty alone does not block drafts; unresolved card identity or mismatched photos does.
- Josh reviews and publishes the drafts. Do not publish automatically.
- Historical fixed 9% premium / item-only records must be flagged for reconciliation. Do not silently carry their formulas forward as the current policy or erase their provenance.
- Stamp recalculated valuations with the effective policy version, evidence references, timestamp, and confidence. Do not stamp an unrecalculated legacy value as compliant.

## Confirmed pricing evidence hierarchy

Authority: Josh's direct clarification in the 2026-10-21 voice conversation, transcript segment 00:32:16–00:36:58, followed by his request to integrate these decisions. The 90-day window is his research preference and current working scope, not a claim that eBay cannot expose older data.

1. Prefer credible eBay sold transactions within the last 90 days for the exact year, set, player, card number, parallel, print run, and comparable condition/grading status. Individual serial stamps may differ. Aim for at least two to three independent sales; one sale is thin evidence, not an automatic basis for high confidence.
2. If exact evidence is insufficient, use recent comparable numbered-parallel sales and the agreed print-run ratio estimate: source value × source print run / target print run. Label it a related-parallel estimate; it is a pricing heuristic, not a guaranteed market relationship. Preserve source identity, condition, totals, and arithmetic.
3. Check exact-card active listings against the sold-based or calculated estimate. When active listings are the only usable basis, inspect the bottom two credible comparable-condition listings for an anomalously cheap result and price near the credible floor. Do not automatically subtract 2–3%; this clarification supersedes that earlier fallback. One active listing alone needs lower confidence and an explicit missing-second-observation flag.
4. If no usable exact sales, supported related-parallel estimate, or credible active listing exists, flag the card for Josh to consider other years or similar cards. Do not invent a price or silently broaden identity. Continue the remaining batch.

## Total buyer cost and condition

- Compare item plus buyer-paid shipping for sold and active observations. Keep item price and shipping separately recorded, including currency and whether shipping is known. Missing shipping is unknown, not zero.
- Condition must be comparable: a poor-condition card does not establish the floor for a near-mint card; graded and ungraded evidence must not be silently pooled.
- Corroborate shipping-heavy sales with independent observations. A $1 item plus $9 shipping is a $10 observation, not conclusive proof of a $10 card. A comparable $3 plus $4.99 shipping supports an approximately $8–$10 range; roughly $9 is an example judgment, not a mandatory midpoint algorithm.
- Once the target buyer total is selected, item price = target buyer total minus the shipping charge for Josh's listing. Never add that shipping a second time. Preserve the resulting buyer total when applying any subsequently approved rounding.
- Acquisition item cost and inbound shipping remain separate cost-basis inputs for profitability; they are not comparable-sale market evidence merely because Josh paid them.

## Remaining reconciliation

The evidence hierarchy, condition requirement, buyer-total basis, and active-only floor above are now resolved for this workflow. Josh subsequently confirmed that initial listings should target supported fair market value with no automatic offer buffer. Tiered rounding is resolved below. Shipping-policy exceptions and permissions for automatic live repricing still require authoritative scope. Do not introduce a fixed 9% premium or an automatic live write while those questions remain unresolved. Runtime implementation and historical recalculation are not completed by this document.

## Store learning requirements, not yet verified running

Track listing age, eventual price, time to sell, and available demand/exposure metrics. Distinguish unsold listings from completed sales when evaluating velocity. Link market signals and refreshed evidence to the affected card definitions. Weekly hot/cold monitoring and daily/weekly repricing are not operational merely because documented here; verify scheduler, input data, and recorded execution before claiming them active.

## Initial asking price: no automatic buffer

Authority: Josh's direct 2026-10-21 clarification, voice transcript 00:39:32–00:40:13. When sufficient comparable evidence supports fair value, target that fair buyer-total value; do not add a fixed 9%, approximate 10%, or other automatic premium to create room for offers. This supersedes earlier proposed listing buffers. Keep confidence tied to evidence and do not use a premium to compensate for uncertainty. The credible active-only floor fallback remains as previously specified. Offer acceptance/discount settings are separate and are not changed by this decision. Runtime calculations and legacy valuations still require implementation/recalculation.

## Tiered item-price rounding

Authority: Josh's direct clarification on 2026-10-21, voice transcript 00:41:49–00:42:31. This replaces the preceding general nearest-ending proposal.

- Compute the unrounded item price as supported target buyer total minus the applicable buyer shipping charge. Apply the $3 threshold to this unrounded item amount, consistent with the calculation discussed immediately before Josh's clarification.
- At $3.00 or below: choose the nearest item price at or above $1.49 ending in .49 or .95, allowing rounding downward or upward. For an exact tie, use the lower ending as a routine implementation convention to avoid unnecessary upward bias.
- Above $3.00: choose the smallest item price at or above the unrounded amount ending in .49 or .95. An amount already at an allowed ending remains unchanged.
- Recalculate and display actual buyer total = rounded item price + shipping; retain the original target, rounding adjustment, and policy version. Do not claim rounding preserves the target exactly.
- Examples: $1.00 becomes $1.49 (hard floor overrides nearest-ending rounding); $3.00 becomes $2.95; $3.01 becomes $3.49; $20.00 becomes $20.49, before adding the separately recorded shipping charge.
- This permits only the buffer resulting from the approved upward rounding above $3, not an added 9%/10% premium. Apply the explicitly approved $1.49 hard item-price floor. If that exceeds evidence-supported buyer total, preserve the discrepancy and flag economics; never silently undercut the floor.
- Documentation is updated; runtime calculations and legacy valuations are not yet verified against this rule.

## Hard minimum item price — overrides all other pricing rules

Authority: Josh's direct 2026-10-21 clarification, transcript 00:43:04–00:43:16: no card may ever be below $1.49. For this workflow, record $1.49 as the minimum item price, with shipping separate, consistent with the item-price calculation under discussion. This supersedes any earlier example allowing $0.95.

Final proposed item price must be at least $1.49 after all pricing and rounding operations. Reject draft/export/revision price proposals below the floor rather than allowing another stage to overwrite it. Preserve the market estimate separately even if lower. Current offer acceptance and promotion settings need inspection to determine whether they could yield an actual card sale below $1.49; do not claim those execution paths enforce the floor until tested. A buyer-total estimate smaller than shipping plus $1.49 is an economics/review exception, not permission to violate the minimum. Historical live prices are not changed by this documentation update.
