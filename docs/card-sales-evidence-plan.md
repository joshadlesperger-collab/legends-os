# Shared sales-evidence database — proposed design

Josh proposed collecting observed sold-listing search results for reusable pricing knowledge on 2026-10-22 and explicitly required sale date. This is a design record, not an implemented database or collection job.

Use the existing PostgreSQL database, with related card definitions, parallels, observations and valuation decisions. Keep schema/code in Git and transaction observations in the database. Do not add a separate graph service initially. Card-to-set, parallel-to-card, sale-to-parallel and valuation-to-sales relationships supply the useful graph.

Capture every legitimately accessible observed result once, including rejected and uncertain results. Collection is not verification or permission to scrape. A search page may mix lots, wrong variants, ended-unsold items and hidden accepted offers. Preserve their status; never count them all as qualifying sales. Deduplicate observations by marketplace/item ID and preserve changes without counting repeated sightings as new sales. Relisted items are separate observations, not assumed independent completed transactions.

Required observation fields:

- Marketplace, listing ID, source URL, original title, search/query context.
- Card identity, parallel, print run, observed serial, autograph/memorabilia, condition, raw/graded and grading details; confidence and unresolved fields.
- Sale date, date precision, original date text and timezone when provided. Unknown dates remain null and ineligible for recency-qualified pricing; never substitute collection time.
- First observed, last observed and last verified timestamps, separately from sale date.
- Item amount, buyer shipping, buyer total and currency; missing shipping remains unknown. Accepted-offer disclosure and auction/fixed-price format.
- Sold/ended-unsold/active/uncertain status, lot quantity, own acquisition/internal sale flags, verification state and exclusion reasons.
- Evidence reference and extraction/verification provenance.

Each valuation links to the exact observation versions used, their eligibility, weighting, selected method, arithmetic, confidence, effective policy and creation time. Calculated print-run estimates are valuations, never fabricated sales.

Read saved evidence first, acquire only missing/fresh evidence, upsert observations, validate comparable sales, apply exact → related-numbered → active fallback, then run scarcity/reduction checks. Date-of-sale supports 90-day eligibility, recency weights and trend comparisons; collection date supports freshness auditing.
