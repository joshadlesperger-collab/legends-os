# Legends OS 26 controlled benchmark — October 24, 2026

Local implementation and preparation completed. Live inference is blocked, not completed.
No deployment, eBay writes, pricing-rule changes, database migration, commit or routing
change was made. Existing uncommitted work was preserved.

Resume verification: all four API credentials again returned HTTP 200. The linked Vercel
project was verified through the CLI after the connector returned project-not-found.
Database variables exist only as Sensitive Production/Preview settings; there is no local
or Development value. Obtain the **existing database's** connection string from its
owner/provider and securely set `DATABASE_URL` in this workspace's ignored `.env.local`
without replacing its other entries, or in the launch environment. Do not send secrets in
chat. No database creation, replacement or production environment change is required.
The resume again passed 28 model tests and TypeScript; the required build remains blocked
by the same Prisma DLL lock. The CLI missing-bounds rejection was explicitly exercised;
no paid call occurred. Full receipt: `artifacts/model-benchmark/resume-verification.json`.

## Completed

- Continued the existing four-provider SDK router and runner; did not rebuild the harness.
- Added a $5 combined, durable append-only budget journal. Each call reserves its entire
  reviewed upper bound before sending; reservations never refund. The same CLI journal
  spans providers, output directories and reruns. Microdollar accounting rounds upward.
- Unknown/expired/mismatched bounds, missing credentials, insufficient budget, corrupt
  journals and unresolved calls fail closed. Usage must include valid input/output counts
  consistent with the total and reservation. Any uncertain call stops the entire batch.
- SDK retries remain zero. The transport also permits only one request, disallows redirects,
  and checks the reviewed request-byte limit, blocking hidden retries/continuations.
- Failed/schema-invalid responses contribute to usage/cost summaries. Unknown cost cannot
  win routing as zero cost. Routing recommendations remain advisory.
- Added benchmark-only hold evaluation; the production pricing rules are unchanged.
- Read retained pricing context for all five cards and generated fresh exact-card preflight.

## Selected cases

| Category | Card | Capture ID | Pricing evaluation |
|---|---|---|---|
| Base | Scyther, Obsidian Flames 004/197, non-holo | LOS-3370573cffc97d8df6 | Current-policy comparison |
| Parallel | Tre Tucker, 2025 Prizm #162 Pandora 154/400 | LOS-60410520996dda134c | Current-policy comparison; review estimate |
| Low serial | Samuel Iling-Junior, Topps UEFA #146 Red 2/5 | LOS-5800451438316f3be4 | Hold: no supported sold basis |
| Weak evidence | Payton Pritchard, Prizm Black #212 Purple 25/99 | LOS-a838ff8251a734499d | Hold: conflicting/unknown source shipping |
| Previously mispriced | Rodrigue Beaubois, Optic #24 25th Anniversary 25/25 | LOS-cd21bce0d1312ad9af | Hold: retained proposal uses superseded policy; reconcile before comparison |

Ten cases and identical derived 1024-pixel previews are saved in
`artifacts/model-benchmark/cases/five-card-cases.json`. Original files were not modified.
`case-lineage.json` retains fresh proposal/review state, exact blockers and next owners;
`selected-cards.json` retains the complete selected source records and evidence.
Hold scoring is an evidence-sufficiency subtest with an explicit abstention contract, not
a blind end-to-end pricing accuracy claim. Recognition expected fields come from retained
human-reviewed identity; numeric year/rookie/grade fields lacking reliable labels are omitted.

## Credentials and live blockers

All four provider model-metadata checks returned HTTP 200: OpenAI, Anthropic, xAI and Google.
No generation was requested. OpenAI's key is inherited by the current process and absent
from `.env.local`; it is not missing in this session. Persist the same credential through
the supported local environment if future shells need it; do not paste keys into chat.

`DATABASE_URL` is absent. Read-only Prisma verification failed with
`PrismaClientInitializationError`. Configure the existing database connection through the
supported local environment before resuming; do not create a new database or migrate as a
workaround. No database or graph persistence is claimed.

A reviewed cost-bound manifest is also required before live calls. The old estimate table
does not establish hard bounds on multimodal and reasoning usage. The default `grok-4`
alias requires resolution: xAI documents retired model redirects with different billing
([retirement notice](https://docs.x.ai/developers/migration/may-15-retirement)). Validate
the exact selected models and current billing before enabling a manifest; no production
model defaults were changed. Local accounting is not an exact billing guarantee and does
not constrain unrelated callers, account surcharges, or out-of-band ledger deletion.

## Persistence verification

Before/after SHA-256 checks match for the 1,086-card orchestrator state, recovered knowledge
snapshot and catalog. All ten selected original photos match retained hashes. Four selected
cards map by normalized front hash into the historical recovery snapshot; Scyther is absent
from that older snapshot. This is a coverage gap, not a new deletion. No existing card,
observation, evidence record or knowledge source was changed. Database verification remains
blocked, and no new live observations were created.

## Validation and measurements

Validation receipts are under `artifacts/model-benchmark/`:

- Mocked provider and guard tests: **28/28 pass**, see `test-models.log` (including restart, locking,
  invalid/unknown usage, cap exhaustion, transport fencing and hold behavior).
- TypeScript: **pass**, `typecheck.log`.
- Final full regression: **526 tests, 524 pass**, two known failures retained separately
  (`regressions-final.log`; baseline was 518 tests, 516 pass):
  `card-orchestrator.test.ts` expects old “Price approval required” report copy;
  `card-preparation.test.ts` expects the superseded pre-draft approval exception.
- Required `npm run build`: blocked before compilation by the existing Prisma Windows
  query-engine DLL rename `EPERM`. No unrelated process was stopped. Supplemental direct
  Next.js build **passed**, recorded in `next-build.log`; it does not replace the required build.

Live identification accuracy, pricing compliance, latency, tokens, disagreements and
approach summaries: **not measured**. No model winner is supported. New generation calls:
**0**; new generation spend: **$0**. Previous account spending is not inferable from this
local run; reconcile it before initializing the cumulative ledger with `--prior-spend-usd`.
Mock timings and outputs are test fixtures, not provider performance evidence.

## Next steps toward 30 seconds per card

1. Restore the existing database connection; verify selected inventory/evidence and graph
   readback, including the Scyther coverage gap, through supported persistence flows.
2. Confirm exact benchmark model IDs and conservative current billing bounds; reconcile
   prior spend. Run the already-authorized controlled benchmark through the same journal.
3. Keep deterministic evidence holds and pricing arithmetic outside model selection. Reuse
   capture-bound identification and validated comp packets; avoid repeating unchanged holds.
4. Measure one primary recognition call, then escalate only disagreement/serial ambiguity.
   Compare concise observable-evidence summaries for reusable prompts after live results.
5. Time photo preparation, recognition, evidence lookup, deterministic pricing and persistence
   separately. Use p50/p95 and failure counts, with a 30-second total target; do not infer
   end-to-end speed from model latency or apply routing changes automatically.
