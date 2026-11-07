# Five-card harness report — October 25, 2026

Status: preparation and mocked validation complete; live comparison NOT executed. This is a prerequisite report, not a model leaderboard. The requested full comparison remains unfinished.

## Input evidence

Five original pairs Card0001–Card0005, suffix115941, in C:\CardScans. Ten distinct SHA256 hashes; zero matches against photo hashes in the current orchestrator queue. Originals remain in place. Manifest and identical image payloads are retained in artifacts/model-benchmark/cactus-five-20261025. B files visually contain fronts; F files contain matching backs.

| Capture | Visible name | Back card number |
|---|---|---|
| 0001 | Josh Giddey | 12 |
| 0002 | Trey Murphy III | 58 |
| 0003 | Shai Gilgeous-Alexander | 35 |
| 0004 | Adou Thiero | 96 |
| 0005 | Trae Young | 19 |

All show Topps Chrome/Cactus Jack branding. Exact parallel names and product-year reference labels remain to be independently checked. The first two show a different foil pattern from the last three. These are assistant visual observations, not results from any of the four tested provider APIs, and not independently certified ground truth. Reference observations are not included in blind recognition inputs.

## Actual execution and validation

- Supported harness dry-run accepted five recognition cases and four providers: 20 planned recognition calls. No network generation.
- npm run test:models: 36 passed, zero failed. These are mocked/regression tests, not live five-card answers or provider latency measurements.
- npm run build: initial sandbox attempt failed with mkdir EPERM; outside-sandbox retry passed. Both logs preserved.
- All four provider keys reported configured, without printing values. This does not establish live model access or quota.
- New paid calls: 0. Incremental provider spend: $0. Prior cumulative authorized spending: unknown. No ledger created or reset.
- No eBay listing edits, drafts, publication, photo moves, deployments, commits or pushes.

## Inventory history

Fresh active report contains 6,952 listings. Extended reports requested through Seller Hub: Last Year (2025), ref12355257868, 3,364 item-number rows; This Year (2026 YTD), ref11343886236, 4,392 item-number rows. These are rows, not unique orders or confirmed paid sales. Files and hashes are retained in reports/inventory-snapshots/2026-10-25-five-card-test. Preserve the separate 90-day export; do not add overlapping windows together. No all-time coverage claim.

Title screening for Cactus plus these five player names found one active candidate: Trey Murphy III #58 Aqua Shimmer /199, item128127665799, quantity1. This is NOT a verified physical variant match and does not authorize a quantity increment. No matching title candidates occurred in the two year exports. Title screening can miss abbreviated or incorrect historical titles; zero candidates is not proof of no historical sale. Buyer/contact fields stay out of model inputs.

## Blockers and implementation gaps

1. Prior spending under the shared authorization remains unreconciled; the fixed spending ledger is absent. Missing ledger is not zero prior spending. User was asked for the amount or billing-export location. No positive remaining budget can yet be certified.
2. No certified exact-model request billing bounds are available for this batch. Existing configured models are gpt-6.1-sol, claude-sonnet-4-5, grok-4 and gemini-2.5-flash. Prior prerequisite evidence reports Claude model-access failures and an ambiguous xAI alias. These historical observations are not fresh access checks. Resolve and pin benchmark-only models before paid execution.
3. Current harness accepts recognition and pricing only. My earlier promised 60-call, three-stage plan overstated implemented support: listing-content generation/scoring is not implemented in this harness. Adding that stage is remaining engineering work, not an external-input blocker.
4. Pricing cases still need independently reviewed identity/parallel labels and a common verified sold-evidence packet with known shipping and correct exclusions. The current five-case packet is recognition-only; no fabricated baseline or stand-in hold test is being passed off as pricing accuracy.

## Recommendations and exact resumption

First reconcile existing spend and exact model access/bounds, then certify the entire selected batch against initial/retest allocations. Never bypass the fixed ledger. Implement and test the missing listing-content stage before describing a three-stage benchmark as ready. Keep one immutable case roster and hash identical images/evidence/prompts per stage. Separate evidence-retrieval time, provider time, validation time and human corrections. Score independently verified facts, not agreement with an unverified assistant answer. Record missing evidence as unscored rather than incorrect or successful. Preserve failed calls and their reservations; continue independent cases only when budget remains provably safe. Do not recommend a winning model from these dry runs.

Resume the owned engineering task cactus-five-harness-20261025 with changed evidence using supported queue recovery. Paid execution is blocked; unpaid listing-stage implementation and evidence curation remain unfinished. Broader automation stays paused. Full comparative report must replace this incomplete status only after actual provider outputs are retained and scored.
