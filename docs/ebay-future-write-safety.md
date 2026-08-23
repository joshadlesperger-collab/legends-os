# Future eBay write safety (proposal; Phase 1 remains read-only)

Sales Velocity Phase 1 contains only GET adapters and recommendation UI. A future write provider must be separate from read providers and must fail closed unless all gates pass:

1. `EBAY_WRITE_ENVIRONMENT` exactly identifies `sandbox` or `production`; absence disables writes.
2. A provider identity check must prove the credential environment, application ID, marketplace, and intended seller account before mutation.
3. `EBAY_<ACTION>_WRITES_ENABLED=explicitly-approved` must be action-specific; a generic development-mode bypass is forbidden.
4. OAuth grants must be checked for the exact write scope and seller identity. Read failures never fall back to broader or production credentials.
5. Every mutation requires an approved operator decision, immutable economic ceiling/floor, fresh revalidation, idempotency key, audit event, and terminal-state protection.
6. Sandbox and production queues, tokens, base URLs, worker identities, and audit labels remain distinct. Cross-environment mismatches block execution.
7. Rollout requires sandbox evidence, a dry-run identity probe, explicit production-readiness approval, action rate limits, and a kill switch.

No Phase 1 route calls `send_offer`, listing revision, price update, campaign/ad mutation, or another eBay write endpoint.
