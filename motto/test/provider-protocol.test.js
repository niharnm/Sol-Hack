import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import bs58 from 'bs58';
import { createProviderRegistry } from '../src/provider-registry.js';
import {
  attestationSigningPayload,
  canonicalJson,
  ProviderProtocolError,
  quoteSigningPayload,
  ReplayGuard,
  sha256Hex,
  verifySignedAttestation,
  verifySignedQuote,
} from '../src/provider-protocol.js';

const NOW = 1_800_000_000_000;

function keyPair() {
  const pair = generateKeyPairSync('ed25519');
  return { privateKey: pair.privateKey, publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex') };
}

function signature(payload, privateKey) {
  return sign(null, Buffer.from(payload), privateKey).toString('base64url');
}

function setup() {
  const quoteKey = keyPair();
  const attestorKey = keyPair();
  const payout = bs58.encode(randomBytes(32));
  const registry = createProviderRegistry({
    version: 1,
    providers: [{
      id: 'paper-shop',
      name: 'Paper Shop',
      payout_address: payout,
      quote_public_key: quoteKey.publicKey,
      fulfillment_url: 'https://merchant.example/motto',
      attestors: [{ id: 'delivery-service', public_key: attestorKey.publicKey }],
      offers: [{
        id: 'research-pack',
        summary: 'Buy a signed research pack',
        network: 'devnet',
        max_hold_usd: '5.00',
        fulfillment_timeout_seconds: 90,
        attestor_ids: ['delivery-service'],
      }],
    }],
  });
  const request = { query: 'battery recycling', options: { count: 3, formats: ['doi', 'title'] } };
  const quote = {
    version: 1,
    quote_id: 'quote_01',
    provider_id: 'paper-shop',
    offer_id: 'research-pack',
    network: 'devnet',
    payout_address: payout,
    hold_usd: '1.00',
    settlement: {
      delivered_usd: '1.00',
      already_handled_usd: '0.10',
      not_delivered_usd: '0.00',
      inconclusive_usd: '0.00',
    },
    request_sha256: sha256Hex(request),
    attestor_id: 'delivery-service',
    nonce: 'quote_nonce_000001',
    expires_at_ms: NOW + 60_000,
    fulfillment_timeout_seconds: 90,
  };
  return { registry, request, quote, quoteKey, attestorKey, payout };
}

function signedQuote(state, quote = state.quote) {
  return { quote, signature: signature(quoteSigningPayload(quote), state.quoteKey.privateKey) };
}

function signedAttestation(state, { quote = state.quote, artifact, order, changes = {} }) {
  const attestation = {
    version: 1,
    attestation_id: 'attestation_01',
    provider_id: quote.provider_id,
    offer_id: quote.offer_id,
    quote_id: quote.quote_id,
    order_id: order.id,
    hold_id: order.hold_id,
    attestor_id: quote.attestor_id,
    network: quote.network,
    payout_address: quote.payout_address,
    request_sha256: quote.request_sha256,
    outcome: 'delivered',
    artifact_sha256: sha256Hex(artifact),
    nonce: 'attest_nonce_00001',
    issued_at_ms: NOW,
    expires_at_ms: NOW + 60_000,
    ...changes,
  };
  return { attestation, signature: signature(attestationSigningPayload(attestation), state.attestorKey.privateKey) };
}

function protocolCode(error) {
  assert.ok(error instanceof ProviderProtocolError);
  return error.code;
}

test('canonical JSON and digests are independent of object key order', () => {
  const left = { z: [3, { b: true, a: null }], a: 'text' };
  const right = { a: 'text', z: [3, { a: null, b: true }] };
  assert.equal(canonicalJson(left), '{"a":"text","z":[3,{"a":null,"b":true}]}');
  assert.equal(sha256Hex(left), sha256Hex(right));
  assert.throws(() => canonicalJson({ bad: undefined }), error => protocolCode(error) === 'invalid_json_value');
  assert.throws(() => canonicalJson([, 1]), error => protocolCode(error) === 'invalid_json_value');
  const cycle = {};
  cycle.self = cycle;
  assert.throws(() => canonicalJson(cycle), error => protocolCode(error) === 'invalid_json_value');
});

test('verifies a provider quote bound to request, payout, network, policy and timeout', () => {
  const state = setup();
  const result = verifySignedQuote(signedQuote(state), {
    registry: state.registry,
    request: state.request,
    network: 'devnet',
    now: NOW,
  });
  assert.equal(result.provider.id, 'paper-shop');
  assert.equal(result.offer.id, 'research-pack');
  assert.equal(result.attestor.id, 'delivery-service');
  assert.match(result.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(result.replayed, false);
});

test('rejects quote changes and mismatched request context', () => {
  const state = setup();
  const changedAmount = structuredClone(state.quote);
  changedAmount.hold_usd = '2.00';
  assert.throws(() => verifySignedQuote({ quote: changedAmount, signature: signedQuote(state).signature }, {
    registry: state.registry, request: state.request, network: 'devnet', now: NOW,
  }), error => protocolCode(error) === 'invalid_quote_signature');

  const contexts = [
    ['network_mismatch', { network: 'mainnet' }],
    ['request_digest_mismatch', { request: { query: 'different' } }],
  ];
  for (const [expected, overrides] of contexts) {
    assert.throws(() => verifySignedQuote(signedQuote(state), {
      registry: state.registry, request: state.request, network: 'devnet', now: NOW, ...overrides,
    }), error => protocolCode(error) === expected, expected);
  }

  const quoteCases = [
    ['payout_mismatch', quote => { quote.payout_address = bs58.encode(randomBytes(32)); }],
    ['hold_above_offer_ceiling', quote => { quote.hold_usd = '6.00'; quote.settlement.delivered_usd = '6.00'; }],
    ['settlement_above_hold', quote => { quote.settlement.already_handled_usd = '1.01'; }],
    ['invalid_hold_usd', quote => { quote.hold_usd = 1; }],
    ['fulfillment_timeout_mismatch', quote => { quote.fulfillment_timeout_seconds = 89; }],
    ['quote_expired', quote => { quote.expires_at_ms = NOW; }],
  ];
  for (const [expected, mutate] of quoteCases) {
    const quote = structuredClone(state.quote);
    mutate(quote);
    assert.throws(() => verifySignedQuote(signedQuote(state, quote), {
      registry: state.registry, request: state.request, network: 'devnet', now: NOW,
    }), error => protocolCode(error) === expected, expected);
  }
});

test('quote replay guard permits exact retries and rejects nonce reuse with different content', () => {
  const state = setup();
  const guard = new ReplayGuard({ now: () => NOW });
  const first = verifySignedQuote(signedQuote(state), {
    registry: state.registry, request: state.request, network: 'devnet', now: NOW, replayGuard: guard, consumeReplay: true,
  });
  const retry = verifySignedQuote(signedQuote(state), {
    registry: state.registry, request: state.request, network: 'devnet', now: NOW, replayGuard: guard, consumeReplay: true,
  });
  assert.equal(first.replayed, false);
  assert.equal(retry.replayed, true);

  const conflicting = structuredClone(state.quote);
  conflicting.settlement.already_handled_usd = '0.11';
  assert.throws(() => verifySignedQuote(signedQuote(state, conflicting), {
    registry: state.registry, request: state.request, network: 'devnet', now: NOW, replayGuard: guard, consumeReplay: true,
  }), error => protocolCode(error) === 'replay_conflict');
});

test('verifies an independent attestation bound to quote, order, hold and artifact', () => {
  const state = setup();
  const artifact = { type: 'citation_pack', citations: [{ doi: '10.1234/example', title: 'Example' }] };
  const order = { id: 'order_01', hold_id: 'hold_01', fulfillment_deadline_ms: NOW + 90_000 };
  const result = verifySignedAttestation(signedAttestation(state, { artifact, order }), {
    registry: state.registry,
    quote: state.quote,
    order,
    artifact,
    network: 'devnet',
    now: NOW,
  });
  assert.equal(result.attestation.outcome, 'delivered');
  assert.equal(result.attestor.public_key, state.attestorKey.publicKey);
  assert.notEqual(result.attestor.public_key, state.quoteKey.publicKey);
  assert.match(result.fingerprint, /^[0-9a-f]{64}$/);
});

test('rejects attestation signature tampering and binding mismatches', () => {
  const state = setup();
  const artifact = { delivered: true, credential: 'private-result' };
  const order = { id: 'order_01', hold_id: 'hold_01', fulfillment_deadline_ms: NOW + 90_000 };
  const original = signedAttestation(state, { artifact, order });
  const tampered = structuredClone(original);
  tampered.attestation.outcome = 'not_delivered';
  assert.throws(() => verifySignedAttestation(tampered, {
    registry: state.registry, quote: state.quote, order, artifact, network: 'devnet', now: NOW,
  }), error => protocolCode(error) === 'invalid_attestation_signature');

  const cases = [
    ['artifact_digest_mismatch', { artifact: { delivered: false } }],
    ['network_mismatch', { network: 'mainnet' }],
    ['order_binding_mismatch', { order: { ...order, hold_id: 'other_hold' } }],
  ];
  for (const [expected, overrides] of cases) {
    assert.throws(() => verifySignedAttestation(original, {
      registry: state.registry, quote: state.quote, order, artifact, network: 'devnet', now: NOW, ...overrides,
    }), error => protocolCode(error) === expected, expected);
  }
});

test('enforces attestation age, expiry, deadline and nonce replay rules', () => {
  const state = setup();
  const artifact = { delivered: true };
  const order = { id: 'order_01', hold_id: 'hold_01', fulfillment_deadline_ms: NOW + 90_000 };
  const timeCases = [
    ['attestation_from_future', { issued_at_ms: NOW + 30_001, expires_at_ms: NOW + 60_000 }],
    ['attestation_too_old', { issued_at_ms: NOW - 300_001, expires_at_ms: NOW + 1_000 }],
    ['attestation_expired', { issued_at_ms: NOW - 1_000, expires_at_ms: NOW }],
    ['fulfillment_deadline_exceeded', { issued_at_ms: NOW, expires_at_ms: NOW + 90_001 }],
  ];
  for (const [expected, changes] of timeCases) {
    assert.throws(() => verifySignedAttestation(signedAttestation(state, { artifact, order, changes }), {
      registry: state.registry, quote: state.quote, order, artifact, network: 'devnet', now: NOW,
    }), error => protocolCode(error) === expected, expected);
  }

  const guard = new ReplayGuard({ now: () => NOW });
  const envelope = signedAttestation(state, { artifact, order });
  const options = { registry: state.registry, quote: state.quote, order, artifact, network: 'devnet', now: NOW, replayGuard: guard, consumeReplay: true };
  assert.equal(verifySignedAttestation(envelope, options).replayed, false);
  assert.equal(verifySignedAttestation(envelope, options).replayed, true);
  const conflict = signedAttestation(state, { artifact, order, changes: { outcome: 'inconclusive' } });
  assert.throws(() => verifySignedAttestation(conflict, options), error => protocolCode(error) === 'replay_conflict');
});
