# Pricing scarcity sanity check — 2026-10-22

Approved by Josh: implement the recommended deterministic pricing check following the Dick Vitale /25 versus /99 example. This adds a veto to the existing factory branch, not a production deployment or eBay change.

- Primary completion evidence remains validated sold transactions. Related anchors must match player, season, set, manufacturer, card number, sport, autograph/memorabilia and condition; only parallel and print run may differ. Existing serial, date, disclosed-price, lot and own-acquisition checks apply.
- Store sale date, source URL/ID, buyer total, source/target runs and the resulting math. Unknown shipping is not zero. Related estimates use buyer total × source run / target run.
- Fewer than five exact confirmed sales cannot override supplied numbered-parallel math downward. Numbered cards with thin evidence need related evidence or a documented search showing no usable anchors. Five exact sales can outweigh math, but cannot justify a proposed total below their own mean.
- A reduction exceeding 25% against a known prior handoff total requires strong exact evidence. This 25% threshold implements the proposed large-reduction review safeguard; it is not a market-value formula.
- Failed checks retain the rejected proposal and evidence in the card's held job, expose no actionable projection, preserve input asking prices, and allow independent cards to continue. Pricing history preserves evidence invalidated by a changed guard/input.
- Historical numbered-card asking-price approvals cannot bypass the new validation. The review UI blocks numbered approvals with fewer than five exact comps; use the orchestrator for related-parallel review.
- Exact dates remain subject to the existing 90-day evidence window. Related anchors are revalidated on completed-result reuse.

## Submission contract

Pricing completion may include `scarcityComps` using the existing full sold-comp structure, or `scarcitySearchEvidence` documenting the related search and lack of usable anchors. `basis: related-print-run` uses its own comps as anchors. The guard does not fetch market data itself. Missing search evidence creates a per-card hold; no broad retry/research is initiated automatically.

## Limits

The branch still contains the older item-only premium calculator. This change vetoes unsafe results; it does not silently certify that calculator as the latest fair-buyer-total policy. Active-only evidence ingestion, all external writers, deployed adoption and a shared sales-evidence database remain separate work. The source queue cannot upload or publish. No legacy price is automatically repriced.

## Sample size and numbered-anchor priority

Aim for five recent exact sales. Three to four exact sales are moderate evidence; one to two remain provisional review estimates. Five independent exact sales are required to override a scarcity contradiction or a major reduction warning. Related math requires three independent comparable sold observations. Consume lowest-print-run groups first (for a /25 target: /50 before /99 before /299); stop when the lower-run groups meet the three-sale sample. Retain excluded higher-run observations for audit, without diluting the selected estimate. A lower count is not a reason to invent evidence or stop the batch.
