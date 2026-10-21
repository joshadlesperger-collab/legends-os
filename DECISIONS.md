# Decision index

Only record an approved decision as effective when its scope and precedence are clear. Link source evidence where available. A summary of conversation context is not proof of runtime enforcement.

## Change history and supersession

- Current operational rules: `docs/PRICING_POLICY.md` and `docs/LISTING_WORKFLOW.md`.
- Dated process changes: `docs/CHANGELOG.md`.
- Replaced decisions and source references: `docs/archive/`, following its README format.
- Preserve each decision's date, scope, rationale, status, and replacement link. Do not silently overwrite old decisions.
- Git supplies committed version history. Josh authorized committing and pushing these documentation changes on a separate repair branch on 2026-10-21. Consult Git for the resulting commit and remote branch.

| Date | Decision | Scope / status |
| --- | --- | --- |
| 2026-10-21 | Repair required gaps within the existing stack; avoid a platform rebuild. | Authorized in current conversation; continuity documentation repair started. |
| 2026-10-21 | Keep project instructions and handoffs separate from durable application records. | Architecture recommendation; application persistence still requires verification. |

## Policy reconciliation required

On 2026-10-21 Josh confirmed: the assistant bulk-uploaded cards with photos, left drafts, and Josh published them. Current routing is documented in `docs/LISTING_WORKFLOW.md`. Pricing reconciliation and explicit provisional-price handling are documented in `docs/PRICING_POLICY.md`. These documents supersede generic conversational proposals about manually attaching photos or treating all pricing review as a draft blocker. They do not establish live implementation.

Earlier discussions contain conflicting choices on weak-evidence pricing and automatic live price increases. Factory material also reportedly contains an older fixed premium. Inspect authoritative sources and effective dates before changing these behaviors. Do not resolve conflicts by silently promoting a historical conversation summary into executable policy.

## 2026-10-21 — confirmed pricing hierarchy (v2)

Josh directly confirmed exact recent sold comps first, numbered-parallel estimates second, active-market comparison/fallback next, and review when evidence is absent. Compare condition and buyer totals; corroborate shipping-heavy sales with multiple observations. Active-only pricing uses the credible floor after inspecting the lowest two comparable listings, replacing the earlier automatic minus-2–3% proposal. See `docs/PRICING_POLICY.md` for source scope and remaining unresolved parameters. Documentation authority is established; runtime enforcement remains unverified.

## 2026-10-21 — initial asking price without an offer buffer (v3)

Josh confirmed he lists fairly against supported comps and does not use a buffer today. No automatic 9% or 10% listing premium; target supported fair buyer-total value. Supersedes earlier buffer proposals. Existing offer settings are unchanged. Documentation is updated; runtime enforcement and recalculation remain unverified.

## 2026-10-21 — price-sensitive rounding (v4)

Josh specified nearest .49/.95 at $3 or below and upward .49/.95 above $3, allowing a small rounding buffer on larger cards. Apply after subtracting buyer shipping, using the unrounded item-price threshold. This supersedes the earlier all-prices-nearest proposal and does not reinstate a percentage premium. See pricing policy for examples and the tie convention. Runtime enforcement remains unverified.

## 2026-10-21 — hard $1.49 minimum (v5)

Josh specified no card ever below $1.49. Record a hard minimum item price with shipping separate; this overrides lower rounding results including the preceding $0.95 example. Apply to proposed draft/export/revision values and inspect offer/promotion execution for compliance before claiming enforcement. Runtime changes remain outstanding.
