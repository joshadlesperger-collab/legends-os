# Legends OS Continuous Improvement Pilot — 2026-10-31

Status: EXPERIMENT PLAN ONLY. No production deployment, listing write, or change to active runs is authorized by this document.

## Objective
Reduce elapsed time, cost, and manual corrections per VERIFIED eBay draft while preserving pricing evidence, image identity, and recovery safety. Keep the currently working bulk-photo-upload route. Do not replace it with single-card browser entry.

## Baseline first
Reconcile deployed revision, Windows runner, eBay draft IDs, card/photo manifests, queue and database. Capture a minimum of 30 representative cards per flow before comparing. Record card_id, SKU, serial, batch_id, model, stage, start/end timestamps, retries, research calls, token/API cost, pricing evidence references, draft ID, verified readback, field corrections, and blocker. Unknown metrics remain unknown.

## Controlled experiments
A. Existing browser flow vs supported bulk upload/API draft flow, same representative mix. Only run write experiments in an authorized environment after verifying seller, policy IDs, idempotency, and draft-only permission.
B. Cached sold comps + deterministic pricing vs existing research path. Keep source, sold date, print run, condition, shipping, confidence and policy version. Do not overwrite historical evidence.
C. Grok vs GPT-6 on 20–30 identical hard pricing cases with identical permitted evidence access, independent reference adjudication, latency, total cost, and price error. No model promoted on subjective preference alone.

## Pricing guardrails
Use docs/PRICING_POLICY.md as the current documented reconciliation baseline; review more recent approved decisions before implementation. Never restore old 9–10% premium. Preserve $1.49 minimum, buyer-total comparisons, 90-day exact sold priority, serial-number analogs, confidence and approved rounding. Weak-evidence review handling must be reconciled with the latest user decisions; do not silently publish or automatically reprice live listings.

## Quality and recovery
Before submission and after eBay readback verify identity, serial, original photos, title, item price, shipping, SKU, and seller account. Reconcile by SKU/serial and persisted draft IDs before retrying. Never touch drafts the user is publishing. Isolate a bad card; stop the affected operation on systemic photo/identity/duplicate errors and preserve receipts. Upload acknowledgment alone is not a verified draft.

## Promotion gates
1. No identity/photo mismatches or duplicate drafts in the pilot.
2. No publication without explicit approval.
3. At least 95% successful verified readbacks, and no degradation in accuracy or policy compliance relative to baseline.
4. Prefer at least 20% reduction in median verified-draft elapsed time or cost, with p90 and correction rates reported.
5. Repeat on a second batch before promoting default routing; keep rollback flag and preserve prior scripts/state.
Thresholds are proposed pilot criteria, not proven outcomes.

## Continuous improvement controller
Daily summarize queue throughput, p50/p90 time, cost/card, exceptions, top three bottlenecks and root-cause hypotheses. Propose one bounded experiment at a time; execute only within approved draft-only scope and cost limits. Record baseline, change, outcome, confidence, rollback decision and source links in an append-only experiment log. No autonomous production promotion without validation and established authorization.

## Immediate next actions
1. Audit runtime versus repository and identify existing bulk upload adapter and queue producer.
2. Instrument current path without disrupting active batches.
3. Reconcile latest pricing decisions with current code and policy.
4. Run shadow pricing benchmark without eBay writes.
5. Pilot batch adapter on a small controlled set, verify actual drafts, then compare and recommend promotion.
