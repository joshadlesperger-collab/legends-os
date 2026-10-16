# Card Listing Factory — pilot SOP
Updated: 2026-10-15
Status: Proposed workflow; eBay create/publish capability NOT yet verified. Do not claim drafts exist on eBay until confirmed by API.

## Goal
User uploads front/back photos via phone or scanner. Legends OS identifies a sports card, researches comps, prepares complete eBay listing, and queues a review. **Never publish without explicit user approval.** Support single-card first, then batch creation.

## Pipeline
1. Ingest photos, pair front/back, retain originals; flag missing or mixed-up sides.
2. Identify year, manufacturer, set, player, card number, parallel, serial number, team, grading/slab details. Check image confidence; do not invent attributes or condition grades.
3. Research recent **sold** comparables, prioritizing exact parallel and /numbering; note comp date, shipping and condition differences. Flag weak comp coverage.
4. Draft optimized original title, accurate item specifics, concise condition text and description. 'Sell Similar' may provide reference specifics, but never copy unsupported attributes or reuse another seller's images.
5. Propose Buy It Now approximately 110% of credible fair sold comp, adjusted for competing total cost; target Best Offers around 8–10% off list. Prices require approval.
6. Shipping defaults from seller conversation: under $10 $1.49; $10–$19.99 $1.95 for eligible raw cards; $20+ or slab/thick patch $6.29 tracked. Verify current eBay Standard Envelope eligibility, thickness, weight, order-value and category limits before service selection. Never use envelope when ineligible. Combined shipping pilot: +$0.50 per eligible additional card; prevent untracked over-limit mixed orders; best-offer orders may require manual handling. No existing eBay policy has been changed.
7. Create an eBay **draft or unpublished offer**, if currently authorized technical capability exists, using verified seller account, marketplace, correct policy IDs and images. Persist draft ID/API response and audit log. Do not publish unless the user explicitly approves that exact listing.
8. Present a review screen with original photos, card ID, comps with confidence, price, fees/estimated margin, shipping, title, description, and warnings. User may approve/edit/reject.
9. Only after approval, publish via verified integration and confirm live eBay item ID and listing URL. Handle errors without duplicate listings.

## First morning test (2026-10-16; user-initiated)
Test 3 cards:
- A: 2026 Topps Finest Hunter Goodman #155 Gold Geometric Refractor, numbered 30/50 (reconfirm from photos). Earlier external Work conversation reported comps $4.99, $5.50, $8.00 and tentative $6.49 BIN + $1.49 shipping; these are **unverified in this repo** and should be refreshed, not treated as approved.
- B: common raw single under $10 for envelope/pricing workflow.
- C: slab or thick patch to test tracked shipping and exceptional attributes.

For each card, measure time from paired photos received to **review-ready draft** (target 30–60 seconds, aspirational and unvalidated); percent of correctly filled fields; manual fixes; comp quality; shipping compliance; success/failure of eBay draft creation. Do not treat 15–30 seconds as guaranteed.

## Technical gates before eBay writes
- Inspect existing Legends OS eBay integrations, scopes, inventory vs Trading API pathways, image hosting, return/payment/fulfillment policy IDs and item-specific validation.
- Check docs/ebay-future-write-safety.md. Existing code references Phase 1 read-only; do not bypass safety flags or assume credentials permit listing.
- Before write, verify environment, seller identity, authorization, idempotency, payload validation, and explicit approval gating.
- If API draft capability is absent, create **local review-ready drafts** only and clearly report that they are not eBay drafts.

## Scaling
After a fully validated single-card draft and publish-with-approval flow, test 3–5 items; then prepare bulk batches up to the supported API limits with throttling, retries and an exceptions queue. Bulk preparation may be parallel; publishing stays approval-gated.

## Persistent assistant instructions
Treat this file as the source of truth for Card Listing Factory requirements. Keep a changelog in Git. Never claim a listing is live or an automation is installed until verified. Never store eBay credentials in Git.