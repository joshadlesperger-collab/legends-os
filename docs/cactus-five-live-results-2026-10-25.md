# Five-card live harness results — October 25, 2026

The live experiment ran. 91 journaled attempts produced 65 structured responses, 26 failures and 0 pending calls. The original round attempted all five cards, all four providers, and all three stages (60 attempts). A separately labeled corrected-schema round tested the repaired harness. Google remained unavailable: the corrected pricing diagnostic returned HTTP 503. A successful four-provider quality comparison is therefore still incomplete; three providers supplied usable head-to-head results. No eBay drafts or listings were changed.

## Scope and controls

- Five original front/back pairs in C:\CardScans; all ten final SHA256 hashes match the starting manifest. Originals were neither moved nor edited.
- Branch: feature/card-listing-factory-v1. Existing uncommitted work preserved; no commits, pushes or deployment.
- Same original images and recognition prompt for all four models. Pricing uses the same shared sold evidence, and listing uses the same independently assembled facts and deterministic price candidates. These are stage comparisons, not one model's recognition errors fed into its later stages.
- Models pinned to gpt-6.1-sol, claude-sonnet-5-5, grok-4.7 and gemini-3.8-flash after model-list checks. API calls use fresh context; no prior Grok chat or last-night pricing memory was supplied.
- Per-call timeout 90 seconds, SDK retries disabled; output caps 2,500 recognition, 1,200 pricing and 1,800 listing. OpenAI uses existing low reasoning; the other providers use defaults. This is a comparison of configured routes, not equal internal compute. Reported Grok output usage can exceed the configured visible output cap; these caps are not certified billing bounds.
- The user's exact five-card budget waiver is retained in budget-waiver.json. A scoped, durable usage journal records originals and labeled retests; the older budget ledger was not reset or bypassed for other work.
- Original results and schema-v2 retests are retained separately. Recognition was not rerun. Pricing/listing use corrected wire schemas in the retest; comparisons below use that corrected round where available.

## Measured results

| Stage / round | Provider | Valid responses / attempts | Mean successful response | Automated checks passed |
|---|---|---:|---:|---:|
| recognition / original | OpenAI GPT-6.1 Sol | 5/5 | 8.80 s | 36/36 |
| recognition / original | Claude Sonnet 5.5 | 5/5 | 8.19 s | 36/36 |
| recognition / original | Grok 4.7 | 5/5 | 26.12 s | 36/36 |
| recognition / original | Gemini 3.8 Flash | 0/5 | — s | 0/0 |
| pricing / original | OpenAI GPT-6.1 Sol | 0/5 | — s | 0/0 |
| pricing / original | Claude Sonnet 5.5 | 5/5 | 4.94 s | 10/10 |
| pricing / original | Grok 4.7 | 5/5 | 17.25 s | 10/10 |
| pricing / original | Gemini 3.8 Flash | 0/5 | — s | 0/0 |
| listing / original | OpenAI GPT-6.1 Sol | 0/5 | — s | 0/0 |
| listing / original | Claude Sonnet 5.5 | 5/5 | 8.78 s | 20/20 |
| listing / original | Grok 4.7 | 5/5 | 30.54 s | 20/20 |
| listing / original | Gemini 3.8 Flash | 0/5 | — s | 0/0 |
| pricing / schema-v2 | OpenAI GPT-6.1 Sol | 5/5 | 3.89 s | 10/10 |
| pricing / schema-v2 | Claude Sonnet 5.5 | 5/5 | 3.82 s | 10/10 |
| pricing / schema-v2 | Grok 4.7 | 5/5 | 23.02 s | 10/10 |
| pricing / schema-v2 | Gemini 3.8 Flash | 0/1 | — s | 0/0 |
| listing / schema-v2 | OpenAI GPT-6.1 Sol | 5/5 | 6.42 s | 20/20 |
| listing / schema-v2 | Claude Sonnet 5.5 | 5/5 | 9.39 s | 20/20 |
| listing / schema-v2 | Grok 4.7 | 5/5 | 27.59 s | 20/20 |

Recognition checks cover player, team, card number, sport, manufacturer, front/back pairing and front orientation, plus Adou's visible RC logo. They do not treat copyright year as release year or reward invented parallels. All three successful providers read the core identity correctly. Claude left set null; OpenAI and Grok returned Topps Chrome. All left the exact parallel unresolved under the image-only instructions. Photo comparison with sold examples subsequently supported LogoFractor for Josh/Trey and base for the other three; these names were shared as research evidence in later stages.

Pricing checks test the supplied comparable arithmetic and fixed $1.49 proposed shipping. They do not establish fair market value or predictive sales accuracy. Listing checks are narrow title/identity/length and no-grade-claim checks; passing them is not a complete eBay submission audit. Buyer-facing descriptions still contain internal comparison/review wording and require cleanup.

### Per-card recognition response time

| Card | OpenAI | Claude | Grok | Gemini |
|---|---:|---:|---:|---:|
| Josh Giddey #12 | 12.25 s | 8.36 s | 34.25 s | failed (90.00 s) |
| Trey Murphy III #58 | 6.90 s | 10.88 s | 40.27 s | failed (90.00 s) |
| Shai Gilgeous-Alexander #35 | 8.91 s | 7.66 s | 9.37 s | failed (90.12 s) |
| Adou Thiero #96 | 7.87 s | 5.57 s | 40.09 s | failed (90.38 s) |
| Trae Young #19 | 8.06 s | 8.49 s | 6.60 s | failed (2.55 s) |

Grok's patterned Josh/Trey cards and Adou took substantially longer than Shai/Trae, with higher reported output-token usage. This is an observed association in one sample per card, not proof of the cause; network and reasoning variability remain confounders. OpenAI/Claude times were more consistent. Five cards are insufficient to declare a universal winner.

## Pricing comparison and economics

All successful corrected pricing responses from OpenAI, Claude and Grok agree on these evidence-based target totals. The approved policy then determines the item price; no policy was changed.

| Card | Single sold item + shipping | Model target total | Policy item | Proposed shipping | Policy buyer total | Evidence |
|---|---:|---:|---:|---:|---:|---|
| Josh Giddey #12 (LogoFractor) | $3.26 + $0.35 | $3.61 | $1.95 | $1.49 | $3.44 | [Sold comparable](https://www.ebay.com/itm/278232231727) |
| Trey Murphy III #58 (LogoFractor) | $1.99 + $1.49 | $3.48 | $1.95 | $1.49 | $3.44 | [Sold comparable](https://www.ebay.com/itm/198660215739) |
| Shai Gilgeous-Alexander #35 (Base) | $2.00 + $0.00 | $2.00 | $1.49 | $1.49 | $2.98 | [Sold comparable](https://www.ebay.com/itm/128110919846) |
| Adou Thiero #96 (Base) | $0.99 + $0.78 | $1.77 | $1.49 | $1.49 | $2.98 | [Sold comparable](https://www.ebay.com/itm/227494310877) |
| Trae Young #19 (Base) | $1.99 + $0.00 | $1.99 | $1.49 | $1.49 | $2.98 | [Sold comparable](https://www.ebay.com/itm/336726119668) |

These are **single-comparable review estimates**, not final market-price recommendations. Product Research sold rows and full-size matching-photo previews are saved locally. Source condition is unknown and receives no premium. For Shai, Adou and Trae, the $1.49 item floor pushes the buyer total above the supplied sold total; those need an economics review rather than an automatic price change. A 90-day current-market research window was used separately from the retained 2025 and 2026 YTD own-sales exports. No all-time coverage claim is made.

Warning text is not fully reliable: for example, OpenAI's Adou pricing response says sale year was not supplied even though the packet includes 2026-09-12. The packet also omitted an explicit evaluation-as-of date, so freshness could not be consistently assessed. A future packet should include that date and validate warnings against supplied fields.

The listing stage exposed inconsistent handling of retained estimate prices: some responses kept the supplied item price while others returned null. All successful corrected listing responses set ready:false because condition/final eligibility or estimate review remained unresolved. This is not evidence that draft preparation must stop: a model's boolean must not replace stage-specific workflow rules. Draft content, pricing evidence, draft-save eligibility and publication readiness need separate deterministic states.

## Spending and timing

Known-usage list-price estimate across originals and retests: **$0.9462**. **Exact billed total is unknown**, because 26 failed attempts returned no usable usage, and provider invoices/cache adjustments have not been reconciled. Failures are not counted as free. Historical cumulative spending is also not reconciled. This report makes no claim that the old $5 ceiling was proven.

Exact-model input/output rates used per million tokens: OpenAI $2/$10; Claude $2/$10; Grok $2/$6; Gemini $0.75/$3.75 introductory rate. Sources checked during this run: [OpenAI](https://developers.openai.com/api/docs/models/gpt-6.1-sol), [Anthropic](https://platform.claude.com/docs/en/models/sonnet-5-5/overview), [xAI](https://docs.x.ai/developers/pricing), [Google](https://ai.google.dev/gemini-api/docs/latest-model). The older harness cost table can prefix-match grok-4.7 to grok-4 rates; use consolidated-live-results.json for this report's corrected estimates, not legacy report cost fields.

Elapsed time from first generation attempt to last recorded outcome: 20.99 minutes, including research/repair intervals between stages. It is not an unattended card-to-draft time. Recognition ran serially; subsequent stages ran providers independently. User/browser research and model time are not conflated.

The existing deterministic pricing function calculated all five candidates in median 0.0013 ms per batch (10,000 actual local batches, p95 0.0037 ms). This excludes research, I/O and identification. It demonstrates that final arithmetic need not consume LLM calls; it does not claim the whole listing pipeline now runs that fast.

## Repairs implemented and validation

1. Added scoped durable attempt accounting with explicit retest labels, duplicate prevention and original-attempt linkage. No silent retries or ledger resets.
2. Implemented a listing-content comparison stage, preserving model output, usage and elapsed time without eBay writes.
3. Fixed pricing wire schema: warnings must be required for strict output while local parser defaults remain compatible.
4. Fixed listing specifics wire schema: explicit name/value entries replace an arbitrary-key object. OpenAI now produces structured responses; Claude now populates specifics rather than returning an empty object under its transformed schema.
5. Added allowlisted failure categories/HTTP status, excluding provider text, request bodies, credentials and URLs. This revealed Google's HTTP503.
6. Added regression coverage for actual SDK schema conversion, redaction and explicit retest durability. **39 focused tests passed; npm run build passed.** Failed intermediate validations are retained. Ten original-image integrity checks passed.

CAPAs benchmark-failure-diagnostics and benchmark-provider-schema-contract are in monitoring; promise-only-execution-stop remains open. Implementation/test success is not claimed as sustained operational prevention.

## Recommended routing and next improvements

| Priority | Recommendation | Evidence / completion test |
|---|---|---|
| 1 | Keep a single primary recognizer; use OpenAI as the current default and Claude as a close alternative. Escalate only uncertain fields. | Both read all core fields correctly; Claude slightly faster on average, OpenAI supplies visible Topps Chrome branding. Do not pay four models for every production card. |
| 1 | Keep prices and workflow state deterministic; use models for evidence interpretation and explanations. | Three providers agree on arithmetic; the local function is far faster. Validate every output price against the shared policy and preserve estimate labels. |
| 1 | Use a deterministic listing template with a canonical specifics map, optionally OpenAI for prose cleanup. | Corrected OpenAI is fast; all models still introduce review/meta language and inconsistent null-price decisions. Require no internal commentary and no unsupported condition/grade. |
| 1 | Add explicit as-of date, evidence freshness, per-field provenance and stage-specific readiness to each handoff. | Prevent false missing-date warnings and stopping draft-content work because publication readiness is incomplete. |
| 2 | Resolve the Google service failure before a fresh bounded retest; retain all original failures. | Corrected pricing request must return a valid response before retrying remaining Google cells; HTTP503 is the current concrete blocker. |
| 2 | Use exact-model rate matching and reconcile billing for failed calls. | Never apply grok-4 rates to grok-4.7 merely by prefix. Current consolidated report corrects estimates only; shared rate-table cleanup remains outstanding. |
| 2 | Expand market validation beyond one comp and separate retrieval quality from calculation quality. | At least several independently verified same-variant sold comps per card, source shipping/condition and a held-out expected result. This run does not establish which model researches pricing best. |
| 3 | Benchmark cached image normalization and bounded card/provider concurrency separately. | Preserve original hashes; compare equal-quality inputs and measured whole-pipeline time. No invented speedup from this test. |

## Exact remaining blockers

- Google generation path: HTTP503 on the corrected pricing diagnostic; preceding attempts included ~90-second timeouts. Model-list/credential metadata checks succeeding did not prove successful generation. No Gemini accuracy ranking is possible from these failures.
- Exact billed spending: missing usage on failures and no reconciled provider billing export.
- Production/draft readiness: physical condition, shipping/policy eligibility and stronger market evidence remain review items. This test intentionally made no eBay writes and does not claim five saved drafts.
- Strong ranking: only five cards and one selected sold comp per card; no repeated randomized trials or independent retrieval benchmark. Grok's prior-chat pricing hypothesis remains untested.

All independent authorized comparison work has been carried through to retained outcomes and this report. Broader automation remains paused. Resume the incomplete four-provider cells after changed Google availability, using a new explicitly labeled attempt in the same journal; never overwrite the original evidence.

## Evidence index

- artifacts/model-benchmark/cactus-five-20261025/consolidated-live-results.json — per-call results, checks, times and exact-model cost estimates.
- authorized-calls.jsonl — durable original and retest attempts.
- shared-market-evidence.json, five *-research.txt files and five *-comp-preview.png files — common pricing evidence.
- recognition-cases.json, pricing-cases-live.json, listing-cases-live.json — identical stage inputs.
- live/, live-pricing-*/, live-listing-results.json and schema-v2-* — separate original/corrected outputs.
- final-tests.log, final-build.log, original-integrity-final.json and deterministic-pricing-timing.json — validation and measurement.


## Gemini recovery executed October 25, 2026

Latest status: **blocked by Google daily quota (HTTP429)**, superseding the earlier HTTP503-only diagnosis. Direct generateContent, Interactions and AI SDK probes returned503 even with a minimal prompt; a legacy model control returned404. Subsequent generation admission returned429. The final sanitized QuotaFailure confirms a per-day quota; RetryInfo requests 45,746 seconds, approximately until 2026-10-26T06:59:58.364Z (2:00 a.m. Chicago October26). This is evidence for the tested project/route, not a claim of a global Google outage.

Implemented actual structured-generation admission, bounded explicit retries, server-directed delay handling, no quick retries for daily/zero quota, per-call durable evidence, and a recovery command that uses the exact saved five-card inputs. A failed gate sends zero card-batch calls; transient card-stage failures trip a provider circuit breaker. No silent model substitution or existing evidence overwrite. CAPA benchmark-generation-admission remains under monitoring, not closed.

Executed 11 additional diagnostic/admission calls; none produced a usable response. Overall journal: 102 attempts, 65 results, 37 failures. Diagnostics are excluded from accuracy and speed rankings. Prior known-usage list-price estimate remains $0.94621; additional failed calls supplied no usage, so exact billing remains unknown. **Gemini remains 0/15 completed comparison cells.** The other three providers' saved results are preserved. No Gemini quality or speed ranking is possible.

Validation: 46 focused tests passed. Build status is recorded below after completion. Evidence: gemini-quota-detail-recovery.json, gemini-recovery-summary.json, gemini-final-tests.log and the unchanged append-only authorized-calls.jsonl.

Exact unblock: let the project's daily generation quota reset, or have the Google account owner review/increase its applicable quota/billing in AI Studio. No key rotation or prompt changes will remove a daily quota. After changed availability, run scripts/gemini-benchmark-recovery.ts with a fresh gemini-prefixed run ID; it verifies structured generation before resuming all15 cells. Do not retry the unchanged hold. No Google billing settings were changed.

Final Gemini recovery validation: npm run build passed (exit 0), all 24 static pages generated; 46/46 focused tests passed. Evidence: artifacts/model-benchmark/cactus-five-20261025/gemini-build-final.log. No commits, deployment, eBay changes or pricing-rule changes.



## Pricing interpretation corrected
See docs/cactus-five-comp-audit-2026-10-25.md for multi-comp/photo and seller-history recheck. The original single-comp results measure arithmetic only. Josh/Trey/Shai price evidence requires review; no model consensus authorizes a price. The seller now limits pricing to30 seconds/card and directs unresolved prices to unpriced draft preparation.


### 2026-10-25T18:58:17.910Z: five-card draft handoff completed
Four unpriced drafts verified: Josh Giddey 5436189206312; Trey Murphy III 5436132805711; Shai Gilgeous-Alexander 5434392115210; Trae Young 5436154011311. Adou active 128155931241 quantity1→2 explicitly authorized and verified; price unchanged. Draft dispatch remaining0. Final build passed;157 broad tests and43 focused tests passed (overlap). Additional paid calls0/API spend$0. Originals retained. Incomplete-draft price/description/shipping/promotion review remains; no publication. Full evidence/timings: docs/cactus-five-draft-results-2026-10-25.md.
