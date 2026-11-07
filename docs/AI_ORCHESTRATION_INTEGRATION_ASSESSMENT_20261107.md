# AI orchestration integration assessment (nonproduction, 2026-11-07)

Scope: no new subscriptions, no model calls, no production writes. This branch adds only a provider-neutral telemetry **contract and unit tests**. It does not connect live OpenAI, Grok, or Muse calls, deploy a gateway, persist events, or verify eBay drafts.

## 1. Observability / Langfuse
The `AiWorkflowEvent` contract captures workflow/card identity, stage, provider/model, attempt, timestamps, elapsed time, token usage, cost provenance, sanitized error codes, and optional external receipt. Keep raw prompts, photos, personal data, credentials, and provider responses out of telemetry by default. Next: map actual provider call sites and instrument them in a development environment; evaluate Langfuse only after comparing native telemetry and hosting cost.

## 2. Model gateway / LiteLLM
Existing source tree does not establish central Grok/Muse routing. Before adopting LiteLLM, verify provider compatibility, API authentication and quotas, how externally scheduled jobs can report usage, and a fail-closed budget gate. LiteLLM does not control calls that bypass its gateway. Never enable paid dispatch or modify credentials during this assessment.

## 3. Shared PostgreSQL workflow
Current Prisma schema contains SyncJob and eBay action execution records, but no clearly named cross-provider card-to-draft execution record. Proposed data model (not migrated): CardWorkflow(id, cardId, stage, status, owner, version, createdAt, updatedAt), CardWorkflowAttempt(id, workflowId, provider, model, stage, attempt, status, elapsedMs, tokens, costUsd nullable, costSource), and ExternalDraftReceipt(workflowId, ebayDraftId, readbackVerifiedAt nullable). Add unique/idempotency constraints for event IDs and provider attempts. Receipt existence is **not** sufficient to claim verified draft: verify eBay readback and card/photo/price identity.

## Acceptance gates before deployment
- Compare deployed commit, database schema and live scheduled tasks with this repository; preserve current Grok/Muse hourly schedulers until proven safe to replace.
- Record actual provider events for a small authorized test batch with no production listing publication.
- Verify eBay draft readback separately; measure drafts/hour, stage latency, exceptions, unknown-cost coverage, and provider-reconciled USD per verified draft.
- Demonstrate interrupted-run recovery, duplicate suppression and safe replay; verify no accidental eBay writes.
- Present infrastructure costs and require explicit approval before paid services, production migration, credential changes or deployment.

**Limitations of the initial module:** It is an in-memory summary utility, not an event store, orchestration controller, Langfuse integration, LiteLLM integration, cost enforcement mechanism, or live dashboard. Its receipt-backed draft count is not proof of eBay readback verification; production KPI calculations must require independent readback evidence.
