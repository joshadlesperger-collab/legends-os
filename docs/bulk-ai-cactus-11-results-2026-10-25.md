# Native eBay bulk-AI pilot — eleven Cactus Jack cards

## Actual outcome

Eleven original physical captures (22 original photos) became eleven actual saved
eBay drafts through native multiple-listings-from-photos: a two-card pilot followed
by nine cards. All eleven IDs were reopened together after corrections. No listings
were published, no originals were moved, and no paid provider calls were made.
All eleven remain unpriced; **saved drafts: 11; publication-ready: 0**.

User instruction applied: “we seemed to have a good process yesterday with the
pokemon cards. apply the learning from those where needed.” Exact wording and
provenance are captured in the engineering queue, linked to bulk-ai-first-20261025.
The seller separately confirmed all eleven are pack-fresh, Near mint or better.

## Pokémon learning applied

- Group original front/back pairs before upload; edit shared fields in one batch.
- Keep stable capture SKUs and resume actual saved IDs. Never recreate an uncertain
  submission. The new capture-bound intent and observation commands use the existing
  card queue and draft lifecycle rather than a separate inventory.
- Preserve acceptable AI titles. Repair factual exceptions and length limits only.
- Verify persisted fields after save/reopen. Apparent input success is insufficient:
  two SKU edits initially retained only their last character and were repaired.
- Keep draft existence distinct from readiness. Pokémon's later country/returns/
  offer/description repairs showed that photo-complete is not publish-ready.

## Measured timing

| Measurement | Actual observed time |
|---|---:|
| Native generation, two-card pilot | 14.839 seconds |
| Native generation, nine-card batch | 8.858 seconds |
| First intent to all eleven initially saved | 2 minutes 47.950 seconds |
| First intent to corrected eleven-draft save | 21 minutes 6.975 seconds |

Generation intervals include observation overhead, not pure service latency.
The longer interval includes engineering, inspection, shared-field edits, browser
input recovery and validation. It is not a human active-work stopwatch. The initial
draft rate is not a ready-to-publish throughput measure. No same-card fifty-card
comparison has been completed, so no speedup over the old process is established.
Timing sources and exact per-card checks: artifacts/bulk-ai-cactus-20261025/metrics.json.

## Per-card results

| Capture / SKU suffix | Reviewed identity | Saved draft ID | Native output adjustment |
|---|---|---|---|
| 0001 | LaMelo Ball #21 Base | 5436270183212 | Removed false White Refractor claim |
| 0002 | Bennedict Mathurin #16 Refractor | 5436468716413 | Kept acceptable title |
| 0003 | Ryan Kalkbrenner #94 Refractor RC | 5436204838211 | Completed missing title, athlete, set, parallel and description |
| 0004 | Stephen Curry #42 Base | 5434453403010 | Removed false White Refractor claim |
| 0005 | Jamal Murray #32 LogoFractor | 5436204847711 | Completed product/parallel/title and description |
| 0006 | Shai Gilgeous-Alexander #35 Refractor | 5436275474312 | Kept title; separate from earlier base Shai |
| 0007 | Hakeem Olajuwon #LFL-17 La Flame Legends | 5436473960613 | Kept title; printed graphic is not authenticated autograph |
| 0008 | Kasparas Jakucionis #UH-40 Utopia Highlights RC | 5434453443210 | Shortened overlong title |
| 0009 | Jase Richardson #85 Pink Refractor 098/250 RC | 5436473967513 | Added physical serial numerator |
| 0010 | Devin Booker #48 Base | 5434453449110 | Removed false White Refractor claim |
| 0011 | Cam Thomas #3 Base | 5436275470212 | Completed product/card-number title |

All SKUs are CACTUS11-NNNN, quantity one. Shared condition, country and autograph
absence were applied. All eleven local identities completed the supported
claim/complete flow. Final reopened grid checks confirm eleven SKUs, conditions,
titles within 80 characters and blank prices. Raw native output remains preserved.
The final grid has no missing-title, overlong-title, missing-description,
missing-condition or missing-country errors. It still reports eleven blank-price
errors, five optional AI recommendations and three country prefill notices.

## Pricing and unresolved readiness

Saved active, 2025 sold, 2026 YTD sold and 90-day sold exports were checked before
external research, along with per-card local pricing contexts and staged knowledge.
No matching active candidate was found in that snapshot. It is historical and is
not fresh inventory clearance. Live knowledge database access remains unavailable.

Seller history contains two Curry base-title sales and a different Curry Refractor
sale. Overlapping YTD/90-day rows are duplicates, not additional comps. One base
row is quantity four and requires per-unit shipping interpretation. None was
silently promoted from a title match to a validated exact comp. The local contexts
contain no admitted/completed/reusable pricing for these eleven identities.
All eleven were saved unpriced without external pricing research or placeholder
prices. Existing pricing mathematics and seller policies were not changed.

Before publication: resolve exact pricing, check shipping eligibility against the
final price (the drafts inherited Free Envelope Only), apply price-dependent offer
settings, and finish the normal per-draft readiness/issue audit. The bulk existence
receipt does not satisfy the stricter publication/archive verification protocol.
Originals remain in C:\CardScans.

## Implementation, validation and recommendations

New lib/card-bulk-ai.ts and CLI commands persist scoped upload intents, reject
repeat submissions and reconcile observed draft IDs through existing lifecycle
checks. QueueState stores the intent in the same durable queue. Existing photo,
identity, price, shipping, offer, duplicate and saved-field validators are reused.
The existing CSV path remains the fallback; native bulk AI was available here.

27 relevant tests passed outside the sandbox. The first run's temporary-file
atomic rename was blocked by the sandbox (EPERM); that evidence was retained.
npm run build passed. No commit, push, deployment or production policy change.
Additional paid provider spend in this pilot: **$0**, with **0 paid provider calls**;
this is not a reconciliation of historical provider spending.

Use native bulk photo generation for preparation, then shared-field edits and a
bounded exception review. Keep the back-of-card variant/serial check mandatory:
native AI produced at least three false parallel claims in eleven cards. Optimize
the exception-edit/persistence path before scaling; generation was fast, corrections
dominated elapsed time. CAPA remains open/monitoring until planned live effectiveness
evidence proves recurrence prevention, rather than being closed by test success.

The requested fifty-card controlled comparison remains unverified. It needs a
representative fifty-capture cohort and both workflow-arm observations with isolated
records, common completion criteria and explicit human/recovery timing. Do not
create duplicate seller drafts merely to manufacture that baseline. This eleven-card
pilot establishes feasibility and exposes corrections; it does not establish a winner.

Evidence directory: artifacts/bulk-ai-cactus-20261025. Resume the saved IDs above;
never rerun upload for these originals. Final-save.png is the eleven-draft receipt;
final-reopened-grid.txt/png and final-grid-fields.json retain the reopened validation.


## Price recovery checkpoint — 2026-10-25T19:58:03.438Z

Nine of11 existing CACTUS11 drafts now have saved/reopened verified item and shipping amounts; see artifacts/cactus11-price-recovery-20261025/results.md and verified-prices.json. Mathurin0002 remains unpriced (no standard-Refractor matching comp); Cam0011 remains unpriced (one base comp only). Build passed; $0 incremental provider spending. Bulk fill-only persistence failure contained using keyboard entry + Enter and saved-list verification. Broader publication-readiness checks remain uncertified; old numeric AX checker cannot consume bulk DOM evidence. No publication or new draft creation.


## Active fallback completed — 2026-10-25T20:06:00.024Z
Mathurin5436468716413 saved/reopened $2.61/free; Cam5436275470212 $1.77/free. Both active-listing estimates in pricing records/handoff; all11 batch drafts priced. Default exact-active-total fallback implemented with safeguards, preserving sold math.109 regression tests and14 candidate/fallback tests passed; build passed. $0 provider spending. Report: artifacts/active-fallback-20261025/results.md. No publication; broader readiness holds retained.
