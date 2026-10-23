# Decisions — 2026-10-22

- Josh approved implementation of the scarcity pricing sanity check after reviewing the Dick Vitale /25 $3 versus /99 $5 example. Related estimates use sold buyer totals and source-run/target-run arithmetic. Strong exact evidence can outweigh the heuristic; unsupported reductions preserve the existing price and become per-card review exceptions. See docs/card-scarcity-guard.md.
- Implementation uses a 25% reduction threshold for the recommended large-reduction review check and five independent validated exact sales for strong exact evidence. These are implementation choices, not assertions of guaranteed market value.
- Josh proposed a reusable master sold-evidence database and explicitly required date of sale. Store sale date separately from collection and verification timestamps. The proposed database is not yet built. See docs/card-sales-evidence-plan.md.
- Standing user authorization in project context permits validated commits/pushes. Production deployment, migrations and new eBay mutations retain their separate approval requirements.

- Josh requested a higher comp bar and lowest-print-run-first math anchors. Aim for five exact sales; five are required for strong-evidence overrides. Three related observations are required for math, consuming lowest-print-run groups first and excluding higher runs once sufficient. Thin evidence remains review-required.
