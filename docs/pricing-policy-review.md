# Isolated pricing-policy candidate

Prepared October 23, 2026 at the seller's request. This checkout contains a copy of the active workspace's source as a baseline, including its pre-existing uncommitted changes. Those baseline changes are not part of this pricing fix. No environment files or credentials were copied.

New implementation: `lib/card-pricing-candidate.ts`, `scripts/compare-pricing-policy.ts`, and `tests/card-pricing-candidate.test.ts`. The comparison remains read-only. The isolated Listing Factory now projects this policy into its existing review and draft-export routes. No queue evidence mutation, migration, eBay call, or automatic repricing occurs.

## Policy resolution

GitHub main `docs/PRICING_POLICY.md` (blob b3c732c2c3abc701f7d8de6475eb700d7c7b56e9) records buyer-total valuation, no automatic buffer, tiered item rounding, and a $1.49 item floor. Local October 22 notes introduce condition normalization but also repeat the superseded 9% formula. The seller requested this isolated fix after the conflict was reported, then said “Use the latest rules.” This candidate uses the no-buffer buyer-total policy and retains the newer condition adjustments. The active policy is not changed by preparing this comparison.

- Target buyer total minus explicitly supplied seller shipping produces unrounded item price.
- At/below $3, choose nearest .49/.95, ties downward; above $3, round upward. Enforce $1.49 minimum, retaining an economics flag when the floor exceeds evidence.
- Retain validated exact/related identity, date, independent-copy and serial safeguards. Missing source shipping blocks calculation; never substitute zero.
- Retain Excellent +10% / Very good +25% to NM and supported one-time 15% special adjustments. These affect source item value, not postage. For related estimates, apply print-run ratio to adjusted source buyer total.
- Preserve the arithmetic mean as a controlled scenario estimator. The policy does not mandate a new median estimator. Active-market checks, shipping-heavy outliers, thin evidence and market judgment remain review work.

## Comparison boundaries

Report uses immutable copies of queue and review JSON, records their SHA-256 hashes, and asserts they are unchanged after calculation. The saved old projection is shown verbatim. Historical seller shipping is held constant to isolate formula effects; it is not fresh eligibility confirmation. No candidate inherits approval. Manual-price events conservatively suppress recalculation. Existing receipts, holds, and next-owner blockers appear alongside each result.

Preflight uses the existing orchestrator projection on a cloned snapshot. The live CLI is intentionally not invoked because it syncs and writes queue state. This is a snapshot handoff, not a fresh eBay inventory check. Reports are not listing upload files.

Run `node --experimental-strip-types scripts/compare-pricing-policy.ts` from this isolated checkout; inputs and outputs are fixed under `artifacts/pricing-policy-review`. Run focused tests with `node --experimental-strip-types --test tests/card-pricing-candidate.test.ts`. Build validation remains `npm run build`.

Approval/export are now bound to the current policy, source evidence, identity, original photo pair and amounts in this isolated checkout. Shipping choices and market corroboration still require review. Old projection history remains intact. Draft offer thresholds are clamped to the $1.49 floor; promotion settings remain unchanged. No commit, push, deployment, migration or eBay change is authorized by this preparation.

## Explicit seller confirmation — October 23, 2026
The seller explicitly confirmed: buyer-total pricing with no automatic buffer supersedes the repeated local 9% formula; retain the newer condition adjustments. This confirms the policy used in the prepared comparison. It does not activate the candidate, change saved approvals, or authorize eBay writes.


## Isolated application integration

The seller subsequently authorized integration and flow tests in this checkout only. `loadCardBacklog` now derives the current proposal from retained validated queue evidence. The old prices remain in the historical prices array; historical calculated approvals never transfer. Unmatched, invalid or shipping-incomplete evidence cannot supply a new approvable proposal. Manual overrides remain separate and must meet the item floor to be actionable; older sub-floor review records remain readable history.

Approval stores the existing review event with a fingerprint that now includes current policy, evidence key and expiration. Reloaded approvals must still match the same identity, original pair, price and evidence. Changed evidence invalidates approval even when the rounded amount is unchanged. Unrelated listing preparation does not invalidate approval: the evidence date is the newest retained sale date, not the card's general modification time. Earliest sale expiry limits eligibility.

Batch packets require a matching current approval. Bulk CSV generation requires current policy/evidence metadata, valid image references and the item floor. Existing draft receipts remain excluded from new rows. Both review screens show evidence caveats. CSVs remain Draft-only and carry no publication authority. The old queue calculator is retained for historical evidence/compatibility; Listing Factory projects the new policy before approval/export instead of rewriting queue results.

Validation exercises the actual backlog loader, saved review events, reload, batch packet and bulk Draft CSV using temporary synthetic card fixtures and mocked hosted-image metadata. The orchestrator CLI test also covers preflight, preparation, review export, holds, changed evidence and manual overrides in a temporary fixture directory. No live browser upload, eBay save, or publication was attempted. Current shipping amounts are retained for review; packaging and shipping-policy verification remain required before a real upload.

Reproduce focused checks with `npm run test:pricing-flow`; new tests are also included in `npm test`. The active workspace, saved batch and original evidence files were not modified.

Final validation: 172 relevant tests passed (53 pricing/approval/export, 119 backlog/orchestrator), application and test TypeScript checks passed, and npm run build passed. Retained queue and review snapshot SHA-256 hashes are unchanged. No deployment, commit, push, active-batch mutation or eBay write.


## Active source integration — October 23, 2026
The reviewed patch is merged into the active checkout using its saved baseline, preserving subsequent bulk, receipt, archive, workflow, and knowledge features. New orchestrator calculations now use the current buyer-total policy as well as the Listing Factory projection. The historical item-only comp mean remains audit evidence; buyerTotalMean is separate. Unknown comp shipping blocks new calculation. Original queue evidence and approval history are not rewritten by integration. Running production builds require separate activation; source integration alone does not update an already-running Next server.

Final active-source validation: 445 repository tests passed; test TypeScript passed; final separate Next production build and application type checks passed in .next-pricing-validated. Required npm run build was attempted and blocked at Prisma generation by the existing DLL lock. The running app remains on its prior build pending explicit activation approval. No eBay writes, publication, commits or pushes performed.
