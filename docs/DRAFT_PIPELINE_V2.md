# Draft Pipeline V2 — controlled specification
Status: proposal / no production activation. Baseline main 87afbca (2026-11-01).

## Outcome
Convert existing paired card photos into complete, verified, unpublished eBay records with minimal paid browser interaction. Preserve the previously successful bulk upload route until its artifacts and Seller Hub Drafts behavior are verified. Do not assume an unpublished Inventory API offer is a Seller Hub Draft.

## Stage contract
1. Reconcile existing card/photo pairs, current drafts and active listings. Never infer absence from missing local IDs.
2. Identify with OpenAI: year, brand, set, player, card number, parallel, serial, condition evidence, photo pair, confidence, provenance. Hold ambiguity.
3. Validate with deterministic schema and category-specific eBay taxonomy. No fabricated item specifics.
4. Prepare idempotent batch manifest with SKU/card fingerprint, image references, exact row mapping, shipping profile, field completeness, and approved placeholder/provisional price policy where required.
5. Compare two candidates without live writes: previously demonstrated photo-inclusive bulk route and Inventory API unpublished-offer route. Verify Seller Hub Drafts compatibility before choosing.
6. With separate approval, create ONE unpublished test record, then read back seller account, SKU, title, image mapping, specifics, status, and receipt. No publication.
7. After draft verification, send pricing work to Grok separately; user retains publication authority.

## Mandatory safety gates
- Default DRY_RUN=true; EBAY_WRITES_ENABLED=false; PUBLISH_ENABLED=false. Fail closed if unspecified.
- No changes to production settings, existing drafts, live listings, source photos, or scheduled jobs during assessment.
- Test selection allowlist (first 1, then 10, then 100); never bulk-replay uncertain receipts.
- Read-only duplicate reconciliation before any future write; idempotency and durable receipts for each card.
- On mismatched identity/photo, duplicate, account mismatch, unexpected write or systemic failure: stop affected write workflow, preserve evidence.
- Cost: preflight estimate, per-job hard cap (initial test proposal $1), daily alert threshold $25 and separately approved daily hard cap. Stop on cap or unexplained cost. Measure actual billed usage; do not equate estimated tokens with invoice.
- No production deployment, publication, credential modification, migration, or merge without explicit authorization.

## Acceptance and measurement
For each run capture cards attempted, verified drafts, field/photo defects, duplicates, time, operator interventions, API/AI spend, and cost per verified draft. Zero verified drafts means no production throughput demonstrated.
Gate A: read-only manifest and simulated validation on 10 existing cards; zero external writes.
Gate B: one approved unpublished record with eBay readback and correct Seller Hub review behavior.
Gate C: 10 approved cards; no duplicate, identity, or photo errors.
Gate D: 100-card benchmark against browser baseline; choose lower-cost method only after measured success.

## Known unresolved questions
- Locate the historical successful bulk upload manifest and its image URL method.
- Establish actual Windows photo source and current deployed revision.
- Confirm Seller Hub Drafts compatibility for API unpublished offers.
- Obtain baseline count of verified drafts from the $20 / 500-credit run.
- Verify currently active external orchestrator and scheduled tasks separately; GitHub run history is not proof of their state.
