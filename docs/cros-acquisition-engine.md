# CROS — Card Recovery & Opportunity System
Status: DESIGN BASELINE / NOT DEPLOYED
Pilot: 1990 Score Bo Jackson #697 (not #695)
Owner: Legends OS acquisition orchestrator

## Mission
Find undervalued raw and graded cards, especially cards hidden in sets and lots; evaluate grading, BGS recovery/crossover and resale economics; create evidence-backed human-approved purchase recommendations. Connect purchase -> repair/submit -> grade -> inventory -> listing -> realized sale.

## Source decisions preserved
- July 10 CROS: Marketplace Scout, Vision Inspector, Recovery Engine, Kurt SOP/why/FMEA knowledge base, Repair Tracker, Submission Manager, Learning Engine and executive dashboard. TAG may provide high-resolution defect/DIG evidence; BGS listing photographs may expose subgrades.
- Initial BGS recovery pilot: centering below 9.5 is a *working hard reject* for recovery candidates; other subgrades may be recoverable. Make policy versioned, configurable and subject to outcome validation; do not infer recoverability from grade alone.
- July 10 MVP: scan eBay active listings for #697; deduplicate listing IDs; capture BGS overall/subgrades/photos; apply gates; calculate delivered cost, expected profit and maximum bid; rank Buy/Watch/Manual Review/Pass; shadow-test before spending.
- Bo Jackson collection strategy: maintain checklist, owned cards, missing cards, personal collection vs business investment flags; reusable product opportunity, player momentum, eBay hunting and deal analysis capabilities.
- October sourcing strategy: search complete 704-card 1990 Score sets, mixed lots, misidentified titles, newly listed BIN and auctions, in addition to exact #697 singles. Never assume a target card is present without evidence.
- Existing Legends OS: reuse pricing evidence ladder, knowledge graph, governed actions/audit, inventory and listing factory; integrate at rollup/contract layer, not duplicate workspaces.

## Components and data contracts
1. Scout: source adapters, rate limits, query variants, listing snapshots, dedupe by marketplace/listing ID and photo fingerprint.
2. Identification: card set/year/number/variant, graded company and grade, autograph/authentication distinctions, photo quality and identity confidence.
3. Condition & recovery: centering/corners/edges/surface, BGS subgrades, TAG detail when authorized, recoverable-defect hypothesis, before/after fingerprints, SOP and FMEA, explicit unknowns.
4. Evidence service: exact recent sold -> near sold -> internal historical relationship -> active context -> manual review. Active asks alone never establish acquisition-grade value. Preserve sale dates, landed prices, provenance and duplicates. Honor data licensing; do not store prohibited raw data.
5. Valuation: grade-outcome probability distribution; scenario EV and downside, grading/repair/submission/shipping/tax/fees/time costs; max landed bid; margin, ROI and capital duration. Include no-grade and damaged scenarios.
6. Decision: BUY/OFFER/WATCH/MANUAL REVIEW/PASS, explainable rationale, evidence links, risk/confidence, approval status and immutable action audit.
7. Outcome ledger: acquisition ID, listing and seller IDs, paid total, card fingerprint, treatment, submission, final grade, resale, realized net profit, days and errors.
8. Learning: forecast calibration, realized vs projected profit, missed-deal analysis, precision of leads, model/API cost per qualified lead, grading success; controlled versioned experiments.

## Guardrails
- No autonomous purchases, bids, offers, paid services or deployments without explicit approval.
- No circumvention of site restrictions. Seller eBay APIs and buyer-side Browse discovery are different permissions.
- Changes to query scheduling and model routing can be automatic within bounded spend; purchase budget, thresholds, grading/repair policy and external paid subscriptions require approval.
- A seller image is insufficient to assert a PSA 10; abstain when image quality is weak.
- Human review for ambiguous identification, counterfeit/alteration risk, questionable recoverability or missing exact sold evidence.
- Keep model routing cheap-first and escalate only for plausible positive-value opportunities.

## Pilot milestones / acceptance
P0 Audit existing code, branches 22–27, schema, tests, action spine, OAuth/scopes, and data rights; publish gap map.
P1 Read-only scanner with exact and lot searches, dedupe, saved snapshots, source traceability and reliable pagination.
P2 Deterministic valuation and BGS gates with tests for fee/cost math, missing data, duplicates and abstention.
P3 Vision review and recommendation queue, replay of known listings, manual-review flow.
P4 Shadow-mode recurring operation; compare to human decisions and observed sale/grade outcomes.
P5 Approval-gated acquisition lifecycle and listing factory integration.
P6 Learning evaluator with change-control, report card, regression tests and explicit deployment signoff.

Definition of done: one target listing can be discovered, identified, evidence-scored, evaluated with all-in costs, ranked, approved/rejected and traced through outcome, with tests and audit evidence. Design completion is not implementation completion.
