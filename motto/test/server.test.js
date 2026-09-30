import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, verify, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { get } from 'node:http';
import { createApp } from '../src/app.js';
import { PurchaseStore } from '../src/store.js';

const pair = generateKeyPairSync('ed25519');
const publicHex = pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
const signReading = reading => ({ ...reading, signature: sign(null, Buffer.from(JSON.stringify(reading)), pair.privateKey).toString('hex'), devicePublicKey: publicHex });
const tx = '3'.repeat(88);
const requestBody = { service: 'research', input: { query: 'battery recycling', count: 3 }, max_spend_usd: '2.00' };

async function workspace(t, options = {}) {
  const store = new PurchaseStore(':memory:');
  const calls = { payments: 0, executions: 0, settlements: 0, charges: [] };
  let blockResolve;
  let verifyResolve;
  const pay = { config: { operator: { recipient: '11111111111111111111111111111111' } },
    async requirePayment(request, gate) {
      calls.payments++;
      calls.request = request;
      calls.gate = gate;
      if (options.paymentError) throw new Error('RPC failed at secret-internal-address');
      if (!request.headers.has('payment-signature')) return { status: 402, response: Response.json({ amount: gate.amount.baseUnits().toString(), scheme: 'upto' }, { status: 402 }) };
      if (options.proofRejected) return { status: 402, response: Response.json({ code: 'settlement_pending' }, { status: 402 }) };
      if (options.verifyBlock) await new Promise(resolve => { verifyResolve = resolve; });
      return { status: 200, payment: { scheme: 'upto' }, charge: { charge: amount => calls.charges.push(amount) },
        async settle() {
          calls.settlements++;
          if (options.settleError) throw new Error('RPC timeout');
          if (options.noReceipt) return {};
          return { 'x-payment-response': Buffer.from(JSON.stringify({ success: true, transaction: tx, amount: options.wrongAmount ? '999999' : (calls.charges.at(-1) ?? 0n).toString(), network: options.wrongNetwork ? 'solana:wrong-network' : 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' })).toString('base64') };
        } };
    } };
  const execute = async (quote, { onUpdate }) => {
    calls.executions++;
    onUpdate({ status: 'validating' });
    if (options.block) await new Promise(resolve => { blockResolve = resolve; });
    if (options.deliveryError) throw new Error('provider timeout');
    const passed = !options.incomplete;
    return { outcome: passed ? 'delivered' : 'inconclusive', charge_usd: options.invalidCharge ? '4.00' : passed ? quote.ceiling_usd : '0.00',
      units_delivered: passed ? quote.input.count : 0, checks: { passed },
      deliverable: { type: 'citation_pack', query: quote.input.query, citations: passed ? [{ title: 'Battery recycling', doi: '10.1234/recycle' }] : [] } };
  };
  const app = createApp({ pay, store, signReading, signingPublicKey: publicHex, execute, ...options });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const json = (path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const quote = async (body = requestBody, headers = {}) => { const response = await json('/v1/quotes', body, headers); assert.equal(response.status, 201); return response.json(); };
  const purchase = (id, key = 'request-key-123', extra = {}) => json(`/v1/purchases/${id}`, {}, {
    'Idempotency-Key': key, 'payment-signature': Buffer.from(JSON.stringify({ payload: { channelId: options.channel ?? randomUUID() } })).toString('base64'), ...extra });
  return { base, store, calls, quote, purchase, json, unblock: () => blockResolve(), unblockVerification: () => verifyResolve() };
}

test('catalog offers digital work and separate spending permission', async t => {
  const w = await workspace(t);
  const response = await fetch(w.base + '/v1/services');
  const body = await response.json();
  assert.deepEqual(Object.keys(body.services), ['research']);
  assert.equal(body.signing_public_key, publicHex);
  assert.equal(body.console.local_pay, false);
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await fetch(w.base + '/v1/rent/charger', { method: 'POST' })).status, 410);
});

test('quotes are immutable task prices, not the user permission amount', async t => {
  const w = await workspace(t);
  const quote = await w.quote();
  assert.equal(quote.ceiling_usd, '0.15');
  assert.equal(quote.max_spend_usd, '2.00');
  assert.match(quote.quote_hash, /^[a-f0-9]{64}$/);
  assert.deepEqual(await fetch(w.base + '/v1/quotes/' + quote.id).then(r => r.json()), quote);
  const changed = await w.json('/v1/purchases/' + quote.id, { count: 20 }, { 'Idempotency-Key': 'cannot-mutate' });
  assert.equal(changed.status, 400);
  assert.equal(w.calls.payments, 0);
});

test('scope above user permission is rejected before payment', async t => {
  const w = await workspace(t);
  const response = await w.json('/v1/quotes', { ...requestBody, max_spend_usd: '0.14' });
  assert.equal(response.status, 422);
  assert.equal(w.calls.payments, 0);
  assert.deepEqual(w.store.purchases(), []);
});

test('unpaid purchase advertises exact quote ceiling', async t => {
  const w = await workspace(t);
  const quote = await w.quote();
  const response = await w.json('/v1/purchases/' + quote.id, {}, { 'Idempotency-Key': 'unpaid-key-123' });
  assert.equal(response.status, 402);
  assert.deepEqual(await response.json(), { amount: '150000', scheme: 'upto' });
  assert.equal(w.calls.executions, 0);
  assert.equal(w.calls.gate.externalId, quote.id);
});

test('accepted work charges the quote and signs delivery bound to purchase', async t => {
  const w = await workspace(t);
  const quote = await w.quote();
  const response = await w.purchase(quote.id);
  assert.equal(response.status, 200);
  const purchase = await response.json();
  assert.equal(purchase.status, 'paid');
  assert.deepEqual([purchase.charged_usd, purchase.returned_usd], ['0.15', '0.00']);
  assert.deepEqual(w.calls.charges, [150000n]);
  assert.equal(purchase.settlement_tx, tx);
  const { signature, devicePublicKey, ...reading } = purchase.reading;
  assert.equal(devicePublicKey, publicHex);
  assert.equal(reading.quote_hash, quote.quote_hash);
  assert.equal(reading.purchase_id, purchase.id);
  assert.ok(verify(null, Buffer.from(JSON.stringify(reading)), pair.publicKey, Buffer.from(signature, 'hex')));
  assert.equal(w.calls.settlements, 1);
});

for (const kind of ['incomplete', 'deliveryError']) {
  test(`${kind} releases the full quoted hold without a service charge`, async t => {
    const w = await workspace(t, { [kind]: true });
    const purchase = await w.purchase((await w.quote()).id).then(r => r.json());
    assert.equal(purchase.status, 'refunded');
    assert.deepEqual([purchase.charged_usd, purchase.returned_usd], ['0.00', '0.15']);
    assert.deepEqual(w.calls.charges, []);
    assert.equal(w.calls.settlements, 1);
  });
}

for (const kind of ['settleError', 'noReceipt', 'wrongAmount', 'wrongNetwork']) {
  test(`${kind} never reports payment or refund as confirmed`, async t => {
    const w = await workspace(t, { [kind]: true });
    const quote = await w.quote();
    const purchase = await w.purchase(quote.id).then(r => r.json());
    assert.equal(purchase.status, 'settle_failed');
    assert.equal(purchase.charged_usd, null);
    assert.equal(purchase.returned_usd, null);
    const retry = await w.purchase(quote.id);
    assert.equal(retry.headers.get('idempotent-replayed'), 'true');
    assert.equal(w.calls.payments, 1);
    assert.equal(w.calls.executions, 1);
    assert.equal(w.calls.settlements, 1);
  });
}

test('retry returns original record without authorizing another hold', async t => {
  const w = await workspace(t);
  const quote = await w.quote();
  const first = await w.purchase(quote.id).then(r => r.json());
  assert.deepEqual(await w.purchase(quote.id).then(r => r.json()), first);
  assert.equal((await w.purchase(quote.id, 'another-request')).status, 409);
  assert.equal(w.calls.payments, 1);
  const secondQuote = await w.quote();
  assert.equal((await w.purchase(secondQuote.id)).status, 409);
  assert.equal(w.calls.payments, 1);
});

test('one payment channel cannot fund two different quotes', async t => {
  const w = await workspace(t, { channel: 'same-channel-authorization' });
  await w.purchase((await w.quote()).id);
  assert.equal((await w.purchase((await w.quote()).id, 'different-key')).status, 409);
  assert.equal(w.calls.executions, 1);
});

test('in-flight request replays existing progress without executing again', async t => {
  const w = await workspace(t, { block: true });
  const quote = await w.quote();
  const pending = w.purchase(quote.id);
  for (let attempt = 0; attempt < 50 && !w.calls.executions; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(w.calls.executions, 1);
  const response = await w.purchase(quote.id);
  assert.equal(response.status, 202);
  assert.equal((await response.json()).status, 'validating');
  w.unblock();
  assert.equal((await pending).status, 200);
  assert.equal(w.calls.payments, 1);
});

test('expired quote cannot start payment but completed receipt remains accessible', async t => {
  let now = Date.now();
  const w = await workspace(t, { clock: () => now });
  const quote = await w.quote();
  now += 120001;
  assert.equal((await w.purchase(quote.id)).status, 410);
  assert.equal(w.calls.payments, 0);
});

test('invalid delivery charge releases the hold and records uncertainty', async t => {
  const w = await workspace(t, { invalidCharge: true });
  const quote = await w.quote();
  assert.equal((await w.purchase(quote.id)).status, 500);
  assert.equal(w.calls.settlements, 1);
  assert.deepEqual(w.calls.charges, []);
  assert.equal(w.store.purchaseForQuote(quote.id).charged_usd, null);
});

test('workspace API key protects quotes and history without leaking in errors', async t => {
  const apiKey = 'private-test-key-that-is-long-enough';
  const w = await workspace(t, { apiKey, consolePay: true });
  assert.equal((await fetch(w.base + '/v1/services')).status, 200);
  const denied = await fetch(w.base + '/v1/purchases');
  assert.equal(denied.status, 401);
  assert.ok(!(await denied.text()).includes(apiKey));
  const quote = await w.quote(requestBody, { Authorization: 'Bearer ' + apiKey });
  assert.equal((await w.purchase(quote.id, 'authorized-key', { Authorization: 'Bearer ' + apiKey })).status, 200);
  assert.equal((await fetch(w.base + '/v1/purchases', { headers: { Authorization: 'Bearer ' + apiKey } })).status, 200);
  assert.equal((await w.json('/v1/console/purchases', { quote_id: quote.id }, { Authorization: 'Bearer ' + apiKey })).status, 403);
});

test('loopback with a remote host, foreign origin, or proxy headers cannot access private records', async t => {
  const w = await workspace(t);
  for (const headers of [{ Host: 'attacker.example' }, { Origin: 'https://attacker.example' }, { 'X-Forwarded-For': '203.0.113.2' }, { 'X-Forwarded-Host': 'public.example' }]) {
    const status = await new Promise((resolve, reject) => {
      get(w.base + '/v1/purchases', { headers }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
    });
    assert.equal(status, 403, JSON.stringify(headers));
  }
});

test('remote payment challenge uses configured origin rather than forwarded request headers', async t => {
  const apiKey = 'another-workspace-secret-long-enough';
  const w = await workspace(t, { apiKey, publicBaseUrl: 'https://motto.example' });
  const auth = { Authorization: 'Bearer ' + apiKey };
  const quote = await w.quote(requestBody, auth);
  const response = await w.json('/v1/purchases/' + quote.id, {}, { ...auth, 'Idempotency-Key': 'canonical-origin', 'X-Forwarded-Host': 'evil.example' });
  assert.equal(response.status, 402);
  assert.equal(w.calls.request.url, `https://motto.example/v1/purchases/${quote.id}`);
});

test('malformed JSON, missing idempotency, and internal payment errors are explicit', async t => {
  const w = await workspace(t, { paymentError: true });
  const malformed = await fetch(w.base + '/v1/quotes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' });
  assert.equal(malformed.status, 400);
  const quote = await w.quote();
  assert.equal((await w.json('/v1/purchases/' + quote.id, {})).status, 400);
  const failed = await w.purchase(quote.id);
  assert.equal(failed.status, 500);
  assert.deepEqual(await failed.json(), { error: 'The service could not complete this request. Inspect purchases and payment attempts before retrying.' });
  assert.equal(w.calls.settlements, 0);
});

test('ambiguous dual payment proof headers are rejected before verification', async t => {
  const w = await workspace(t);
  const quote = await w.quote();
  const response = await w.purchase(quote.id, 'dual-proof-key', { 'x-payment': 'different-proof' });
  assert.equal(response.status, 400);
  assert.equal(w.calls.payments, 0);
});

for (const conflict of ['key', 'channel']) {
  test(`concurrent ${conflict} reuse is rejected before a second authorization`, async t => {
    const w = await workspace(t, { verifyBlock: true, ...(conflict === 'channel' ? { channel: 'concurrent-channel-authorization' } : {}) });
    const quote1 = await w.quote();
    const quote2 = await w.quote();
    const first = w.purchase(quote1.id);
    for (let attempt = 0; attempt < 50 && !w.calls.payments; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(w.calls.payments, 1);
    const second = await w.purchase(quote2.id, conflict === 'key' ? 'request-key-123' : 'different-concurrent-key');
    assert.equal(second.status, 409);
    assert.equal(w.calls.payments, 1);
    w.unblockVerification();
    assert.equal((await first).status, 200);
    assert.equal(w.calls.executions, 1);
    assert.equal(w.calls.settlements, 1);
  });
}

test('payment verification uncertainty is durably journaled and prevents a new authorization', async t => {
  const w = await workspace(t, { paymentError: true });
  const quote = await w.quote();
  assert.equal((await w.purchase(quote.id)).status, 500);
  const response = await fetch(w.base + '/v1/payment-attempts');
  const { attempts } = await response.json();
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].status, 'unconfirmed');
  assert.equal(attempts[0].quote_id, quote.id);
  assert.equal(attempts[0].idempotency_key, undefined);
  assert.equal((await w.purchase(quote.id, 'new-authorization-key')).status, 409);
  assert.equal((await w.purchase((await w.quote()).id)).status, 409);
  assert.equal(w.calls.payments, 1);
});

test('a 402 after submitted proof leaves authorization uncertain and blocks another hold', async t => {
  const w = await workspace(t, { proofRejected: true });
  const quote = await w.quote();
  assert.equal((await w.purchase(quote.id)).status, 402);
  assert.equal(w.store.attempts()[0].status, 'unconfirmed');
  assert.equal((await w.purchase(quote.id, 'fresh-retry-key')).status, 409);
  assert.equal(w.calls.payments, 1);
});

test('storage failures after authorization cannot skip zero-charge release', async t => {
  const w = await workspace(t);
  const quote = await w.quote();
  const save = w.store.saveAttempt.bind(w.store);
  let writes = 0;
  w.store.saveAttempt = attempt => { if (++writes > 1) throw new Error('disk full'); return save(attempt); };
  w.store.createPurchase = () => { throw new Error('disk full'); };
  assert.equal((await w.purchase(quote.id)).status, 500);
  assert.equal(w.calls.settlements, 1);
  assert.deepEqual(w.calls.charges, []);
});
