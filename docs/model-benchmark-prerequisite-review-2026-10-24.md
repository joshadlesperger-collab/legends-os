# Four-provider benchmark prerequisite review — October 24, 2026

Outcome: **blocked before paid generation**. No live accuracy, latency, token, or winner results exist from this review. New generation calls: **0**; new generation spend: **$0**. This report consolidates the current findings; historical reports and receipts remain intact.

## Exact scope and preserved conditions

The existing packet contains five cards, each with recognition and pricing: 10 cases and 40 planned provider calls. Recognition uses the same two derived images per card. Prompts, schemas, evidence, expected holds, output caps (2,500 recognition / 1,200 pricing), and production routing were not changed. Three pricing cases intentionally test abstention rather than numerical pricing accuracy.

Branch: `feature/card-listing-factory-v1`. Existing uncommitted source changes were preserved. No migration, deployment, eBay write, pricing-rule change, credential modification, commit, or push occurred.

## Official models, prices, and limits

Prices below are USD per million tokens, standard direct-API list prices, not certified request reservations. Sources were opened during this review.

| Provider / model examined | Input / output | Documented limits | Fresh metadata result |
|---|---|---|---|
| OpenAI `gpt-6.1-sol` | $2 / $10 | 1,050,000 context; 128,000 max output | Exact model HTTP 200 |
| Anthropic `claude-sonnet-4-5-20250929` (alias `claude-sonnet-4-5`) | $3 / $15 | 200,000 context; 64,000 max output | Both alias and snapshot HTTP 404; model-list HTTP 200 |
| xAI `grok-4.3` (candidate replacing ambiguous configured `grok-4`) | $1.25 / $2.50 | 1,000,000 context; separate output maximum not established in fetched page | Exact candidate HTTP 200; no configuration changed |
| Google `gemini-2.5-flash` | $0.30 / $2.50 | 1,048,576 input; 65,536 output | Exact model HTTP 200; API returned these limits |

Sources and qualifications:

- [OpenAI model specification](https://developers.openai.com/api/docs/models/gpt-6.1-sol): cache writes $2.50/M; over 272K input, input/cache rates double and output rates increase 1.5x. Fast/Ultrafast and regional premiums must be excluded or bounded before execution. Text and image input are supported.
- [Claude specification](https://platform.claude.com/docs/en/models/sonnet-4-5/overview) and [pricing](https://platform.claude.com/docs/en/about-claude/pricing): 5-minute/1-hour cache writes $3.75/$6 per million. Documentation lists the model as deprecated, with retirement November 30, 2026. Documentation does not establish availability for this account; the exact-model checks failed.
- [Grok 4.3 specification](https://docs.x.ai/developers/models/grok-4.3) and [retirement notice](https://docs.x.ai/developers/migration/may-15-retirement): older listed slugs redirect to Grok 4.3, changing billing. Its page flags higher pricing above 200K context; the fetched page did not expose that tier's amounts. Do not carry forward the old `grok-4` estimate table as a hard bound.
- [Gemini specification](https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash) and [pricing](https://ai.google.dev/gemini-api/docs/pricing): output pricing includes thinking tokens. Access is limited to prior users. Metadata success verifies model visibility, not a successful inference or available paid quota.

The initial sandbox metadata requests failed at transport. A permitted network retry reached the providers and produced the HTTP results above. No error response bodies, keys, or other secrets were printed or saved. Anthropic's successful list check establishes credential acceptance; its two 404 results are a model-access blocker, not evidence that its key is invalid. The returned list page contained no Sonnet 4.5 IDs; no claim is made that all pagination was exhausted.

## Budget reconciliation and balanced selection

The fixed live ledger `artifacts/model-benchmark/spending-ledger.jsonl` does not exist. Existing `completion-status.json` explicitly records `priorAccountSpendVerified: false`; previous session receipts record zero generation spending but do not reconcile earlier benchmark spending across all callers. No local spending/billing ledger was found by the filename search. The checked `OPENAI_ADMIN_KEY` and `ANTHROPIC_ADMIN_API_KEY` environment variables were absent; that is not an exhaustive account-permissions audit. No authenticated billing statement or provider cost export was available to establish a reconciled prior benchmark total. Do not infer prior spending of zero from an absent journal.

For each prospective call j, the existing guard charges the nonrefundable reservation:

`r_j = ceil(inputBound_j * inputRate_j + outputBound_j * outputRate_j) / 1,000,000`

Full-batch eligibility requires `priorBenchmarkSpend + sum(r_1 ... r_40) <= 5`. A balanced subset containing k whole cards requires 8k calls: both tasks for each selected card, on all four providers, with unchanged source inputs. All reservations must be affordable before the first call; the current runner only checks affordability incrementally.

**The remaining budget cannot be proved positive.** Even assuming prior spend lies within the authorized $0–$5 cap, its worst permitted value leaves $0. Consequently the largest *currently certifiable* balanced selection is **0 cards / 0 calls**. This does not assert that the actual 40-call workload costs more than $5. It means neither 40 calls nor a positive smaller subset has a verified available budget. No subset file or spending journal was fabricated.

**Per-call billing bounds also remain uncertified.** The model context maxima are not useful small request bounds. For illustration, reserving OpenAI's full 1,050,000 context at the documented long-context cache-write ceiling of $5/M already reserves $5.25 before output. That deliberately loose envelope cannot fit even one OpenAI call; it is not an estimate of these small card inputs. A tighter bound must cover the actual serialized prompts, JSON schemas, image tokenization, provider framing, and all reasoning/output billing, with request bytes checked separately. Model output maxima and application output caps must not be conflated, particularly with hidden thinking tokens. The xAI higher-context rates/output ceiling and account model access also need resolution.

No executable manifest sets `allBillableTokensBounded: true`, because that claim has not been established. Public list prices alone are insufficient. Neither reducing card count nor swapping a Claude model resolves the independent unreconciled-spending gate; live model substitution was therefore not attempted after the stop condition was established.

## Guard and validation

- `npm run test:models`: **28 passed, 0 failed**. Mocked provider/guard tests ran; these are not live provider measurements.
- `npm run build`: **failed before compilation**, the existing Windows Prisma query-engine DLL rename `EPERM`. No process was terminated to remove the lock.
- Inspected the guard: durable pre-call reservations, a fixed cumulative journal, exclusive lock, no refunds, no SDK retries, one HTTP request, no redirects, and stop on uncertain usage. These protections do not independently establish provider billing bounds or prior spending.
- No TypeScript/source implementation changed in this review. Earlier typecheck results were not relabeled as fresh checks.

Logs: `artifacts/model-benchmark/prerequisite-review-20261024/test-models.log` and `build.log`. `model-access.json` retains the initial sandbox failure; `verified-metadata.json` records the subsequent network-enabled checks.

## Exact remaining requirements

1. Obtain a reconciled prior benchmark spend total from existing billing/usage records, scoped to this $5 authorization and including any interrupted or external benchmark calls. An authorized billing export or existing billing-access session can supply this; do not send secrets in chat or rotate credentials.
2. Resolve an accessible Claude model (or restore access to the documented Sonnet 4.5 snapshot) and pin benchmark-only model IDs, including an explicit xAI model. Recheck exact-model visibility and compatible structured-output/image support without changing production defaults.
3. Establish and validate request-specific conservative token/billing bounds for every selected model. Include documented reasoning limits, relevant cache/premium rates, request-byte ceilings, source URLs and expiry. Sum every nonrefundable reservation, then select the largest whole-card balanced subset that fits the reconciled remainder.
4. Re-run mocked guard checks for any changed implementation. Run live only after all gates pass, preserving the fixed spending ledger. A billing uncertainty or failed call stops the batch with its reservation retained.

The saved-packet CLI does not access the database: restoring `DATABASE_URL` is a separate inventory/knowledge readback task, not a technical gate for this comparison. The Prisma build failure is a validation limitation, also separate from the benchmark CLI's explicit gates.

## Evidence fingerprints

SHA-256 recorded after inspection; these existing files were never written by this review:

- `cases/five-card-cases.json`: `D3E1780C69D2C9569CC75786355CC9ED60AEE944520642DA97010A2FE5AB8DDD`
- `selected-cards.json`: `622D2B78E2DC6EC268F6A3D2BE9F869DE2EEFE2E29542A6E986A4785F4D4DFB9`
- `case-lineage.json`: `01167E5F3B41B6BAB578753946E07DBE27D80369B7BBED0C4D550630BE0DCF3D`
