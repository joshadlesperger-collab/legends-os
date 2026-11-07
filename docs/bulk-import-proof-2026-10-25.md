# Supported bulk import test — October 25, 2026

Status: corrected replacement import executed with ZERO browser repairs. NM condition and city/state persist; shipping/payment/return policies still blank. Live acceptance FAILED and remains open. Latest replacement IDs and results are at the end; earlier repaired test copies were deleted with seller authorization. Earlier checkpoints below are retained as history; the final live result supersedes their pending-terms status. Existing drafts, original captures, quantities and pricing rules preserved.

## Findings and actual work

- Seller Hub Reports offers Create new drafts and Autofill listing details. Downloaded both current official templates into `artifacts/bulk-import-proof-20261025`.
- Recovered the earlier live three-card CSV pilot, job11342162826. Its saved evidence reports approximately20 minutes of import/completion before final audit. The minimal Draft template did not import specifics/policies or the detailed condition. This is adverse evidence, not an untested speed solution.
- Submitted two known cards to Autofill for suggestions. XLSX was rejected as unreadable. Fully quoted CSV was rejected as an unidentified template. Preserving unquoted #INFO metadata produced accepted job13337001435, subsequently Completed. Rejections and accepted job evidence are preserved; do not resubmit that job.
- Downloaded the actual result workbook without executing macros. Its general instructions explicitly allow Draft in the category sheet. Unlike the minimal Draft template, the returned97-column category template includes condition descriptors, item specifics, offers and shipping/return/payment policies. This is a supported candidate for removing browser field entry; persistence remains to be tested.
- AI output kept both titles and card numbers, but omitted known season/set/manufacturer/parallel fields; Noah also lacked structured player/team. Prepared these deterministically from reviewed records. AI descriptions contain unnecessary value claims; replaced with factual test descriptions.
- Prepared exactly two rows with action Draft, TEST ONLY titles and TEST-CSV SKUs: Jalen Williams36 and Noah Penda92. These are explicitly authorized test copies, not new physical inventory. Item prices1.78 and1.99, free shipping, NM descriptor400010, condition4000, known business policy names. Offers disabled on disposable test copies; original draft offers remain untouched.
- Local preparation took approximately0.10seconds for the full97-column file using existing evidence. This excludes identification, photo hosting, research, eBay processing, review and verification and is NOT listing throughput.

## Implementation and validation

The existing bulk exporter now explicitly returns readinessScope=csv-import-only, submissionReady=false, requiresPostImportVerification=true, and remaining field families. This prevents a local CSV result from being represented as verified eBay completion.

Bulk export/pricing integration:13/13 tests passed outside sandbox after a sandbox temporary-file rename failure. Updated exporter tests:8/8 passed. Required npm run build passed outside sandbox after sandbox .next mkdir EPERM. No processes terminated. No provider spending incurred by this run.

CAPA bulk-import-contract-and-throughput remains open. Two successful live draft observations are required; local tests do not close it.

## Exact checkpoint

File `artifacts/bulk-import-proof-20261025/full-draft-two-card-test.csv` is prepared and guarded to two Draft actions. User approved two labeled test drafts. Seller Hub upload notice explicitly says creation accepts User Agreement, Payments Terms and Marketing Terms; action-time confirmation is pending under browser-control rules. Screenshot `upload-terms.png` preserves the exact notice. Do not upload until answered. Do not use the original Add values from the AI result.

After confirmation: record upload start and file hash; upload once; reconcile returned job and two draft IDs; inspect actual persisted photos, identity, prices, condition and policies. Record missing fields without disguising recovery time. Compare complete elapsed and active work per card to60–90seconds, separating one-time engineering and existing-photo reuse. No publication, inventory increments or archive for test copies. Preserve all original drafts and source evidence.

## Live result — 2026-10-25 21:56:51 UTC

The seller explicitly accepted the upload terms. Uploaded the guarded two-row Draft CSV once. Job 12355300462 returned two Draft Success responses, without errors or warnings. Nothing was published; original drafts and stock quantities were untouched.

| Card | Test draft ID | Saved item price | Quantity |
|---|---|---:|---:|
| Jalen Williams #36 | 5434946111410 | $1.78 | 1 |
| Noah Penda #92 | 5436966627213 | $1.99 | 1 |

Both saved two correct upright photos, TEST ONLY titles, test SKUs, factual descriptions, and supplied identity specifics. Offers, promotions and scheduling were off. The detailed Near mint condition descriptor and shipping/payment/return policy selections were blank on BOTH drafts. ZIP/city were also blank: Location was omitted from the input, a preparation gap rather than evidence of importer loss. Ungraded condition type did save. Do not represent these drafts as submission-ready or claim free shipping is bound.

### Measured timing and verdict

Upload start: 2026-10-25T21:55:08.281Z. Both success responses: 21:55:43.836Z, 35.555 seconds total. Full inspection including policy/settings panels ended 21:56:51.560Z: 103.279 seconds total, 51.640 seconds per card. Two drafts created; zero fully complete drafts. No repair time is included because missing fields were preserved as test evidence.

This does NOT yet prove a complete listing beats the seller's 60–90 seconds per card. It demonstrates creation plus inspection at 51.6 seconds/card using already identified cards, hosted photos and prepared prices. Initial research, template failures, preparation and approval waiting are excluded; no reliable full end-to-end elapsed measurement exists for that earlier setup. Complete-listing throughput remains unproven, not 51.6 seconds/card.

### Required improvement

Resolve the exact condition descriptor and business-policy value encoding against the downloaded template; current numeric descriptor and policy names did not persist. Populate item location. Preserve the 97-column template, deterministic known specifics, two-row/Draft-only guards and saved-ID reconciliation. Do not infer that eBay universally rejects policies from this one test. Root cause remains unconfirmed. Any future import must avoid duplicate inventory and independently verify all completion fields; do not silently repair these test results and count them as import success.

CAPA bulk-import-contract-and-throughput remains open with this failed persistence observation. The authorized live experiment and report are complete; a successful full-workflow speed claim is not. Existing validation remains 13/13 integration tests, 8/8 exporter tests, and npm run build passed; no source code changed during the final live upload. No paid LLM calls were made in this stage.

Evidence: live-import-response.csv, live-import-start.json, full-verification-time.json, both imported DOM captures/screenshots, policies-imported.json and both settings captures in artifacts/bulk-import-proof-20261025. Resume from these two test IDs, never resubmit the CSV blindly.


## Existing-draft repair and final verification — October 25, 2026

Repaired ONLY test drafts 5434946111410 (Jalen Williams, $1.78) and 5436966627213 (Noah Penda, $1.99). No new drafts, quantity increments, publication or original edits. Saved and reopened both: Near mint or better, Card Factory – Free Envelope Only, eBay Managed Payments (248164941010), No Return Accepted (248164940010), and established seller ZIP/city all persist. Both previews show correct condition, free eBay Standard Envelope, seller location and no domestic returns. Existing photos, titles, prices, descriptions, specifics and quantity1 retained. No visible editor errors; preview is not an actual submission validation and nothing was submitted.

Timing: initial import+inspection103.279s; repairs through reopened field verification140.512s; combined243.791s =121.896s/card. Extended complete observation through both previews and intervening prevention engineering325.335s =162.668s/card. No earlier template research/preparation or inter-turn waiting is included. BOTH measurements exceed60–90s/card. This trial does not establish faster production throughput, even before photo hosting/identification/pricing costs.

Root-cause evidence: input Location omitted; payment policy name lacked its exact suffix; condition numeric value differed from official workbook dropdown display. Fill-only location edits did not persist; keyboard ZIP entry triggered city lookup and persisted after save/reopen. One city autofill race and two editor-rerender click failures were corrected and retained in measured repair time. Corrected condition/policy CSV persistence is still unproven: no documented safe existing-draft CSV update path was established, so the authorized existing-ID editor was used. Never upload another Draft row for these IDs.

Implemented categoryDraftCompletionFields: mandatory exact policy names and location, template NM descriptor, rejection of existing-draft reimport and unsupported conditions. Integrated into test builder; it now refuses regeneration when its successful import response exists. Original CSV and response remain unchanged. Minimal exporter now explicitly includes item location in post-import checks. The helper's field encoding is preparation validation, not a live import certification. eBay's official inventory onboarding guide documents profile-name fields: https://pages.ebay.com/sh/reports/help/create-listings-bulk/ .

Nine focused tests pass; duplicate-regeneration guard rejected as expected before output. CAPA remains open for future fresh-batch import persistence effectiveness; repair is not proof that the importer is fixed. Recommended next approach: deterministic category data with exact profile names/location, then grouped completion of any unsupported fields; do not repeat per-card research/AI for known fields. No speed claim until a genuinely fresh authorized batch reaches saved-field verification. Evidence: repair-timing.json, repair-full-timing.json, *-final-reopened.txt, *-preview-verified.txt, repaired-preview.png in artifacts/bulk-import-proof-20261025.

Final validation: npm run build completed successfully (repair-build.log); nine focused tests passed. No deployment, commit or push.

## Corrected zero-repair replacement trial — 2026-10-25

Seller authorized replacing only the two disposable TEST ONLY drafts. Retained all prior evidence; deleted5434946111410 and5436966627213 with explicit2-drafts-deleted confirmation and original Jalen/Noah rows still present. One corrected upload job12355303643 created replacement Jalen5437023862813 and Noah5435003346310. No publication, new physical inventory, price change or browser field repair.

Result: full NM descriptor now persists on both, as does Location city/state. Prices1.78/1.99, quantity1, two photos, supplied identity specifics and descriptions retained. Shipping, payment and return policy bindings remain blank on BOTH despite exact profile-name columns. No success claim for complete import. ZIP blank is distinct from Location failure: official guide permits city/state Location OR PostalCode; the supplied city/state did persist. No browser repairs or Save for later performed on replacements.

Clock22:14:45.333Z–22:17:50.827Z:185.494seconds total (92.747/card), including disposable cleanup, corrected preparation and navigation. Upload22:16:30.483Z to inspection:80.344seconds (40.172/card), not completed throughput because policies missing. Historical identity/pricing/photo hosting reused; neither number proves fresh-card end-to-end speed or repeatability. Preparation itself82.3ms is not listing speed.

Official sources: https://pages.ebay.com/sh/reports/help/create-listings-bulk/ documents profile names and Location vs PostalCode; https://pages.ebay.com/sh/reports/help/uploadable-file-feeds/ warns extra Draft columns are not guaranteed. This is evidence of incomplete tested Draft persistence, not proof all eBay imports lack policy support. Next requirement is a documented policy-binding draft mechanism or changed import evidence; never repeat the same file or substitute Add/publication.

Systemic change: bulk-import acceptanceKind now enforces a retained live result, zero field repairs, all required saved fields, distinct IDs, no publication/duplicate inventory and source-to-verification timing <=90s/card (<60 target). Both completion CLI and final exit check enforce it. The actual failed replacement report was deliberately submitted to completion and REJECTED; state remains unfinished. Two acceptance tests and11 queue regressions pass; required build passes after fixing a callback typing error and rerunning outside sandbox following EPERM. This is a task-specific evidence gate, not a claim that agents run continuously or every task has automatic semantic validation. CAPA remains open; one successful test would still require independent repetition before claiming a repeatable production process.

Evidence: replacement-response.csv, replacement-*-dom.txt, replacement-*-settings.txt, replacement-start.json, replacement-verified-time.json, replacement-acceptance.json, replacement-verdict.json, rejected-completion.log. Live proof task bulk-import-zero-repair-live-proof stays blocked on demonstrated policy persistence; do not mark complete from browser repair. No further seller decision is needed for read-only diagnosis/local improvements. Additional disposable replacement is not automatically authorized by the single completed replacement permission.


## Policy diagnosis checkpoint — 2026-10-25
Live policy names verified, including actual payment name suffix; naming hypothesis ruled out for corrected file. Official Draft contract warns extra columns are not guaranteed and directs browser completion. Inventory API supports policy-bound offers but documents no mapping from these Seller Hub draft IDs; no parallel offers created. Supported no-repair existing-draft route remains unestablished. Full speed proof remains unfinished, not passed. Evidence and unsent support reproduction: artifacts/bulk-import-proof-20261025/policy-diagnosis.md. Existing two replacement drafts preserved, no eBay writes or paid calls.


Policy diagnosis validation: npm run build passed outside sandbox after .next mkdir EPERM. No application source changes in this diagnostic run. Acceptance exit remains false for live zero-repair proof; CAPA remains open.


## Inventory API diagnostic — 2026-10-25
Captured and executed inventory-api-no-duplicate-test. New bounded GET-only probe and three mocked safety tests; actual run stopped at missing DATABASE_URL before eBay access. No API latency, persistence, or <=90s/card proof. No publication, duplicate objects or inventory writes. Review would move to an API-connected Legends OS screen, not Seller Hub Drafts; that review integration is not yet implemented. eBay documents API-only revisions for Inventory API listings. Exact report/restart: artifacts/bulk-import-proof-20261025/inventory-api-report.md. Task blocked pending supported seller OAuth database access and verified duplicate-free target; existing drafts preserved.


## Connection recovery and review screen — 2026-10-25
Implemented and browser-verified read-only Inventory API review page with existing draft links, local/remote evidence separation and safe blocked refresh. Eight tests pass. Diagnosed missing local settings, invalid sibling settings and empty Vercel Development. Broad Production secret pull rejected by automatic review; five scoped settings requested privately. Claude engineering inspector added through shared adapter/guard; preflight blocked on absent ledger/bounds, no live Claude call. Full evidence/checkpoint: artifacts/bulk-import-proof-20261025/recovery-review-report.md. No eBay writes or speed success claim.

