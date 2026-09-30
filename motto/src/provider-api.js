import { createHash } from 'node:crypto';
import { usage, usd } from '@solana/pay-kit';
import { formatUsd, toBaseUnits } from './settlement.js';
import { ReplayGuard, sha256Hex, verifySignedAttestation, verifySignedQuote } from './provider-protocol.js';

class ProviderApiError extends Error {
  constructor(status, code, message = code) {
    super(message);
    this.name = 'ProviderApiError';
    this.status = status;
    this.code = code;
  }
}

function fail(status, code, message) {
  throw new ProviderApiError(status, code, message);
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res)).catch(next);
}

function exactOrderBody(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'invalid_order_request');
  const keys = Object.keys(value);
  const fields = ['provider_id', 'offer_id', 'request'];
  if (fields.some(key => !keys.includes(key)) || keys.some(key => !fields.includes(key))) {
    fail(400, 'invalid_order_request');
  }
  if (typeof value.provider_id !== 'string' || typeof value.offer_id !== 'string') fail(400, 'invalid_order_request');
  return value;
}

function loopback(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '::1';
}

function configuredOrigin(value) {
  if (!value) return undefined;
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(500, 'invalid_public_origin');
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') fail(500, 'invalid_public_origin');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback(url.hostname))) fail(500, 'invalid_public_origin');
  return url.origin;
}

function webPaymentRequest(req, publicOrigin) {
  let origin = publicOrigin;
  if (!origin) {
    const host = req.headers.host;
    if (!host) fail(400, 'missing_host');
    let local;
    try {
      local = new URL(`http://${host}`);
    } catch {
      fail(400, 'invalid_host');
    }
    if (!loopback(local.hostname)) fail(503, 'public_origin_not_configured');
    origin = local.origin;
  }
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(name, value);
  return new Request(`${origin}${req.originalUrl}`, { method: req.method, headers });
}

async function relayPaymentResponse(result, res) {
  const response = 'respond' in result ? result.respond : result.response;
  const body = Buffer.from(await response.arrayBuffer());
  res.status(response.status);
  response.headers.forEach((value, name) => res.setHeader(name, value));
  res.send(body);
}

function capability(req) {
  const direct = req.get('x-motto-order-token');
  if (direct) return direct;
  return /^Bearer (.+)$/i.exec(req.get('authorization') ?? '')?.[1];
}

function proofDigest(req) {
  const proof = req.get('payment-signature') ?? req.get('x-payment');
  if (!proof) fail(500, 'payment_proof_missing');
  return createHash('sha256').update(proof).digest('hex');
}

function settlementTransaction(headers) {
  for (const value of Object.values(headers)) {
    for (const candidate of [value, Buffer.from(value, 'base64').toString('utf8')]) {
      const match = candidate.match(/"(?:transaction|signature|txHash)"\s*:\s*"([1-9A-HJ-NP-Za-km-z]{64,90})"/);
      if (match) return match[1];
    }
  }
  return null;
}

function paymentSummary(order) {
  if (order.payment_state !== 'settled') {
    return { charged_usd: null, returned_usd: null, settlement_transaction: order.settlement_transaction ?? null };
  }
  const charged = toBaseUnits(order.approved_charge_usd ?? '0.00');
  const hold = toBaseUnits(order.hold_usd);
  return {
    charged_usd: formatUsd(charged),
    returned_usd: formatUsd(hold - charged),
    settlement_transaction: order.settlement_transaction ?? null,
  };
}

function sendCreatedOrder(res, created) {
  res.status(created.replayed ? 200 : 201).json({
    order: created.order,
    order_token: created.capability,
    execute_path: `/v1/orders/${created.order.id}/execute`,
    replayed: created.replayed,
  });
}

export function mountProviderApi({
  app,
  pay,
  payForProvider = () => pay,
  registry,
  orders,
  providerClient,
  network,
  publicOrigin: rawPublicOrigin,
  verifyQuote = verifySignedQuote,
  verifyAttestation = verifySignedAttestation,
  replayGuard = new ReplayGuard(),
}) {
  if (!app || typeof payForProvider !== 'function' || !registry || !orders || !providerClient) fail(500, 'provider_api_not_configured');
  const publicOrigin = configuredOrigin(rawPublicOrigin);

  app.get('/v1/providers', (_req, res) => res.json({ providers: registry.publicProviders() }));

  app.post('/v1/orders', asyncRoute(async (req, res) => {
    const body = exactOrderBody(req.body);
    const idempotencyKey = req.get('idempotency-key');
    const replay = orders.replay({ idempotencyKey, creation: body });
    if (replay) return sendCreatedOrder(res, replay);
    registry.getOffer(body.provider_id, body.offer_id);
    const quoted = await providerClient.quote({
      providerId: body.provider_id,
      offerId: body.offer_id,
      request: body.request,
      network,
      idempotencyKey,
    });
    const verified = verifyQuote(quoted.signed_quote, {
      registry,
      request: body.request,
      network,
      replayGuard,
      consumeReplay: true,
    });
    if (verified.quote.provider_id !== body.provider_id || verified.quote.offer_id !== body.offer_id) fail(502, 'provider_quote_mismatch');
    const created = orders.create({
      signedQuote: quoted.signed_quote,
      quoteFingerprint: verified.fingerprint,
      request: body.request,
      idempotencyKey,
      creation: body,
    });
    return sendCreatedOrder(res, created);
  }));

  app.get('/v1/orders/:id', (req, res, next) => {
    try {
      const order = orders.get(req.params.id, capability(req));
      res.json({ order, payment: paymentSummary(order) });
    } catch (error) {
      next(error);
    }
  });

  app.post('/v1/orders/:id/execute', asyncRoute(async (req, res) => {
    let order = orders.get(req.params.id, capability(req));
    if (order.payment_state !== 'none') fail(409, 'order_already_executed');
    if (order.signed_quote.quote.expires_at_ms <= Date.now()) fail(409, 'quote_expired');

    const gate = () => usage(usd(order.hold_usd), {
      payTo: order.payout_address,
      externalId: `motto:${order.id}`,
      description: `Motto order ${order.id}`,
    });
    const paymentRequest = webPaymentRequest(req, publicOrigin);
    const providerPay = payForProvider(order.provider_id);
    if (!providerPay || providerPay.config?.operator?.recipient !== order.payout_address) fail(500, 'provider_payment_recipient_mismatch');
    const result = await providerPay.requirePayment(paymentRequest, gate);
    if ('respond' in result || result.status === 402) return relayPaymentResponse(result, res);

    let settlementHeaders = {};
    try {
      order = orders.startExecution(order.id, {
        payer: result.payment.payer,
        paymentProofSha256: proofDigest(req),
      });
      try {
        const delivery = await providerClient.fulfill(order);
        const verified = verifyAttestation(delivery.signed_attestation, {
          registry,
          quote: order.signed_quote.quote,
          order,
          artifact: delivery.artifact,
          network,
          replayGuard,
          consumeReplay: true,
        });
        order = orders.recordEvidence(order.id, {
          artifact: delivery.artifact,
          signedAttestation: delivery.signed_attestation,
          attestationFingerprint: verified.fingerprint,
        });
      } catch (error) {
        order = orders.rejectFulfillment(order.id, error.code ?? 'fulfillment_failed');
      }

      order = orders.beginSettlement(order.id);
      const charge = toBaseUnits(order.approved_charge_usd ?? '0.00');
      if (charge > 0n) {
        if (!result.charge) fail(500, 'payment_meter_missing');
        result.charge.charge(charge);
      }
      try {
        settlementHeaders = await result.settle();
      } catch (error) {
        order = orders.settlementUnknown(order.id, error?.message ?? error);
        return res.status(502).json({ order, payment: paymentSummary(order), error: 'settlement_unknown' });
      }
      for (const [name, value] of Object.entries(settlementHeaders)) res.setHeader(name, value);
      order = orders.settle(order.id, {
        transaction: settlementTransaction(settlementHeaders),
        settlementHeadersSha256: sha256Hex(settlementHeaders),
      });
      return res.json({ order, payment: paymentSummary(order) });
    } catch (error) {
      if (order.payment_state === 'held') {
        try {
          order = orders.rejectFulfillment(order.id, error.code ?? 'internal_error');
          order = orders.beginSettlement(order.id);
        } catch (transitionError) {
          console.error(`order ${order.id}: failed to record refund transition:`, transitionError?.message ?? transitionError);
        }
      }
      try {
        settlementHeaders = await result.settle();
        const current = orders.getInternal(order.id);
        if (current.payment_state === 'settling') {
          order = orders.settle(order.id, {
            transaction: settlementTransaction(settlementHeaders),
            settlementHeadersSha256: sha256Hex(settlementHeaders),
          });
        }
      } catch (settlementError) {
        const current = orders.getInternal(order.id);
        if (current.payment_state === 'settling') {
          try {
            orders.settlementUnknown(order.id, settlementError?.message ?? settlementError);
          } catch (recordError) {
            console.error(`order ${order.id}: failed to record unknown settlement:`, recordError?.message ?? recordError);
          }
        }
      }
      throw error;
    }
  }));
}

export const providerApiInternals = { configuredOrigin, exactOrderBody, paymentSummary, webPaymentRequest };
