# Local Card Backlog

The backlog API reports stable error codes for unavailable local evidence, source-generation changes, invalid evidence and unexpected read failures. It never exposes raw exception text. A changing generation gets one bounded retry; corrupt or unknown failures do not. The browser retains its previous successful snapshot when refresh fails. The hosted app cannot access the canonical Windows workspace; use the local app for this backlog.

Verified draft-to-live observations recorded through `cards:orchestrate -- record-receipt` are retained in the queue and projected into this dashboard. A positive live receipt excludes new Add work but does not certify saved prices or grant publication authority. See the verified receipt feedback contract in `card-orchestrator.md`.

The Sell → Card Backlog page at `/listing-factory` opens a card workbench using existing local work from the authenticated `/api/listing-factory/backlog` endpoint. The full source dashboard and the older manual snapshot queue remain under **All records & audit**; `/card-listing-factory` is unchanged.

## Working a card

The landing page shows **Scanned → Identified → Priced → Listed** coverage for original physical captures. These are overlapping saved-evidence milestones: priced means a positive saved asking price, and listed means a saved live or sold receipt. Neither a draft nor a scheduled receipt counts as listed. Source conflicts remain visible and no current stock is inferred.

Below the totals, **Identify**, **Price**, and **Listing review** show the remaining cards in each stage, split into **Your review**, **Needs work**, and **Blocked**. A held card stays in its stage. Each physical capture belongs to exactly one next-work stage or the existing-receipts bucket. Receipt-only unmapped records are separate and never add physical inventory. No status claims that an agent is actively running.

Tabs for **All cards**, the three preparation stages, **Existing listings**, and **Unmapped records** open searchable card-level tables. Every row shows its stage, current status, saved blocker, and next action. Clicking a card opens the detailed workbench, with saved drafts and prepared cards ordered first in its stage queue. Status filters expose action-required and stuck cards directly. Next-card actions stay in the selected stage and status filter. These queues are review tasks, not upload readiness or unsold stock.

Card rows are one line high. The Card column uses saved eBay receipt titles first, then saved prepared titles; records with only a player name use their available identity fields as a display fallback. This fallback does not assert an eBay save or complete identity review. Long fields truncate visually and retain full hover text and card details.

### Blocker causes and RCCA/PA

`lib/card-blocker-causes.ts` defines versioned codes for capture/receipt mapping, original photos, local processing failures, identity gaps, parallel/serial uncertainty, sold evidence, price validation, inventory clearance, shipping, listing audits, offers/promotion, manual holds and unclassified causes. Codes derive from current saved requirements; they are blocker categories, not confirmed root causes. Unknown reasons remain `OTHER01` for triage. The evidence and source queues are unchanged.

The **Primary cause** filter and clickable row codes narrow the card list. **Blocker causes · Pareto & RCCA/PA** shows the selected stage's blocked population, sorted by count, with share and cumulative percentages. Each card contributes to exactly one primary code; secondary codes and every original reason remain in card details. Pareto counts are scoped to the stage before search/status/cause filters, so selecting a bar does not change the denominator. All cards excludes unmapped records; their own tab includes them explicitly.

The RCCA/PA CSV exports the complete stage's blocked population, original capture/SKU, title, stage, primary/secondary codes, exact reasons, rule version and snapshot date. Suggested owners, correction and prevention prompts are separate from blank fields for confirmed root cause, corrective/preventive actions, owner, due date, effectiveness check and action status. These suggestions do not perform queue actions, grant approval or claim root-cause confirmation. Spreadsheet formula prefixes are escaped. Next-card navigation retains a selected primary-cause filter.

The workbench displays both original photos, identity, retained asking price, open requirements and existing receipt links. Original bytes are served only after operator authentication, inbox containment and SHA-256 validation. Missing, ambiguous or unsupported originals show an unavailable preview rather than a substitute card.

- **Approve asking price & next** saves an exact local seller decision and advances to another card. It does not claim evidence validation, save anything to eBay or mark listing checks complete.
- **Set a manual price** accepts the seller's exact item amount and buyer shipping, even when a comp proposal is missing. **Save price & move to listing review** records an approved override and moves that capture out of Price. No premium, rounding or postage conversion changes the typed item amount. Shipping defaults are editable; a current tracked-service requirement is retained in the suggestion. Saving another manual price replaces the current override while retaining its history.
- **Save note** records a correction or instruction with that capture; it does not complete an identity/research job.
- **Hold & next** requires a concrete reason and puts the card in its stage’s Blocked bucket. **Return to workflow** removes the local hold while preserving its history and any source requirements.
- **Skip for now** moves past a card for this session without changing its evidence. The browser remembers the current card across reloads.
- **Copy work request** includes the exact capture, saved decisions, receipts and remaining requirements for the existing workflow chat. It does not message or start an agent. Known drafts open using their recorded IDs.

Decisions live in ignored `artifacts/card-backlog/reviews.json`, protected by an exclusive lock and atomic replacement. Requests are idempotent. Approval and hold projections bind to the current identity, original pair, exact source proposal, source approval/override, receipts and blockers; changed source evidence invalidates the projection while retaining decision history. Failed or stale saves keep the card visible with an error. Source queues remain unchanged. Identity and pricing worker completion still requires the orchestrator claim/complete protocol, and external listing work still requires a fresh preflight and the existing publication handoff.

`CARD_WORKFLOW_REVIEW_ROOT` is an optional process-only root for isolated review-write smoke tests. Normal operation uses the workspace root.

Manual prices bind to the physical capture, original pair and reviewed identity, rather than the changing comp proposal. Research refreshes cannot silently replace them; changed identity/photos require a new decision. Ordinary price approvals keep their existing tighter source-proposal binding. Pricing-job holds remain in saved evidence after a manual decision and no longer block that card's listing-review queue; identity, inventory, shipping, seller holds and listing requirements remain active. The workflow's copyable handoff and the orchestrator's fresh `pricing-context`/`preflight` include the manual price with precedence over automatic estimates. The runner reads that decision from the supported review store without changing source jobs or repeating photo hashing. Conflicting concurrent source/review changes require a fresh packet. No eBay price is changed by this control.

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

Legacy manifest statuses `held-pricing-evidence` and `held-own-acquisition-excluded-needs-independent-comps` retain pricing-stage provenance. Their exact reasons remain visible but do not block independent identity work. Generic manifest reviews, seller holds and capture/identity conflicts remain blockers. Cause rules version 2 distinguishes unavailable comparable-sale originals in pricing research from missing inventory originals.
