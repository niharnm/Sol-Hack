import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256Hex } from './provider-protocol.js';

const IDEMPOTENCY_KEY = /^[\x21-\x7e]{8,256}$/;
const TERMINAL_PAYMENT_STATES = new Set(['settled', 'settlement_unknown']);

export class OrderError extends Error {
  constructor(status, code, message = code) {
    super(message);
    this.name = 'OrderError';
    this.status = status;
    this.code = code;
  }
}

function fail(status, code, message) {
  throw new OrderError(status, code, message);
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sameSecret(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function withoutSecrets(order) {
  const { capability_sha256, idempotency_sha256, creation_sha256, ...visible } = order;
  return structuredClone(visible);
}

export class OrderStore {
  constructor({ dataDir = 'data', capabilitySecret, now = Date.now, uuid = randomUUID } = {}) {
    if (typeof now !== 'function' || typeof uuid !== 'function') fail(500, 'invalid_order_store');
    this.now = now;
    this.uuid = uuid;
    this.directory = dataDir;
    this.file = join(dataDir, 'orders.json');
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.capabilitySecret = capabilitySecret ?? this.loadCapabilitySecret();
    if (typeof this.capabilitySecret !== 'string' || Buffer.byteLength(this.capabilitySecret) < 32) {
      fail(500, 'invalid_capability_secret', 'order capability secret must contain at least 32 bytes');
    }
    this.orders = this.load();
  }

  loadCapabilitySecret() {
    const path = join(this.directory, 'order-capability.key');
    if (!existsSync(path)) {
      writeFileSync(path, randomBytes(32).toString('base64url'), { mode: 0o600, flag: 'wx' });
    }
    chmodSync(path, 0o600);
    return readFileSync(path, 'utf8').trim();
  }

  load() {
    if (!existsSync(this.file)) return [];
    let value;
    try {
      value = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch (error) {
      fail(500, 'invalid_order_store', `cannot read ${this.file}: ${error.message}`);
    }
    if (!Array.isArray(value) || value.some(order => !order || typeof order.id !== 'string')) {
      fail(500, 'invalid_order_store', `${this.file} must contain an array of orders`);
    }
    return value;
  }

  save() {
    const temporary = `${this.file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.orders, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, this.file);
  }

  capabilityFor(orderId) {
    return `motto_${createHmac('sha256', this.capabilitySecret).update(orderId).digest('base64url')}`;
  }

  create({ signedQuote, quoteFingerprint, request, idempotencyKey }) {
    if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY.test(idempotencyKey)) {
      fail(400, 'invalid_idempotency_key', 'Idempotency-Key must be 8 to 256 visible ASCII characters');
    }
    const idempotencySha256 = hash(idempotencyKey);
    const creationSha256 = sha256Hex({ signed_quote: signedQuote, request });
    const prior = this.orders.find(order => order.idempotency_sha256 === idempotencySha256);
    if (prior) {
      if (prior.creation_sha256 !== creationSha256) fail(409, 'idempotency_conflict', 'Idempotency-Key was used with different order data');
      return { order: withoutSecrets(prior), capability: this.capabilityFor(prior.id), replayed: true };
    }
    if (this.orders.some(order => order.quote_fingerprint === quoteFingerprint)) {
      fail(409, 'quote_already_used', 'signed quote already belongs to another order');
    }

    const quote = signedQuote.quote;
    const id = this.uuid();
    const capability = this.capabilityFor(id);
    const createdAt = this.now();
    const order = {
      version: 1,
      id,
      capability_sha256: hash(capability),
      idempotency_sha256: idempotencySha256,
      creation_sha256: creationSha256,
      provider_id: quote.provider_id,
      offer_id: quote.offer_id,
      network: quote.network,
      payout_address: quote.payout_address,
      hold_usd: quote.hold_usd,
      settlement: structuredClone(quote.settlement),
      request: structuredClone(request),
      request_sha256: quote.request_sha256,
      signed_quote: structuredClone(signedQuote),
      quote_fingerprint: quoteFingerprint,
      order_state: 'awaiting_payment',
      fulfillment_state: 'not_started',
      payment_state: 'none',
      created_at_ms: createdAt,
      updated_at_ms: createdAt,
      events: [{ sequence: 1, type: 'order_created', at_ms: createdAt }],
    };
    this.orders.push(order);
    this.save();
    return { order: withoutSecrets(order), capability, replayed: false };
  }

  getInternal(id) {
    const order = this.orders.find(candidate => candidate.id === id);
    if (!order) fail(404, 'order_not_found');
    return order;
  }

  get(id, capability) {
    const order = this.getInternal(id);
    if (!sameSecret(hash(capability ?? ''), order.capability_sha256)) fail(404, 'order_not_found');
    return withoutSecrets(order);
  }

  startExecution(id, { payer, paymentProofSha256 }) {
    const order = this.getInternal(id);
    if (order.payment_state !== 'none') fail(409, 'order_already_executed');
    const now = this.now();
    const deadline = Math.min(order.signed_quote.quote.expires_at_ms, now + order.signed_quote.quote.fulfillment_timeout_seconds * 1000);
    if (deadline <= now) fail(409, 'quote_expired');
    order.hold_id = this.uuid();
    order.payer = payer ?? null;
    order.payment_proof_sha256 = paymentProofSha256;
    order.fulfillment_deadline_ms = deadline;
    order.order_state = 'executing';
    order.fulfillment_state = 'requested';
    order.payment_state = 'held';
    this.record(order, 'payment_held');
    return withoutSecrets(order);
  }

  recordEvidence(id, { artifact, signedAttestation, attestationFingerprint }) {
    const order = this.getInternal(id);
    if (order.payment_state !== 'held' || order.fulfillment_state !== 'requested') fail(409, 'invalid_order_transition');
    order.artifact = structuredClone(artifact);
    order.signed_attestation = structuredClone(signedAttestation);
    order.attestation_fingerprint = attestationFingerprint;
    order.outcome = signedAttestation.attestation.outcome;
    order.fulfillment_state = 'verified';
    order.approved_charge_usd = order.settlement[`${order.outcome}_usd`];
    this.record(order, 'evidence_verified');
    return withoutSecrets(order);
  }

  rejectFulfillment(id, code) {
    const order = this.getInternal(id);
    if (order.payment_state !== 'held' || !['requested', 'evidence_received'].includes(order.fulfillment_state)) {
      fail(409, 'invalid_order_transition');
    }
    order.fulfillment_state = this.now() >= order.fulfillment_deadline_ms ? 'timed_out' : 'rejected';
    order.failure_code = String(code || 'fulfillment_rejected');
    order.outcome = 'inconclusive';
    order.approved_charge_usd = '0.00';
    this.record(order, order.fulfillment_state);
    return withoutSecrets(order);
  }

  beginSettlement(id) {
    const order = this.getInternal(id);
    if (order.payment_state !== 'held' || !['verified', 'rejected', 'timed_out'].includes(order.fulfillment_state)) {
      fail(409, 'invalid_order_transition');
    }
    order.payment_state = 'settling';
    this.record(order, 'settlement_started');
    return withoutSecrets(order);
  }

  settle(id, { transaction = null, settlementHeadersSha256 = null } = {}) {
    const order = this.getInternal(id);
    if (order.payment_state !== 'settling') fail(409, 'invalid_order_transition');
    order.payment_state = 'settled';
    order.order_state = 'completed';
    order.settlement_transaction = transaction;
    order.settlement_headers_sha256 = settlementHeadersSha256;
    order.settled_at_ms = this.now();
    this.record(order, 'settled');
    return withoutSecrets(order);
  }

  settlementUnknown(id, error) {
    const order = this.getInternal(id);
    if (order.payment_state !== 'settling') fail(409, 'invalid_order_transition');
    order.payment_state = 'settlement_unknown';
    order.order_state = 'failed';
    order.settlement_error = String(error || 'settlement_not_confirmed');
    this.record(order, 'settlement_unknown');
    return withoutSecrets(order);
  }

  record(order, type) {
    if (TERMINAL_PAYMENT_STATES.has(order.payment_state) && order.events.some(event => event.type === type)) {
      fail(409, 'duplicate_terminal_transition');
    }
    order.updated_at_ms = this.now();
    order.events.push({ sequence: order.events.length + 1, type, at_ms: order.updated_at_ms });
    this.save();
  }
}
