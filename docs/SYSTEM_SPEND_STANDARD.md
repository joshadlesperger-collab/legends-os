# Spending visibility standard

Approved by the user on November 6, 2026 for Legends OS and future systems built together.

Include a compact spending/budget indicator in the shared top-level application shell when paid tools or services apply. Make it expandable so routine work stays prominent.

- Distinguish actual provider credit balance, an application's enforced budget, and subscription/usage allowance. Never present one as another.
- Label each metric's service, scope, period, currency or other unit, source, and observation time. Show reserved/unknown usage separately from recorded actual spend.
- Use supported live data when available. Otherwise show unavailable or a clearly dated manual snapshot; never invent zero, freshness, or API access.
- Allow additional tools to be tracked without suggesting they have a live integration. Manual planning budgets must not change real enforcement limits.
- Keep credentials and raw account/card data out of the header response. Apply existing authentication and same-origin write protections.
- Cache/poll conservatively so observing spend does not become the production bottleneck. Show stale/offline status honestly.
- Retain this standard when creating future systems; adapt the implementation to their architecture rather than introducing unnecessary infrastructure.
