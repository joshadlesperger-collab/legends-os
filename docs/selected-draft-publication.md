# Selected-draft publication

The site selects exact unpublished draft IDs and optionally records a manual
item price. Selection, sorting, and manual typing are previews. Only the final
reviewed Publish action creates a durable request, after a current publisher
heartbeat is observed. Blank manual prices retain each draft's saved item price;
shipping, quantity, identity, policies, descriptions and original photos are
protected. Comp exceptions are shown for an explicit operator decision rather
than silently becoming an automatic pricing approval.

## Activation prerequisites

1. Obtain explicit approval before applying the additive migration
   `20261107020000_draft_publication_bridge`. Do not apply it during ordinary
   source validation. It adds only publication jobs, exact draft ownership and
   publisher heartbeats; no existing card or inventory data is rewritten.
2. Deploy validated source and the private current report using the documented
   production approval flow. Without the new tables or a live publisher the
   site's connection remains unavailable, and no request can be queued.
3. After activation approval, start the local operational checkout's publisher:
   `node --experimental-strip-types scripts/card-draft-publisher.ts --allow-publish`.
   It uses the existing operator password through normal login to the allowlisted
   live Legends origin. No credentials are sent in heartbeat/job payloads.
   It uses the existing separate app-owned eBay profile, signed in as imaydit58.
   No personal browser, cookie import, undocumented Seller Hub API or Trading
   new-listing creation is used.

Do not start the worker or create live publication jobs as an implementation
test. Fixture tests cover native actions; no live publication was performed in
this feature's development.

## Handoff and recovery

- Requests are stored in the existing database rather than a cloud filesystem.
  Request IDs are idempotent and each seller/draft pair has one persistent owner.
  Selecting the same draft again cannot create a second publication request.
- The local worker reports a fresh actual seller-session observation. It closes
  the dedicated browser while idle, and refuses a busy card-processing session.
  Chromium's profile singleton is the final concurrent-launch boundary. A narrow
  startup race can fail closed and require connection recovery; do not claim a
  shared multi-workflow browser host has been implemented.
- A worker claims one exact queued request using an expiring lease. Each price
  edit and final native Submit requires an acknowledged durable checkpoint.
  Per-draft database compare-and-set prevents duplicate Submit checkpoints.
  Expired or ambiguous writes become REVIEW_REQUIRED; they are never requeued
  automatically. A lease or checkpoint failure stops subsequent remote actions.
- The native transport selects only requested IDs, in groups up to 200 on the
  observed draft page. It verifies unchanged saved identity/prices/shipping/qty,
  accepts only zero listing fees, and uses native draft submission. It retains
  native confirmation plus exact live SKU/title/amount/quantity acknowledgements.
- Positive live receipts are stored before moving any photos. The existing
  hash-verified Listed archive flow moves supported original pairs. Missing or
  consolidated multi-capture provenance can produce ARCHIVE_REVIEW; this never
  authorizes publication again. Published IDs are removed from the report using
  one exact bounded database projection, without scanning active inventory.
- Unknown unfinished bulk workspaces are preserved and cause a hold. Live
  verification uses one current active-grid page; if selected acknowledgements
  are not visible there, outcome is uncertain and must be reconciled. Unattended
  completion of every arbitrary 500-draft multi-page scope is not yet proven.

The status API reports queued/running/review/complete outcomes explicitly. An
accepted request or connected heartbeat is not evidence of completed listings.
No auto-publishing schedule, automatic price decrease, active-inventory duplicate
scan, paid pricing request, or card re-identification is introduced.
