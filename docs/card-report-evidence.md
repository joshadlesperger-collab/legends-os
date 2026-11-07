# Historical report evidence intake

`scripts/import-card-report-evidence.ts` records the reviewed offline reconciliation report in the normal locked card queue. It does not contact eBay or a model. Validation is the default:

```powershell
node --experimental-strip-types scripts/import-card-report-evidence.ts --report REPORT.json --active ACTIVE.csv --orders ORDERS.csv
```

Use `--queue DIRECTORY` for an isolated fixture or the explicit operational queue. Only add `--apply` after reviewing the report. Intake verifies both CSV byte hashes, exact source-state hash/revision, complete unique card coverage, reviewed identity and exact active-match bindings. The report SHA256 is its immutable evidence ID. Exact replay is a no-op, including after the intake's own queue revision change. No real queue intake was performed during implementation.

Stored evidence preserves export/file modification dates, reconciliation time, separate import time, and current identity/photo keys. Import time is never a fresh live observation. Only allowlisted card/listing evidence is stored; arbitrary report fields and buyer fields are discarded. Jobs, holds, exclusions, draft operations, receipts and photo archives remain unchanged. The only additions are the evidence entry, an audit event and the normal queue revision increment.

The new-create branch of `draftNext` checks current identity/photo/SKU-bound positive report matches and conflicts. It returns `reconcile-report-match` before a new draft intent. Same-ID inspection, repair, verification and archive routes are unaffected. A negative report does not grant duplicate clearance, and changing identity/photos cannot transfer an old match. This conservative block has no automatic expiry or blanket reset; resolve the physical-copy match through supported reconciliation rather than deleting evidence.

Orders are historical evidence only. A sale may coexist with an active quantity listing and does not establish cancellation/refund outcome or retirement of every physical copy. CSV evidence cannot settle unknown draft writes, establish saved draft fields/photos, or authorize archiving. No pipeline jobs are retired by this intake and no live success is implied by its tests.

Validation: `node --experimental-strip-types --test tests/card-report-evidence.test.ts tests/card-draft-lifecycle.test.ts` covers atomic rejection, immutable replay, privacy, active/order overlap, positive-only creation guard and same-ID preservation. Run the repository build before operational adoption.


## Batch-first report reuse - 2026-11-03

Before per-card pricing/browser research, read the private local manifest `reports/ebay/imaydit58/latest.json` and search all selected identities together. The legacy saved-source index remains supported for legacy card IDs; do not rebuild or import that queue merely to search V2 identities. Explicit legacy SKU aliases must come from retained reset/ownership evidence.

Canonical storage is `/reports/ebay/` (git-ignored because raw order exports contain buyer information). A reviewed packet to `node --experimental-strip-types scripts/stage-seller-reports.mjs PACKET.json` specifies seller `imaydit58` and sources with `path`, `kind` (`active`/`orders`), explicit filename export date `exportDate`, and a coverage label. It copies original bytes into `<export-date>/<kind>-<sha256>.csv`, creates an immutable listing-only `.index.json`, and updates `latest.json` pointers by coverage. Raw sources are unchanged. Indexes exclude buyer/contact/address/order/tracking fields and hash transaction identifiers for overlap deduplication. Hash conflicts stop staging; lock conflicts require investigation. Preserve original exports indefinitely as practical; do not silently replace an old version.

Run `node --experimental-strip-types scripts/search-card-report-batch.ts PACKET.json artifacts/NEW-RESULT.json`. The packet contains `targets` (id/name/year/product/number/variant/serial and optional verified `skuAliases`) and either `manifest: "reports/ebay/imaydit58/latest.json"` or explicit `sources` with path/kind. Canonical reads verify raw and index hashes, reuse projected indexes, and retain original source timestamps. Each distinct source version is scanned once for the entire batch. Results are candidate evidence only: wrong products/variants/serials, unknown condition/shipping/language, stale active snapshots and sale ages remain visible. Report negatives never establish draft/scheduled clearance, and an asking price is not a sale. File modification dates, filename export dates, index build dates and actual live observation dates are distinct; copying/staging does not renew freshness.

Refresh active reports before a listing batch when the last actual observation is older than 60 minutes, and after listing/quantity changes. Share one refresh across the batch rather than refresh per card. Recommended sold cadence: daily rolling 90-day exports with overlap and exact transaction deduplication; weekly all-available/history exports and a one-time historical bootstrap. Preserve original sale dates: older sales support identity/history but do not become current comps through cache refresh. These are operating recommendations; no downloader, watcher or automatic schedule was created. Process New Cards does not automatically consume this manifest yet; the worker must perform and retain this source-first step.

The 2026-11-03 five-card lookup read 17,587 rows across five immutable source files in 656.5 ms on its initial local run (excluding discovery/setup). A later canonical-index read produced the same candidate counts in 118.7 ms. These are measured local lookups, not a controlled end-to-end speed comparison with browser work. No exact selected Lime Green copy was established: the Vince/Jusuf Optic candidates were Blue /49; Paolo candidates were other products. See `artifacts/card-processing-v2-five-20261103/report-discovery.json`. CAPA `v2-report-first-reuse-20261103` requires three subsequent authorized batches for effectiveness; local tests do not close it.

Validation: `npm run test:card-processing-v2` includes batch/privacy/overlap and canonical immutability/hash tests. Canonical storage is private and excluded from Git; do not attach raw order CSVs to reports, prompts or commits.
