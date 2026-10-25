# Harness reliability remediation — phases 1–3

Status: integration candidate only. Not deployed; no eBay writes authorized. This branch is based on feature/card-listing-factory-v1, not main.

## Phase 1 — branch and policy audit (verified 2026-10-24)

GitHub compare against main:
| Branch | Ahead | Behind | Implication |
|---|---:|---:|---|
| feature/card-listing-factory-v1 | 11 | 13 | Diverged; requires deliberate reconciliation |
| feature/knowledge-graph-evidence-reuse-26 | 1 | 0 | Sold observation domain and test isolated |
| feature/chief-performance-agent | 4 | 0 | Performance agent isolated |
| closed-loop-autonomy-v1 | 16 | 17 | Diverged; scheduler/learning overlap |
| legends-scheduler-v1 | 13 | 18 | Diverged; scheduler overlap |
| fix/durable-pipeline-recovery-20261022 | 2 | 0 | Sales velocity fix isolated |

**Critical policy mismatch:** lib/card-orchestrator-policy.ts on the factory branch has premiumPercent:9 and minimum premium 8–10%, inconsistent with the owner's removed-premium rule. DO NOT automatically use this branch's price calculation to publish. The policy also needs a verified comparison against the latest minimum item price, shipping, rounding, comp precedence, scarcity, and offer rules. Add regression tests before replacing the implementation.

**Important limitation:** local orchestrator docs explicitly say local-preparation-only, separate Process Card Inbox writer not migrated, no global browser lock, and no automatic eBay publishing. Its runner does not perform unattended visual research. Never count local review listings as eBay drafts.

**Integration order:** first establish a single authoritative policy and state/receipt protocol, then integrate the knowledge graph and chief performance agent, then reconcile the two scheduler branches. Avoid wholesale merges of diverged branches. Require clean working tree, typecheck, tests, and human sign-off before any deployment.

## Phase 2 — unified orchestration contract (implementation target)

1. Every physical card gets stable card_id + source photo SHA-256 hashes + SKU; all workers use the same shared state store and policy_version.
2. Stages: scan -> pair -> identify -> reconcile -> research -> price -> prepare -> external draft verification. Stage outputs must include input fingerprint, evidence provenance, timestamps, confidence, and status.
3. Only one lease holder may write a stage result; stale completions rejected by token and input generation. External eBay Add requires a separate single-writer lease, current inventory reconciliation, approved price, and idempotency receipt. Unknown external outcomes always reconcile; never blindly retry.
4. Explicit terminal states: completed, blocked-needs-human, blocked-needs-evidence, failed-retryable, failed-permanent. No silent dropped cards.
5. Change control: policy updates require version bump + deterministic regression tests + approval for high-impact price changes. Chat decisions become tracked issues until code, tests, and operational validation confirm completion.
6. The current code has portions of this contract, but independent writers and browser concurrency remain unintegrated. Do not claim unified orchestration is installed until those adapters are tested end-to-end.

## Phase 3 — durable unattended execution (implementation target)

A reliable run requires an external persistent process/service; a ChatGPT session is not that process. Use a supervised worker or scheduled service, durable state on disk/DB, heartbeat, crash recovery, budget caps, and end-to-end receipts. The existing CLI already supports limited durable queue state, lease expiry, and retries. Add a supervisor and measure actual runtime recovery, not just CLI invocation.

Acceptance tests:
- Kill worker mid-card; restart; expired lease returns to queue without duplicate work.
- Crash after external submission with unknown outcome; reconcile receipt; never duplicate Add.
- Two workers claim same card; exactly one succeeds.
- Price policy version changes; stale proposals are held and recomputed.
- Research provider unavailable; card held, next eligible card progresses.
- Run overnight; report attempted, completed, blocked, actual eBay drafts, elapsed time, model spend, and evidence reuse.
- Reboot host; service restarts and resumes within the defined recovery window.

## Immediate next actions

1. Reconcile latest pricing policy with user decisions, implement tests, and retire the 9% premium path.
2. Build cross-writer lease/receipt adapter; retire independent eBay writers only after migration tests.
3. Implement and test supervisor on the actual Windows host; ensure machine remains awake and local drive persists.
4. Integrate selected branches in small PRs, run npm run validate and npm run test:integration, inspect eBay dry-run, and request sign-off before deployment.

This audit is based on GitHub contents and branch comparisons; it does not establish local machine runtime, test pass, model connectivity, or eBay account state.
