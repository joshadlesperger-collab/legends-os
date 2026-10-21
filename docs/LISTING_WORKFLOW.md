# Card-to-draft workflow — 2026-10-21

## Confirmed user-reported working route

Josh reported that the assistant performed bulk uploads including photos, left cards in eBay drafts, and Josh published them. Preserve and locate that successful route before substituting single-card entry or introducing another platform. The original upload files, image-hosting method, and execution environment have not yet been verified in this checkout.

## Required stages and handoffs

| Stage | Required handoff | Completion evidence |
| --- | --- | --- |
| Reconcile | Stable physical-card ID, inventory reference, photos, duplicate status | Check existing live listings and drafts; record scope and time; a missing saved ID is not proof of absence |
| Identify | Card definition, parallel, card number, serial where applicable, quantity, original photo references | Identity evidence; unresolved identity routes to its own review queue |
| Price | Estimate, item price, shipping, buyer total, confidence, policy version, evidence, review flags | Saved valuation; historical values retain original policy provenance |
| Prepare | Valid bulk draft rows with correct original photo URLs and stable inventory references | Saved batch manifest, file reference, row-to-card mapping, field and image validation |
| Upload | Execute assistant-operated bulk draft route in an available authorized environment | Upload receipt and per-row results; do not publish |
| Verify | Reconcile accepted and failed rows to actual eBay drafts | Draft reference or inspectable equivalent, photo/identity/price readback, timestamp |
| Review | Hand verified drafts and outstanding pricing flags to Josh | Josh publishes; subsequently reconcile actual live item IDs |

## Recovery rules

- Every card needs a saved next action, stage, and specific blocker when blocked. Never stop an entire batch for one exception.
- Save batch IDs, row mappings, attempts, receipts, errors, and output references in durable records. This document itself is not an implemented queue.
- Before retrying an uncertain upload, inspect existing drafts/results to prevent duplicates. Do not blindly replay an entire partially successful file.
- An upload receipt alone does not establish that drafts exist. Do not report success until verified.
- Do not claim background execution without an actual running job. If access is unavailable, state the precise missing environment or artifact.

## Acceptance demonstration

Trace a small batch from existing inventory/photos through current-policy valuations into verified drafts, preserve exceptions, and resume an interrupted attempt without duplicate drafts or repeated completed research. Record elapsed time and manual corrections. Production readiness remains unverified until this demonstration succeeds.
