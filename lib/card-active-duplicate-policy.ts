/** Seller standing authority, 2026-10-25. Evidence and write receipts remain separate. */
export const ACTIVE_DUPLICATE_POLICY = {
  id: 'active-duplicate-increase-quantity-20261025',
  source: 'docs/card-listing-factory-pilot.md#active-listing-duplicate-authority--2026-10-25',
  matchedActiveAction: 'increase-existing-quantity',
  askPerCardPermission: false,
  createSeparateDraftForConfirmedActiveMatch: false,
  preserveExistingPriceAndSettings: true,
  instructions: [
    'A confirmed additional physical copy matching an active listing goes to that listing as a quantity increase. Do not ask increase-or-draft or request per-card quantity approval.',
    'Match product/year, player, card number, parallel, language, condition and single-card contents. Different serials/parallels are not interchangeable copies. Resolve genuine identity conflicts before writing.',
    'Use the saved active report to find candidates, then verify the exact live listing and current available quantity before the scoped update. A stale report is not a quantity baseline.',
    'Count each distinct original capture once. Copies, conversions, retries and captures already represented in stock do not add quantity. An existing receipt alone is not proof of extra inventory.',
    'Persist the listing ID, new capture IDs, observed starting quantity, intended target and write outcome before/after the supported edit. On uncertain outcome reconcile that same operation; never increment again blindly.',
    'Increase by the number of verified new captures, preserve existing price and all other listing settings, then reopen and verify the saved quantity. If concurrent stock changes occur, reconcile before applying a new target.',
    'This standing authority permits the scoped active-listing quantity edit, not a new listing publication, deletion of drafts or arbitrary inventory-wide changes. Respect explicit item holds and writer ownership.',
  ],
} as const;
