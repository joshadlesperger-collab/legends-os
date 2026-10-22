# Card Listing Factory — RCCA and isolated implementation contract
Date: 2026-10-22
Status: Design and audit findings only. Not deployed, not tested against local Windows runtime.

## Confirmed repository findings
- The Listing Factory UI stores imported manifests in browser localStorage; it is not a shared, server-side worker queue and performs no eBay upload.
- Existing legends-scheduler handles store synchronization and seller operations, not a verified scan-to-eBay-draft execution loop.
- Existing closed-loop-learning tunes seller actions based on outcome observations, not model selection.
- The existing workflow documentation requires durable handoffs and draft verification but explicitly does not implement a queue.
- Local Windows checkout, active runner, deployed revision, and actual eBay draft pathway have not been reconciled.

## RCCA verification plan
1. Compare local working tree, branches and HEAD with remote without discarding changes.
2. Trace five real card IDs through scan pairing, identity, pricing, preparation, upload and draft verification; capture timestamps, persisted IDs, errors and last successful stage.
3. Inventory all actual worker triggers and schedules, process lifetime, persistence, locks and retry behavior. Distinguish UI snapshots from authoritative processing records.
4. Reproduce a stalled card and a partial bulk-upload failure in a safe test environment.
5. Classify each failure: unavailable evidence, model capability, validation/rule, transient service, authorization, or orchestration defect. Record causal evidence and corrective action.

## Proposed reusable execution contract (not yet implemented)
- Stable card ID and immutable batch ID; per-stage status queued/running/completed/retryable/review/blocked.
- Durable checkpoint per stage, attempt number, model/provider/config, cost, elapsed time, error code, input/output artifact references and idempotency key.
- Atomic claim/lease with expiry; heartbeat and expired-lease recovery; bounded exponential backoff with jitter for transient errors.
- No repeating identical unsuccessful model calls; resume at last validated checkpoint; independent card execution so one exception cannot stop a batch.
- Upload retries must reconcile existing eBay drafts first; verify each row by draft reference and original photo/identity/price readback.
- No publication without explicit user approval; no production writes or migrations without separate approval.

## Model escalation and learning policy
- Route by task type, card complexity and evidence quality, not universally from cheapest tier.
- Retry transport failures without increasing reasoning; switch models only for diagnosed capability limitations.
- Maximum three model attempts per task by initial policy, with per-card and per-batch spend ceilings configured before use.
- Persist outcomes including independent accuracy checks, completion, total cost (including retries), latency and human correction.
- Promote a model to default for a task class only after adequate verified examples and a measured improvement in cost per correct completion; maintain a rollback and periodic cheaper-model sampling.
- Keep separate task-class performance histories for Legends OS and other future applications.

## Acceptance gates
- Resume after simulated crash without lost or duplicated cards.
- Partial bulk upload replay creates zero duplicate drafts.
- Failure in one card does not block unrelated cards.
- Every card ends in verified draft, actionable review or specific blocked state.
- Demonstrate 100-card pilot with measured throughput, correctness, cost per verified draft and human interventions.

## Next engineering step
Use Codex against the reconciled latest local checkout to implement the durable queue and recovery controller, with tests, before integrating adaptive routing. Preserve current code and require explicit approval before merging or deploying.
