// The money table in one place: outcome and settle result to what the agent is told.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHECK_FEE_BASE_UNITS, HOLD_BASE_UNITS, settlementFor } from '../src/settlement.js';

test('delivered keeps the full hold', () => {
  assert.deepEqual(settlementFor('delivered'), { keep: true, chargeBaseUnits: HOLD_BASE_UNITS, decision: 'kept', charged_usd: '1.00', returned_usd: '0.00' });
});

test('already handled and not delivered charge the check fee only', () => {
  for (const outcome of ['already_handled', 'not_delivered']) {
    assert.deepEqual(settlementFor(outcome), { keep: false, chargeBaseUnits: CHECK_FEE_BASE_UNITS, decision: 'refunded', charged_usd: '0.01', returned_usd: '0.99' }, outcome);
  }
});

test('a failed or inconclusive check charges nothing', () => {
  for (const outcome of ['check_failed', 'inconclusive']) {
    assert.deepEqual(settlementFor(outcome), { keep: false, chargeBaseUnits: 0n, decision: 'refunded', charged_usd: '0.00', returned_usd: '1.00' }, outcome);
  }
});

test('a failed settle reports no money moved, whatever the outcome', () => {
  for (const outcome of ['delivered', 'already_handled', 'check_failed']) {
    const s = settlementFor(outcome, 'rpc down');
    assert.equal(s.decision, 'settle_failed', outcome);
    assert.equal(s.charged_usd, null);
    assert.equal(s.returned_usd, null);
  }
});
