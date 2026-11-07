# Card knowledge recovery and database integration

## All-product observation import

The user's import scope includes all 239 saved observations, regardless of checklist match. `lib/market-observation-import.ts` prepares and transactionally archives them using the existing `KnowledgeImport` / `KnowledgeLegacyRecord` source-record storage with `sourceTable=ebay_saved_search_observations` and `reviewStatus=observed-market-data`. This deliberately avoids the `KnowledgeObservation` variant foreign key while identities remain unresolved. It creates no inventory, product, variant, price approval or multiplier. A nullable `proposedChecklistEntryId` is retained in each raw record; parallel and condition are not collapsed into that ID.

`node --experimental-strip-types scripts/import-market-observations.ts` writes the concrete all-product import plan. Adding `--apply --approved-database-import` attempts the authorized import, but never applies migrations. Same-content retries have deterministic IDs and return unchanged; new snapshots remain separate historical observations. Any downstream sale counting must deduplicate by `observationKey` (provider/item ID), not count source snapshots as independent sales. Unknown transaction prices remain null; displayed prices, sold-date text, advertised shipping, source hash and uncertainty flags remain intact.

The supplied batch prepared 239 records, 56 proposed checklist IDs and 46 uncertain prices. The attempted apply returned `blocked-database-access` before writing because the local DATABASE_URL is unavailable. Four focused matching/import-plan tests passed; production persistence is not verified. The existing knowledge storage migrations must be present before this import can succeed.

## Checklist title matching

Saved observations now receive `checklistEntryId` independently of sale verification. Matching requires an explicit 2025/2025–26 Topps Chrome title, a catalog player and exact card number, and a compatible section. Explicit image variations match the variation entry; titles without variation wording match the described base entry rather than asserting photographic identity. Explicitly different releases, years and sports are held outside the current catalog; missing season/product is unresolved. Lots and multiple named players cannot receive one checklist ID. Parallel, grade, condition and price uncertainty remain separate fields and are not collapsed by this ID.

For the supplied HTML batch: 56 title matches, 150 outside the current catalog or product/season unresolved, 33 remaining identity holds, 46 uncertain prices. This is local staging, not a production import or proof that the title accurately describes the physical card.

## Saved HTML listing-link review — October 23, 2026

The user-provided saved HTML yielded 239 unique sold-search observations with 239 full item URLs, IDs, titles, displayed prices, dates and shipping amounts. The offline parser `scripts/read-saved-ebay-html.py` does not execute scripts or make network requests. The source hash is retained, account/recommendation content is excluded, and 46 prices remain uncertain (38 offer-capable, eight fixed-price). These counts differ from the earlier live snapshot because the supplied file is a different capture.

`node --experimental-strip-types scripts/stage-saved-market.ts` stages this specific reviewed source as `saved-market-packet.json` and `saved-market-review.json` under the ignored knowledge-graph artifacts directory. It rejects a different source digest instead of applying the manual checks to a new batch. The authenticated local `/card-knowledge/market-review` view now reads that packet and exposes original URLs, separate product groups, checklist proposals and listing-check notes. It does not read the earlier URL-less snapshot or claim production persistence. Capture time is unknown; the displayed analysis timestamp is not a sale observation timestamp.

Six links were individually opened in the browser. Bam Adebayo 198713414761, Thomas Sorber 128142139873, Dylan Harper 840028932778, Clint Capela 960076616507 and VJ Edgecombe 860045768954 redirected to product pages; product asking prices were not substituted for the saved sale prices. Ja Morant 377579315409 exposed See original listing and confirmed the same ID/title, SOLD $1.04, two bids, Oct 23 2026 18:19:54 PDT, advertised $4.99 shipping with combined shipping, and seller-described Ungraded—Excellent condition. Its front photograph shows the basketball-pattern border. This is retained as confirmed listing facts, not proof of settled payment, actual buyer shipping or independent acquisition. The remaining 233 links have not been individually visited. No row is eligible for the parallel estimator yet.

No production writes, migrations or deployments were performed. Database access remains unconfigured locally; knowledge migrations remain unapplied per the prior integration record. The supported production observation import/review flow is still incomplete. The local packet is an honest staging queue, not a completed database import.

## Single-page marketplace review — October 23, 2026

The requested 240-per-page search returned 239 distinct listing cards. The retained local packet is `artifacts/knowledge-graph/ebay-page-review-2026-10-23.json`; it is not a production import. The original 134 candidates were a preliminary screen, not verified comps. `node --experimental-strip-types scripts/review-market-batch.ts` reconciles all observations against the existing manufacturer catalog and writes `artifacts/knowledge-graph/market-review.json`. `/card-knowledge/market-review` exposes the local packet with product routing, original-candidate membership, checklist proposals and explicit holds. Missing local data shows unavailable.

There are 193 auction observations and 46 uncertain prices (37 offer-capable results and nine fixed-price results). Only 14 of the original 134 have a single player/card-number proposal in the current catalog. Even these remain unverified for release, section, parallel, condition, own-purchase exclusion and transaction status. The first-page capture did not preserve full individual listing URLs; DOM row identifiers are retained as observation keys but are not asserted to be verified sale IDs. Displayed prices and shipping are retained separately from verified amounts, which remain null. All rows are ineligible for pricing and no parallel model consumes this queue.

Product hints keep Update, Sapphire, Update Sapphire, Black, Cosmic, Cactus Jack, McDonald's, other seasons and other sports separate. Unqualified Chrome and Sapphire titles remain release-unverified; omitted Update labels must not be silently repaired. Re-running the report replaces only its derived local file and cannot increment stock or write production observations. The source packet remains unchanged.

Production import is blocked by missing configured database access and unapplied knowledge migrations. No migration, deployment, environment change or database write was performed. An approved migration and supported observation import/review flow are still required; authorization to import does not establish the missing factual verification or permission for an automated marketplace crawl.

## Free-source parallel evidence intake — 2026-10-24

The parallel view now reads up to 200 recent Topps Chrome order-line candidates from the existing authorized eBay order database, without a provider subscription, new sync, migration or database write. The read deliberately includes other sports/seasons as candidates; a reviewed checklist link determines eligibility. It selects no buyer data. An authenticated download is available at `/api/card-knowledge/seller-sales`. Unavailable access is shown separately from an empty dataset.

`npm run cards:parallel-sales -- collect` writes a private snapshot and candidate review report under `artifacts/knowledge-graph`. `npm run cards:parallel-sales -- analyze SNAPSHOT.json [REVIEWS.json]` uses an existing authorized export offline. Both generate `seller-parallel-coverage.json`; neither writes production data. Review files default to `artifacts/knowledge-graph/seller-sale-reviews.json` and are excluded from deployment bundles. The deployed view therefore remains a candidate queue unless reviews are provisioned through a future persistent application workflow.

Reviews use `{version:1,reviews:[...]}` and the schema in `lib/card-parallel-intake.ts`: sale key, exact source fingerprint, checklist entry ID, language, raw condition, full variant descriptor, explicit identity/condition/variant/ordinary-copy/single-card checks, review timestamp and evidence notes. Titles only suggest matches. The checklist supplies the canonical player and section. Source changes invalidate prior review; repeated reads of unchanged facts do not. No unknown field is silently verified.

Only paid, uncancelled, unrefunded single-unit lines with reconciled item + shipping + tax = line total qualify. Discount ambiguity, unknown shipping/tax, multiple lines from one order, missing item IDs and stale status snapshots are held. Status observations expire after seven days and sale eligibility after 90 days. Multi-quantity sales never create multiple independent observations. Actual buyer totals exclude tax; seller markup, condition conversions, pack odds and prior estimated prices do not train the relationship model.

Reviewed sales are partitioned by release, section, language, condition and currency. Each observed non-base variant is studied against Base Chrome, preserving finish and print run. Study coverage now reports missing baseline/target sales per card. The existing three-player and three-sales-per-side thresholds, shared 14-day window, direct-comp precedence and held-out-card fallback remain in force. Sparse data produces no usable multiplier.

Current execution: the local collector could not access the order database, so no real seller transactions or measured premiums were imported. This is an access gap, not evidence that no sales exist. Card Hedge registry entries are archived under the no-paid-subscriptions policy.

Validation: 22 catalog/parallel tests passed, including five seller-intake tests; TypeScript passed. The required root build encountered the existing Prisma DLL lock; the final isolated `npm run build` passed. Browser review confirmed the free-source evidence section and honest unavailable-data state. No deployment or migration was performed. Status freshness uses the recorded order-sync timestamp, never the dashboard read time. Single-line, single-unit orders can supply missing line shipping/tax/total from their own order totals; multi-line orders never receive an invented allocation.

## Current implementation

### Catalog/source audit completed October 23, 2026

`/card-knowledge/sources` exposes the source registry, format-specific odds and section-level edition evidence. `scripts/audit-card-catalog.py` independently accounts for every card-shaped line in the retained checklist and reconstructs odds columns from PDF coordinates with source-hash/layout checks. All 1,300 checklist rows are accounted for; 559 odds rows contain 1,787 mapped cells across the ten printed format columns (the refractor-box-set column has no extracted ratio cells). Original checklist/odds IDs and the original catalog digest are preserved; audited enrichment lives in `data/card-catalog/topps-chrome-basketball-2025-26-audit.json`.

The original 20 review rows are source-omitted Rock Stars teams, not dropped players. Card 226 remains absent from the manufacturer document. The printed Base Refractors Pulsar `1:0` is explicitly held. RayWave's printed `1:3` cells map to Mega and Fanatics Mega. Sapphire Selections has Sapphire-only format evidence. Nine section labels have no exact normalized odds-label join (including Infinite Sapphire vs the printed odds label Infinity); the audit intentionally leaves those mappings unresolved rather than silently equating names. Full transcription is complete; per-card parallel applicability and serial runs still need supplementary manufacturer evidence.

`data/card-catalog/source-registry.json` records the two manufacturer source hashes plus Card Hedge API/trial/rights references, acquisition state, reuse/retention gates, refresh rules and excluded uses. It is versioned local application data, not a claim of a live database import or a general license to harvest public pages. PostgreSQL remains inaccessible because Vercel's sensitive DATABASE_URL is not retrievable. Registry/audit data are not yet persisted into PostgreSQL by the catalog importer.

User constraint: **no paid subscriptions**. Card Hedge and credit-card trials are excluded from the active plan. Use manufacturer documents for identity and odds, existing authorized seller transaction records for pricing evidence, and manually reviewed comps where permitted. Do not infer permission for bulk collection from public visibility. Keep unsupported parallel premiums unknown until comparable sales support them.

`npm run cards:trial-plan` regenerates the historical registry and offline 100-query coverage manifest; it does not authorize a vendor trial. See `docs/cardhedge-trial.md` for archived findings. No subscription, vendor outreach or authenticated trial was performed.

Open **Sell → Card Knowledge** (`/card-knowledge`). The authenticated page searches the checked-in manufacturer catalog, links each entry to its original PDF page, shows recovered pilot coverage, and exposes a bounded graph export. `/api/card-knowledge?q=Cooper%20Flagg&view=graph` returns product → checklist entry → subject edges with source provenance. It does not create inventory or propose prices.

The initial catalog is **2025–26 Topps Chrome Basketball**, printed product year **2025**. A printed copyright year alone must not resolve an inventory card to this product. Chrome, Chrome Updates, Chrome Black and Sapphire remain different products.

Recovered on October 23, 2026:

| Material | Verified result |
| --- | --- |
| `Legends-OS-Pricing-Pilot.zip` | Existing October 20 offline pilot; recovered without executing its Python importer |
| SQLite integrity and foreign keys | Passed; original file opened read-only |
| Source records / recorded inventory rows | 1,205 / 1,205; not a fresh count of physical stock |
| Candidate variants | 798, including 30 recorded 2025–26 Topps Chrome Basketball variants |
| Individual market observations | 0; historical aggregates cannot be expanded into sales |
| Preserved normalized historical records | 6,843 across eight original tables |
| Official checklist | 1,300 entries across base, inserts, autographs and relics; 361 product-scoped subject names |
| Base checklist | 299 entries; printed numbers 1–300 excluding 226, exactly as supplied by Topps |
| Official odds evidence | 559 rows retained; multi-format column mapping remains unreviewed |
| Review items | 20 Rock Stars entries have no team supplied in the manufacturer checklist; team remains null |

Checklist reconciliation also found **24 candidate links and 7 holds** among the 31 recovered records named Topps Chrome Basketball (30 carry season 2025–26). These are review proposals only. Repeated player/card-number combinations across base and variations remain ambiguous when the old record lacks a section. See `artifacts/knowledge-graph/checklist-link-proposals.json`.

The original **Knowledge Graph Pricing** chat is at https://chatgpt.com/c/6adb71dd-4924-83ea-8329-ea94649b80ae. Its readable architecture reply describes product, player, sales and pricing intelligence plus a 100-card validation pilot. Subsequent implementation replies were returned as inaccessible content references. A browser fallback required sign-in. This recovery therefore restores the actual local October 20 archive and implements the missing repository integration; it does not claim to have recovered the unreadable October 23 attachments or completed their 100-card pilot.

## Files and reproducibility

- `data/card-catalog/topps-chrome-basketball-2025-26.json`: public manufacturer facts, exact printed text, original PDF pages, source URLs and SHA-256 fingerprints. It contains no seller inventory or credentials.
- `artifacts/knowledge-graph/recovered/`: the original archive entries, including the SQLite database and historical policy. The policy is historical evidence, not a replacement for current seller decisions.
- `artifacts/knowledge-graph/recovered-records.json`: lossless export of all eight recovered tables, including original raw source JSON, overrides, recorded quantities and draft/listing references.
- `artifacts/knowledge-graph/recovery-summary.json`: local dashboard summary, explicitly unverified for current eBay state.
- `artifacts/knowledge-graph/sources/`: original official checklist and odds PDFs.
- `artifacts/knowledge-graph/import-plan.json`: concrete database import plan.
- `scripts/recover-card-knowledge.py`: reproducible read-only recovery and PDF extraction. Requires `pypdf` and `pdfplumber`. It never executes the archived importer, which would recreate its database.

Private recovered files stay under the existing ignored `artifacts/` directory and are excluded by the existing Next output tracing rules. They are not embedded in deployed JavaScript. A host without those files shows recovery unavailable rather than zero inventory. Preserve the original zip as the recovery source.

```powershell
npm run cards:knowledge -- status
npm run cards:knowledge -- plan
npm run cards:knowledge -- search Cooper Flagg
npm run cards:knowledge -- graph Cooper Flagg
npm run test:card-knowledge
```

## Database design and approval boundary

`prisma/migrations/20261023180000_card_knowledge/migration.sql` creates ten new tables and their indexes/foreign keys. It does not alter existing inventory, listing, order, account, approval or pricing tables. The migration was generated from schema differences without connecting to a database. **It has not been applied.**

The relational graph consists of products, sources, checklist entries, subjects, odds, reviewed variants, individual observations, unresolved review items, import manifests and preserved legacy records. This uses the existing PostgreSQL/Prisma stack without introducing a second production graph service.

`lib/card-knowledge-import.ts` provides explicit transactional catalog and historical import functions:

- Identical catalog retries return unchanged. Changed catalog digests require a reviewed revision rather than overwriting facts used by downstream work.
- Legacy record keys include the source database fingerprint, original table and original primary key. Retries cannot increment stock, because the importer never writes stock.
- Bounded bulk writes avoid per-entry queries. Serializable transactions protect each independent import. The catalog and historical snapshot are separate transactions; if the second fails, retrying skips the completed first import.
- Legacy statuses, quantities, prices and overrides are stored as historical raw records, never promoted to current approval.
- Market sale identity is unique by provider and sale ID, not observation timestamp. Unknown shipping, hidden offers, own purchases, stale dates and variant/condition mismatches fail evidence eligibility. Pricing computation and publication remain with the existing seller workflow.

After explicit approval for the target database and its migration, the import command is:

```powershell
npm run cards:knowledge -- apply --approved-database-import
```

The flag is an intentional operator safeguard, not permission to run the command without approval. The command does not apply migrations itself. Review all pending repository migrations before approving deployment; do not blindly deploy unrelated pending migrations.

The current UI reads the versioned catalog snapshot and local recovery summary. Database import prepares durable storage; switching the UI to database reads and exposing mutation/review endpoints are later work, after migration and database integration verification. No application startup, build, page load, or GET endpoint writes the database.

## Checklist player names and recommended titles

All 1,300 checklist entries have a full player name and a generated recommended eBay title. The additive `20261023200000_card_knowledge_titles` migration adds `KnowledgeEntry.playerName`, `recommendedEbayTitle` (varchar 80), and `titleNeedsReview`, plus a product-level title policy version. The catalog page and search API expose the same title suggestions. Example: `2025-26 Topps Chrome Cooper Flagg #251 RC`.

Titles preserve the full player name and card number, include the release and applicable section/rookie designation, and fit within 80 characters. They do not invent condition, grade, parallels, or serial numbering. They remain suggestions requiring physical-copy review. An unchanged import is idempotent; the initial title backfill refuses to overwrite edited fields.

For the user's checklist-only import, after approved migrations and database access, run:

```powershell
npm run cards:knowledge -- apply-catalog --approved-database-import
```

This command excludes historical inventory recovery. `npm run cards:knowledge -- plan` prepares all titles for inspection without database access. Nine focused tests, application TypeScript validation, and `npm run build` in the isolated validation copy passed with the title changes. Production database access is pending explicit credential-access approval after automatic review rejected environment retrieval; no live import is claimed.

## Validation completed

- Prisma schema validation passed using a nonconnecting dummy URL.
- Application and test TypeScript checks passed.
- Full repository suite: 414 tests passed with normal filesystem permissions. The sandbox initially blocked existing tests' atomic file renames; rerunning outside that restriction passed.
- Eight knowledge tests passed, including source integrity, release/variant separation, missing shipping, duplicate-sale rejection, retry idempotency, historical preservation, and ambiguous checklist link holds.
- `npm run build` passed in an isolated copy of the repository and dependencies. The shared checkout's Prisma engine DLL was locked; no other process was stopped or shared dependency replaced to bypass that lock.
- Signed-in browser review: catalog statistics, navigation, Cooper Flagg/base-card search and graph endpoint verified. Local preview uses test authentication and a dummy database address.
- PostgreSQL migration/import and real database integration tests remain **not run** pending approval. No production deployment, commit, push, inventory update or eBay mutation occurred.

## Remaining evidence and expansion

### Parallel relationships and fallback estimates

`/card-knowledge/parallels` is the parallel research view. It reads up to 20 saved `KnowledgeParallelStudy` snapshots for this product and explicitly distinguishes database unavailability, no evidence, insufficient evidence, and expired studies. The additive `20261023220000_parallel_studies` migration is prepared, not applied. Each snapshot stores its scoped relationship, multiplier, observed interquartile spread, provisional confidence, counts, full input sale packet, source links/IDs, analysis method, and expiry. No RayWave premium is seeded as fact.

`lib/card-parallel.ts` learns the median of player-level median matched-card ratios. Each card must have three independently verified baseline sales and three parallel sales in a shared recent 14-day window; the model needs three different players. The 90-day eligibility policy excludes asking/aggregate/hidden-price sales, own purchases, missing shipping, duplicate sale identities, and mismatches. Only reviewed ordinary copies enter the model; special serials/color-match effects must be excluded upstream. Product, section, language, condition, currency, finish and print-run identity cannot be pooled silently. Confidence is provisional: insufficient when held, low for 3–9 players, moderate for 10+. An interquartile spread exceeding 50% of the median ratio holds the fallback. These thresholds require calibration against future held-out results.

`estimateParallel` first uses verified direct target comps. If none exist, it requires three actual baseline sales for the target card and multiplies their median buyer total by the parallel relationship learned with that card excluded. No inferred price can train or anchor another estimate. Its `estimatedBuyerTotalCents` field includes shipping and excludes tax; it is not an approved listing price and does not feed the seller's pricing/approval flow automatically. This is a price-ratio model, not a Pearson correlation coefficient or a claim of causal value.

Start with the empty packet template; its RayWave descriptor is an illustrative research request whose applicability must be verified before adding sales:

```powershell
npm run cards:parallels -- plan data/card-catalog/parallel-study-template.json
npm run cards:parallels -- plan PATH_TO_VERIFIED_PACKET.json --entry CHECKLIST_ENTRY_ID
```

Plans write reviewable reports to `artifacts/knowledge-graph/parallel-studies/` without database access. A sale packet includes the fields defined in `parallelPacketSchema`: original sale URL/provider/ID, dates, item/shipping cents, verified identity/condition flags, product/checklist/player identity, complete parallel descriptor and ordinary-copy review. Retain original evidence and use existing pricing-context handoffs before new research. There are currently no verified source sales in the recovered pilot, so the empty template correctly produces no multiplier.

After explicit migration and database-write approval, `npm run cards:parallels -- apply PACKET.json --approved-database-import` persists a research snapshot. Same-day retries of an identical ordered packet are idempotent. Studies expire after seven days; the estimator always recomputes from current evidence rather than trusting saved multipliers. No automatic refresh, sale ingestion, production deployment or listing mutation has been enabled.

When `--entry` is supplied, the saved result also retains that entry's calculation, direct/fallback basis, blockers and supporting sale IDs. Different target entries have separate snapshot IDs. Validation: 14 focused catalog/parallel tests, Prisma validation and the isolated `npm run build` passed. Browser review confirmed the visible view links, unavailable-database state and hypothetical $20 × 1.15 = $23 calculation. Real database persistence remains unverified pending access/migration approval.

1. Apply the reviewed migration/import only after explicit approval. Verify actual PostgreSQL transactions and counts; mock importer tests do not establish database integration success.
2. Recover the unreadable October 23 chat artifacts if they become available and reconcile their source hashes before importing.
3. Review format columns in the odds PDF. It includes Sapphire and retail formats. Do not create a cartesian product of every checklist card with every parallel, derive serial print runs from pack odds, or use odds ratios as price multipliers.
4. Resolve player aliases across products with evidence. Product-scoped subject keys deliberately do not equate similar names across sports/releases.
5. Recover dated individual sold evidence from existing seller handoffs before new research, using the orchestrator pricing-context and per-copy validation protocol. The recovered pilot itself contains no individual sales.
6. Link physical captures only through supported inventory flows with capture IDs; retain every distinct original and do not change inventory from checklist imports.
7. Add further manufacturer-backed product packets using the same schema and validation rules. Source format parsers must be release-specific; the current PDF extraction script is specifically for this Topps release.
8. Run the proposed 100-card accuracy/research-efficiency pilot once validated sales and per-copy identities exist. Do not claim pricing accuracy, player momentum, or Market Movers connectivity from catalog coverage alone.

## Primary sources

### CompsAPI free pilot — October 23, 2026

10K collection completed October 23 (America/Chicago): 10,189 unique listing IDs staged locally, including 9,186 new IDs beyond the prior 1,003. Forty successful responses supplied 9,600 rows; 414 repeated observations were retained as evidence without increasing the unique count. Collection elapsed time was 517.458 seconds including failure recovery; successful fetch time totaled 186.867 seconds. The dashboard confirmed Free with 43/100 monthly requests used. No paid plan, new key, eBay login sharing, production import or recurring job was enabled; the temporary local key file was removed.

The one-year query's page 2 failed three times with HTTP 503. The collector switched to documented date filters and overlapping end dates, retaining per-response hashes, receipts and source references. Dense days hit the 240-row cap: 39 dates are explicitly marked potentially incomplete. This reaches a unique-observation target, not complete market coverage. API-reported dates and prices remain unverified; 8,406 IDs have at least one unknown offer-status observation, 885 unknown-shipping flags and 184 multi-unit-average flags. There are 1,659 checklist-title matches across 14 product/review groups. All rows remain ineligible for pricing.

Outputs: `artifacts/knowledge-graph/compsapi-collection/index.json`, `new-listings.json`, filterable `report.html`, `checkpoint.json`, `verification.json` and the `pages/` evidence directory. `scripts/collect-compsapi.ts --report-only` rebuilds the index without network requests. Completed targets return without fetching again. A crash with an uncertain request outcome requires review; confirmed 503 responses receive bounded retries. `scripts/render-market-collection.ts` refreshes the report from the index. Nine focused tests and TypeScript passed; required build remains blocked by the existing locked Prisma engine DLL. Browser automation could not open the local file URL, so no browser-render validation is claimed.

User-raised spot check: eBay item 128126119596 explicitly displayed “This listing sold” and SOLD US $8.50. Its product page `/p/23094420008` showed a separate active offer, item 960076404536. The check is saved in `flagg-listing-check.json`. This confirms the displayed sold label and amount for that one listing, not payment settlement or the accuracy of all API rows.

Full-page follow-up: the user then authorized one 240-listing request. It returned 240 distinct IDs in 1.809 seconds, uncached, with no malformed rows or internal duplicates. All 25 pilot IDs reappeared (two also appeared in the saved HTML); deduplication against the union of both sources therefore found 215 new IDs and 1,003 combined local IDs. The account remained Free at 2/100 requests. There were 39 title matches, 73 provider-reported offers, two multi-unit averages, 16 unknown shipping amounts, 19 graded cards, and two sealed products. All 240 prices remain unverified. Product proposals are retained as 12 separate groups, including unresolved season/product groups; none is automatically linked to a pricing variant.

The full response, report, 215 new records and 25 repeated observations are saved separately under `artifacts/knowledge-graph/compsapi-batch-240/`. `report.html` filters by product, new/repeated status and title/ID. The saved response can be reanalyzed using `node --experimental-strip-types scripts/test-compsapi.ts --size=240 --reanalyze` without spending another request. A fetch receipt blocks accidental refetching of a completed batch. No pagination, 10K collection or production import was started.

User authorized a small free API test with no eBay login. One `/v1/usage` check and one `/v1/sold` request fetched 25 listings for `2025 topps chrome basketball` (30 days, page 1, size 25, US, offer flags and card hints). The dashboard confirmed Free and 1/100 monthly requests used. No upgrade, subscription, eBay credential access, database write or recurring job was enabled. The temporary local key file was removed after the request.

Results: 1.482 seconds for the sold request; provider reported uncached. There were 25 unique IDs, 23 new against the 765 saved-page IDs, two overlaps, no malformed rows, and one unique checklist-title match. Product proposals: 10 Chrome Update, eight Bowman, three Chrome Black, two Cactus Jack, two Chrome release-unverified. Sealed product is flagged separately. All rows remain provider-reported observations, not verified transaction comps.

Of two overlapping listings, item 147641795941 matched saved auction price and shipping. Item 327374248300 matched the saved displayed item price, but its provider offer flag was false while the HTML said Best Offer, and shipping differed ($5.39 versus $5.47). Neither observation establishes the accepted amount. Provider documentation defines price as an average per unit where multiple units sold; preserve that basis and unit counts. The broad search also returns other products, so API results must not be assumed to satisfy every query term.

Artifacts: `artifacts/knowledge-graph/compsapi-pilot/report.json`, its hash-named original response, and `request-plan.json`. `scripts/test-compsapi.ts` prepares a plan by default; explicit `--fetch --confirmed-free-tier` performs one search, no automatic retry or pagination. It reads `COMPSAPI_API_KEY` or a dedicated ignored `.env.compsapi-key`, and never logs credentials. Do not rerun just to reclassify a saved response. TypeScript and seven focused tests passed; the required build encountered the existing locked Prisma engine DLL.

Terms and documentation checked at https://compsapi.com/terms and https://compsapi.com/docs. The provider permits automated calls and local storage but does not represent this as an official eBay feed. No claims of accepted-price accuracy or completeness were independently established by this pilot.

- Product: https://www.topps.com/products/2025-26-topps-chrome%C2%AE-basketball-hobby-box
- Checklist: https://cdn.shopify.com/s/files/1/0662/9749/5709/files/2025-26_Topps_Chrome_Basketball_Checklist.pdf?v=1787956981
- Odds: https://cdn.shopify.com/s/files/1/0662/9749/5709/files/2025-26_Topps_Chrome_Basketball_Odds.pdf?v=1787958983
# Local normalization and exploratory comparisons

## Retrospective backtesting

After normalization, run `node --experimental-strip-types scripts/backtest-market.ts`. The local `artifacts/knowledge-graph/backtesting/report.html` separates displayed-auction-only results from the uncertain-inclusive sensitivity run. `predictions.json` retains every training listing ID, target ID, prediction, outcome and uncertainty count; `results.json` includes exclusion counts and collection priorities. The normalized dashboard links to this report.

Comp-count tests use exactly 1, 3, 5, 10 or 20 preceding comparable listings within 90 days, excluding the target day. Pairwise count comparisons use the same target population. Shipping tests share training IDs and target buyer-total outcomes: item-only, median item plus historical median shipping, and median individual landed totals. Target shipping is never a predictor. Parallel tests exclude the target player from multiplier learning and require three other players with three observations on each side, plus three target-card base anchors, all strictly earlier and within 14 days. Insufficient evidence produces no prediction, never zero error.

These are sale-date-ordered retrospective tests, not a true point-in-time information-availability replay. Source observations and identity matches were assembled later; transactions and copy independence remain unverified. Dependent errors and limited card coverage prevent significance or optimal-count claims. Fresh outcomes collected after freezing model inputs are needed for prospective validation. The current implementation reports no statistical confidence intervals or calibrated prediction ranges.

Test with `node --experimental-strip-types --test tests/market-backtest.test.ts`.

Run `node --experimental-strip-types scripts/normalize-market.ts` after rebuilding the collection index. This is offline and writes `artifacts/knowledge-graph/normalized/{listings,graph,comparisons}.json` and `report.html`. It does not migrate or import production data. The existing collection report links to the new report.

The normalizer resolves source references back to saved HTML observations, CompsAPI responses and workbook records. Each listing retains every source price and date, including approximate workbook dates and constructed-title provenance. Accepted offers, conflicting prices, multi-unit aggregates, non-card lots and ambiguous identities are held out of all comparison modes. The default comparison mode uses displayed auction results; the optional mode includes explicitly uncertain reported prices. Neither mode verifies settlement or grants listing-price approval.

Graph nodes distinguish source observations, listings, provisional name-derived athlete identities, product families, season-specific release proposals, checklist entries, parallel proposals and variant proposals. Edges retain evidence references and proposal status. Athlete aliases beyond normalized exact catalog names are not reconciled. Unknown parallels are not silently treated as Base. Autograph, variation and language qualifiers remain separate; unspecified qualifiers are not evidence of absence. No sale-event nodes are invented from listing IDs.

Comparisons use USD item-only prices, three distinct listing IDs per group, sale month, described grade/condition, and matching identity dimensions. They show median, range, uncertain count and peer-group count. Unknown physical condition and source sampling bias remain limitations. `2025` and `2025-26` cannot by themselves create a cross-year comparison. Product and true year comparisons need additional canonical catalogs. These exploratory cohorts do not feed the stricter verified parallel-pricing engine.

Validation: `node --experimental-strip-types --test tests/market-normalization.test.ts tests/market-collection.test.ts tests/card-market-review.test.ts`, `npx tsc --noEmit`, and `npm run build`. The build is currently blocked by an existing Prisma Windows DLL rename lock. Local output validation checks listing uniqueness, graph edge endpoints, retained evidence and HTML script syntax; browser visual verification is not yet recorded.

