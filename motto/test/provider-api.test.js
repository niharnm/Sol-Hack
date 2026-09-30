import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mountProviderApi } from '../src/provider-api.js';
import { OrderStore } from '../src/orders.js';

const roots = [];
const servers = [];
after(() => {
  for (const server of servers) server.close();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
    probe.on('error', reject);
  });
}

function quote() {
  return {
    version: 1,
    quote_id: 'quote_01',
    provider_id: 'paper-shop',
    offer_id: 'research-pack',
    network: 'devnet',
    payout_address: '11111111111111111111111111111111',
    hold_usd: '1.00',
    settlement: {
      delivered_usd: '0.75', already_handled_usd: '0.10', not_delivered_usd: '0.00', inconclusive_usd: '0.00',
    },
    request_sha256: 'a'.repeat(64),
    attestor_id: 'delivery-service',
    nonce: 'quote_nonce_000001',
    expires_at_ms: Date.now() + 60_000,
    fulfillment_timeout_seconds: 30,
  };
}

async function start({ providerFailure, settlementFailure } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'motto-provider-api-'));
  roots.push(root);
  const orders = new OrderStore({ dataDir: root, capabilitySecret: 's'.repeat(32) });
  let charged = 0n;
  let gate;
  let quoteCalls = 0;
  const pay = {
    config: { operator: { recipient: quote().payout_address } },
    async requirePayment(_request, receivedGate) {
      gate = typeof receivedGate === 'function' ? await receivedGate(_request) : receivedGate;
      if (!_request.headers.get('payment-signature')) {
        return { status: 402, response: new Response(JSON.stringify({ accepts: [{ scheme: 'upto', payTo: gate.payTo }] }), { status: 402, headers: { 'content-type': 'application/json' } }) };
      }
      return {
        status: 200,
        payment: { payer: 'payer-address' },
        charge: { charge(amount) { charged = amount; } },
        async settle() {
          if (settlementFailure) throw new Error('confirmation timeout');
          const transaction = '3'.repeat(64);
          return { 'payment-response': Buffer.from(JSON.stringify({ transaction })).toString('base64') };
        },
      };
    },
  };
  const registry = {
    publicProviders: () => [{ id: 'paper-shop', payout_address: quote().payout_address, offers: [{ id: 'research-pack' }] }],
    getOffer(providerId, offerId) {
      assert.deepEqual([providerId, offerId], ['paper-shop', 'research-pack']);
      return { id: offerId };
    },
  };
  const providerClient = {
    async quote() {
      quoteCalls++;
      return { signed_quote: { quote: quote(), signature: 'signed' } };
    },
    async fulfill(order) {
      if (providerFailure) throw Object.assign(new Error('provider failed'), { code: 'provider_failed' });
      return {
        artifact: { citations: [{ doi: '10.1234/example', title: 'Example' }] },
        signed_attestation: { attestation: { outcome: 'delivered', order_id: order.id }, signature: 'signed' },
      };
    },
  };
  const app = express();
  app.use(express.json());
  mountProviderApi({
    app, pay, registry, orders, providerClient, network: 'devnet',
    verifyQuote: signedQuote => ({ fingerprint: 'b'.repeat(64), quote: signedQuote.quote }),
    verifyAttestation: () => ({ fingerprint: 'c'.repeat(64) }),
  });
  app.use((error, _req, res, _next) => res.status(error.status ?? 500).json({ error: error.code ?? 'internal_error' }));
  const port = await freePort();
  const server = app.listen(port, '127.0.0.1');
  servers.push(server);
  return { base: `http://127.0.0.1:${port}`, charged: () => charged, gate: () => gate, quoteCalls: () => quoteCalls };
}

async function createOrder(base, key) {
  const response = await fetch(`${base}/v1/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify({ provider_id: 'paper-shop', offer_id: 'research-pack', request: { query: 'battery recycling' } }),
  });
  assert.equal(response.status, 201);
  return response.json();
}

test('creates a private order and advertises an upto hold paid directly to the provider', async () => {
  const service = await start();
  const created = await createOrder(service.base, 'api-request-0001');
  assert.equal(created.order.payment_state, 'none');
  const denied = await fetch(`${service.base}${created.execute_path}`, {
    method: 'POST', headers: { 'x-motto-order-token': created.order_token },
  });
  assert.equal(denied.status, 402);
  assert.equal((await denied.json()).accepts[0].payTo, quote().payout_address);
  assert.equal(service.gate().payTo, quote().payout_address);
  assert.equal(service.gate().amount.baseUnits(), 1000000n);
  const replay = await fetch(`${service.base}/v1/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'api-request-0001' },
    body: JSON.stringify({ provider_id: 'paper-shop', offer_id: 'research-pack', request: { query: 'battery recycling' } }),
  });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).order.id, created.order.id);
  assert.equal(service.quoteCalls(), 1);
});

test('verifies provider evidence before charging and records a settled order', async () => {
  const service = await start();
  const created = await createOrder(service.base, 'api-request-0002');
  const response = await fetch(`${service.base}${created.execute_path}`, {
    method: 'POST',
    headers: { 'x-motto-order-token': created.order_token, 'payment-signature': 'paid-proof' },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(service.charged(), 750000n);
  assert.deepEqual([body.order.order_state, body.order.fulfillment_state, body.order.payment_state], ['completed', 'verified', 'settled']);
  assert.deepEqual([body.payment.charged_usd, body.payment.returned_usd], ['0.75', '0.25']);
  assert.equal(body.order.artifact.citations[0].doi, '10.1234/example');

  const read = await fetch(`${service.base}/v1/orders/${created.order.id}`, { headers: { authorization: `Bearer ${created.order_token}` } });
  assert.equal(read.status, 200);
  assert.equal((await read.json()).order.payment_state, 'settled');
});

test('provider or evidence failure settles zero', async () => {
  const service = await start({ providerFailure: true });
  const created = await createOrder(service.base, 'api-request-0003');
  const response = await fetch(`${service.base}${created.execute_path}`, {
    method: 'POST', headers: { 'x-motto-order-token': created.order_token, 'payment-signature': 'paid-proof' },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(service.charged(), 0n);
  assert.deepEqual([body.order.fulfillment_state, body.order.payment_state], ['rejected', 'settled']);
  assert.deepEqual([body.payment.charged_usd, body.payment.returned_usd], ['0.00', '1.00']);
});

test('failed settlement remains unknown and cannot be executed again', async () => {
  const service = await start({ settlementFailure: true });
  const created = await createOrder(service.base, 'api-request-0004');
  const response = await fetch(`${service.base}${created.execute_path}`, {
    method: 'POST', headers: { 'x-motto-order-token': created.order_token, 'payment-signature': 'paid-proof' },
  });
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.error, 'settlement_unknown');
  assert.equal(body.order.payment_state, 'settlement_unknown');
  assert.equal(body.payment.charged_usd, null);
  const retry = await fetch(`${service.base}${created.execute_path}`, {
    method: 'POST', headers: { 'x-motto-order-token': created.order_token, 'payment-signature': 'another-proof' },
  });
  assert.equal(retry.status, 409);
  assert.equal((await retry.json()).error, 'order_already_executed');
});
