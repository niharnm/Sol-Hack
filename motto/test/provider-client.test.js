import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderClient, ProviderClientError, providerClientInternals } from '../src/provider-client.js';

const provider = {
  id: 'paper-shop',
  fulfillment_url: 'https://merchant.example/motto/fulfill',
};
const registry = { getProvider(id) { assert.equal(id, provider.id); return provider; } };
const order = {
  id: 'order_01', hold_id: 'hold_01', provider_id: provider.id, network: 'devnet', payout_address: 'pay_to',
  request_sha256: 'a'.repeat(64), fulfillment_deadline_ms: Date.now() + 60_000,
  signed_quote: { quote: { quote_id: 'quote_01' }, signature: 'signed' }, request: { query: 'battery recycling' },
};

function code(error) {
  assert.ok(error instanceof ProviderClientError);
  return error.code;
}

function client(options = {}) {
  return new ProviderClient({
    registry,
    tokenFor: () => 'provider-token-with-enough-bytes',
    resolver: async () => [{ address: '8.8.8.8', family: 4 }],
    fetcher: async () => new Response(JSON.stringify({ artifact: { delivered: true }, signed_attestation: { attestation: {}, signature: 'signed' } }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }),
    ...options,
  });
}

test('sends a bounded authenticated fulfillment request with the order binding', async () => {
  let seen;
  const result = await client({ fetcher: async (url, init) => {
    seen = { url: String(url), init, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ artifact: { delivered: true }, signed_attestation: { attestation: {}, signature: 'signed' } }), {
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  } }).fulfill(order);
  assert.equal(seen.url, provider.fulfillment_url);
  assert.equal(seen.init.headers.authorization, 'Bearer provider-token-with-enough-bytes');
  assert.equal(seen.init.headers['idempotency-key'], order.id);
  assert.equal(seen.init.redirect, 'error');
  assert.equal(seen.body.order.hold_id, order.hold_id);
  assert.equal(seen.body.action, 'fulfill');
  assert.deepEqual(seen.body.request, order.request);
  assert.equal(result.artifact.delivered, true);
});

test('requests a provider-signed quote before any payment challenge', async () => {
  let seen;
  const signedQuote = { quote: { quote_id: 'quote_01' }, signature: 'signed' };
  const result = await client({ fetcher: async (_url, init) => {
    seen = { headers: init.headers, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ signed_quote: signedQuote }), { headers: { 'content-type': 'application/json' } });
  } }).quote({
    providerId: 'paper-shop',
    offerId: 'research-pack',
    request: { query: 'battery recycling' },
    network: 'devnet',
    idempotencyKey: 'quote-request-0001',
  });
  assert.equal(seen.body.action, 'quote');
  assert.equal(seen.body.offer_id, 'research-pack');
  assert.equal(seen.headers['idempotency-key'], 'quote-request-0001');
  assert.deepEqual(result.signed_quote, signedQuote);
});

test('blocks private DNS answers and permits explicit loopback test providers', async () => {
  await assert.rejects(() => client({ resolver: async () => [{ address: '10.0.0.4', family: 4 }] }).fulfill(order), error => code(error) === 'provider_address_blocked');
  const localProvider = { ...provider, fulfillment_url: 'http://127.0.0.1:9000/fulfill' };
  const localRegistry = { getProvider: () => localProvider };
  await assert.rejects(() => new ProviderClient({ registry: localRegistry, tokenFor: () => 'provider-token-with-enough-bytes' }).fulfill(order), error => code(error) === 'provider_address_blocked');
  const result = await new ProviderClient({
    registry: localRegistry,
    allowLocal: true,
    tokenFor: () => 'provider-token-with-enough-bytes',
    fetcher: async () => new Response(JSON.stringify({ artifact: {}, signed_attestation: {} }), { headers: { 'content-type': 'application/json' } }),
  }).fulfill(order);
  assert.deepEqual(result.artifact, {});
});

test('fails closed on missing auth, redirects, provider errors and invalid JSON', async () => {
  await assert.rejects(() => client({ tokenFor: () => undefined }).fulfill(order), error => code(error) === 'provider_auth_not_configured');
  await assert.rejects(() => client({ fetcher: async () => new Response('no', { status: 503 }) }).fulfill(order), error => code(error) === 'provider_rejected');
  await assert.rejects(() => client({ fetcher: async () => new Response('not-json', { headers: { 'content-type': 'application/json' } }) }).fulfill(order), error => code(error) === 'invalid_provider_response');
  await assert.rejects(() => client({ fetcher: async () => new Response('{}', { headers: { 'content-type': 'text/plain' } }) }).fulfill(order), error => code(error) === 'invalid_provider_content_type');
});

test('enforces the decompressed response byte limit', async () => {
  const oversized = JSON.stringify({ artifact: 'x'.repeat(1500), signed_attestation: {} });
  await assert.rejects(() => client({ responseLimit: 1024, fetcher: async () => new Response(oversized, { headers: { 'content-type': 'application/json' } }) }).fulfill(order), error => code(error) === 'provider_response_too_large');
  assert.equal(providerClientInternals.privateIp('192.168.1.1', 4), true);
  assert.equal(providerClientInternals.privateIp('8.8.8.8', 4), false);
  assert.equal(providerClientInternals.privateIp('fd00::1', 6), true);
});
