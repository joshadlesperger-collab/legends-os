import test from "node:test";
import assert from "node:assert/strict";
import { assignPhoto, pairPhotoIds, type PairedCard } from "../lib/card-photo-pairing.ts";
const identity = { sport: "Baseball" as const, player: "Hunter Goodman", year: 2026, manufacturer: "Topps", set: "Finest", cardNumber: "155" };
const cards = (): PairedCard[] => [
  { id: "one", draft: { identity, quantity: 1, verified: true, frontImageId: "a", backImageId: "b" } },
  { id: "two", draft: { identity, quantity: 1, verified: true, frontImageId: "c", backImageId: "d" } },
];
test("bulk alternating and fronts-first orders handle even and odd batches", () => {
  assert.deepEqual(pairPhotoIds(["a", "b", "c", "d"], "alternating"), [["a", "b"], ["c", "d"]]);
  assert.deepEqual(pairPhotoIds(["a", "c", "b", "d"], "fronts-first"), [["a", "b"], ["c", "d"]]);
  assert.deepEqual(pairPhotoIds(["a", "b", "c"], "alternating"), [["a", "b"], ["c", undefined]]);
  assert.deepEqual(pairPhotoIds(["a", "c", "b"], "fronts-first"), [["a", "b"], ["c", undefined]]);
});
test("same-card reassignment swaps sides without duplication", () => {
  const result = assignPhoto(cards(), "one", "front", "b");
  assert.equal(result[0].draft.frontImageId, "b");
  assert.equal(result[0].draft.backImageId, "a");
  assert.equal(result[0].draft.verified, false);
  assert.equal(result[1].draft.verified, true);
});
test("cross-card assignment swaps displaced photos and resets both approvals", () => {
  const result = assignPhoto(cards(), "one", "back", "c");
  assert.equal(result[0].draft.backImageId, "c");
  assert.equal(result[1].draft.frontImageId, "b");
  assert.ok(result.every(c => !c.draft.verified));
  assert.equal(new Set(result.flatMap(c => [c.draft.frontImageId, c.draft.backImageId])).size, 4);
});
test("missing-side repair and clearing preserve other assignments", () => {
  const cleared = assignPhoto(cards(), "one", "back");
  assert.equal(cleared[0].draft.backImageId, undefined);
  const repaired = assignPhoto(cleared, "one", "back", "d");
  assert.equal(repaired[0].draft.backImageId, "d");
  assert.equal(repaired[1].draft.backImageId, undefined);
  assert.equal(cards()[0].draft.backImageId, "b");
});
