import { createHash, createPublicKey, timingSafeEqual, verify } from 'node:crypto';
import { toBaseUnits } from './settlement.js';

const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const NONCE = /^[A-Za-z0-9_-]{16,128}$/;
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const OUTCOMES = new Set(['delivered', 'already_handled', 'not_delivered', 'inconclusive']);
const SETTLEMENT_FIELDS = ['delivered_usd', 'already_handled_usd', 'not_delivered_usd', 'inconclusive_usd'];

export class ProviderProtocolError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'ProviderProtocolError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProviderProtocolError(code, message);
}

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`invalid_${name}`, `${name} must be an object`);
  return value;
}

function exactKeys(value, allowed, name) {
  const missing = allowed.filter(key => !Object.hasOwn(value, key));
  if (missing.length) fail(`invalid_${name}`, `${name} is missing "${missing[0]}"`);
  const extra = Object.keys(value).filter(key => !allowed.includes(key));
  if (extra.length) fail(`invalid_${name}`, `${name} has unknown field "${extra[0]}"`);
}

function reference(value, name) {
  if (typeof value !== 'string' || !REFERENCE.test(value)) fail(`invalid_${name}`, `${name} contains unsupported characters`);
  return value;
}

function digest(value, name) {
  if (typeof value !== 'string' || !DIGEST.test(value)) fail(`invalid_${name}`, `${name} must be a lowercase SHA-256 hex digest`);
  return value;
}

function nonce(value) {
  if (typeof value !== 'string' || !NONCE.test(value)) fail('invalid_nonce', 'nonce must be 16 to 128 base64url characters');
  return value;
}

function timestamp(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(`invalid_${name}`, `${name} must be a positive integer in milliseconds`);
  return value;
}

function amount(value, name) {
  if (typeof value !== 'string') fail(`invalid_${name}`, `${name} must be a USD string`);
  try {
    return toBaseUnits(value);
  } catch {
    fail(`invalid_${name}`, `${name} must be a non-negative USD string with at most six decimals`);
  }
}

function signatureBytes(value) {
  if (typeof value !== 'string' || !SIGNATURE.test(value)) fail('invalid_signature', 'signature must be an unpadded base64url Ed25519 signature');
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== 64 || bytes.toString('base64url') !== value) fail('invalid_signature', 'signature must encode 64 bytes');
  return bytes;
}

function publicKeyFromHex(value) {
  return createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(value, 'hex')]),
    format: 'der',
    type: 'spki',
  });
}

function assertSignature(payload, signature, publicKey, code) {
  const valid = verify(null, Buffer.from(payload), publicKeyFromHex(publicKey), signatureBytes(signature));
  if (!valid) fail(code, code.replaceAll('_', ' '));
}

function canonical(value, seen) {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('invalid_json_value', 'canonical JSON does not allow non-finite numbers');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') fail('invalid_json_value', `canonical JSON does not allow ${typeof value}`);
  if (seen.has(value)) fail('invalid_json_value', 'canonical JSON does not allow cycles');
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    if (Object.keys(value).some(key => !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) fail('invalid_json_value', 'canonical JSON arrays cannot have named properties');
    for (let index = 0; index < value.length; index++) if (!Object.hasOwn(value, index)) fail('invalid_json_value', 'canonical JSON arrays cannot have holes');
    result = `[${value.map(item => canonical(item, seen)).join(',')}]`;
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail('invalid_json_value', 'canonical JSON requires plain objects');
    result = `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key], seen)}`).join(',')}}`;
  }
  seen.delete(value);
  return result;
}

export function canonicalJson(value) {
  return canonical(value, new Set());
}

export function sha256Hex(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function quoteSigningPayload(quote) {
  return [
    'motto-quote-v1',
    quote.quote_id,
    quote.provider_id,
    quote.offer_id,
    quote.network,
    quote.payout_address,
    quote.hold_usd,
    quote.settlement.delivered_usd,
    quote.settlement.already_handled_usd,
    quote.settlement.not_delivered_usd,
    quote.settlement.inconclusive_usd,
    quote.request_sha256,
    quote.attestor_id,
    quote.nonce,
    String(quote.expires_at_ms),
    String(quote.fulfillment_timeout_seconds),
  ].join('\n');
}

export function attestationSigningPayload(attestation) {
  return [
    'motto-attestation-v1',
    attestation.attestation_id,
    attestation.provider_id,
    attestation.offer_id,
    attestation.quote_id,
    attestation.order_id,
    attestation.hold_id,
    attestation.attestor_id,
    attestation.network,
    attestation.payout_address,
    attestation.request_sha256,
    attestation.outcome,
    attestation.artifact_sha256,
    attestation.nonce,
    String(attestation.issued_at_ms),
    String(attestation.expires_at_ms),
  ].join('\n');
}

function equalText(actual, expected) {
  const a = Buffer.from(String(actual));
  const b = Buffer.from(String(expected));
  return a.length === b.length && timingSafeEqual(a, b);
}

export class ReplayGuard {
  constructor({ now = Date.now, maxEntries = 10_000 } = {}) {
    if (typeof now !== 'function' || !Number.isInteger(maxEntries) || maxEntries < 1) fail('invalid_replay_guard');
    this.now = now;
    this.maxEntries = maxEntries;
    this.entries = new Map();
  }

  prune() {
    const now = this.now();
    for (const [key, entry] of this.entries) if (entry.expires_at_ms <= now) this.entries.delete(key);
  }

  consume({ kind, signerId, nonce: value, fingerprint, expiresAtMs }) {
    this.prune();
    const cleanNonce = nonce(value);
    const key = `${reference(kind, 'replay_kind')}:${reference(signerId, 'signer_id')}:${cleanNonce}`;
    const existing = this.entries.get(key);
    if (existing) {
      if (equalText(existing.fingerprint, fingerprint)) return { replayed: true };
      fail('replay_conflict', 'nonce was already used for different signed content');
    }
    if (this.entries.size >= this.maxEntries) fail('replay_store_full', 'replay store is full');
    this.entries.set(key, { fingerprint, expires_at_ms: timestamp(expiresAtMs, 'expires_at_ms') });
    return { replayed: false };
  }
}

function quoteFields(raw) {
  const quote = object(raw, 'quote');
  const fields = [
    'version', 'quote_id', 'provider_id', 'offer_id', 'network', 'payout_address', 'hold_usd', 'settlement',
    'request_sha256', 'attestor_id', 'nonce', 'expires_at_ms', 'fulfillment_timeout_seconds',
  ];
  exactKeys(quote, fields, 'quote');
  if (quote.version !== 1) fail('unsupported_quote_version', 'quote version must be 1');
  reference(quote.quote_id, 'quote_id');
  reference(quote.provider_id, 'provider_id');
  reference(quote.offer_id, 'offer_id');
  reference(quote.network, 'network');
  reference(quote.payout_address, 'payout_address');
  digest(quote.request_sha256, 'request_sha256');
  reference(quote.attestor_id, 'attestor_id');
  nonce(quote.nonce);
  timestamp(quote.expires_at_ms, 'expires_at_ms');
  if (!Number.isInteger(quote.fulfillment_timeout_seconds) || quote.fulfillment_timeout_seconds < 1 || quote.fulfillment_timeout_seconds > 180) {
    fail('invalid_fulfillment_timeout', 'fulfillment_timeout_seconds must be an integer from 1 to 180');
  }
  const settlement = object(quote.settlement, 'settlement');
  exactKeys(settlement, SETTLEMENT_FIELDS, 'settlement');
  const hold = amount(quote.hold_usd, 'hold_usd');
  if (hold === 0n) fail('invalid_hold_usd', 'hold_usd must be greater than zero');
  for (const field of SETTLEMENT_FIELDS) if (amount(settlement[field], field) > hold) fail('settlement_above_hold', `${field} exceeds hold_usd`);
  return hold;
}

export function verifySignedQuote(input, {
  registry,
  request,
  network,
  now = Date.now(),
  replayGuard,
  consumeReplay = false,
} = {}) {
  const envelope = object(input, 'signed_quote');
  exactKeys(envelope, ['quote', 'signature'], 'signed_quote');
  const quote = envelope.quote;
  const hold = quoteFields(quote);
  const provider = registry?.getProvider(quote.provider_id) ?? fail('registry_required');
  const offer = registry.getOffer(quote.provider_id, quote.offer_id);
  const attestor = registry.getAttestor(quote.provider_id, quote.attestor_id);
  if (!offer.attestor_ids.includes(attestor.id)) fail('attestor_not_allowed', 'attestor is not allowed for this offer');
  if (quote.network !== network || quote.network !== offer.network) fail('network_mismatch', 'quote network does not match the request and registered offer');
  if (quote.payout_address !== provider.payout_address) fail('payout_mismatch', 'quote payout address does not match the provider registry');
  if (hold > toBaseUnits(offer.max_hold_usd)) fail('hold_above_offer_ceiling', 'quote hold exceeds the registered offer ceiling');
  if (quote.fulfillment_timeout_seconds !== offer.fulfillment_timeout_seconds) fail('fulfillment_timeout_mismatch', 'quote timeout does not match the registered offer');
  if (quote.expires_at_ms <= now) fail('quote_expired', 'quote has expired');
  if (quote.request_sha256 !== sha256Hex(request)) fail('request_digest_mismatch', 'quote is not bound to this request');

  const payload = quoteSigningPayload(quote);
  assertSignature(payload, envelope.signature, provider.quote_public_key, 'invalid_quote_signature');
  const fingerprint = createHash('sha256').update(payload).update('\n').update(envelope.signature).digest('hex');
  const replay = consumeReplay
    ? (replayGuard ?? fail('replay_guard_required')).consume({
        kind: 'quote', signerId: provider.id, nonce: quote.nonce, fingerprint, expiresAtMs: quote.expires_at_ms,
      })
    : { replayed: false };
  return { quote, signature: envelope.signature, provider, offer, attestor, fingerprint, ...replay };
}

function attestationFields(raw) {
  const attestation = object(raw, 'attestation');
  const fields = [
    'version', 'attestation_id', 'provider_id', 'offer_id', 'quote_id', 'order_id', 'hold_id', 'attestor_id',
    'network', 'payout_address', 'request_sha256', 'outcome', 'artifact_sha256', 'nonce', 'issued_at_ms', 'expires_at_ms',
  ];
  exactKeys(attestation, fields, 'attestation');
  if (attestation.version !== 1) fail('unsupported_attestation_version', 'attestation version must be 1');
  for (const field of ['attestation_id', 'provider_id', 'offer_id', 'quote_id', 'order_id', 'hold_id', 'attestor_id', 'network', 'payout_address']) {
    reference(attestation[field], field);
  }
  digest(attestation.request_sha256, 'request_sha256');
  digest(attestation.artifact_sha256, 'artifact_sha256');
  nonce(attestation.nonce);
  if (!OUTCOMES.has(attestation.outcome)) fail('invalid_outcome', 'attestation outcome is unsupported');
  timestamp(attestation.issued_at_ms, 'issued_at_ms');
  timestamp(attestation.expires_at_ms, 'expires_at_ms');
  if (attestation.expires_at_ms < attestation.issued_at_ms) fail('invalid_attestation_expiry', 'attestation expires before it was issued');
  return attestation;
}

export function verifySignedAttestation(input, {
  registry,
  quote,
  order,
  artifact,
  network,
  now = Date.now(),
  maxClockSkewMs = 30_000,
  maxAgeMs = 5 * 60_000,
  replayGuard,
  consumeReplay = false,
} = {}) {
  const envelope = object(input, 'signed_attestation');
  exactKeys(envelope, ['attestation', 'signature'], 'signed_attestation');
  const attestation = attestationFields(envelope.attestation);
  object(quote, 'quote');
  object(order, 'order');
  const provider = registry?.getProvider(attestation.provider_id) ?? fail('registry_required');
  const offer = registry.getOffer(attestation.provider_id, attestation.offer_id);
  const attestor = registry.getAttestor(attestation.provider_id, attestation.attestor_id);
  if (!offer.attestor_ids.includes(attestor.id)) fail('attestor_not_allowed', 'attestor is not allowed for this offer');
  if (attestation.provider_id !== quote.provider_id || attestation.offer_id !== quote.offer_id || attestation.quote_id !== quote.quote_id) {
    fail('quote_binding_mismatch', 'attestation does not match the signed quote');
  }
  if (attestation.order_id !== order.id || attestation.hold_id !== order.hold_id) fail('order_binding_mismatch', 'attestation does not match the order and hold');
  if (attestation.network !== network || attestation.network !== quote.network || attestation.network !== offer.network) fail('network_mismatch');
  if (attestation.payout_address !== provider.payout_address || attestation.payout_address !== quote.payout_address) fail('payout_mismatch');
  if (attestation.request_sha256 !== quote.request_sha256) fail('request_digest_mismatch');
  if (attestation.artifact_sha256 !== sha256Hex(artifact)) fail('artifact_digest_mismatch', 'attestation is not bound to this artifact');
  if (!Number.isSafeInteger(order.fulfillment_deadline_ms)) fail('invalid_order_deadline');
  if (attestation.issued_at_ms > now + maxClockSkewMs) fail('attestation_from_future');
  if (attestation.issued_at_ms < now - maxAgeMs) fail('attestation_too_old');
  if (attestation.expires_at_ms <= now) fail('attestation_expired');
  if (now > order.fulfillment_deadline_ms || attestation.issued_at_ms > order.fulfillment_deadline_ms || attestation.expires_at_ms > order.fulfillment_deadline_ms) {
    fail('fulfillment_deadline_exceeded');
  }

  const payload = attestationSigningPayload(attestation);
  assertSignature(payload, envelope.signature, attestor.public_key, 'invalid_attestation_signature');
  const fingerprint = createHash('sha256').update(payload).update('\n').update(envelope.signature).digest('hex');
  const replay = consumeReplay
    ? (replayGuard ?? fail('replay_guard_required')).consume({
        kind: 'attestation', signerId: `${provider.id}:${attestor.id}`, nonce: attestation.nonce, fingerprint, expiresAtMs: order.fulfillment_deadline_ms,
      })
    : { replayed: false };
  return { attestation, signature: envelope.signature, provider, offer, attestor, fingerprint, ...replay };
}
