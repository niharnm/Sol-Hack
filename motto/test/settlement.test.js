// The money table in one place: item terms, outcome and settle result to what the agent is told.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chargeKind, formatUsd, settlementFor, toBaseUnits } from '../src/settlement.js';
import { ITEMS, MAX_HOLD_USD } from '../src/items.js';

const charger = { hold_usd: '3.00', check_fee_usd: '0.05', charge_on_delivered: 'hold' };
const verify = { hold_usd: '0.10', check_fee_usd: '0.10', charge_on_delivered: 'fee' };

test('usd strings round-trip through 6-decimal base units', () => {
  assert.equal(toBaseUnits('3.00'), 3_000_000n);
  assert.equal(toBaseUnits('0.05'), 50_000n);
  assert.equal(toBaseUnits('10'), 10_000_000n);
  assert.equal(toBaseUnits('0.000001'), 1n);
  assert.equal(formatUsd(2_950_000n), '2.95');
  assert.equal(formatUsd(0n), '0.00');
  assert.equal(formatUsd(10_000_000n), '10.00');
  assert.equal(formatUsd(1_234_500n), '1.2345');
  for (const bad of ['$3', '3.', '.5', '-1', '1.0000001', 'abc']) assert.throws(() => toBaseUnits(bad), bad);
});

test('delivered keeps the whole hold', () => {
  assert.deepEqual(settlementFor(charger, 'delivered'), { keep: true, chargeBaseUnits: 3_000_000n, decision: 'kept', charged_usd: '3.00', returned_usd: '0.00' });
});

test('already handled and not delivered charge the check fee only', () => {
  for (const outcome of ['already_handled', 'not_delivered']) {
    assert.deepEqual(settlementFor(charger, outcome), { keep: false, chargeBaseUnits: 50_000n, decision: 'refunded', charged_usd: '0.05', returned_usd: '2.95' }, outcome);
  }
});

test('a failed or inconclusive check charges nothing', () => {
  for (const outcome of ['check_failed', 'inconclusive']) {
    assert.deepEqual(settlementFor(charger, outcome), { keep: false, chargeBaseUnits: 0n, decision: 'refunded', charged_usd: '0.00', returned_usd: '3.00' }, outcome);
  }
});

test('a pure check charges its fee on a definitive verdict either way', () => {
  for (const outcome of ['already_handled', 'delivered']) {
    assert.equal(chargeKind(verify, outcome), 'fee', outcome);
    assert.deepEqual(settlementFor(verify, outcome), { keep: true, chargeBaseUnits: 100_000n, decision: 'kept', charged_usd: '0.10', returned_usd: '0.00' }, outcome);
  }
  assert.deepEqual(settlementFor(verify, 'inconclusive'), { keep: false, chargeBaseUnits: 0n, decision: 'refunded', charged_usd: '0.00', returned_usd: '0.10' });
});

test('a failed settle reports no money moved, whatever the outcome', () => {
  for (const outcome of ['delivered', 'already_handled', 'check_failed']) {
    const s = settlementFor(charger, outcome, 'rpc down');
    assert.equal(s.decision, 'settle_failed', outcome);
    assert.equal(s.charged_usd, null);
    assert.equal(s.returned_usd, null);
  }
});

test('every item states rules whose numbers match its own prices', () => {
  assert.deepEqual(Object.keys(ITEMS), ['research']);
  for (const [name, item] of Object.entries(ITEMS)) {
    const hold = toBaseUnits(item.hold_usd);
    const fee = toBaseUnits(item.check_fee_usd);
    assert.ok(fee <= hold, `${name}: fee within hold`);
    assert.ok(item.covers, `${name}: says what the hold buys`);
    assert.ok(item.summary.length <= 63, `${name}: summary fits the registry cap`);
    assert.equal(item.fulfillment.type, 'virtual', `${name}: uses virtual fulfillment`);
    for (const [outcome, sentence] of Object.entries(item.rules)) {
      const { charged_usd, returned_usd } = settlementFor(item, outcome);
      const expected = charged_usd === '0.00' ? `nothing charged, $${returned_usd} returned` : chargeKind(item, outcome) === 'fee' ? `the $${charged_usd} check fee is charged, $${returned_usd} returned` : `$${charged_usd} charged (${item.covers}), nothing returned`;
      assert.ok(sentence.endsWith(`${expected}.`), `${name}.${outcome}: "${sentence}" should end with "${expected}."`);
    }
  }
  assert.equal(MAX_HOLD_USD, '1.00');
});
