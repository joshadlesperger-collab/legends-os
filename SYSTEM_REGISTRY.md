# Legends OS — Operational System Registry

Last reviewed: 2026-11-12 (America/Chicago)
Purpose: Durable discovery map for every assistant and operator. Read before asking the owner where production lives. This document is **not** proof of current runtime health.

## Verified identifiers and evidence
- GitHub repository: `joshadlesperger-collab/legends-os`; default branch `main`. Verified via connected GitHub on 2026-11-12.
- Application architecture in repository: Next.js, Prisma/PostgreSQL, eBay OAuth, listing/order synchronization, `/sales`, `/stores`, traffic reporting. **Code presence does not prove deployment or successful sync.**
- Vercel connected account has team **Legends**, slug `legends17`, ID `team_dDuFlWun18GDzHrQAFN45CdV` (verified via team listing 2026-11-12). Both personal scope and this team returned zero projects and zero recent deployments in read-only listing calls on 2026-11-12. **This does not prove production is absent**: it may reside in another Vercel account, a disconnected integration, or a different host.
- Windows laptop/workspace: operator reports an active local workflow; exact workspace path, connectivity, and current execution state **not verified**.
- Production URL, Vercel team/project IDs, deployment revision, database host/instance, scheduler endpoint, eBay store identifiers and last successful sync: **unverified**. Never guess or fill from a different project.

## Required discovery order (read-only)
1. Read this registry, `AGENTS.md`, `CURRENT_STATE.md`, and `DECISIONS.md`; check last verification dates.
2. Inspect the connected Vercel account **and all authorized team scopes**, repository/deployment link and configured project metadata. A zero-result name search is inconclusive.
3. Compare actual deployment URL, revision and environment with the repository. Confirm database/scheduler reachability without revealing credentials.
4. Inspect read-only job/sync status, `/sales` and traffic metrics, and source timestamps. Distinguish eBay production data from seeded, cached or local sample data.
5. If production access is unavailable, record the exact missing scope or permission once; do not repeatedly ask the operator for already documented locations.
6. Record each verified locator, evidence source, check time, owner, and next action here. Do not record credentials, tokens, database connection strings, private buyer data, or unsupported assertions.

## Quick operational questions
- **Is it running today?** Verify latest hosted job receipt, last successful eBay sync, backlog and verified draft count; distinguish local laptop tasks from hosted jobs.
- **What sold?** Use authoritative eBay order lines from both stores, with sync coverage and freshness; report daily revenue, units, orders, unique buyers when available, refunds and fees separately.
- **Why did sales spike?** Compare 2026-11-05 through 2026-11-08 with adjacent days and prior 28 days; correlate new listings (same day and previous 72 hours), impressions, views, old-vs-new inventory sold, order size, promotion/ad changes and known sporting events. Correlation is not causation.
- **What changed?** Check deployments and migrations, repository revision, sync failures and provider authorization.

## Runtime status — unverified
| System | Known locator | Last verified | Status / next step |
|---|---|---|---|
| Source | GitHub repo above | 2026-11-12 | Accessible; not proof of production |
| Vercel | Connected team `legends17` / `team_dDuFlWun18GDzHrQAFN45CdV`; project unknown | 2026-11-12 | Personal and team scopes return zero projects/deployments; identify correct account/connection |
| PostgreSQL | Unknown instance | Never | Locate through deployment metadata; read-only checks |
| eBay stores | Legends Trading Cards; Legends Trading Cards Too (operator labels) | Never in this session | Verify authorized accounts and sync freshness |
| Windows photo/processing queue | Unknown path | Never | Establish runtime boundary and safe remote status access |
| Daily operational report | Not confirmed | Never | Establish durable receipts and freshness alert after source verification |

## Maintenance contract
- Update after every verified change to production topology, integration, access scope or runtime status.
- Date-stamp each fact and retain unresolved blockers; do not overwrite unknown with zero.
- A daily machine-generated health receipt should live in durable application storage and report timestamp, store, source freshness, listing/draft throughput, orders/sales and failures. Do not treat this Markdown document as the live dashboard.
- Never deploy, change credentials, migrate data or publish eBay listings as part of registry maintenance without the required approval.
