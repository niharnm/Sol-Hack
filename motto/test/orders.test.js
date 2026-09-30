import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OrderError, OrderStore } from '../src/orders.js';

const dir = mkdtempSync(join(tmpdir(), 'motto-orders-'));
after(() => rmSync(dir, { recursive: true, force: true }));
let uuidSequence = 0;
let storeSequence = 0;

function signedQuote() {
  return {
    quote: {
      quote_id: 'quote_01',
      provider_id: 'paper-shop',
      offer_id: 'research-pack',
      network: 'devnet',
      payout_address: '11111111111111111111111111111111',
      hold_usd: '1.00',
      settlement: {
        delivered_usd: '1.00', already_handled_usd: '0.10', not_delivered_usd: '0.00', inconclusive_usd: '0.00',
      },
      request_sha256: 'a'.repeat(64),
      expires_at_ms: 1_800_000_060_000,
      fulfillment_timeout_seconds: 90,
    },
    signature: 'signed',
  };
}

function store(options = {}) {
  return new OrderStore({
    dataDir: join(dir, String(++storeSequence)),
    capabilitySecret: 'a'.repeat(32),
    now: () => 1_800_000_000_000,
    uuid: () => `00000000-0000-4000-8000-${String(++uuidSequence).padStart(12, '0')}`,
    ...options,
  });
}

function errorCode(error) {
  assert.ok(error instanceof OrderError);
  return error.code;
}

test('creates private orders and returns the same response for an exact idempotent retry', () => {
  const orders = store();
  const input = { signedQuote: signedQuote(), quoteFingerprint: 'b'.repeat(64), request: { query: 'battery recycling' }, idempotencyKey: 'request-0001' };
  const first = orders.create(input);
  const retry = orders.create(input);
  assert.equal(first.order.id, retry.order.id);
  assert.equal(first.capability, retry.capability);
  assert.equal(first.replayed, false);
  assert.equal(retry.replayed, true);
  assert.equal(first.order.capability_sha256, undefined);
  assert.equal(first.order.idempotency_sha256, undefined);
  assert.equal(readFileSync(orders.file, 'utf8').includes(first.capability), false);
  assert.deepEqual(orders.get(first.order.id, first.capability).request, input.request);
  assert.throws(() => orders.get(first.order.id, 'wrong'), error => errorCode(error) === 'order_not_found');
});

test('rejects changed data under an existing idempotency key', () => {
  const orders = store();
  const input = { signedQuote: signedQuote(), quoteFingerprint: 'b'.repeat(64), request: { query: 'battery recycling' }, idempotencyKey: 'request-0002' };
  orders.create(input);
  assert.throws(() => orders.create({ ...input, request: { query: 'changed' } }), error => errorCode(error) === 'idempotency_conflict');
  assert.throws(() => orders.create({ ...input, idempotencyKey: 'short' }), error => errorCode(error) === 'invalid_idempotency_key');
  assert.throws(() => orders.create({ ...input, idempotencyKey: 'request-0002-second' }), error => errorCode(error) === 'quote_already_used');
});

test('records held, verified and settled states with separate fulfillment and payment status', () => {
  const orders = store();
  const created = orders.create({ signedQuote: signedQuote(), quoteFingerprint: 'b'.repeat(64), request: {}, idempotencyKey: 'request-0003' });
  const held = orders.startExecution(created.order.id, { payer: 'payer', paymentProofSha256: 'c'.repeat(64) });
  assert.deepEqual([held.order_state, held.fulfillment_state, held.payment_state], ['executing', 'requested', 'held']);
  assert.match(held.hold_id, /^[0-9a-f-]{36}$/);

  const signedAttestation = { attestation: { outcome: 'delivered' }, signature: 'signed' };
  const verified = orders.recordEvidence(created.order.id, { artifact: { result: true }, signedAttestation, attestationFingerprint: 'd'.repeat(64) });
  assert.equal(verified.approved_charge_usd, '1.00');
  assert.equal(verified.fulfillment_state, 'verified');
  assert.equal(orders.beginSettlement(created.order.id).payment_state, 'settling');
  const settled = orders.settle(created.order.id, { transaction: 'transaction' });
  assert.deepEqual([settled.order_state, settled.payment_state], ['completed', 'settled']);
  assert.throws(() => orders.startExecution(created.order.id, { payer: 'payer' }), error => errorCode(error) === 'order_already_executed');
});

test('rejected or timed out fulfillment approves zero and settlement errors remain unknown', () => {
  const orders = store();
  const created = orders.create({ signedQuote: signedQuote(), quoteFingerprint: 'b'.repeat(64), request: {}, idempotencyKey: 'request-0004' });
  orders.startExecution(created.order.id, { payer: 'payer', paymentProofSha256: 'c'.repeat(64) });
  const rejected = orders.rejectFulfillment(created.order.id, 'invalid_attestation');
  assert.equal(rejected.approved_charge_usd, '0.00');
  orders.beginSettlement(created.order.id);
  const unknown = orders.settlementUnknown(created.order.id, 'confirmation timeout');
  assert.deepEqual([unknown.order_state, unknown.payment_state], ['failed', 'settlement_unknown']);
  assert.match(unknown.settlement_error, /confirmation timeout/);
});

test('reloads orders while deriving capabilities from the persistent secret', () => {
  const isolated = mkdtempSync(join(tmpdir(), 'motto-orders-reload-'));
  try {
    const first = new OrderStore({ dataDir: isolated });
    const created = first.create({ signedQuote: signedQuote(), quoteFingerprint: 'b'.repeat(64), request: {}, idempotencyKey: 'request-0005' });
    const second = new OrderStore({ dataDir: isolated });
    assert.equal(second.get(created.order.id, created.capability).id, created.order.id);
  } finally {
    rmSync(isolated, { recursive: true, force: true });
  }
});
