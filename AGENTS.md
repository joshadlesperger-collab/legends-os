# Repository Agent Operating Model

## Project continuity

- At session startup, read `CURRENT_STATE.md` and `DECISIONS.md`. Read `README.md` for orientation and only the domain procedures relevant to the task.
- Verify the current branch, working tree, and source evidence before relying on a previous handoff. Repository implementation is not proof of deployment or live operation.
- Before ending substantial work, update `CURRENT_STATE.md` with verified changes, validation, unresolved blockers, and the next concrete action. Never record planned work as completed.
- Record approved durable decisions with date, scope, and supersession in `DECISIONS.md`; flag conflicting instructions instead of silently choosing a policy.
- Keep operational card progress, evidence, and execution checkpoints in durable application records. Markdown handoffs do not replace application persistence.
- For card preparation, read `docs/PRICING_POLICY.md` and `docs/LISTING_WORKFLOW.md`. Historical CSV prices are evidence of earlier work, not current approved prices. Follow the draft/publication distinction in those documents.

## Production-first listing orchestration (2026-10-26)

For card-listing runs, the primary outcome is **new, verified eBay drafts per elapsed hour**, not agent activity, commits, research volume, or queue movement. Engineering work is a means to restore or improve production, not a substitute for it.

- At run start, reconcile existing photographed/identified cards against current eBay drafts and live listings. Choose eligible cards with the fewest remaining steps; reuse valid identification, images, pricing evidence, and prior checkpoints. Do not re-research completed work without a specific reason.
- Prefer the shortest previously demonstrated authorized bulk-draft route, including photos. Do not invent a replacement platform, agent, or handoff before testing whether the known route is available. eBay AI may prepare fields where supported; independently validate card identity, price, shipping, and image mapping.
- Work through independent cards while isolating uncertain identities, weak prices, missing images, and provider errors in a reason-coded exception queue. Do not let one card halt the batch. Keep duplicate prevention and verified receipt reconciliation mandatory.
- For an active production run, check progress at least every 30 minutes. If verified-draft count remains unchanged, inspect stage timings and logs, name the current constraint, try the smallest safe correction, and measure the result. Do not repeatedly add rules, agents, or research steps without evidence of improved end-to-end flow.
- Record start/end timestamps, eligible backlog, stage transitions, verified drafts, held cards by reason, retries, human interventions, and measured AI/API spend. Report drafts/hour and cost/verified draft; report unknown cost or unavailable provider verification explicitly rather than estimating success.
- A run with zero verified drafts is **not** a successful listing-production run, even if code or documentation improved. Report the precise blocker, what was attempted, and the next executable recovery action. Never claim an overnight job ran unless execution records verify it.
- Optimize the full photo-to-draft value stream, not individual agent utilization. Before adding a gate, prove it addresses a real error or required safety control; otherwise remove or bypass redundant work. Benchmark against the seller's manual throughput.
- Preserve approval boundaries: authorized draft preparation is distinct from publication. Never publish, deploy, migrate, change credentials, or perform other restricted writes without the required approval. Do not bypass price/identity safeguards or duplicate checks to improve throughput.
- If production access is unavailable, state which concrete dependency is missing and direct engineering only toward restoring that dependency; do not mislabel engineering output as eBay production.

## Engineering workflow

- Work end-to-end on requested features and bugs. Run the necessary development commands yourself instead of asking the user to run individual commands.
- Inspect the existing architecture, conventions, and relevant implementation before making changes.
- Make requested code changes directly and prefer solving the requested outcome over repeatedly stopping for minor implementation decisions.
- Preserve existing functionality unless the task explicitly requires changing it.
- Treat the existing uncommitted working tree carefully. Never discard, overwrite, or revert work that you did not create.
- Validate changes yourself with appropriate TypeScript checks, tests, and other relevant checks. Fix errors you introduce and iterate until validation passes.
- Always run the repository build validation command:

  ```bash
  npm run build
  ```

## Safety and data handling

- Never expose secrets, tokens, passwords, connection strings, or other credential values in output.
- Never rotate credentials, modify production environment variables, run database migrations, delete production data, or perform destructive database operations without explicit user approval.
- Use existing supported application flows, including OAuth, instead of ad-hoc database manipulation.
- Do not scrape unauthorized data sources.
- Keep Prisma and API usage efficient. Avoid unnecessary inventory-wide reads, writes, processing, or external API calls.

## Deployment and Git controls

- Before any production deployment, summarize what changed and the validation results, then ask for explicit approval.
- Creating Git commits and pushing to remotes require explicit user approval.
