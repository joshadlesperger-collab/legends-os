# Pipeline execution action plan — October 25, 2026

The backlog is not empty. At intake it contained 69 done, 18 blocked, 28 ready and one active engineering task. Ready is not the same as runnable: some tasks depend on missing mappings, unlaunched experiments or external evidence.

## Findings and execution order

| Priority | Finding | Action and completion evidence | Harness task |
|---|---|---|---|
| 1 | A global active task captured every subsequent claim; no worker ownership or exact-target receipt protected completion. | Add owned dispatch/claim/checkpoint, preserve foreign active tasks, reject foreign completion, test across CLI restarts. | pipeline-owned-execution-20261025 |
| 2 | Dispatch labeled unrelated ready work as generic exceptions, hiding actionable work. | Separate actionable tasks from exact dependency, permission, unchanged-input and ownership gates. | pipeline-owned-execution-20261025 |
| 3 | Missing transactions were coerced to zero and could trigger offer/reprice recommendations. | Keep missing counts unknown, expose evidence gap, test null versus observed zero and positive conversion. No pricing-rule changes or live actions. | store-performance-missing-transactions |
| 4 | Several pricing results need independent sales, not more retries of the same evidence. | Keep Stover, Pierotti and Orsolini holds; recover only with changed evidence. Continue independent work. | Existing per-card tasks and evidence |
| 5 | Local preparation is being confused with completed listings. | Retain fresh inventory, shipping and saved/reopened draft gates. No external edits under this mission. | Existing listing review / mapping tasks |
| 6 | Four-model comparison is gated independently of local processing. | Keep paid calls blocked pending reconciled spending, certified exact-model bounds and Claude access; do not claim model rankings from mocks. | live-benchmark |
| 7 | Knowledge import lacks a designated test target. | Keep immutable import packet local; verify test target, schema, access and import authority before execution. | Existing storage/import tasks |

## Execution contract

Read instructions and `dispatch-owned WORKER`. Claim an exact actionable ID with `claim-owned ID WORKER`, verify the receipt, execute, then checkpoint actual results using `done-owned` or `blocked-owned` with the matching claim. Continue independent eligible work. When empty, discover fresh card work through the existing bounded bridge. Neither elapsed time nor a new worker authorizes an unchanged blocked retry.

The harness coordinates execution and retains evidence; it is not a continuously running model agent. The existing scheduled chat executes workers at wakeups. Scheduled runs read AGENTS.md and therefore inherit the owned-claim protocol. No model API calls, automatic eBay writes or production imports are introduced.

## Evidence

Intake: `artifacts/engineering-mission/pipeline-execution-request-20261025.json`.
Owned execution: `pipeline-execution-owned-claim.json`, `pipeline-owned-outcome.json`, `pipeline-owned-completed.json` in the same artifact directory.
Analytics execution: `pipeline-transactions-claim.json`; final validation and outcome recorded alongside it.
Initial sandbox tests failed on temporary-file rename restrictions; preserve that log and use the separate verified test log. Do not relabel the failed run as passing.

## Executed results

- **Done:** ownership and dispatch repair. 13 harness tests passed, including cross-process ownership, exact target receipts, foreign completion rejection and unchanged legacy-active preservation.
- **Done:** missing transaction fix. 23 analytics/doctrine/sprint tests passed. Unknown/invalid transaction counts cannot establish zero conversion; observed zero and independently observed positive conversion retain existing behavior.
- **Partial, evidence-blocked:** executed `store-performance-low-net-economics` through an owned claim. Recomputed 52 listings / 70 units / $77.51 net before unrecorded costs. Retained reported fees and labels per item in `artifacts/engineering-mission/pipeline-economics-audit.json`; unknown costs and contribution remain null. Verified $1,223.22 minus $1,130.51 minus $79.90 leaves $12.81. A transaction-level fees/credits reconciliation and exact per-copy acquisition/fulfillment costs are required; no arbitrary allocation.
- **Validation:** test TypeScript and `npm run build` passed. Logs: `pipeline-execution-types.log`, `pipeline-execution-build.log`; no deployment.
- **Continuation snapshot:** `pipeline-execution-final-dispatch.json` contains 14 actionable tasks and 32 exceptions with exact reasons. The foreign legacy mapping task was preserved. Next ranked task is `store-performance-dale-fulfillment`; local per-store offer-flag and cohort-learning fixes are also independently actionable. Actionable means claimable under recorded dependencies, not a guarantee that external evidence exists.
- **Cost:** zero new paid provider calls and zero external mutations. Historical provider spending remains unreconciled. These are local harness and analytics results, not a live four-model benchmark or new model-speed measurements.
