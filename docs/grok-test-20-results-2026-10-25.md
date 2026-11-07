# Grok Test: 20-card pipeline results — October 25, 2026

All 20 physical cards reached saved, reopened and verified eBay drafts: 14 single-card drafts plus three quantity-two drafts, 17 drafts total. All 40 original JPEGs are now in `C:\CardScans\Drafted`, with SHA-256 and byte counts matching the untouched intake manifest. All 40 original source paths are absent after the seller-authorized supported move. No listing was published. Unrelated seller drafts were preserved.

## Measured outcome

The intake manifest started at 14:05:55.722 UTC. Final saved-draft verification completed at 16:14:45.030 UTC: **2h 8m 49s elapsed**, including research, engineering fixes, validation, browser retries and review. The draft phase, from the first durable write intent to final verification, took **1h 21m 55s**. These are observed wall times, not uninterrupted CPU or provider latency.

The 14 single drafts averaged 279.15 seconds from recorded write intent to final verification. The three quantity-two drafts averaged 169.24 seconds per draft, or 84.62 seconds per physical card. Group totals were Egor 216.15s, Ryan 147.64s and Alijah 143.92s. This is descriptive, not a controlled causal speedup: catalog matches, retries, workflow learning and review delays differ. Grouping correctly reduced 20 physical cards to 17 listings; it did not discard duplicate inventory.

Image/case preparation measured **1,944.7602ms cold → 300.6878ms warm**, 84.54% less elapsed time (6.47×), with 40/40 warm cache hits. This measures preparation only. It is not the full pipeline or an LLM benchmark.

## Saved draft register

| Original capture(s) | Card | Draft ID | Quantity | Item / shipping |
|---|---|---|---:|---|
| 1 | Kam Jones #99 | 5435444904812 | 1 | $1.49 / $0 |
| 2 | Hugo Gonzalez #88 | 5435456988412 | 1 | $1.49 / $0 |
| 3, 14 | Egor Demin #68 | 5435657037112 | 2 | $1.49 / $0 |
| 4, 12 | Ryan Kalkbrenner #94 | 5435600572511 | 2 | $1.49 / $0 |
| 5 | Rasheer Fleming #91 | 5435684579113 | 1 | $1.49 / $0 |
| 6 | Nolan Traore #79 | 5433679120310 | 1 | $1.95 / $0 |
| 7, 11 | Alijah Martin #100 | 5435609487511 | 2 | $1.49 / $0 |
| 8 | Adou Thiero #96 | 5435512458112 | 1 | $1.49 / $0 |
| 9 | Chaz Lanier #98 | 5435524278712 | 1 | $1.49 / $0 |
| 10 | Ben Saraf #86 | 5433714042710 | 1 | $1.49 / $0 |
| 13 | Danny Wolf #87 | 5433724939210 | 1 | $1.49 / $0 |
| 15 | Drake Powell #82 | 5435759265313 | 1 | $1.49 / $0 |
| 16 | David Robinson LFL-16 | 5435497483911 | 1 | $1.95 / $1.49 |
| 17 | Ray Allen LFL-1 | 5435777223713 | 1 | $1.95 / $0 |
| 18 | Larry Bird LFL-3 | 5435527932511 | 1 | $2.95 / $1.49 |
| 19 | Kevin Garnett LFL-9 | 5435545292111 | 1 | $1.95 / $1.49 |
| 20 | Isiah Thomas LFL-15 | 5433802351610 | 1 | $1.95 / $1.49 |

Prices retain the existing validated rule and estimate status; saved drafts are the seller's review surface. Research retained 34 sold observations across 17 identities. Unknown comp condition received no inferred premium. The Very Good research filter remains a sampling limitation, not evidence that every sold card had that condition. No pricing rule changed. General and Priority promotion are off in these drafts; the standing 3% General promotion setting remains a separate publication handoff issue. Saved-draft checks do not certify publication readiness.

## Systemic fixes implemented and exercised

1. A stale intake identity note no longer blocks a completed source-bound identity review. Actual source, identity and seller holds still block.
2. Matching-copy creation now records every member's intent atomically, binds all members to one observed draft ID before upload, retains distinct capture SKUs and requires matching identity, price, condition, language and distinct original fronts. Restart/retry resumes the same draft.
3. Group verification checks quantity and each copy's exact front/back slots. No group archive receipt is issued until every member passes photo/identity verification. All three groups completed this live flow.
4. Reopened-field verification caught transient UI selections that did not persist, including Ray's six reverted specifics and Egor's missing SKU. Failures remain in evidence; repairs used the same IDs. Catalog defaults and shipping defaults were corrected against reviewed identity and price, not trusted blindly.
5. Added `archived-source-lineage.json` and a source-reviewed reference packet. Original manifests and embedded-image comparison cases remain unchanged. Later comparisons can resolve each original to its hash-verified archive location without recreating captures.

The dominant remaining time cost is browser preparation/review and its save/reopen handoffs, not subsecond warm preprocessing. Native text entry followed by a saved reopen proved more reliable than optimistic field-fill success. Future optimization should measure stage boundaries and retry counts, reuse matching identity/pricing evidence, and reduce redundant UI transitions while retaining the verification boundary.

## Validation and evidence

- Card orchestrator suite: **154 passed, 0 failed**; sandbox-only rename failure retained separately; supported outside-sandbox rerun passed.
- Required **`npm run build` passed**, including Prisma generation, Next compilation and type checks. No process termination or deployment.
- Provider adapter/mock suite: **36 passed, 0 failed**. Mock outputs are not live model results.
- Live saved checks: **20/20 cards passed**; final Seller Hub inventory contains all 17 Grok draft rows, quantities totaling 20.
- Final archive audit: **40/40 hashes, 40/40 original byte counts, 40/40 source removals verified**.
- Branch remains `feature/card-listing-factory-v1`; existing uncommitted work retained; no commit/push.

Evidence root: `artifacts/model-benchmark/grok-test-20-20261025/`. Key files: `final-batch-audit.json`, `final-drafts-inventory.txt`, `archived-source-lineage.json`, `reviewed-ground-truth-and-pricing.json`, `quantity-group-tests.log`, `quantity-group-build.log`, per-draft captures/expectations/checks/screenshots and archive receipts. `audit-final.mjs` performs a read-only content audit and writes additive report artifacts. The reviewed reference is source-reviewed by this session, not independently adjudicated model ground truth.

## Four-model result and exact remaining blockers

**No live four-model comparison was run. Incremental paid provider generation spending for this batch is $0; prior cumulative spending remains unknown.** Model metadata visibility is not inference success, available credits or certified billing. No model can honestly be ranked fastest or most accurate from these results, including Grok. Last night's Grok prices must retain their source/time/identity provenance and be checked against the same sold evidence before entering an accuracy comparison.

The prepared 20-card recognition comparison plans 80 calls (20 × 4); a full separate pricing comparison adds 80. Before any paid call, the harness still needs: (1) reconciled prior spending across all four providers and the preserved durable ledger; (2) certified exact-model bounds covering actual prompts, schemas, image tokens, reasoning/output, retries and pricing tiers; (3) verified credentials/model availability for those exact IDs; and (4) whole balanced-plan affordability under the existing $1 initial/$1 retest allocation, $2 session maximum and $5 cumulative ceiling, with $3 reserve unavailable. The later general request to stop constraining the test did not establish a new numeric spending ceiling or reconcile prior spend. No ledger reset or alternate spending script was used.

Candidate models are not winners. Until an equal-input trial is possible, use deterministic code for pairing, hashes, caching, arithmetic, budgets and policy validation; use source-grounded review for identity exceptions and sold-comparison admissibility. Score recognition exact identity/variant/serial correctness and appropriate abstention; score pricing against retained comps and rule calculations; report per-provider cost, latency and failure rate. Reuse the same image bytes and evidence packet for every provider. Do not select a model from a single success or cached answer.

Knowledge artifacts are retained locally; no database import is claimed. A designated supported non-production database, schema/access verification and import authorization remain required for database execution. The live draft milestone is complete independently of these comparison/database blockers.

### 2026-10-25T16:21Z — Independent store evidence isolation fixed
After the20-card milestone, continued local backlog. Dale fulfillment evidence reviewed: actual packed weight/dimensions and supported destination-specific label/coverage quote absent; buyer shipping policy is not postage cost. Exact blocker retained in dale-fulfillment-checkpoint.md. Fixed cross-store offer evidence in lib/sales-velocity.ts using lib/store-offer-evidence.ts: successful sellerA no longer makes failed/disconnected sellerB falsely ineligible; successful empty results remain false with their own timestamp. Marketing success now scoped to store as well. Added regressions to normal test command;22 relevant tests pass and npm run build passed (store-offer-tests-integrated.log/store-offer-build.log). No external offer/ad writes, deployment or database runtime claim. Final card dispatch confirms all20 draft-complete-awaiting-publication-handoff; no remaining draft-preparation action. Broader engineering backlog remains in durable queue; no claim of continuous execution between runs.
