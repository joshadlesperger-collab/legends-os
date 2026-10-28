# Legends OS orchestration reliability acceptance plan — 2026-10-28

Status: assessment plan only. No live card processing, eBay writes, or Windows workspace validation performed.

## Objective
Demonstrate 100 previously processed cards can traverse scan/identity -> evidence-based price -> photo-mapped verified eBay draft with durable recovery and no duplicate actions. Do not publish listings.

## Evidence gate before test
1. Identify active Windows checkout, commit, process runner, scanner inbox, source manifest, and database. Compare to GitHub branch and deployed app.
2. Read existing card IDs, images, completed identities, pricing evidence, eBay draft IDs, and listing IDs. Do not repeat completed work or duplicate drafts.
3. Select 100 prior cards stratified by scarcity, parallel, and comp availability. Preserve original baseline and never overwrite existing prices.
4. Establish authorized read-only eBay status and permitted draft creation route. Without it, run offline replay only and report draft verification as unavailable.

## Required scenario matrix
- Normal card with reliable sold comps.
- Weak/no comps: documented fallback and confidence; exception queue if below threshold.
- Interrupted pricing and interrupted draft receipt: restart from checkpoint, no duplicated action.
- Transient API failure: bounded retry with backoff; permanent failure: reason-coded hold and continue other cards.
- Duplicate images/cards: deduplication and receipt reconciliation.
- Malformed model output: validation, retry, then hold.
- Unexpected spend or permission boundary: stop affected action and escalate.

## Metrics
Eligible cards, verified draft IDs, drafts/hour, stage p50/p95 duration, percentage blocked by reason, manual interventions, duplicate actions, price evidence coverage/confidence, cost per verified draft, and resume success rate. Unknown values must remain unknown.

## Release gates
No production deployment, eBay publishing, credential changes, migrations, or destructive operations without required approval. Require reproducible offline replay and build/tests before proposing live draft validation. Measure against the 30-second-per-card goal without assuming it is achieved.

## Immediate engineering backlog
1. Reconcile active Windows implementation against repository and identify available test fixtures.
2. Build a durable queue/receipt audit and offline 100-card replay harness using existing records.
3. Inject failures, verify idempotent recovery, and publish an evidence-based scorecard.
4. Only then connect approved draft path and verify actual eBay receipts.

## Completion definition
Do not mark completed until a run log, reproducible dataset/fixture manifest, stage-level metrics, failure-injection outcomes, and independent eBay draft receipt evidence are available. A design document or successful build is not a passing end-to-end test.
