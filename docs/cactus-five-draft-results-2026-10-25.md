# Five-card draft completion — 2026-10-25

Four new unpriced drafts saved and reopened; original front/back pairs, SKU, quantity1 and blank item price verified. The fifth distinct copy, Adou, was added to existing active listing 128155931241, quantity1→2, with explicit seller authorization; retained item price $1.49 unchanged. No new listing published.

| Card | Saved draft | Intent→verified wall seconds |
|---|---|---:|
| Josh Giddey | 5436189206312 | 320 |
| Trey Murphy III | 5436132805711 | 194 |
| Shai Gilgeous-Alexander | 5434392115210 | 173 |
| Trae Young | 5436154011311 | 147 |

These are actual observed elapsed intervals, not pure browser execution or model latency. They include condition-decision wait, concurrent local validation, browser latency and input recovery. Earlier pricing research and engineering are outside these draft intervals. This run does not prove a steady-state throughput improvement or a 20-second listing time.

## What failed and changed
- Benchmark identities had never been admitted to the card preparation queue. All five now have supported photo/identity/listing checkpoints.
- Draft lifecycle required a price; it now has a separately verified unpriced checkpoint after a30-second pricing deferral. Pricing leases fence late completion at30seconds. The check runs when the queue is exercised; it is not an independent background timer and does not cancel a remote in-flight request.
- Model agreement on one shared comp was only arithmetic agreement. The separate comp audit now requires independent sale provenance, rejects duplicate/wrong/stale evidence and flags spread; approved pricing mathematics unchanged.
- eBay supplied catalog prices and a stock photo. Original pair upload replaced stock imagery. Plain fill did not persist the first SKU/price changes; keyboard input plus same-ID save/reopen verified correction. The first erroneous save is preserved in unpriced-first-save-mismatch.txt, not reported as success.
- New condition confirmation: seller explicitly confirmed all five pack-fresh. Each new draft shows Near mint or better. Original benchmark facts remain preserved; condition-instruction.json records the later seller evidence.
- Fresh inventory read found Adou already active even though an earlier cached draft tab still showed its draft. Current read prevented a duplicate. The quantity2 receipt binds the new capture and prevents a repeated increment.

## Validation and spending
157 card-orchestrator tests passed, followed by43 focused tests (overlapping coverage) including new30-second fencing, blank-field verification and zero-placeholder rejection. Final npm run build passed: timebox-build-verified.log. No paid model calls; additional API spending $0.00. Historical provider billing is not re-certified here. Existing originals and previous benchmark outputs retained.

## Remaining review and recommendations
These are incomplete drafts, not publication-ready listings: prices are blank by request; description and shipping/promotion review remain. The inherited shipping policy currently displays PWE $1.95; it was not certified as the final appropriate policy for unpriced cards. No publication, price approval, or original-photo archive is implied.

Use the saved IDs, never create replacements. Keep pricing research off the draft critical path after30seconds. Reuse validated exact-variant comps and seller history; treat model arithmetic and market-price quality separately. Use one same-ID save/reopen audit, including actual field persistence. Measure a clean next batch separately from engineering/setup and seller waits; four drafts here cannot prove sustained CAPA effectiveness. CAPA remains monitoring, not closed. Gemini quota remains an independent benchmark limitation; no retry or new model comparison occurred.

Evidence: artifacts/model-benchmark/cactus-five-20261025/unpriced-results.json, four unpriced-capture/verified files, adou-quantity-result.json and final-four-drafts.png.
