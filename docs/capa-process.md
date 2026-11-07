# Corrective and preventive action (CAPA)

Every discovered process failure or recurring gap gets a durable CAPA in `artifacts/engineering-mission/work-queue.json`, linked to executable engineering tasks. Incident repair is containment; it is not proof that recurrence has been prevented. Preserve original evidence and permissions.

At each engineering run, run `node --experimental-strip-types scripts/engineering-work-queue.ts capa-sync-drafts`, then `capa-status` and `dispatch-owned WORKER`. Synchronization imports changed saved-draft failure counters and admits investigation tasks. Unchanged counters do not create duplicate work. Other process gaps require `capa-record PACKET`; do not wait for a recurrence to record a known systemic gap.

Each record requires an owner, due date, linked task IDs, immutable incident evidence, containment, root-cause status, corrective action, preventive action and a predefined measurable effectiveness plan. Confirm a cause only with supporting evidence. Use the owned task claim/checkpoint protocol to implement actions. Isolate external blockers and continue independent tasks. Overdue records appear in dispatch; review their owner and required next action without repeatedly retrying unchanged holds.

Use `capa-record PACKET` to enter monitoring after implementation, supplying implementation evidence and time. Use `capa-check ID RESULT` for effectiveness. Its result contains the exact predefined criterion, kind (`live` or `local-regression`) and distinct observations with ID, time, passed and evidence path. Closure requires a confirmed cause, completed linked tasks and enough passing post-implementation observations. A local regression cannot satisfy a live plan. File evidence is checked and hashed by the CLI; the operator must also verify that it supports the stated observation. Hashes establish provenance, not truth.

A failed effectiveness check or new incident reopens the CAPA and retains history. New failure counts admit new action tasks. Do not reset counters or erase prior incidents. Saved-field recovery counters alone are not evidence of sustained prevention. Live effectiveness remains pending until authorized real operations supply the planned observations; this process grants no eBay, spending, deployment or database permissions.

Report implementation validation separately from open effectiveness checks. The CLI persists and dispatches work; scheduled or interactive agent runs execute it. It does not run an agent continuously between sessions.

Before interpreting saved-field failure counters as current repair inventory, run `node --experimental-strip-types scripts/engineering-work-queue.ts capa-draft-context`. This read-only view distinguishes retained historical failures after known live/sold handoff from records requiring current draft reconciliation. It never resets counters or replaces fresh seller observation or CAPA effectiveness evidence.

## Recurrence controls — 2026-10-28
Read docs/bowman-rcca-2026-10-28.md before the next batch. bulk-ai-checkpoint retains observed phase/recovery failures; capa-sync-drafts imports these incidents automatically. A failed recovery holds unresolved captures and never permits reupload. Apply shared edits first and pass a native-input saved/reopened pilot before repeating corrections. Live effectiveness remains open; tests or recovered IDs alone cannot close CAPA.
