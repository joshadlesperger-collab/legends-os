# Listing workflow audit — October 24, 2026

## Reliability repairs completed after the audit

The original findings below are retained as the before-state. The root problem
was a missing execution contract: decisions and successful fixes lived in chat
or side artifacts, while the preparation queue did not own the eBay draft
lifecycle. The seller repeatedly supplied the missing coordination. More agent
roles or another prompt would not have repaired that state gap.

The authorized repair now retains each capture's draft ID, resume URL, observed
disposition, pending write intent, current approval binding, exact verification
result and archive outcome in the normal queue. One configured writer lease and
`draft-dispatch` select the next action. Both legacy listing schedules are paused;
no autonomous replacement schedule was enabled. A local lease does not prevent
human or unregistered external edits. Current code is local and not deployed.

Eight captures were reconciled through supported browser observations: Tucker,
Mack, Bettis, Dack and Codie retain their five existing saved IDs; Lich, Memnarch
and Loyal were already live and are excluded. Dack/Codie's invalid floor-price
offers were disabled without changing approved asking prices. All five saved
drafts passed field, shipping/policy, issue-summary and original-photo checks.
The fresh five-row issue view has only Codie's country-origin information notice,
covered by the standing United States default. General promotion is still off;
the existing 3% promotion restriction and final publication handoff remain open.
No draft was created and no item was published during this reliability repair.

After the seller's explicit four-file move approval, Dack/Codie's source files
were removed through the supported archive protocol. All ten originals across
the five saved drafts are retained under their draft IDs, hash-matched, with
source paths absent. Original capture IDs and quantity did not change.

Restart proof includes an actual Tucker write intent, a new process returning
`reconcile-write-outcome` with the same draft ID, and subsequent saved/reopened
verification. Two final separate processes returned the same five completed
drafts and three live exclusions. Dispatch returned no task, zero remaining
actions and zero seller decisions for this scope. Regression coverage also proves
overnight completion retention, stale-worker fencing, changed-input invalidation,
unknown-outcome exclusion, approval guards and idempotent evidence replay.

The feedback loop records failure categories, repair instructions and verified
recoveries. It drives precise repair work and preserves completed evidence;
it does not self-train a model, silently change prices or rewrite seller policy.
The next validation is one bounded fresh batch through this same owner/dispatcher,
measuring completed drafts, repeat work, recovery time and seller interventions.
Do not add features or claim the 30–60 second target before that measurement.

Validation: **141 focused regression tests passed**; application and test
TypeScript checks passed. Required `npm run build` was attempted and remains
blocked at Prisma generation by the existing Windows DLL rename `EPERM`.
No deployment, commit or push. The remaining broader backlog is not completed.

Evidence: [final restart and archive proof](../artifacts/draft-reliability-20261024/restart-final.json),
[five saved checks](../artifacts/draft-reliability-20261024/five-final-results.json),
[fresh issue-review image](../artifacts/draft-reliability-20261024/five-current-review.png),
and [regression log](../artifacts/draft-reliability-20261024/regression-tests.log).

## Original audit findings

The workflow is still an agent-assisted preparation process with a fragile eBay handoff. It produces useful work, but it does not yet provide a dependable path to a submission-ready listing. The seller is compensating for missing receipt synchronization, incomplete saved-field verification, and browser recovery. Faster image recognition alone will not fix those problems.

This audit covers the latest saved batch (Tucker, Mack, Bettis), the preceding ten-card Chrome test, the five unfinished Magic drafts, and the large Pokémon run. Findings use saved browser evidence, queue events, source code and chat history. They are not a fresh eBay inventory inspection. The audit independently rehashed the latest batch's six archived originals and confirmed that their old source paths are absent.

## What actually finished

| Batch | Observed result | Time and limitation |
|---|---|---|
| Latest three-card trial | Three saved, photo-verified drafts; six originals archived; **zero with complete readiness evidence** | Browser interval 18:05:22–18:14:05 CDT: 8m43s, **174 seconds/card**. Excludes earlier research/approval/inventory and later archive/checker work. |
| Chrome, ten captures evaluated | Seven saved/photo-verified/archived drafts, three evidence holds; **zero certified ready** | Recorded elapsed 30m59s: 186 seconds/evaluated card, **266 seconds/saved draft**, including work on held cards. Initial viewing predates the timer. |
| Magic, five cards | Five draft IDs retained in browser artifacts; verification/archiving unfinished; Dack/Codie offers and one return policy need repair | Browser access failed at reopening. Several later seller requests did not resolve the same boundary. No honest completed-draft benchmark. |
| Pokémon, 238 captures | 237 captures in 176 historically verified draft groups; 474 original photos archived; Squawkabilly held | Intake to archive audit: 12h43m, **193 seconds/physical card or 260 seconds/draft group**. Includes waits and recovery; active work was not measured reliably. |

Pokémon's later reconciliation records 208 captures in 157 live groups and 29 captures in 19 draft groups, plus the held capture. Those are dated observations, not a current inventory count. “176 verified drafts” is cumulative history. Capsakid and Wooper subsequently needed return-policy/country repairs after the seller attempted submission. The saved/photo completion milestone did not establish submission readiness.

Sources: [latest checkpoint](../artifacts/saved-draft-trial-20261024/checkpoint.json), [Chrome handoff](../artifacts/chrome-test-20261024/handoff.json), [Magic draft IDs](../artifacts/magic-five-20261024/draft-map.json), [Pokémon progress](../artifacts/pokemon-20261023-201919/draft-progress.json), [Pokémon archive audit](../artifacts/pokemon-20261023-201919/completed-batch-archive-audit.json).

## Where work stalls and repeats

### 1. Saved drafts and the queue disagree

At audited queue revision 14065, all five Magic cards have **no `knownDraft`, no saved receipt, no exclusion and no verified receipt**. Their IDs and resume paths exist in `magic-five-20261024/draft-map.json` and `saved-links.json`. That directory is outside the receipt manifest allowlist. The draft map also still says `generated-not-yet-saved`, while the later chat and saved-link artifact report saved drafts.

The queue shows local listing work done, pricing evidence held, and expired inventory clearance. It cannot use its normal receipt route to resume those five drafts. Current holds prevent straightforward creation; this is a missing duplicate-protection input, not evidence that duplicates were actually created. The seller and chat history are supplying the missing connection.

**Repair owner: listing operator.** Bind the five recorded draft outcomes to the existing supported receipt/import path after resolving their saved state and original-pair mapping. Keep them excluded from new creation; do not fabricate verified-photo receipts or archive unverified photos. No new queue is needed.

Evidence: [frozen audit](../artifacts/workflow-audit-20261024/evidence.json), [resume paths](../artifacts/magic-five-20261024/saved-links.json), `receiptManifestPaths` in `lib/card-orchestrator-import.ts`.

### 2. The completion gate comes too late and its result is separate

The latest three checker reports correctly fail `issues.inspected` and `issues.errors`: an explicit eBay issue-summary inspection is missing. Photo/identity verification passed and archiving completed. General 3% remains off. Those are saved drafts with remaining work.

Fresh preflight routes all three to `listing-review` / `resume-existing-draft`, but repeats generic shipping/policy and save/reopen requirements. The standalone checker results are not consumed by the workflow/preflight code. This makes the next operator reconstruct which checks passed and which two actually remain. A safe generic hold is preferable to false readiness, but it creates needless repeat review.

**Repair owner: workflow maintainer.** Connect the existing saved-check evidence to the existing capture/draft record, with the same freshness and identity bindings. Preserve separate photo/archive and submission readiness milestones. Missing evidence stays incomplete; a saved confirmation never clears it.

Sources: [fresh three-card preflight snapshot](../artifacts/workflow-audit-20261024/three-card-preflight.json), `lib/card-saved-draft-check.ts`, `lib/card-workflow.ts`, `lib/card-orchestrator-flow.ts`. The global `alreadyListed` count also includes draft/scheduled/sold exclusions; `readyForUpload` is fixed at zero for this local-only runner. Neither is a count of submission-ready listings.

### 3. A prevention check existed, but the generator still made the mistake

Dack and Codie received offer thresholds equal to their $1.49 Buy It Now price. The seller caught eBay's rejection. A checker and written rule were added, but both the batch packet and price calculation still generated those invalid thresholds. The latest Bettis packet contained the same values; its saved expectation manually disabled offers instead.

**Fixed locally in this audit:** both generators now use one offer calculation. At $1.49 it emits `offersEnabled: false` and omits thresholds. Above the floor it keeps thresholds below Buy It Now. The bulk verification manifest retains the explicit toggle. Approved item/shipping prices are unchanged. Tests cover the floor, $1.50, normal prices, grouped manual-price export, and enabled-offer inequalities across cent amounts. Existing draft settings and historical packets have not been rewritten.

### 4. eBay entry and recovery dominate measured work

The Chrome test records:

| Stage | Recorded seconds |
|---|---:|
| eBay entry | 605 |
| Research | 338 |
| Inventory/shipping | 250 |
| Verification | 197 |
| Identity | 120 |
| Archive | 87 |
| Seller approval wait | 82 |
| Photos | 46 |
| Service wait | 32 |

Entry, inventory/shipping and verification consumed **64% of recorded work time**. Seller approval wait was only **4.4% of elapsed time**. Removing price approval would not address this bottleneck. Recovery was recorded inside other stages despite a separate recovery field reading zero; zero is not evidence of no recovery.

The latest three-card action log records a Tucker resume-link recovery and two Mack price-entry attempts. Its checkpoint reports a tool timeout and manual field repairs. Saved-field checks take milliseconds, but browser capture, navigation and visual inspection do not. Summing the partial action log or quoting checker milliseconds would conceal most of the actual work.

**Repair owner: listing operator.** Establish the working draft-resume route and persisted category/policy defaults on one existing draft before entering another batch. Retain exact resume URLs. Enter complete prepared fields, explicitly remove inherited specifics, and perform one complete save/reopen review. On failure, retain unfinished fields and the exact receipt; isolate that card after one focused recovery. Do not repeat a blocked navigation or bypass a security rejection.

### 5. Several control paths leave the seller coordinating

The Card Inbox heartbeat continues every 15 minutes, while another chat performs browser listing work. The queue declares `externalWriterPossible: true` and explicitly says the heartbeat has not adopted it. Recent heartbeat reads show five unchanged/no-progress passes and one quantity-import exception notification, not an automatic drain of the unfinished Magic drafts. Earlier checkpoints record concurrent `SOURCE_CHANGED` failures during preparation. This does not establish a collision in the latest three-card trial, but it does establish that a shared end-to-end owner has not been enforced.

The `Pokemon` chat records repeated seller instructions to finish the same five Magic drafts, opening the editor, supplying a screenshot, and asking again to fix fields. The worker still saw a different page and retained an earlier browser security block. The seller was acting as browser-session recovery and quality assurance.

**Repair owner: workflow owner.** Use one designated listing chat/browser owner and one fixed capture list. Explicitly migrate or pause the competing writer before claiming exclusive ownership; this audit did neither and did not message other chats. The seller's remaining role should be grouped price approval, genuine exceptions and the required final publication handoff.

### 6. Old failures and instructions remain operational debt

Tucker and Mack's original photo audits were held on October 18 because a queue-state file rename returned `EPERM`; targeted recovery occurred October 22. These were storage failures, not bad photographs. Identity/pricing evidence was subsequently reused in the latest trial. Mack's local listing text was prepared twice around pricing completion on October 24; that is local regeneration, not a second eBay draft. New buyer-total pricing required a legitimate later correction/approval; it should not be described as needless repeated research.

The runbooks still contain earlier item-only/9% instructions as well as the October 23 buyer-total/no-buffer decision. They require readers to discover the superseding rule. The required `npm run build` again fails at Prisma's Windows engine rename. The filesystem cause has not been proven; do not assert that OneDrive or a specific process caused it. New local improvements therefore cannot be presented as deployed, proven workflow improvements.

**Repair owner: maintainer.** Put the current rule and completion definitions at the top of the existing runbook, preserve historical evidence below, and separate runtime/build repair from listing sessions. Do not restart the user's runtime, modify credentials or weaken file-lock safeguards as a shortcut.

## Exact open work

| Saved work | Next owner | Remaining action |
|---|---|---|
| Tucker `5434032084413`, Mack `5434036336713`, Bettis `5433771726011` | Listing operator; seller only for restricted promotion/publication actions | Resume these IDs. Capture an explicit issue summary; resolve General 3% through the permitted route. Keep passed photo/field evidence. Six archived originals independently rechecked successfully. |
| Seven Chrome drafts | Listing operator / seller for restricted promotion step | Retain seven IDs in the handoff. Resolve promotion and establish readiness; retain the three pricing/parallel holds. |
| Dack `5433367654513`, Lich `5433367688013`, Codie `5433367682413`, Memnarch `5431347165910`, Loyal Tutor `5433367684413` | Listing operator | Restore the supported resume connection, repair Dack/Codie offers and identify/fix the missing return policy, verify all five pairs and persisted fields, then complete receipt-triggered archiving. Reconcile the queue's missing draft mappings. Both Ob Nixilis copies remain held. |
| Pokémon batch | Listing operator | Use dated live/draft receipts, retain Squawkabilly, and treat the already-recorded Capsakid/Wooper policy repairs as completed repairs, not new work. Later market changes require a fresh read. |

## Simpler operating sequence and release bar

Use the existing batch and queue: **fixed capture list → prepared proposal → one grouped seller price review → save/resume existing drafts → complete saved review → receipt/archive → final user handoff**. An exception gets one reason, evidence, a next owner and a concrete resume condition; it does not stop independent cards. Unchanged approved work and verified evidence stay retained. A security/access blocker is reported once with the supported recovery needed, not turned into repeated seller prompts.

Before more feature work or a larger batch, demonstrate one bounded batch and a restart/resume of that same batch with: all created IDs retained in the normal queue; no duplicate creation or quantity increments; no repeated unchanged approvals/research; zero routine seller field repairs; every eligible original archived with matching hashes; and readiness reported separately from saved/photo-verified. Record time per evaluated capture **and** per completed draft, including failed work and recovery. The 30–60 second target remains unproven.

This audit made only the offer-generation repair and the current runbook entry below. It did not solve the browser connection, ingest the five unverified Magic outcomes, integrate readiness reports, change the automation, edit eBay or deploy. Those remaining failures are explicit work, not a claim that the process is now reliable.

Validation: **131 focused regression tests passed outside the Windows sandbox** after sandbox temporary-file rename failures; application and test TypeScript checks passed. `npm run build` was attempted before and after the repair and remains blocked by Prisma engine rename `EPERM`. No production deployment, commit, push, photo move or eBay write occurred in this audit.

Evidence bundle: [frozen source hashes, queue events, timings and archive recheck](../artifacts/workflow-audit-20261024/evidence.json). Audit collection script reads only selected local artifacts/originals and writes only its audit directory. Related chat evidence: `Pokemon` (`01a16b0a-3a17-7841-8ced-4b0154974977`, October 24 repair/access turns), `3. Listing Creation Agent` (`01a14596-1f4f-7281-b493-e8f7dfe7bea2`, six recent heartbeats), and `Assess 10-card scan-to-draft test` (`01a16632-124b-7701-adfa-7c3a0c58f396`, batch timing/activation reports).
