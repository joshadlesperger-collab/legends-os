# Hosted draft price report

The live price-review endpoint can serve a frozen, private server-side report
snapshot. Operator sign-in is required; the endpoint stays GET-only, private and
no-store. Filtering and discount calculations run in the browser. They never
write prices, invoke card processing, query eBay or publish listings.

Local operational evidence remains authoritative on the runner. If the local
report pointer is absent, the server reads
`private-data/draft-price-report/snapshot.json`. Corrupt local evidence does not
silently fall back. The hosted envelope is hash-checked and schema-validated,
with complete unique draft scope, original observation times and current
read-only publication policy reconstructed on every read.

## Deploying the saved snapshot

1. Export the selected validated source into a clean deployment directory.
2. From the operational checkout, run
   `node --experimental-strip-types scripts/export-hosted-price-report.ts <absolute deployment directory>`.
   This copies only allowlisted report fields and bounded market summaries.
   It refuses to overwrite an existing snapshot. No credentials, card photos,
   account data or raw source artifacts are copied.
3. Build the deployment source with `npm run build`. Confirm the report API's
   server trace includes the private snapshot and no public asset contains it.
4. Deploy using the approved release procedure. The snapshot is durable within
   that deployment; subsequent releases must repeat the export to retain it.
   It is deliberately ignored by Git and is never placed under `public/`.
   Production builds refuse a missing snapshot, so a later source-only release
   cannot silently remove the hosted report.
5. Verify unauthenticated API access returns401, authenticated access returns the
   expected complete report, and the private file URL is inaccessible. Test the
   filters/calculator without enabling price or publication writers.

The observation date remains visible. This is a saved report, not an automatic
refresh of current drafts: cards published since that date can remain in the
historical snapshot. Updating it requires a separately authorized report refresh.
No database migration, new service or production environment variable is needed.
