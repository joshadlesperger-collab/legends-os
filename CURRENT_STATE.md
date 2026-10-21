# Current project state

Updated: 2026-10-21.

## Verified scope

- This handoff describes the accessible checkout, not the user's Windows workspace or a verified production deployment.
- Starting branch: main. Starting commit: 6ddfee43c29d9e0c1a96f3607268ba043cecd3f8.
- Prisma schema declares PostgreSQL and models for listings, snapshots, sales, recommendations, operator decisions, action execution, and outcome observations.
- Added startup/handoff instructions and a decision index. Runtime behavior has not been changed.
- Added linked pricing reconciliation and card-to-draft procedures based on the latest conversation. Confirmed user-reported route: assistant bulk upload with photos, verified drafts, Josh publishes. No draft has been created in this session.
- Added `docs/CHANGELOG.md` and `docs/archive/README.md` for dated process changes and explicit decision supersession. No historical decisions moved; source reconciliation remains open.

## Open work

1. Reconcile Windows checkout, remote branches, deployed revision, database, photos, and scheduled runner. Do not assume this checkout is the operating version.
2. Reconcile factory pricing instructions against dated user decisions before modifying pricing code. Premium, shipping basis, weak-evidence handling, and price-increase permissions need authoritative scope.
3. Inspect factory branch persistence and connect card/photo/evidence/stage records to durable storage where missing.
4. Map card identity and relationships to the existing schema before introducing any separate graph database.
5. Measure AI usage per completed card and prove interruption recovery and duplicate-action prevention.

## Validation

- Documentation-only continuity repair; `npm run build` passed on 2026-10-21 (compilation, type validation, and static page generation).
- Josh authorized commit and push on a separate repair branch on 2026-10-21. No production change, migration, or deployment performed. Consult Git for synchronization status.

## Listing Factory UI — 2026-10-21

- Branch: `feature/listing-factory-workflow`; new authenticated `/listing-factory` route linked under Sell.
- Implemented real empty state, versioned queue import/export, browser-local refresh recovery, stage/status/search filtering, 50-row pagination, evidence/confidence breakdowns, item/shipping/total display, hold/next-action details, HTTPS photo references, and recorded cost/history metrics.
- Queue producer contract and limitations: `docs/LISTING_FACTORY_UI.md`. No sample inventory is loaded automatically. Imported verification remains historical, not fresh eBay readback.
- This is a browser-local queue interface, not shared database persistence or a Windows inbox connection. No eBay writes, migrations, recognition calls or production deployment performed.
- Validation: production build passed; application/test typechecks passed; 7 new domain tests and 203 existing tests passed. Production HTTP smoke passed (auth redirect, authenticated page and navigation). Browser interaction verification blocked: Playwright browser unavailable and download returned invalid archives.
- Next: connect actual inbox/manifest producer to the documented contract; then add account-scoped shared persistence and verified bulk-upload receipt integration. Existing feature/card-listing-factory-v1 remains separate and unmerged.
