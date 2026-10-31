# Legends OS Continuous Improvement Pilot — 2026-10-31

Status: EXPERIMENT PLAN ONLY. No production deployment, listing write, or change to active runs is authorized by this document.

## Objective
Reduce elapsed time, cost, and manual corrections per VERIFIED eBay draft while preserving pricing evidence, image identity, and recovery safety. Keep the currently working bulk-photo-upload route. Do not replace it with single-card browser entry.

## Baseline first
Reconcile deployed revision, Windows runner, eBay draft IDs, card/photo manifests, queue and database. Capture a minimum of 30 representative cards per flow before comparing. Record card_id, SKU, serial, batch_id, model, stage, start/end timestamps, retries, research calls, token/API cost, pricing evidence references, draft ID, verified readback, field corrections, and blocker. Unknown metrics remain unknown.

## Controlled experiments
A. Existing browser flow vs supported bulk upload/API draft flow, same representative mix. Only run write experiments in an authorized environment after verifying seller, policy IDs, idempotency, and draft-only permission.
B. Cached sold comps + deterministic pricing vs existing research path. Keep source, sold date, print run, condition, shipping, confidence and policy version. Do not overwrite historical evidence.
C. Grok-only pricing benchmark on 20–30 representative cards, independently reviewing evidence quality, latency, cost, policy adherence, and valuation error. OpenAI must not produce competing card valuations.

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

## Binding model responsibilities — user decision 2026-10-31
- Grok is the EXCLUSIVE card pricing agent. Only Grok may research pricing comps, reason about market value, calculate proposed price, and revise valuations.
- OpenAI handles card identification, listing content, bulk draft preparation, eBay draft execution, and readback verification. It must copy Grok's approved price without independently repricing, adjusting, or suggesting an alternate value.
- Orchestrator routes identified card records to Grok, enforces schema and policy gates, retries Grok on failures, and routes unresolved cases to a pricing hold while independent cards proceed. Schema checks and numeric invariant checks are allowed; valuation judgments are Grok-only.
- Persist Grok price, item/shipping/buyer total, confidence, source evidence, model/version, policy version and timestamp as immutable handoff fields. Never use a fallback OpenAI pricing model.
- Do not publish. Do not modify active drafts. This document is a specification; runtime routing remains unverified until implemented and tested.

## Superseding workflow decision — 2026-10-31: price AFTER eBay draft creation
This section supersedes any prior stage ordering in this pilot document. The orchestrator must prioritize identifying cards, preparing listings, and creating VERIFIED unpublished eBay drafts BEFORE Grok pricing. OpenAI handles identification, draft fields, photos, and eBay draft creation, but NEVER estimates or calculates market price. If eBay requires a price at draft creation, use only a technically permitted non-market placeholder that is explicitly flagged PROVISIONAL, is compliant with eBay and the $1.49 minimum, and is never exposed as approved market pricing. If a safe placeholder is not supported, hold that draft creation with a specific blocker rather than asking OpenAI to price.

On verified draft creation, persist draft ID, SKU, serial, photos, seller account, and initial readback; then queue Grok to research sold comps and return price, confidence, sources, policy version, and timestamp. Orchestrator applies Grok's authorized result to the matching draft and verifies the eBay price readback. Grok is the sole valuation authority; OpenAI may perform mechanical field validation but cannot revise Grok's price. Keep provisional/unpriced drafts strictly NOT READY TO PUBLISH. The user alone publishes after pricing and final verification. Continue processing independent drafts while Grok works; do not edit drafts the user is publishing. Reconcile retries by stable SKU/serial/draft ID to prevent duplicates. No runtime change or deployment is implied by this documentation.

## Superseding description decision — 2026-10-31
Use eBay's native AI description generator as the preferred description author, not OpenAI. OpenAI remains responsible for identifying the card, preparing structured title/item specifics, associating original photos, and creating the unpublished draft; it must not author a competing description in the normal path. Invoke eBay AI only when supported by the actual authorized draft workflow. Do not claim that eBay's AI description feature is available via an API without verifying it. If unavailable, preserve a minimal factual description or hold description completion as a distinct exception; never fabricate an AI-generated description. Validate eBay-generated text against the source card record for player, year, set, parallel, serial, autograph, grade, and condition; remove or flag unsupported claims without silently changing card identity. Record description provenance, generation time, correction count, and draft readback. Keep Grok pricing AFTER verified draft creation. Do not publish or modify drafts the user is publishing. Experiment against existing description path before promoting runtime defaults; this documentation alone is not a deployment.
