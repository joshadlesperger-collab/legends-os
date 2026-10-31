# Photo and eBay Backlog Reconciliation — 2026-10-31

Status: FIRST PRIORITY. Read-only audit plan, not executed against Windows or eBay.

## Goal
Classify every physical card/photo group as UNPROCESSED, DRAFTED, LISTED, SOLD, or EXCEPTION, using actual eBay evidence. Avoid reprocessing cards already drafted or listed. Preserve original photos.

## Evidence inputs
1. Windows OneDrive Card Inbox and related existing photo folders (inventory path must be confirmed in the running environment).
2. Actual photo-to-card manifest and stable SKU/serial mappings.
3. eBay drafts, active listings, sold records for both authorized stores, with timestamps and listing/draft IDs.
4. Bulk upload receipts and prior run checkpoints.

## Read-only procedure
- Inventory files with full paths, sizes, hashes, timestamps, front/back pairing; no moves/deletes.
- Reconcile stable SKU + serial + card identity and photo hash to eBay drafts and active/sold records. Do not treat identical images as necessarily the same physical card.
- Status precedence: SOLD when transaction confirmed; LISTED when live ID confirmed; DRAFTED when draft readback confirmed; UNPROCESSED only after checking relevant eBay states; otherwise EXCEPTION/UNKNOWN.
- Detect duplicate IDs, missing photos, orphaned drafts, failed bulk rows, unmatched files, and price/description incomplete drafts.
- Produce counts of cards and image files separately; include source coverage and last-sync time. No inference of zero backlog from missing data.
- Write a CSV/JSON reconciliation report and a proposed move plan, but DO NOT move, delete, upload, reprice, publish, or alter drafts without a separately validated and authorized operation.

## Acceptance
All input sources identified with coverage; every card has a documented status, evidence IDs, and next action; unmatched items explicitly listed. Report exact unfinished work and exceptions by stage. Resume processing only verified UNPROCESSED items after review of reconciliation results.

## Blocker
The GitHub repository is not a connection to the user's Windows photo folder or live eBay seller inventory. A running Windows-side audit or authorized eBay data connection is required to populate the actual report.
