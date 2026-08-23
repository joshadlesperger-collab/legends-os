import assert from "node:assert/strict";
import test from "node:test";
import { getOAuthReplayOutcome, issueEbayOAuthState, processingOAuthState, verifyEbayOAuthState } from "../lib/ebay-oauth-state.ts";

test.before(() => { process.env.TOKEN_ENCRYPTION_KEY = "11".repeat(32); });

test("signed OAuth state binds the existing store and intent without storing the transmitted token", () => {
  const now = Date.parse("2026-08-14T20:00:00.000Z");
  const issued = issueEbayOAuthState("existing-store", "reauthorize_orders", now);
  const verified = verifyEbayOAuthState(issued.state, now + 1_000);
  assert.deepEqual(verified, { storeId: "existing-store", intent: "reauthorize_orders", verifier: issued.verifier });
  assert.notEqual(issued.storedState, issued.state);
  assert.match(issued.storedState, /^pending:[0-9a-f]{64}$/);
});

test("OAuth state rejects tampering and expiration", () => {
  const now = Date.parse("2026-08-14T20:00:00.000Z");
  const issued = issueEbayOAuthState("existing-store", "reauthorize_orders", now);
  assert.equal(verifyEbayOAuthState(`${issued.state}x`, now + 1_000), null);
  assert.equal(verifyEbayOAuthState(issued.state, now + 10 * 60 * 1000 + 1), null);
});

test("duplicate callbacks never exchange again and resolve safely after completion", () => {
  const issued = issueEbayOAuthState("existing-store", "reauthorize_orders");
  assert.equal(getOAuthReplayOutcome(processingOAuthState(issued.verifier), issued.verifier, "reauthorize_orders", "connected", "requires_reauth"), "processing");
  assert.equal(getOAuthReplayOutcome(null, issued.verifier, "reauthorize_orders", "connected", "ready"), "completed");
  assert.equal(getOAuthReplayOutcome(null, issued.verifier, "connect", "connected", "ready"), "completed");
  assert.equal(getOAuthReplayOutcome(null, issued.verifier, "reauthorize_orders", "connected", "requires_reauth"), "invalid");
});
