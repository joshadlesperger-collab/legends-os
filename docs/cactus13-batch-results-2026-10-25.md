# Cactus Jack 13-card batch — 2026-10-25

13 distinct original pairs (153017 suffix) were processed: 12 saved eBay drafts and one existing-listing quantity update. No publication, no paid provider calls; incremental provider spending $0.00. All 26 originals remain unchanged in C:\CardScans. Unrelated drafts/listings were preserved.

## Saved outcomes

Prices below are item + shipping in USD. All nine new prices are **active-listing estimates**, not sold-backed valuations.

| Card | Draft/listing ID | Item | Shipping | Outcome |
|---|---|---:|---:|---|
| Jalen Williams #36 | 5436491423011 | 1.78 | 0.00 | active-listing estimate |
| Ja Morant #56 | 5436760571013 | blank | 0.00 | unpriced |
| Ja Morant #56 Refractor | 5436760569113 | 2.50 | 1.49 | active-listing estimate |
| Nolan Traore #79 Refractor | 5434740052710 | 1.86 | 1.49 | active-listing estimate |
| Trey Murphy III #58 Refractor | 5436562063012 | blank | 0.00 | unpriced |
| Alex Sarr #29 Refractor | 5436562070212 | 2.87 | 1.49 | active-listing estimate |
| Adou Thiero #96 Refractor | 5436491473511 | 2.12 | 1.49 | active-listing estimate |
| Kawhi Leonard #44 Refractor | 5436562075712 | 2.98 | 0.00 | active-listing estimate |
| Kawhi Leonard #44 | 5436562081312 | blank | 0.00 | unpriced |
| Noah Penda #92 | 5436562110412 | 1.99 | 0.00 | active-listing estimate |
| Collin Murray-Boyles #69 LogoFractor | 5436760617813 | 11.04 | 1.95 | active-listing estimate |
| Johni Broome #95 LogoFractor | 5434740106210 | 4.87 | 1.49 | active-listing estimate |
| Ben Saraf #86 base RC | [128155931242](https://www.ebay.com/itm/128155931242) | 1.49 retained | 0.00 retained | Quantity 1 → 2, reload verified |

Ja Morant base, Trey Murphy III Refractor and Kawhi Leonard base remain unpriced: checked cheapest candidates were Excellent, not the seller's NM condition. No second research loop or invented prices. The other nine prices preserve the exact comparable buyer total and approved shipping/offer mathematics.

## Timing and comparison

Measured wall time from recorded inventory-stage start to final draft/quantity inspection: **54m 55.4s**, 253.5 seconds per physical card. This is not model inference time. Initial intake/hash/photo review before the timer was not separately instrumented. Report writing, strict queue reconciliation and build validation follow this endpoint.

| Recorded interval | Wall time |
|---|---:|
| inventory-shipping | 7m 55.3s |
| upload | 0m 20.5s |
| generation | 1m 32.6s |
| correction | 13m 54.3s |
| save | 0m 17.6s |
| pricing | 25m 0.0s |
| reopen-verification | 5m 55.1s |

Intervals include agent reasoning/tool latency and recovery. The generation interval includes waiting/context overhead and is NOT certified pure eBay generation latency. The pricing interval includes title recovery, queue evidence correction, shipping, offer corrections and save. Per-card isolated pricing durations were not persisted, so the requested every-stage/per-card benchmark is incomplete. Deferral elapsed counters use a shared earlier workflow timestamp and must not be reported as actual individual research durations.

Prior eleven baseline: initial save 2m47.950s; corrected initial save 21m6.975s, still unpriced at that checkpoint. Later pricing was not fully timed. New batch upload start → first save checkpoint 15m47.404s, with first-save title persistence defects; final corrections/pricing/quantity/verification are the longer total above. **No throughput improvement is demonstrated.** The endpoints and card mix differ; an end-to-end percentage speedup would be misleading.

## What happened

- All12 two-photo pairings were verified against the original fronts/backs. Ben's exact active base listing reused; Nolan/Adou refractors were not conflated with active base cards.
- Initial eBay AI output had3 blank titles,5 incomplete titles,3 wrong variant titles; the Sarr title was otherwise usable. Three wrong variants included Ja base as White Refractor, Kawhi base as Refractor, and Collin LogoFractor as Refractor.
- eBay AI supplied no prices and no condition selection. NM default was applied to all12 without asking again.
- Bulk text fill and some focus-only interactions displayed edits that did not persist. Native keyboard input plus blur/commit and reopening the same IDs repaired price/SKU/offer omissions. Johni SKU required the single-card editor.
- Unsupported optional autograph/event/thickness metadata required removal; individual reopen caught residual Jalen autograph authentication/Hard Signed and Johni authentication, then confirmed their removal.
- All12 reopened titles, SKUs, card numbers, parallels, teams, NM conditions, quantity1 and two-photo counts matched. Nine prices, shipping and offer thresholds matched the calculated proposals. Sarr's saved full-name Alexandre Sarr is the same player as Alex Sarr.
- Bulk issue summary after corrections had exactly3 missing prices, with no remaining offer errors. Country-of-origin and AI suggestions remain review warnings; do not interpret this as full publication approval.

## Validation and limits

Live evidence is in artifacts/cactus13-20261025: exact draft IDs, original hashes, photo mapping, active comps, reopened AX/screenshot captures, original-integrity.json, batch-audit-packet.json and batch-audit-result.json. Batch audit checks actual saved fields, not mocked provider output. Full strict lifecycle verification is recorded separately; policy-ID capture or other missing evidence must remain explicit rather than weakening guards. No originals archived until all required receipt gates pass.

Source order used fresh seller active inventory, available 2025+2026 sold exports and local knowledge graph before external active comparisons. No exact reusable sold evidence was accepted for these twelve. One current seller price was retained for Ben. Active estimates express asking-price competition, not measured sale probability. No four-model comparison was run or implied.

## Required changes before the next batch

1. Use a validated keyboard/blur commit path with a read-back assertion per field. If the grid cannot persist once, use the same draft's single-card editor directly; never regenerate.
2. Start an append-only stage timer before intake and keep separate per-card research, website wait, correction and verification intervals. Enforce one30-second research timer per identity; no shared placeholder start times.
3. Retain acceptable AI content. Review only identity/parallel/serial/photo risks; avoid broad description rewrites unless necessary. This batch still over-edited and spent too long in UI repair.
4. Audit unsigned-card optional attributes after title enrichment. Do not accept catalog suggestions automatically.
5. Batch known shipping policies, then apply native price/offer inputs and verify from persisted state. Treat active estimates and blank-price exceptions distinctly.
6. Keep automatic exact-duplicate quantity increments with durable original-capture IDs and reload evidence.
7. Next comparison must use identical endpoints: first intake → all persisted drafts/quantity updates verified, with separate priced/unpriced counts and correction minutes. CAPA remains open until a new batch demonstrates the improvement.

## Final harness checkpoint — 2026-10-25T21:36:43.061Z

All nine priced drafts pass **every strict saved-draft check** after read-only policy-overlay evidence was added. Three intentionally unpriced drafts pass the separate supported unpriced verification. Ben quantity1→2 is reload-verified. Full-manifest batch audit:13/13 verified, zero missing outcomes. Strict evidence collection/queue validation brings measured run wall time to **64m 47.1s** from recorded inventory start (includes build overlap and reporting/tool overhead). Individual per-card stage durations remain unavailable; do not infer them.

Required npm run build passed (build-final.log). Initial sandbox EPERM was isolated. A subsequent build caught temporary evidence scripts named .ts; those batch-owned scripts were renamed .mjs and the build rerun successfully. No application pricing rules changed. Procedural fixes are recorded in docs/card-orchestrator.md; CAPA remains open pending future effectiveness evidence. No provider spending, publication, commits, pushes or source-photo moves.
