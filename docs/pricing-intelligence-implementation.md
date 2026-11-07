# Pricing Intelligence — implementation status
Initial non-destructive foundation for 2025 Topps Chrome Basketball. Product identity is **unverified** until matched against an authoritative manufacturer checklist. Do not mix printed 2025 with 2024–25 or 2025–26.

## Implemented
- Pure pricing estimator with verified-exact and inferred-parallel methods, explicit evidence IDs, confidence and review gate.
- No writes to eBay, no approval mutation, and no fabricated product checklist or premium table.

## Remaining work
1. Verify manufacturer product identity, checklist, parallel matrix and source revision.
2. Add PostgreSQL/Prisma persistence for product, subset, player, variant, sale, source, snapshot and review entities; immutable sale observations and deduplication.
3. Build authenticated import/research workflow and sale identity checks.
4. Add player demand snapshots from permitted sold-volume sources, with coverage and observation dates.
5. Connect estimator to orchestrator behind review gates, and backtest a 100-card holdout before any automated use.

Pricing evidence must be checked against same card, parallel, grade/condition and sale date. Inferred valuations are **never** verified comps. Scarcity alone does not guarantee a price premium. Release age is a covariate, not a universal discount.

## Player-demand layer (implemented pure computation)
`lib/player-demand-intelligence.ts` calculates observed verified sales counts in 7/30/90-day windows, 30-day gross landed sales, prior-period volume growth, and an explicitly labeled active-listing sell-through proxy. Missing active listing coverage yields null, not zero. Demand signals do not override verified comps or automatically multiply price. Source coverage is essential: partial imports must never be called global player rank.

## Relational knowledge graph schema target
ProductRelease -> ChecklistCard -> Player; ProductRelease -> Parallel; SaleObservation -> ChecklistCard + Parallel; Player -> DemandSnapshot; PricingDecision -> evidence IDs. Use Prisma/PostgreSQL before adding a separate graph service. Retain source URL, verification timestamp, sale date, price plus shipping, condition, serial denominator, and source transaction ID for deduplication. Null print run is unknown, not unlimited.

## Research and rollout safeguards
Verify 2025 Topps Chrome Basketball checklist against manufacturer documents before importing any parallels or print runs. Distinguish insert, variation, autograph and base parallels. Evaluate eBay Product Research and any Market Movers/Card Ladder licensing before automated imports. For sparse exact comps, prefer observed same-release and condition matched-player parallel ratios, and nearby numbered tiers. If insufficient, send to review rather than stalling. Validate 100-card holdout accuracy and coverage before enabling listing writes.

## Still not implemented
Persistent Prisma tables and migration, ingest connectors, manufacturer-verified checklist, integration with listing orchestrator, automated tests and deployment.
