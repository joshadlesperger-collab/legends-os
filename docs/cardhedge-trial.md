# Card Hedge evaluation — closed under no-paid-subscriptions policy

User decision: no paid subscriptions. Card Hedge enrollment, credit-card trials, Enterprise inquiries and paid API access are not next steps. The findings and unsent inquiry below are retained as historical research only; do not act on them. No vendor contact or subscription was made.

Use the manufacturer checklist and odds for identity, existing authorized seller transaction records for observed prices, and manually reviewed evidence where permitted. Public visibility alone does not authorize bulk collection. Keep the 100-query manifest as an offline coverage sample, not a pending vendor evaluation. Leave parallel premiums unknown until sufficient comparable sales support an estimate.

Research date: October 23, 2026 (America/Chicago). Status: prepared, not enrolled or run. No vendor message sent, payment authorized, API credential acquired, or seller data uploaded.

## Recommendation

Request written permission for a limited commercial evaluation of Legends OS before enrolling. The [developer signup page](https://ai.cardhedger.com/signup?target=developer) advertises a seven-day trial requiring a credit card and developer plans starting at $49/month, but separately states commercial use requires Enterprise. That public starting price is not an Enterprise quote. Confirm trial duration, total cost, renewal/cancellation mechanism and data rights in the proposed business agreement.

The [published terms](https://ai.cardhedger.com/terms) reserve reproduction and derivative-work rights absent written permission. The [enterprise inquiry](https://ai.cardhedger.com/api-services) is the appropriate business-access route. Neither a personal subscription nor marketing references to ML establish our retention or model-training rights.

Use the [OpenAPI specification](https://api.cardhedger.com/openapi.json) as the integration contract: `https://api.cardhedger.com`, server-side `X-API-Key`, catalog search followed by reviewed card-ID mapping, then `/v1/cards/comps` with `grade: Raw` and `include_raw_prices: true`. Marketing pages contain conflicting example hosts/auth headers; do not implement those examples. The documented comp records include source URLs, dates, titles, sale type and provider IDs; shipping, cancellation status and accepted-offer semantics require confirmation in actual responses. Provider price-history IDs alone may not deduplicate the same marketplace sale across vendors.

## Prepared sample

`data/card-catalog/cardhedge-trial.json` contains 100 deterministic, catalog-derived queries: 20 base cards covering stars, rookies and other veterans, each requested as Base, Refractor, RayWave and Gold RayWave (80); ten inserts; ten image variations. This is a coverage test, not a statement that we own those cards or that every queried variant applies to every subject. Parallel rows are candidates until per-card applicability is confirmed. No print runs were inferred from odds.

The request ceiling is 250 calls, no automatic retries, at most ten calls per minute, and subject to the actual approved contract. No runner is scheduled. Prioritize resolving exact catalog identities before spending calls on comps. Save evaluation responses only under the agreed retention policy and outside public deployment assets.

For each query record: provider card ID; exact release/edition/subset/number/parallel match; manual reviewer; raw-grade match; query time; source sales and dates; item/shipping/currency semantics; marketplace IDs/URLs; accepted-offer verification; lot/quantity/canceled-sale handling; duplicates; and usable matched-pair evidence. Record no-match and insufficient evidence rather than treating them as zero price. Do not substitute PSA 9/10 results for raw cards.

Proposed acceptance targets: at least 98% manually verified identity precision on returned matches and at least 70% usable raw-comp coverage overall, reported separately for all strata. These are pilot targets, not measured results. A critical edition/parallel mismatch must be corrected before use. Assess cost per usable match and compare held-out predictions with direct sales; do not launch automated pricing merely because coverage targets pass.

## Unsent inquiry draft

Hello Card Hedge team,

We are evaluating a commercial API integration for Legends OS, an internal sports-card catalog and seller research application. Our initial product is 2025–26 Topps Chrome Basketball, with emphasis on inexpensive raw singles, refractors, RayWave/color parallels, inserts and image variations.

Could you offer a bounded commercial evaluation covering 100 card/variant queries and up to 250 API requests, and provide an Enterprise quote? Please confirm:

1. Whether the advertised trial applies to business evaluation, its cost, payment requirements, renewal and cancellation terms.
2. Coverage and onboarding lag for this release, especially raw cards and low-volume parallels.
3. Whether individual comps expose original marketplace transaction identifiers, URLs, timestamps, actual accepted-offer amounts, currency and buyer shipping separately.
4. How multi-card lots, multi-quantity listings, cancellations, refunds and duplicated/relisted sales are represented.
5. Permission to store source records internally, cache results, calculate parallel price ratios, validate predictive models and retain derived models after termination; required deletion and attribution rules.
6. Image storage/display rights, source-data licensing, applicable rate limits and data-correction support.

We can provide the query manifest after evaluation terms are agreed. We will distinguish source sales from estimates and will not publish or redistribute your dataset without permission.

Thank you.
