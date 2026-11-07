# Multi-model benchmark (OpenAI / Claude / Grok / Gemini)

Local, head-to-head benchmark for card identification and pricing. OpenAI remains the default
production provider; Claude (`@ai-sdk/anthropic`), Grok (`@ai-sdk/xai`) and Gemini
(`@ai-sdk/google`) are opt-in via the provider router in `lib/ai-providers.ts`.

## Configuration

- Keys: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `XAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`
  (read by the provider SDKs only).
- Routing: `AI_PROVIDER`, or per task `CARD_RECOGNITION_PROVIDER` / `CARD_PRICING_PROVIDER`
  (`openai` | `anthropic` | `xai` | `google`). Default is always `openai`.
- Models: `CARD_RECOGNITION_MODEL` (legacy OpenAI), `OPENAI_MODEL`, `ANTHROPIC_MODEL`
  (default `claude-sonnet-4-5`), `XAI_MODEL` (default `grok-4`), `GOOGLE_MODEL`
  (default `gemini-2.5-flash`).
- Cost rates: `AI_MODEL_COSTS='{"model":{"inputPer1MTokens":3,"outputPer1MTokens":15}}'` overrides
  the estimate table in `lib/ai-model-pricing.ts`. Unknown models report `costUsd: null`; costs are
  never fabricated.

## Running

Overnight authorization (October 24): the guard additionally enforces $1 for `--phase initial` (default), $1 for `--phase retest`, and $2 combined. The remaining $3 of the cumulative $5 ceiling is protected. Phase reservations persist across restarts; unattributed prior spend conservatively counts against either phase. Retest inputs must be actual disagreements from the initial comparison. These limits do not authorize calls with unreconciled prior spending or unverified billing bounds.

Live execution now requires a durable combined $5 guard. The default provider list is all
four providers, and any missing credential blocks the entire live plan before calls.
The fixed journal is `artifacts/model-benchmark/spending-ledger.jsonl`; changing `--out`
or task filters does not reset it. Never delete/reset the journal or its unresolved lock
to continue spending. Reconcile interrupted calls and provider billing first.

Use `--bounds FILE` containing an array of reviewed `BenchmarkBound` records (see
`lib/ai-benchmark-budget.ts`): exact provider/model, input/output token upper bounds,
maximum serialized request bytes, positive worst-case input/output USD-per-million rates,
official source URL, justification covering image/reasoning/cache/long-context billing,
expiry and `allBillableTokensBounded: true`. A byte limit alone is not a vision-token
bound. Use a documented full-context bound or a verified request-specific token bound.
No model-prefix price fallback is accepted by the guard. Do not fill unknown values
with guesses. An unreviewed manifest does not authorize calls.

For the first journal only, pass `--prior-spend-usd AMOUNT` with reconciled prior benchmark
spend; later runs read the journal. Full reservations remain charged locally even when
observed usage costs less. Failures, timeouts and missing/inconsistent usage stop the
batch with the reservation retained. One HTTP request per call and no redirects or SDK
continuations are allowed. This may stop below $5, and is not an exact billing guarantee.

The selected real cases are `artifacts/model-benchmark/cases/five-card-cases.json`.
Live execution remains blocked as recorded in the October 24 report; the older examples
below omit mandatory live guard arguments and therefore fail closed if used with `--run`.

```bash
npm run models:benchmark -- --cases artifacts/model-benchmark/cases/pricing-sample.json           # dry-run: plan + provider status, no network
npm run models:benchmark -- --cases FILE --run                                                    # live, sequential, bounded to listed cases
npm run models:benchmark -- --cases FILE --task pricing --providers openai,anthropic,xai,google --run
```

Results save to `artifacts/model-benchmark/model-benchmark-<timestamp>.json` and `latest.json`.
Reports contain no image payloads (hashes only) and no credentials.

## Case files

`{ "schema": "legends-model-benchmark-cases-v1", "cases": [...] }` or a bare array.

- Recognition: `{ kind, id, images: [frontDataUri, backDataUri], expected? }` where `expected`
  carries `pairMatches`, `frontImageIndex` and/or `identity` fields to score against.
- Pricing: `{ kind, id, evidence, baseline: { buyerTotal, shipping } }`. The baseline buyer total
  comes from the existing validated pricing pipeline (`candidatePrice`); models propose
  `targetBuyerTotal` + `shipping` from identical evidence and the shared policy module recomputes
  the item price. Proposals are comparison-only: never approved, never written anywhere.
- Held pricing: `{ kind: "pricing", id, evidence, expectedHold: true }`. No fabricated
  numeric baseline. Correct behavior requires an explicit hold, null prices and an
  evidence-gap warning; this is an evidence-sufficiency subtest.

## Metrics

Per provider and task: accuracy (field-level vs `expected` for recognition; within 5% buyer-total
tolerance for pricing), mean latency, token usage, estimated cost, schema/validation failures, and
cross-model disagreements per case. Each run records the model's bounded `approach` summary
(max 280 chars). Chain-of-thought is never requested, recorded or stored.

## Boundaries

Recommendations in the report are advisory (`applied: false`). They never modify production
routing, pricing rules, approvals or eBay listings. The CLI performs no database, eBay or
deployment access. Run `npm run test:models` for the offline regression tests.


## Optional Meta Muse provider (2026-10-30)

Provider ID: meta. Default: muse-spark-1.3 (standard, not contributor). Set MODEL_API_KEY in local ignored .env.local; optional META_MODEL overrides the model. Obtain access/key from https://dev.meta.ai/docs/quickstart. Do not paste keys into chat or commit them.

Explicitly include meta in --providers openai,anthropic,xai,google,meta to prepare a five-provider comparison. Existing CLI default remains four providers. The shared Responses adapter sends image input and structured output, disables storage, and uses the existing guarded single-request transport with no retries. Tests verify the installed adapter's openai option namespace.

Advisory standard rates: $1.25/M input and $4.25/M output (https://dev.meta.ai/docs/pricing-rate-limits). This table does not authorize a paid call. Live execution still requires reviewed, unexpired Meta bounds for all image/input/output/reasoning charges, available credentials, existing persistence prerequisites and affordability of the entire plan against the existing spending journal. The combined $5 ceiling and stricter existing phase allocations remain shared across all five providers. Local accounting is not an exact billing guarantee. No Meta bounds or separate budget were created.
