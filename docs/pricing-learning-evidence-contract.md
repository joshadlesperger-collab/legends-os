# Pricing learning evidence contract

Seller requirement, October 25, 2026: preserve findings in the knowledge system, test the seller's pricing hypotheses and proactively return suggestions supported by data and mathematics. Suggestions do not authorize changes to approved rules or live listings.

## Verified readiness

Local source observations, original identities, sold-comparison evidence, uncertainty and review results exist. Import packages and supported import functions exist. Database import/readback is not verified; local staging must never be described as completed database ingestion.

`lib/closed-loop-learning.ts` groups outcome observations by action and uses ten observations plus raw sale-rate thresholds to assign FAVOR/SLOW DOWN. It does not establish matched cohorts, independent observations, controls, complete economics or uncertainty intervals. Its adaptive policy is not proof of causal pricing benefit. Repair is tracked by `store-performance-cohort-learning`; this audit does not modify that policy.

## Required learning cycle

1. Register each seller hypothesis verbatim with source/date. Define eligible cards, proposed treatment, unchanged controls, primary metric, minimum worthwhile effect, allocation and observation window before testing. Do not invent seller hypotheses from general instructions.
2. Retain source ID/hash, observed and effective timestamps, original evidence, exact card/copy identity, currency, condition, item/shipping amounts, provenance and uncertainty. Separate observed sales, asking prices, estimates and seller policy. Deduplicate sale IDs and physical captures; snapshots are not independent sales.
3. Link observations to hypothesis, treatment, actual intervention receipt and outcome window. Store corrections as history. Verify idempotent import and readback on the designated test database before claiming durable database integration.
4. Compare appropriate cohorts: release, product, variant, condition, grade, sales channel and time period. Preserve inventory availability, exposure, promotion, shipping and offer changes as confounders. Do not train a market premium on prior estimated prices or seller markups.
5. Evaluate both sell-through and economics. Per-sale contribution = item revenue + buyer-paid shipping - platform/payment/ad fees - actual postage - packaging - acquisition cost - attributable returns/refunds. Avoid double-counting export costs. Unknown inputs remain unknown. Compare contribution per available listing-day and comparable exposure, not just sale-rate or revenue. Separate account overhead allocation from incremental contribution.
6. Predefine sample size from baseline variance/rate and minimum worthwhile effect; ten observations is not a universal sufficiency rule. Report uncertainty intervals with dependence-aware grouping, control/treatment balance, elapsed window and missingness. Repeated checking requires a predefined sequential rule; low power means inconclusive. Observational comparisons can motivate a test but cannot establish causal lift.
7. Return an advisory packet when the declared evidence gate is met: exact affected cohort/cards, current and proposed buyer total, independent sale count and dates, exclusions, estimated contribution change, uncertainty, costs, hypothesis result, assumptions and next test. Label it descriptive, experimental, inconclusive or validated for the studied scope. Keep current approved rules unless the seller authorizes a change.

## Current blockers and continuation

- Database: designated non-production target, supported access, schema verification and authorized import/readback are outstanding. Preserve local immutable packets meanwhile.
- Economics: per-copy costs and transaction-level fee reconciliation are incomplete; the retained low-net cohort cannot yet support a verified contribution ranking.
- Learning: repair cohort matching and uncontrolled sale-rate adaptation; existing task remains open. No demonstrated learning-driven price improvement is claimed.
- Experiments: retained title/photo matched pairs have not launched and are not pricing experiments. Register explicit pricing hypotheses and eligible test designs before applying treatments.
- Notification: the existing continuation workflow should check these gates and surface a recommendation packet when evidence becomes sufficient, or a material blocker changes. This document is a standing requirement, not proof that a database-backed evaluator/notification worker already exists.
