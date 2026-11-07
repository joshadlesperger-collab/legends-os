import test from 'node:test';
import assert from 'node:assert/strict';
import { StoreOfferEvidence } from '../lib/store-offer-evidence.ts';

test('a successful seller read cannot turn failed or disconnected sellers into ineligible evidence', () => {
  const evidence = new StoreOfferEvidence();
  evidence.recordSuccess('seller-a', ['shared-item'], '2026-10-25T16:00:00.000Z');
  assert.deepEqual(evidence.get('seller-a', 'shared-item'), { eligible: true, observedAt: '2026-10-25T16:00:00.000Z' });
  assert.deepEqual(evidence.get('seller-a', 'other'), { eligible: false, observedAt: '2026-10-25T16:00:00.000Z' });
  assert.deepEqual(evidence.get('seller-b', 'shared-item'), { eligible: null, observedAt: null });
  assert.deepEqual(evidence.get('disconnected', 'other'), { eligible: null, observedAt: null });
});

test('empty successful reads and refreshed eligibility remain scoped to the observed store', () => {
  const evidence = new StoreOfferEvidence();
  evidence.recordSuccess('seller-a', ['item'], '2026-10-25T16:00:00.000Z');
  evidence.recordSuccess('seller-b', [], '2026-10-25T16:01:00.000Z');
  assert.deepEqual(evidence.get('seller-b', 'item'), { eligible: false, observedAt: '2026-10-25T16:01:00.000Z' });
  assert.equal(evidence.get('seller-a', 'item').eligible, true);
  evidence.recordSuccess('seller-a', [], '2026-10-25T16:02:00.000Z');
  assert.deepEqual(evidence.get('seller-a', 'item'), { eligible: false, observedAt: '2026-10-25T16:02:00.000Z' });
});
