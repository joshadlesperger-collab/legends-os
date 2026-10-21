# Repository Agent Operating Model

## Project continuity

- At session startup, read `CURRENT_STATE.md` and `DECISIONS.md`. Read `README.md` for orientation and only the domain procedures relevant to the task.
- Verify the current branch, working tree, and source evidence before relying on a previous handoff. Repository implementation is not proof of deployment or live operation.
- Before ending substantial work, update `CURRENT_STATE.md` with verified changes, validation, unresolved blockers, and the next concrete action. Never record planned work as completed.
- Record approved durable decisions with date, scope, and supersession in `DECISIONS.md`; flag conflicting instructions instead of silently choosing a policy.
- Keep operational card progress, evidence, and execution checkpoints in durable application records. Markdown handoffs do not replace application persistence.
- For card preparation, read `docs/PRICING_POLICY.md` and `docs/LISTING_WORKFLOW.md`. Historical CSV prices are evidence of earlier work, not current approved prices. Follow the draft/publication distinction in those documents.

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
