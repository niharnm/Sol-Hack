import express from 'express';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Gate, usage, usd, caip2, toNetwork } from '@solana/pay-kit';
import { createResearchQuote, digitalService, executeResearchQuote } from './digital.js';
import { toBaseUnits, formatUsd } from './settlement.js';

const run = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const digest = value => createHash('sha256').update(value).digest('hex');

function localRequest(req) {
  if (!LOOPBACK.has(req.socket.remoteAddress)) return false;
  let origin;
  try { origin = new URL(`http://${req.headers.host}`); } catch { return false; }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)) return false;
  if (req.headers['x-forwarded-for'] || req.headers['x-forwarded-host'] || req.headers['x-forwarded-proto']) return false;
  return !req.headers.origin || req.headers.origin === origin.origin;
}

function channelId(req) {
  const header = req.get('payment-signature') ?? req.get('x-payment');
  if (!header || header.length > 32768) return undefined;
  try {
    const proof = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
    const id = proof.payload?.channelId;
    return typeof id === 'string' && id.length <= 200 && id.length >= 16 ? id : undefined;
  } catch { return undefined; }
}

function settlementReceipt(headers, amount, network, payer) {
  const value = Object.entries(headers).find(([name]) => ['x-payment-response', 'payment-response'].includes(name.toLowerCase()))?.[1];
  if (!value) return undefined;
  try {
    const receipt = JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
    return receipt.success === true && receipt.amount === amount.toString() && receipt.network === caip2(toNetwork(network)) &&
      (!payer || receipt.payer === payer) && typeof receipt.transaction === 'string' && /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(receipt.transaction) ? receipt : undefined;
  } catch { return undefined; }
}

export function createApp({ pay, store, signReading, signingPublicKey, network = 'localnet', apiKey,
  publicBaseUrl, quoteTtlSeconds = 120, pricing = {}, execute = executeResearchQuote,
  consolePay = false, consoleDevnet, revision = null, version = '0.9.0', clock = () => Date.now(), consoleRunner = run }) {
  if (!Number.isInteger(quoteTtlSeconds) || quoteTtlSeconds < 30 || quoteTtlSeconds > 240) throw new Error('QUOTE_TTL_SECONDS must be an integer from 30 to 240');
  const publicOrigin = publicBaseUrl ? new URL(publicBaseUrl).origin : undefined;
  if (publicBaseUrl && (new URL(publicBaseUrl).pathname !== '/' || new URL(publicBaseUrl).search || new URL(publicBaseUrl).hash || new URL(publicBaseUrl).username || new URL(publicBaseUrl).password)) throw new Error('PUBLIC_BASE_URL must be an origin without credentials, path, query or fragment');
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
    next();
  });
  app.use(express.json({ limit: '16kb' }));
  const pending = new Set();
  const pendingKeys = new Set();
  const pendingChannels = new Set();
  let consoleBusy = false;

  function authorize(req, res, next) {
    if (apiKey) {
      const supplied = req.get('authorization') ?? '';
      if (!timingSafeEqual(Buffer.from(digest(supplied)), Buffer.from(digest(`Bearer ${apiKey}`)))) return res.status(401).json({ error: 'A valid workspace API key is required.' });
    } else if (!localRequest(req)) return res.status(403).json({ error: 'Remote access requires a workspace API key.' });
    next();
  }

  function catalog(req, res) {
    res.json({ service: 'Motto', version, currency: 'USDC', network, signing_public_key: signingPublicKey,
      services: { research: digitalService(pricing) },
      console: { local_pay: !apiKey && localRequest(req) && ((consolePay && network === 'localnet') || (network === 'devnet' && Boolean(consoleDevnet))) },
      payment: { scheme: 'x402 upto', spending_limit: 'Per-purchase user permission. Only the quoted service ceiling is held.',
        acceptance: 'All requested records must pass the quote requirements. Otherwise no service charge is settled.' } });
  }
  app.get('/v1/services', catalog);
  app.get('/v1/terms', catalog);
  app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'Motto', version, network, commit: revision, uptime_s: Math.round(process.uptime()) }));
  app.use('/v1/quotes', authorize);
  app.use('/v1/purchases', authorize);
  app.use('/v1/console', authorize);
  app.use('/v1/payment-attempts', authorize);
  app.get('/v1/payment-attempts', (_req, res) => res.json({ attempts: store.attempts().map(({ idempotency_key, ...attempt }) => attempt) }));
  app.get('/v1/quotes/:id', (req, res) => {
    const quote = store.quote(req.params.id);
    if (!quote) return res.status(404).json({ error: 'Quote not found.' });
    res.json(quote);
  });
  app.post('/v1/quotes', (req, res) => {
    const now = clock();
    const quote = { id: randomUUID(), ...createResearchQuote(req.body, pricing), currency: 'USDC',
      created_at: new Date(now).toISOString(), expires_at: new Date(now + quoteTtlSeconds * 1000).toISOString() };
    const immutable = { ...quote, quote_hash: digest(JSON.stringify(quote)) };
    store.saveQuote(immutable);
    res.status(201).json(immutable);
  });
  app.get('/v1/purchases', (_req, res) => res.json({ purchases: store.purchases() }));
  app.get('/v1/purchases/:id', (req, res) => {
    const purchase = store.purchase(req.params.id);
    if (!purchase) return res.status(404).json({ error: 'Purchase not found.' });
    res.json(purchase);
  });

  app.post('/v1/purchases/:quoteId', async (req, res) => {
    const quote = store.quote(req.params.quoteId);
    if (!quote) return res.status(404).json({ error: 'Quote not found.' });
    const rawKey = req.get('idempotency-key');
    if (typeof rawKey !== 'string' || rawKey.length < 8 || rawKey.length > 128 || !/^[a-zA-Z0-9_-]+$/.test(rawKey)) return res.status(400).json({ error: 'Idempotency-Key must contain 8 to 128 letters, digits, underscores or hyphens.' });
    const key = digest(rawKey);
    const priorKey = store.purchaseForKey(key);
    if (priorKey && priorKey.quote_id !== quote.id) return res.status(409).json({ error: 'Idempotency-Key already belongs to another quote.' });
    const prior = store.purchaseForQuote(quote.id);
    if (prior) {
      if (!priorKey || priorKey.id !== prior.id) return res.status(409).json({ error: 'This quote already has a purchase. Inspect the existing purchase before retrying.', purchase_id: prior.id });
      res.setHeader('idempotent-replayed', 'true');
      return res.status(['fetching', 'validating', 'settling'].includes(prior.status) ? 202 : 200).json(prior);
    }
    const unresolved = [store.attemptForQuote(quote.id), store.attemptForKey(key)].find(attempt => attempt && ['authorizing', 'interrupted', 'unconfirmed'].includes(attempt.status));
    if (unresolved) return res.status(409).json({ error: 'An earlier payment authorization is unresolved. Inspect payment attempts before signing another hold.', authorization_id: unresolved.id, payment_channel_id: unresolved.payment_channel_id });
    if (Date.parse(quote.expires_at) <= clock()) return res.status(410).json({ error: 'Quote expired. Request a new quote before authorizing payment.' });
    if (req.body && Object.keys(req.body).length) return res.status(400).json({ error: 'Purchase input is fixed by the quote; this endpoint accepts no body.' });
    if (pending.has(quote.id)) return res.status(409).json({ error: 'Payment verification for this quote is already in progress. Inspect purchases before retrying.' });
    if (req.get('payment-signature') && req.get('x-payment')) return res.status(400).json({ error: 'Send one payment proof header, not both payment-signature and x-payment.' });
    if (pendingKeys.has(key)) return res.status(409).json({ error: 'This Idempotency-Key is already being authorized. Inspect purchase history before retrying.' });
    const channel = channelId(req);
    if (channel && pendingChannels.has(channel)) return res.status(409).json({ error: 'This payment channel is already being authorized.' });
    if (channel && store.purchaseForChannel(channel)) return res.status(409).json({ error: 'This payment channel already belongs to a purchase.' });
    const previousAttempt = channel ? store.attemptForChannel(channel) : undefined;
    if (previousAttempt && (previousAttempt.quote_id !== quote.id || previousAttempt.idempotency_key !== key || previousAttempt.status !== 'rejected')) return res.status(409).json({ error: 'This payment channel has an existing authorization attempt. Inspect it before retrying.', authorization_id: previousAttempt.id, payment_channel_id: channel });
    const gate = Gate.create({ name: `quote:${quote.id}`, ...usage(usd(quote.ceiling_usd), { externalId: quote.id, description: `Research: ${quote.input.count} citation records` }) },
      { accept: ['x402'], payTo: pay.config.operator.recipient });
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(name, value);
    const base = publicOrigin ?? (localRequest(req) ? `http://${req.headers.host}` : undefined);
    if (!base) return res.status(400).json({ error: 'Configure PUBLIC_BASE_URL for remote paid requests.' });
    const request = new Request(`${base}${req.originalUrl}`, { method: 'POST', headers });
    pending.add(quote.id);
    pendingKeys.add(key);
    if (channel) pendingChannels.add(channel);
    let grant;
    let purchase;
    let purchasePersisted = false;
    let settleStarted = false;
    let attempt;
    try {
      if (channel) {
        const now = new Date(clock()).toISOString();
        attempt = store.saveAttempt({ id: previousAttempt?.id ?? randomUUID(), quote_id: quote.id, idempotency_key: key, payment_channel_id: channel,
          network, ceiling_usd: quote.ceiling_usd, status: 'authorizing', created_at: previousAttempt?.created_at ?? now, updated_at: now });
      }
      const result = await pay.requirePayment(request, gate);
      if ('respond' in result || result.status === 402) {
        if (attempt) store.saveAttempt({ ...attempt, status: 'unconfirmed', updated_at: new Date(clock()).toISOString() });
        const response = 'respond' in result ? result.respond : result.response;
        res.status(response.status);
        response.headers.forEach((value, name) => res.setHeader(name, value));
        return res.send(Buffer.from(await response.arrayBuffer()));
      }
      grant = result;
      if (!channel || !result.charge || result.payment.scheme !== 'upto') throw new Error('Verified payment lacks a usage channel or meter');
      const now = new Date(clock()).toISOString();
      purchase = { id: randomUUID(), quote_id: quote.id, quote_hash: quote.quote_hash, service: quote.service,
        input: quote.input, acceptance: quote.acceptance, max_spend_usd: quote.max_spend_usd,
        ceiling_usd: quote.ceiling_usd, payment_channel_id: channel, unit_price_usd: quote.unit_price_usd, currency: 'USDC', network,
        status: 'fetching', charged_usd: null, returned_usd: null, created_at: now, updated_at: now,
        reason: 'Payment authorized. Fetching records for the accepted quote.' };
      store.createPurchase(purchase, key, channel);
      purchasePersisted = true;
      store.saveAttempt({ ...attempt, status: 'recorded', purchase_id: purchase.id, updated_at: now });
      const update = changes => {
        purchase = { ...purchase, ...changes, updated_at: new Date(clock()).toISOString() };
        store.updatePurchase(purchase);
      };
      let delivery;
      try {
        delivery = await execute(quote, { onUpdate: progress => update({ status: progress.status }) });
      } catch (error) {
        console.error(`purchase ${purchase.id}: delivery failed`, error.message);
        delivery = { outcome: 'inconclusive', detail: 'provider_failed', charge_usd: '0.00', units_delivered: 0,
          checks: { passed: false }, limitations: 'Delivery failed. No accepted work is charged.' };
      }
      const amount = toBaseUnits(delivery.charge_usd);
      const ceiling = toBaseUnits(quote.ceiling_usd);
      if (amount > ceiling || amount > toBaseUnits(quote.max_spend_usd) ||
        (delivery.outcome !== 'delivered' && amount !== 0n) ||
        (delivery.outcome === 'delivered' && (delivery.checks?.passed !== true || delivery.units_delivered !== quote.input.count || amount !== ceiling))) throw new Error('Delivery charge does not satisfy the accepted quote');
      const reading = signReading({ ...delivery, purchase_id: purchase.id, quote_id: quote.id, quote_hash: quote.quote_hash, payment_channel_id: channel,
        service: quote.service, ts: clock() });
      update({ status: 'settling', reading, reason: 'Delivery checked. Settlement is pending.' });
      if (amount > 0n) result.charge.charge(amount);
      settleStarted = true;
      let receiptHeaders;
      try { receiptHeaders = await result.settle(); }
      catch (error) {
        console.error(`purchase ${purchase.id}: settlement failed`, error.message);
        update({ status: 'settle_failed', reason: 'Settlement is unconfirmed. Inspect this purchase and payment channel before authorizing another payment.' });
        return res.json(purchase);
      }
      const receipt = settlementReceipt(receiptHeaders, amount, network, result.payment.payer);
      if (!receipt) {
        update({ status: 'settle_failed', reason: 'The payment provider returned no matching successful settlement receipt. Payment is unconfirmed; do not automatically retry.' });
        return res.json(purchase);
      }
      for (const [name, value] of Object.entries(receiptHeaders)) res.setHeader(name, value);
      update({ status: amount > 0n ? 'paid' : 'refunded', charged_usd: formatUsd(amount), returned_usd: formatUsd(ceiling - amount),
        settlement_tx: receipt.transaction, settlement_receipt: receipt, reason: amount > 0n ? 'All requested records passed the agreed checks. The quoted service price was charged.' : 'The requested delivery did not pass all checks. No service charge was settled; the full hold was returned.' });
      return res.json(purchase);
    } catch (error) {
      if (grant && !settleStarted) {
        try { await grant.settle(); }
        catch (releaseError) { console.error('Unable to release payment after a service error:', releaseError.message); }
      }
      if (attempt && !purchasePersisted) store.saveAttempt({ ...attempt, status: 'unconfirmed', updated_at: new Date(clock()).toISOString() });
      if (purchasePersisted) store.updatePurchase({ ...purchase, status: 'settle_failed', reason: 'A service error interrupted the purchase. Payment is unconfirmed. Inspect before retrying.', updated_at: new Date(clock()).toISOString() });
      throw error;
    } finally {
      pending.delete(quote.id);
      pendingKeys.delete(key);
      if (channel) pendingChannels.delete(channel);
    }
  });

  app.post('/v1/console/purchases', async (req, res) => {
    if (apiKey || !localRequest(req) || !((consolePay && network === 'localnet') || (network === 'devnet' && consoleDevnet))) return res.status(403).json({ error: 'Use your own Pay.sh client for this workspace. Host wallet execution is unavailable.' });
    if (consoleBusy) return res.status(409).json({ error: 'A local purchase is already running.' });
    const id = req.body?.quote_id;
    if (typeof id !== 'string' || !UUID.test(id)) return res.status(400).json({ error: 'A valid quote_id is required.' });
    const quote = store.quote(id);
    if (!quote) return res.status(404).json({ error: 'Quote not found.' });
    const existing = store.purchaseForQuote(id);
    if (existing) return res.json(existing);
    if (Date.parse(quote.expires_at) <= clock()) return res.status(410).json({ error: 'Quote expired. Request a new quote.' });
    consoleBusy = true;
    try {
      if (network === 'devnet') {
        const result = await consoleDevnet(quote);
        return res.json(result);
      }
      const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR };
      const { stdout } = await consoleRunner('pay', ['--sandbox', 'curl', '-sS', '--max-time', '75', '-X', 'POST',
        `http://127.0.0.1:${req.socket.localPort}/v1/purchases/${id}`, '-H', `Idempotency-Key: ${randomUUID()}`], { env, timeout: 80_000, maxBuffer: 2 * 1024 * 1024 });
      const record = store.purchaseForQuote(id);
      if (record) return res.json(record);
      let result;
      try { result = JSON.parse(stdout); } catch { return res.status(502).json({ error: 'Pay.sh returned no purchase. Inspect history before retrying.' }); }
      return res.status(502).json({ error: typeof result.error === 'string' ? result.error.slice(0, 300) : 'Payment authorization failed. No purchase was recorded.' });
    } catch (error) {
      console.error('Local payment client failed:', error.code ?? 'unknown');
      if (error.code === 'DEVNET_FUNDING') return res.status(503).json({ error: error.message });
      const record = store.purchaseForQuote(id);
      if (record) return res.json(record);
      return res.status(502).json({ error: 'Pay.sh did not complete the request. Inspect purchase history before retrying.' });
    } finally { consoleBusy = false; }
  });

  app.get('/openapi.json', (_req, res) => res.json({ openapi: '3.1.0', info: { title: 'Motto', version, description: 'Quoted digital work with user spending permission and checked delivery.' },
    components: { securitySchemes: { workspace: { type: 'http', scheme: 'bearer' } } },
    paths: {
      '/v1/services': { get: { summary: 'Read digital services and unit prices', responses: { 200: { description: 'Service catalog' } } } },
      '/v1/quotes': { post: { summary: 'Quote research within a user spending limit', security: [{ workspace: [] }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['service', 'input', 'max_spend_usd'], properties: { service: { const: 'research' }, input: { type: 'object', required: ['query', 'count'], properties: { query: { type: 'string', minLength: 3, maxLength: 200 }, count: { type: 'integer', minimum: 1, maximum: 20 }, required_terms: { type: 'array', maxItems: 5, items: { type: 'string' } }, from_year: { type: 'integer' }, to_year: { type: 'integer' } } }, max_spend_usd: { type: 'string', description: 'User-chosen maximum per purchase in USDC, not the service price.' } } } } } }, responses: { 201: { description: 'Immutable expiring quote' }, 422: { description: 'Service quote exceeds spending permission' } } } },
      '/v1/quotes/{id}': { get: { summary: 'Read an immutable quote', security: [{ workspace: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Stored quote' }, 404: { description: 'Quote not found' } } } },
      '/v1/purchases/{id}': { post: { summary: 'Authorize and execute a quoted digital purchase', security: [{ workspace: [] }], parameters: [{ name: 'id', in: 'path', required: true, description: 'Quote ID for POST; purchase ID for GET.', schema: { type: 'string', format: 'uuid' } }, { name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', minLength: 8, maxLength: 128 } }], responses: { 200: { description: 'Recorded purchase, signed delivery, and settlement state' }, 202: { description: 'Existing purchase still in progress' }, 402: { description: 'x402 upto authorization for the immutable quoted ceiling' }, 409: { description: 'Quote or idempotency conflict' }, 410: { description: 'Quote expired' } } }, get: { summary: 'Read one private purchase', security: [{ workspace: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { 200: { description: 'Stored purchase' }, 404: { description: 'Purchase not found' } } } },
      '/v1/purchases': { get: { summary: 'Read private purchase history', security: [{ workspace: [] }], responses: { 200: { description: 'Latest 100 purchases' } } } },
      '/v1/payment-attempts': { get: { summary: 'Inspect private payment authorizations and unresolved holds', security: [{ workspace: [] }], responses: { 200: { description: 'Latest 100 authorization attempts' } } } },
    } }));
  app.all('/v1/rent/:item', (_req, res) => res.status(410).json({ error: 'Rental endpoints have been retired. Read /v1/services and create a digital-service quote at /v1/quotes.' }));
  app.use('/v1', (req, res) => res.status(404).json({ error: `No route ${req.method} ${req.path}` }));
  app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
    console.error(`${req.method} ${req.path}:`, error.message);
    res.status(status).json({ error: status < 500 ? error.message : 'The service could not complete this request. Inspect purchases and payment attempts before retrying.' });
  });
  return app;
}
