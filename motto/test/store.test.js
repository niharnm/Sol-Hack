import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PurchaseStore } from '../src/store.js';

test('quotes and completed purchases survive a restart; uncertain progress stays unknown', t => {
  const dir = mkdtempSync(join(tmpdir(), 'motto-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'purchases.sqlite');
  let store = new PurchaseStore(path);
  const quote = { id: 'quote', ceiling_usd: '0.15', input: { count: 3 } };
  store.saveQuote(quote);
  assert.throws(() => store.saveQuote({ ...quote, ceiling_usd: '10.00' }), /UNIQUE/);
  const paid = { id: 'paid', quote_id: 'quote', status: 'paid', charged_usd: '0.15', returned_usd: '0.00' };
  store.createPurchase(paid, 'key1', 'channel1');
  store.saveAttempt({ id: 'attempt', quote_id: 'quote3', idempotency_key: 'key3', payment_channel_id: 'channel3', status: 'authorizing' });
  store.createPurchase({ id: 'pending', quote_id: 'quote2', status: 'settling', charged_usd: null, returned_usd: null }, 'key2', 'channel2');
  assert.throws(() => store.createPurchase({ ...paid, id: 'duplicate' }, 'key3', 'channel3'), /UNIQUE/);
  assert.throws(() => store.createPurchase({ ...paid, id: 'duplicate', quote_id: 'other' }, 'key4', 'channel1'), /UNIQUE/);
  store.close();
  store = new PurchaseStore(path);
  assert.deepEqual(store.quote('quote'), quote);
  assert.equal(store.attemptForChannel('channel3').status, 'interrupted');
  assert.equal(store.attemptForQuote('quote3').id, 'attempt');
  assert.equal(store.attemptForKey('key3').id, 'attempt');
  assert.deepEqual(store.purchase('paid'), paid);
  assert.equal(store.purchase('pending').status, 'interrupted');
  assert.equal(store.purchase('pending').charged_usd, null);
  assert.equal(store.purchase('pending').returned_usd, null);
  assert.equal(store.purchaseForKey('key1').id, 'paid');
  assert.equal(store.purchaseForChannel('channel1').id, 'paid');
  assert.equal(statSync(path).mode & 0o777, 0o600);
  store.close();
});

test('updating an older attempt cannot hide unresolved authorization behind newer history', () => {
  const store = new PurchaseStore(':memory:');
  const first = { id: 'first', quote_id: 'quote', idempotency_key: 'key', payment_channel_id: 'channel-a', status: 'rejected' };
  store.saveAttempt(first);
  store.saveAttempt({ ...first, id: 'second', payment_channel_id: 'channel-b' });
  store.saveAttempt({ ...first, status: 'unconfirmed' });
  assert.equal(store.attemptForQuote('quote').id, 'first');
  assert.equal(store.attemptForKey('key').id, 'first');
  store.close();
});
