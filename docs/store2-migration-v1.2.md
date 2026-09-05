# Store #2 migration v1.2

This is the governed execution path for finishing Store #2 → Store #1 consolidation after the overlength-aspect verification work.

## What changed

- `Features` and `League` may be serialized as multiple eBay `<Value>` elements only when the original provider value is comma-delimited and every logical value is 65 characters or fewer.
- All other overlength fields remain fail-closed, including identity-sensitive fields such as `Player/Athlete` and `Team`.
- Only source IDs `358541944249` and `358541944298` were removed from the governed exclusion set because the existing `verify-store2-multivalue-aspects.ts` proof explicitly exercised those records. Other governed exclusions remain in place.
- The v1.2 runner no longer applies the old pilot composition caps of four graded listings and six multi-quantity listings. The 250-listing batch ceiling remains.
- Duplicate title/SKU checks, source seller/title/price/quantity checks, category and condition mapping, image completeness, fresh execution-time destination checks, provider verification, mandatory SKU recovery, post-create reconciliation, authentication aborts, quota aborts, idempotency keys, and source-store non-mutation remain intact.

## Preflight only

No destination listing is created without the explicit execute flag.

```powershell
$env:STORE2_MIGRATION_CSV_PATH="C:\path\to\current-active-store2.csv"
node --experimental-strip-types scripts/run-store2-migration-batch-v2.ts --compact-preflight
```

Review `selected` and `manualReviewExclusions`. A zero-candidate result fails closed.

## Provider verification without creating listings

```powershell
node --experimental-strip-types scripts/run-store2-migration-batch-v2.ts --compact-preflight --verify-first-two
```

This runs `VerifyAddFixedPriceItem` on the first two selected candidates and performs no listing creation.

## Governed execution

Use only after the preflight/verification output is acceptable and the existing Store #2 migration approval remains in force.

```powershell
node --experimental-strip-types scripts/run-store2-migration-batch-v2.ts --compact-preflight --execute-approved-250
```

Execution takes a fresh destination snapshot, re-reads the source item, rechecks title/price/quantity and duplicate state, verifies the exact payload with eBay, writes the existing audit records, creates the destination listing once with mandatory SKU recovery, reconciles provider state, and records `verified` only after material fields match. Store #2 is not mutated.

## Stop conditions

The runner stops or fails closed on hard authentication failure, eBay quota failure, source-state change, duplicate destination state, unsupported condition/category, incomplete/distinct image failure, unsafe overlength aspects, provider reconciliation differences, or zero eligible candidates.

Do not use the legacy `run-store2-migration-batch.ts` for the v1.2 overlength-unlock cohort.
