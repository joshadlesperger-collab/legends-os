# Repository Agent Operating Model

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

## Card listing orchestration

- For card-inbox/orchestrator work, read `skills/card-orchestrator/SKILL.md` and `docs/card-orchestrator.md`, then the latest seller decisions in `docs/card-listing-factory-pilot.md`.
- The seller never scans the same physical card twice: distinct original front captures are additional inventory, even when visually identical. Do not ask again for physical-copy confirmation. Group only matching unnumbered variants/language/condition; different serials or parallels remain separate. Copied files, previews and reimports of the same original are not new captures. Track capture IDs so retries cannot increment stock twice.
- Use `npm run cards:orchestrate -- run --limit 10` and its claim/complete protocol for the new local preparation queue. Preserve source queues and original photos. Read its checkpoint before resuming; do not repeatedly rework unchanged holds.
- Before researching a card, run `pricing-context --card CARD_ID` through the orchestrator and consume the existing pricing agent handoff, validated results and matching-copy evidence first. Research only documented gaps. Claims serialize matching pricing identities; retained evidence still requires per-copy validation.
- Before any listing batch or price answer, run `preflight --cards CARD_ID,CARD_ID` through the orchestrator. Use its freshly generated `artifacts/card-orchestrator/handoff.json` and `handoff.html`: show the price proposal, review status, next owner and exact blockers. A prepared title or existing draft is not a completed listing. Resume saved draft IDs; never recreate them. Existing drafts can complete local photo, identity and pricing work. No price approval or eBay persistence is implied by the packet.
- This queue cannot upload or publish. The existing Card Inbox automation has not yet adopted it and remains a possible external writer. Do not claim cross-chat coordination is complete or bypass the current final publication handoff.
