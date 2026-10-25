import test from 'node:test';
import assert from 'node:assert/strict';
import { CARD_POLICY, calculateCardPrice } from '../lib/card-orchestrator-policy.ts';
test('no legacy premium',()=>assert.equal(CARD_POLICY.premiumPercent,0));
test('minimum item price',()=>assert.ok(calculateCardPrice(0.5).item>=1.49));
test('serial pricing requires independent evidence',()=>assert.equal(CARD_POLICY.mode,'local-preparation-only'));
