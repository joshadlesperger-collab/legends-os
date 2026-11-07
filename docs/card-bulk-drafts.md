# Bulk draft workflow — researched October 23, 2026

October25 test update: the newer Autofill result category template explicitly supports Draft actions and includes condition descriptors, specifics and business policies. The minimal Draft template below is not the only supported schema. Live recommendation job13337001435 completed; full-field draft persistence and throughput remain unproven. See docs/bulk-import-proof-2026-10-25.md before repeating the older minimal-template pilot. Preserve unquoted #INFO metadata when serializing CSV; quoted metadata was rejected in the live test.

Use Seller Hub Reports' **Create new drafts** CSV, not an Add listing feed.
The current official template was downloaded from the seller's account and retained
at `artifacts/pokemon-20261023-174512/ebay-official-draft-template.csv`.
Its price header is `Price`, and the action must be `Draft`. The sample shoe row
must never be imported. No publication endpoint is part of this implementation.

## Fast path

1. Select the entire current batch (1–500 captures) in Listing Factory. Ten-card
   batches remain useful for timing comparisons; there is no ten-card import limit.
2. Review front/back originals and identity in the grid. Distinct captures are
   physical inventory; matching unnumbered artwork, variant, language and condition
   form one quantity row. Reimports do not increment quantity. Existing receipts
   go to a separate reconciliation list and are never exported as new drafts.
3. Run orchestrator pricing-context for research gaps and preflight before the
   price handoff. Retain reusable evidence and per-copy validation. Obtain current
   price approval and resolve holds before exporting or hosting photos.
4. Confirm selected originals are upright and correctly paired, then use **Host
   approved batch photos on eBay**. This uses the connected `imaydit58` account's
   existing OAuth flow and Media API `createImageFromFile`. Four workers process
   eight photos per request. Each successful upload is committed to a local cache;
   errors stop the UI loop and retries reuse successes. Nothing creates a listing.
   The current implementation uploads original bytes: rotate/review a separately
   supported photo export before using this route if originals are not upright.
5. Download the draft CSV and companion verification manifest. Missing, unreviewed
   or soon-expiring hosted images block export. CSV contains one representative
   front/back pair per reviewed quantity group and captures all member IDs in the
   manifest. The manifest retains shipping, condition, specifics and offer rules.
6. After fresh inventory/shipping preflight, upload the CSV **once** in Seller Hub
   Reports. Retain its processing report. The minimal template does not establish
   complete shipping/condition descriptors/item specifics; finish those in the
   bulk editor and save drafts. Do not use Publish/Complete to active listings.
7. Reconcile result rows by SKU; resume saved draft IDs. An unknown outcome is not
   permission to repeat an import. Reopen/verify saved prices, quantities, shipping,
   identity and photos. Only then record verified receipts through the orchestrator
   to move originals into Drafted. Listed remains reserved for verified live items.

`npm run cards:batch -- bulk` returns export readiness, CSV, blockers and the
verification manifest for the selected approved batch. It performs no eBay writes.
The app's hosting button is separate, explicit and authenticated. A lock prevents
concurrent photo upload chunks; cache entries retain original hashes, image URI and
expiry. Never delete a media lock unless the owning request is known to have ended.

## Research and expected speed impact

- [eBay Seller Hub bulk guide](https://pages.ebay.com/sh/reports/help/create-listings-bulk/):
  file feeds and hosted photo URLs avoid repeated listing-form entry. The draft
  file still needs result-report reconciliation. Upload processing is asynchronous.
- [Media API specification](https://developer.ebay.com/develop/api/spec/media_api.json):
  `POST https://apim.ebay.com/commerce/media/v1_beta/image/create_image_from_file`,
  multipart field `image`, existing `sell.inventory` scope; success returns image
  URL, expiry and Location resource URI. No new OAuth scope is needed.
- [Managing images](https://developer.ebay.com/api-docs/sell/static/inventory/managing-image-media.html):
  keep image resource IDs and expiry. Draft-only photos must not be assumed permanent.

The expected saving is fewer browser interactions, shared-field bulk edits and
reused image/pricing evidence. This is an engineering hypothesis until timed on a
real batch. Measure active work separately from seller approval and eBay processing
wait; do not claim the 30–60 seconds/card target has been achieved yet.

Implementation does not replace the local orchestrator's preflight/receipt rules
or solve coordination with the older external Card Inbox writer. It does not
implement automatic CSV submission, live quantity revision, publication, or an
automatic orientation classifier. A verified end-to-end seller upload is still
required before treating this path as production-proven.

## October 24 speed instrumentation and exception isolation

The batch panel now supports 500 captures, atomic approval of displayed eligible
prices, and a ready-work plan. Draft CSV/media preparation selects complete approved
quantity groups only. Holds, missing approvals and existing receipts remain visible;
they are never silently reset or exported as new inventory. A later photo/hash error
still fails safely. Ready means locally packet-ready, not fresh inventory clearance.

Saved pricing-library reads are chunked at the endpoint's 50-capture limit. This
fixes the previous failure of evidence lookup for a larger batch. Evidence reuse
still requires per-copy review and never transfers approval.

CSV companion manifests group common shipping, condition and intersecting specifics
for shared bulk edits. The official minimal Draft template remains authoritative;
no unsupported shipping columns or Add actions are invented. Submission remains
through Seller Hub; automatic upload/result ingestion is not implemented here.

On the next batch, select exact captures before work begins. Start photos, identity,
research, inventory-shipping, ebay-entry, verification and archive stages when those
activities begin. Use approval-wait and service-wait explicitly; use recovery for
retry work and pause for unrelated work. Export the timing report after completion.
Server photo hosting/export operations are additionally recorded automatically in
artifacts/card-batches/operations/<batch-id>, including failures and monotonic
durations. Operation sums may overlap and must not be added to elapsed time.
Archived measurements now freeze their finish timestamp. The 30–60 second target
is displayed as a target, not a measured achievement. No new batch has yet been timed.

Inventory checks still require fresh four-scope evidence; a batch-wide marketplace
snapshot collector is not implemented in this change. Original archiving remains
the existing receipt-triggered, hash-verified flow after actual saved-draft review.
Production activation requires explicit seller approval under AGENTS.md.

## Native bulk-AI pilot and Pokémon lessons (2026-10-25)

The seller requested reuse of the Pokémon workflow's effective steps. Use grouped
front/back uploads, shared-field bulk edits, stable capture SKUs, and saved-ID
reconciliation. Preserve acceptable eBay titles; correct only factual omissions,
contradictions, serials and length errors. Do not turn every draft into another
full writing/research task. A saved draft is not a ready-to-publish listing.

`bulk-ai-begin --cards ... --worker ... --token ... --evidence ...` records a
capture-bound upload intent in the existing card queue before native generation.
This explicitly scoped initial-generation route permits unknown identity because
the native AI is being tested. It still requires verified original pairs and the
existing writer lease/creation authority. It never authorizes publication.
`bulk-ai-observe --submission ... --file ... --worker ... --token ...` records
visually verified original-to-draft mappings through the existing lifecycle.
`bulk-ai-status --submission ...` exposes unresolved captures. Never retry an
uncertain upload; reconcile the original intent and resume its saved IDs.

The eleven-card pilot exposed three incorrect White Refractor claims on base
cards, missing identity fields, and one overlong title. Verify both sides and
critical specifics on every pilot card, including physical serial numerator.
Correct contradictions in title, specifics AND description. Native AI agreement
or a plausible title is not evidence of a parallel or price.

Shared condition, country of origin and autograph absence were edited together.
Apply only values supported for that batch, and retain shipping/offer policy
checks separately. The UI's apparent field value is not proof of persistence:
use normal keyboard input/blur, let the row save, then reopen the same IDs and
compare actual stored fields. Preserve a failed input observation before repair.

Keep all-available seller history, but exclude duplicate exports, different
parallels and ambiguous quantity/shipping semantics from pricing calculations.
Use active/sold/local knowledge evidence first. Missing verified pricing stays
blank; never enter a placeholder just to remove the eBay price validation error.
Report generation time separately from review/recovery and end-to-end elapsed
time. The eleven-card native pilot is not a controlled fifty-card comparison.
See `docs/bulk-ai-cactus-11-results-2026-10-25.md` for evidence and remaining work.
