# Local Card Backlog

The Sell → Card Backlog page at `/listing-factory` loads the existing local work automatically through the authenticated, read-only `/api/listing-factory/backlog` endpoint. The older manual snapshot queue remains available from that page; `/card-listing-factory` is unchanged.

Run `npm run cards:backlog` to generate `artifacts/card-backlog/snapshot.json` and the smaller `artifacts/card-backlog/audit.json`. These ignored artifacts contain local evidence and are not deployment assets. `npm run test:card-backlog` runs the reconciliation, manual queue, and scan-folder tests. The full repository test command also includes them.

## Evidence inputs

`lib/card-backlog-store.ts` reads an explicit allowlist:

- `artifacts/identity-queue/cards.json`: identities, original/current paths, SHA-256 hashes, review status, condition decisions and saved receipt references.
- `artifacts/pricing-queue/queue-state.json`: retained proposals, policy/source dates, explicit price overrides and receipt references.
- `artifacts/card-orchestrator/state.json` and `asking-price-approvals.json`: reviewed identities, local preparation, exclusions, holds and exact snapshot approvals.
- Batch and dated-batch manifests, bulk pilot manifests, `one-piece-processing.json`, the saved Goodman draft and batch-test audit: archive mappings, quantities, prepared titles, decisions and receipts.
- Saved exact-title matches, verified backlog, additional matches, live Prizm reconciliation, active-listing cells and current-UI records: positive marketplace receipt observations. Titles are retained but never used alone to join cards.
- Original image bytes in the Card Inbox, including Listed and Processed subfolders. The default is the current user's `OneDrive/Documents/Legends OS/Card Inbox`; `CARD_INBOX_PATH` can point at another local directory.

The loader does not read credentials, call eBay, use Prisma, edit queue state or alter original photos. It hashes with four workers, caches unchanged image hashes by path/size/mtime, rejects files changing during reads, and checks source versions before returning a snapshot. Concurrent API refreshes share one read. A failed refresh leaves the last client snapshot visible.

## Reconciliation rules

- One distinct original front hash represents one physical capture. Reimports and byte-identical files merge into that capture. Shared backs do not collapse distinct fronts. Saved quantities are historical observations, not additional captures or current stock.
- Separate original fronts remain separate records even when visually identical. Different serials/variants remain separate. A repeated full serial on different captures is a reading conflict, not proof of a rescan.
- Receipt-ID matches preserve saved draft/live/sold/scheduled evidence. Hashless ID/SKU matches are unresolved and cannot grant identity or pricing authority. A positive receipt excludes a new listing even when its capture mapping needs review.
- Multiple captures may share a receipt only when a saved quantity group and matching unnumbered identity, season, manufacturer, language and condition support it. No stock increment is inferred.
- Prices are retained as proposals, explicit overrides, exact snapshot approvals and observed eBay prices separately. Approval requires matching original pair, identity fingerprint, item amount, shipping, policy and source timestamp, with valid approval/source dates. A changed proposal is not silently approved. Explicit overrides are never replaced by a formula.
- Prepared and saved titles retain intentional trailing periods. Source conflicts and all retained price observations remain inspectable in record details and exports.
- Unmapped images remain images requiring a side/card mapping. Filename order and image-count division do not establish inventory. The optional browser folder comparison hashes locally and only matches saved captures.

## Reading the dashboard

State counts are mutually exclusive. Conflicts take precedence, followed by sold, live, draft, scheduled/held, local approval, priced, identified and unprocessed. Identity coverage, saved approvals, receipts and holds are separate overlapping milestones. Consequently a locally approved card can appear in the live or held state rather than the locally-approved state.

All-evidence scope includes receipts without a mapped local capture; these have zero physical units. Use Physical captures to restrict the table to original fronts. Draft/live IDs are distinct receipt counts, not stock counts; a historical draft may now be live.

Every snapshot explicitly records `marketplace.complete: false` and `absenceMeansUnlisted: false`. Missing receipts mean unverified status. Zero saved sold receipts does not mean nothing has sold. Fresh active, draft, scheduled and sold reconciliation is still required before an external listing action. This integration provides no upload, publish, revision or quantity-write capability and does not change the existing final publication handoff.

## Local operation and verification

The application process must have access to this workspace's evidence and the Card Inbox. An unrelated hosted server cannot read Windows files; it receives an unavailable response rather than a fabricated empty backlog. Local evidence and ZIP exports are explicitly excluded from Next.js output tracing.

The optional `LEGENDS_NEXT_DIST_DIR` allows an isolated Next.js output directory when an existing OneDrive build directory is locked. Validation here used `.next-backlog`; the normal default remains `.next`. Build with `npm run build` and start with the same output-directory setting.

The ignored `artifacts/card-backlog/` directory contains the audit, source snapshot, validation logs and browser verification screenshot. It is an audit output, not a new source queue. Existing Card Inbox automation may still write the source files; this dashboard does not claim cross-chat writer coordination.
