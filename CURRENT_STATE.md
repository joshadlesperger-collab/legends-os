# Current state — scarcity guard — 2026-10-22

Base: feature/card-listing-factory-v1 at 0e89b1f99a4bf49bbbd938f6d1d07a8d88d7c365. Work branch: fix/scarcity-pricing-guard.

Implemented the deterministic scarcity/reduction guard at orchestrator pricing completion. Validated related sold evidence supplies buyer-total math, source references and sale dates. Failed checks retain rejected projections in held jobs, preserve inputs and do not stop independent cards. Pricing history retains evidence invalidated by changed inputs/guard. Completed related anchors are revalidated for freshness. Numbered historical approval and thin-comp UI bypasses are blocked; UI approval snapshots include guard version.

Validation: 309 tests passed; scarcity coverage includes lower-run-first selection and thin-sample holds; application/test typecheck passed; production build passed. No production deployment, database migration, eBay write or live repricing. No evidence was collected into a new master database.

Josh's sales-evidence database proposal and explicit sale-date requirement are captured in docs/card-sales-evidence-plan.md. This is design only. Database records should separate sale date from collection/verification time; unknown dates are not invented.

Limit: factory still has an older item-only premium calculator. This guard adds a veto; it does not certify all legacy pricing as compliant with later buyer-total/no-buffer decisions. Independent Windows/background writers and deployed adoption remain unverified. Review branch against its factory base before integration; do not infer production installation from a PR.
