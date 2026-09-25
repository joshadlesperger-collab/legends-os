import assert from "node:assert/strict";
import test from "node:test";
import {calculateVelocityOfferPrice,VELOCITY_OFFER_DISCOUNT_PCT,VELOCITY_OFFER_MAX_PER_RUN,VELOCITY_REFRESH_CANARY,VELOCITY_REFRESH_MAX_PER_RUN} from "../lib/sales-velocity-autopilot-domain.ts";

test("Velocity Autopilot offer policy is capped at eight percent and rounds toward seller",()=>{
  assert.equal(VELOCITY_OFFER_DISCOUNT_PCT,8);
  assert.equal(calculateVelocityOfferPrice(10),9.20);
  assert.equal(calculateVelocityOfferPrice(2.95),2.72);
});

test("Velocity Autopilot batch limits preserve canary-first execution",()=>{
  assert.equal(VELOCITY_OFFER_MAX_PER_RUN,25);
  assert.equal(VELOCITY_REFRESH_CANARY,3);
  assert.equal(VELOCITY_REFRESH_MAX_PER_RUN,10);
  assert.ok(VELOCITY_REFRESH_CANARY<VELOCITY_REFRESH_MAX_PER_RUN);
});
