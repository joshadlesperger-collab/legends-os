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
