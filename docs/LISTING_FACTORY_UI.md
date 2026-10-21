# Listing Factory workspace

Route: `/listing-factory`, under Sell → Listing Factory.

## Current delivery

The page follows the existing application styling and operator authentication. It displays an imported queue snapshot; it does not infer a scan backlog from commerce listings. It supports stage/status/search filters, pagination (50 rows), card details, pricing evidence/confidence breakdowns, quantity, photos, next actions, holds, item/shipping/total, recorded API costs, and stage-completion history.

No database migration, provider call, recognition call, upload, or publication is performed. Browser-local persistence supports refresh recovery, not shared or server durability. Import replaces the previous snapshot after validation and successful local save. Export before switching snapshots to preserve prior work. Photos remain external HTTPS references; C-drive paths cannot be displayed here.

## Queue import contract

JSON `{ "version": 1, "cards": [...] }`, at most 5 MB / 10,000 records. A sample format is available from the page at `/listing-factory-example.json` and is explicitly marked as an example. The empty page does not load sample inventory.

Required record fields: `id` (stable physical card/quantity-group ID), `definitionId` (shared identity), `title`, positive integer `quantity`, `stage`, `status`, ISO datetime `enteredAt`, and `nextAction`.

Stages: `scanned`, `identified`, `priced`, `bulk-upload`, `verified-drafts`. Status: `queued`, `processing`, `held`, `complete`. Held records require `holdReason`. A verified-drafts record requires `draftUrl` and `verifiedAt`; imported verification remains a historical assertion, not a new provider readback.

Optional evidence: `evidenceBasis` (`exact-sold`, `serial-math`, `active-only`, `saved-estimate`), `confidence` (`low`, `medium`, `high`), `compCount`, `evidenceAt`, `evidenceNotes`, `evidenceUrls`, `policyVersion`, `targetTotal`, `rangeLow`, `rangeHigh`. Amounts are USD; range and target refer to buyer total. Optional proposed `itemPrice` and `shipping` remain distinct. Item price must be at least $1.49. The importer validates the floor; it does not claim the incoming price has been recalculated under the current policy.

Optional `photos` (HTTPS URLs), `apiCostUsd` (recorded per-record allocation, not a per-copy multiplier), `draftUrl`, `verifiedAt`, and `history` entries `{ stage, completedAt }`. Reused research should be allocated once by the producer; do not duplicate definition-level API spend on every copy. Missing cost is unknown, while explicit zero is measured zero.

## Health definitions

Current stage counts are exclusive per imported card ID. Unit quantity is shown separately. Stage age uses `enteredAt`; it is not total lead time. Recorded 24-hour throughput counts each record at most once per stage and excludes future completions. Completion-history coverage is displayed. A zero observed count with partial history is not proof of zero actual throughput. No flow trends or bottleneck diagnosis are claimed without repeated snapshots.

## Next integration

Produce this contract from the actual Windows inbox/manifest records after inventory and live/draft reconciliation. Move queue persistence to an authenticated account-scoped database model with stage events, evidence references and upload receipts. Keep that schema separate from Markdown handoffs and keep secrets out of imports. Connect the existing bulk upload route only after its image hosting and receipt format are verified. Josh publishes after draft verification; pricing uncertainty alone need not prevent draft preparation.

## Identity coverage and scan folder reading

`identityStatus` is optional and explicitly one of `identified`, `not-identified`, `needs-review`. Missing status is unknown, never inferred from a title, definition ID or workflow stage. Coverage metrics count records across all stages and filter the table on click; quantity is separately displayed. The producer must populate status from saved identification evidence.

Read scan folder uses the browser directory picker and hashes image bytes locally. It shows candidate pairs based on explicit front/back filename suffixes by default, or an operator-selected alternating/front-only convention. Exact duplicate bytes are excluded from candidate counts; they may still represent separate physical copies, so this is not inventory reconciliation. Images are not uploaded or retained. Counts do not prove identity or absence of drafts/live listings. Folder reading remains independent of the imported card queue until a photo-to-record reconciliation producer is connected.
