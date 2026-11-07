# Next batch timing controls

Use the original processing click as the end-to-end anchor. Recovery workers retain that batch ID. Completion freezes only when every exact selected pair has a saved receipt and verified photo archive; an observed incomplete endpoint is labeled separately.

Before an actual browser operation, use the existing browser-timing `begin`/`end` lease commands with its exact batch/card scope. Only one coarse external stage may run. Supported explicit handoffs now include `browser-seller-review-wait` and `browser-agent-gap`. Close the current operation before beginning either. Seller wait requires `handoffEvidence: {path, sha256}` referencing retained JSON under artifacts: `{kind:"seller-decision-request", batchId, observedAt, question, cardId?}`. Timestamp must be current and match the real request. End on the actual seller response/cancellation. An agent gap starts only on an explicit contemporaneous pause. Never classify historical silence, a holder exception, or elapsed time retrospectively as seller review.

Read-only export:

```
node --experimental-strip-types scripts/card-processing-v2-timing-report.ts BATCH_UUID
```

The report separates work, service waits, explicit seller waits, explicit agent gaps, and unknown time without overlap inflation. Running/interrupted spans have unknown final duration. Broad orchestration parents do not hide unknown gaps. Shared operations retain their whole observed interval. Retained readback receipts are counted separately from timed attempts; first-pass card success stays unknown without independent actual audit/correction history. The $0.20 identification-cost target is a warning, not authority to spend; unavailable usage stays unknown. No pricing writes or new batch starts are implied.

`evaluateV2TimingRollout` compares complete reports by original wall-clock milliseconds per selected card. A measured normalized regression or retained evidence-backed quality failure requires review of only the implicated engineering change. Incomplete reports cannot establish normalized regression. These comparisons are descriptive; scope/contents, seller decisions and unknown gaps remain confounders. No automatic rollback is performed. Preserve saved drafts, prices, original photos, receipts, and all inventory. Re-run retained quality tests before selectively reverting a source change. New report helpers can remain inert. Do not use a broad Git revert.

Exact pre-initial-edit source snapshots were not retained by this child; provenance under rollback-baseline records this gap honestly. Never present reconstructed source as an original baseline. The snapshot there precedes only addition of comparison triggers. Existing retained55 replay is regression evidence for report truthfulness, not a live speed gain. Next explicitly authorized batch must retain actual boundaries and per-card quality evidence before a speed claim.

## Acquisition metadata and outer-controller coverage - 2026-11-05

Every new internal readback session retains effective acquisitionMode and expandFeatures from the actual request in its durable checkpoints, lock and session trace. The trace importer validates optional mode/boolean metadata and exposes it in persistence results. Historical traces without these fields remain unknown; do not infer their mode or relabel them from later defaults. This adds no browser reads, saved-card inspections or per-step processes.

Required operator boundaries before the next batch: begin the supported outer activity phase at the actual operational entry, bound to the original batch and intended owner/lane. Declare reconciliation/report acquisition, shared UI completion, readback, engineering/recovery and final reporting explicitly before each starts. Checkpoint meaningful actual progress after the tool/native operation settles, then close the phase and record its exact next-owner handoff. Consume the existing next-action after completion. Heartbeats establish presence only, never advance progress or create productive work. A stale phase or unobserved continuation remains a coverage warning.

Use the current supported activity APIs and bounded session wrapper, preserving separate state-writer ownership. An unexpected engineering blocker needs its own actual engineering boundary and evidence; do not wrap the entire controller lifetime as productive processing. Final accounting retains original-click-to-final-archive elapsed, measured operations, waits/failures and controller intervals without finer attribution. Missing telemetry cannot cause a save/upload/identification replay.

The session metadata patch does not enforce all external-controller entry points. Outer report/UI/engineering actions that bypass supported phase boundaries remain an operational enforcement gap. The current mixed run's reported6.6percent coverage and roughly2h14 unknown are not fixed by adding acquisition metadata, and no historical intervals were rewritten. A future fully measured run is required to demonstrate coverage effectiveness; no automatic100percent coverage or speed claim is made here.
