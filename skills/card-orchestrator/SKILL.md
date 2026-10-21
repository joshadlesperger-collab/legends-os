---
name: card-orchestrator
description: Run the Legends OS local card-listing queue for imaydit58, including original-photo audits, visual identity reviews, sold-comp evidence, duplicate reconciliation and local listing preparation. Use for processing the card inbox or resuming its orchestrator; this runner cannot upload or publish eBay listings.
---

Read `docs/card-orchestrator.md` for commands, role contracts and recovery. Read the current decision section of `docs/card-listing-factory-pilot.md` for the seller's latest instructions. Read `artifacts/card-orchestrator/build-checkpoint.json` and `status.json` before resuming. Resolve paths from the repository root, two levels above this skill.

Run `npm run cards:orchestrate -- run --limit 10`. Claim a job before visual or research work and submit a result with that claim's token. Use the deterministic photo/listing workers for their stages. Never directly rewrite queue state or source identity/pricing queues to manufacture completion.

Keep one short batch in progress. Reuse completed evidence; stop unresolved research after 90 seconds and one focused UI recovery. Hold that card and continue others. Do not repeatedly retry unchanged holds. If the current batch has no actionable work, a bounded `sync --new --limit 10` may admit more existing source records for independent local preparation.

View both retained originals, confirm front/back and individual serial, preserve the user's condition default and overrides, and report uncertainty. Exclude own exact-serial acquisition comps. Unknown shipping does not enter the item-only sold mean. The shared policy module calculates prices; never trust imported buyer-total formulas. A sold-result estimate remains visibly unapproved.

The user confirms they never scan the same physical card twice. Each distinct original front capture is additional physical inventory, even when visually identical. Do not ask for physical-copy confirmation again. Matching unnumbered copies should be grouped only after variant, artwork, language and condition match; different serials/parallels stay separate. Copied/converted files and reruns of the same original are not new captures. Retain capture IDs to prevent repeated stock increments. See the current quantity authority in the seller decisions. Grouped quantity updates are not yet implemented by this local queue; do not claim live quantities changed or bypass its existing-record exclusions.

When usable exact comps are absent, the seller-approved same-card numbered-parallel fallback uses `basis: "related-print-run"` with `exactSearchEvidence`. Supply the original sold item price and source identity; the engine retains and calculates source print run / target print run. Both runs and the source's complete individual serial must be inspected and independently supported. Preserve source currency and disclosed-price checks; do not invent USD conversions or serials. All related estimates remain flagged for price review. The new capability alone does not justify retrying every old hold.

Live/draft receipts are Add exclusions. The existing Card Inbox automation remains a possible external writer until explicitly migrated. Use a single browser worker; never take over another worker's tabs, lease or unknown submission outcome. This queue is single-host, even though its folder is synchronized by OneDrive.

Finish with `prepare` and `status`, update the checkpoint and morning summary, and report only material progress, failure or a genuinely necessary user decision. Do useful local work despite unavailable hosting or API credentials. No external listing writes, deployment, commits or pushes through this skill.
