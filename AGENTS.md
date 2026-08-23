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
