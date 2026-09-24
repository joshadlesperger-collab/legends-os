# Free Shipping Phase 1 experiment

Status: **dry-run implementation only**. No production listing mutation is authorized by this change.

## Objective

Test whether the eBay "free shipping" presentation improves sell-through when the buyer's pre-tax delivered price is held constant.

For each treatment listing:

```
proposed item price = live item price + live shipping charge
proposed shipping charge = $0.00 / FREE
```

The promoted-listing rate is held at **5.0%** so Phase 1 isolates the shipping effect.

## Fixed treatment cohort

The 75 treatment ItemIDs selected from the 2026-09-24 listing-quality / active-listing / promoted-listing data are embedded in `lib/free-shipping-experiment.ts`.

The dry run fails closed for a listing unless live eBay state still satisfies all of these conditions:

- active fixed-price listing is still present in Legends OS;
- live title and price still agree with the persisted listing;
- live shipping charge is exactly $1.49 or $1.95;
- current Promoted Listings ad rate is exactly 5.0%;
- a proposed new item price can preserve the pre-tax delivered price.

## Dry run

Run:

```bash
npm run ebay:free-shipping-phase1:dry-run
```

The command uses GET-only reads against Trading, Marketing, and Account APIs. It reports:

- every selected ItemID;
- live price and shipping;
- proposed free-shipping price;
- current shipping profile ID;
- current ad rate;
- blockers;
- candidate free-shipping fulfillment policies.

It does **not** select a fulfillment policy automatically and does **not** call a write endpoint.

## Production gate

Before any live change:

1. review the dry-run output and resolve every blocked listing;
2. identify the exact free-shipping fulfillment policy to use;
3. add an action-specific governed write that changes only price + shipping policy;
4. revalidate live state immediately before each write;
5. require an explicit production batch approval for the exact ItemIDs and proposed values;
6. verify each listing after eBay accepts the revision;
7. stop the batch on unintended or unrelated field changes.

This experiment is intentionally separate from the 3% vs 5% advertising-rate test.
