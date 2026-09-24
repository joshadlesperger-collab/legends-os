import assert from "node:assert/strict";
import test from "node:test";
import {
  FREE_SHIPPING_PHASE1_ITEM_IDS,
  cents,
  deliveredPricePreserved,
  evaluateFreeShippingCandidate,
  freeShippingPolicies,
  proposedFreeShippingPrice,
  providerShippingCharge,
  providerShippingProfileId,
} from "../lib/free-shipping-experiment.ts";

test("Phase 1 treatment cohort is fixed at 75 unique item IDs", () => {
  assert.equal(FREE_SHIPPING_PHASE1_ITEM_IDS.length, 75);
  assert.equal(new Set(FREE_SHIPPING_PHASE1_ITEM_IDS).size, 75);
  assert.ok(FREE_SHIPPING_PHASE1_ITEM_IDS.every(id => /^\d+$/.test(id)));
});

test("free-shipping price preserves pre-tax delivered price", () => {
  assert.equal(proposedFreeShippingPrice(2.95, 1.49), 4.44);
  assert.equal(proposedFreeShippingPrice(3.95, 1.95), 5.90);
  assert.equal(cents(2.95 + 1.49), 4.44);
  assert.equal(deliveredPricePreserved(2.95, 1.49, 4.44), true);
  assert.equal(deliveredPricePreserved(2.95, 1.49, 4.43), false);
});

test("shipping parser reads live Trading API structures", () => {
  const item = {
    ItemID: "123",
    Title: "Example",
    Quantity: 1,
    QuantityAvailable: 1,
    SellingStatus: { CurrentPrice: { "#text": 2.95, "@_currencyID": "USD" }, ListingStatus: "Active" },
    ShippingDetails: { ShippingServiceOptions: { ShippingServiceCost: { "#text": 1.49, "@_currencyID": "USD" } } },
    SellerProfiles: { SellerShippingProfile: { ShippingProfileID: "248164775010" } },
  };
  assert.equal(providerShippingCharge(item), 1.49);
  assert.equal(providerShippingProfileId(item), "248164775010");
});

test("candidate must still be active, 5 percent promoted, and in approved shipping band", () => {
  const base = {
    ItemID: "123",
    Title: "Example",
    Quantity: 1,
    QuantityAvailable: 1,
    SellingStatus: { CurrentPrice: 2.95, ListingStatus: "Active" },
    ShippingDetails: { ShippingServiceOptions: [{ ShippingServiceCost: 1.49 }] },
    SellerProfiles: { SellerShippingProfile: { ShippingProfileID: "paid-profile" } },
  };
  const ready = evaluateFreeShippingCandidate({ itemId: "123", item: base, persistedTitle: "Example", persistedPrice: 2.95, adRate: 5 });
  assert.equal(ready.ready, true);
  assert.equal(ready.proposedPrice, 4.44);

  const blocked = evaluateFreeShippingCandidate({
    itemId: "123",
    item: { ...base, ShippingDetails: { ShippingServiceOptions: [{ ShippingServiceCost: 2.49 }] } },
    persistedTitle: "Example",
    persistedPrice: 2.95,
    adRate: 3,
  });
  assert.equal(blocked.ready, false);
  assert.match(blocked.blockers.join(" "), /outside the approved Phase 1 cohort/);
  assert.match(blocked.blockers.join(" "), /not 5\.0%/);
});

test("free fulfillment policies are detected without choosing one implicitly", () => {
  const policies = [
    { fulfillmentPolicyId: "paid", name: "Paid", shippingOptions: [{ shippingServices: [{ shippingCost: { value: "1.49" } }] }] },
    { fulfillmentPolicyId: "free", name: "Free", shippingOptions: [{ shippingServices: [{ shippingCost: { value: "0.00" }, freeShipping: true }] }] },
  ];
  assert.deepEqual(freeShippingPolicies(policies).map(row => row.fulfillmentPolicyId), ["free"]);
});
