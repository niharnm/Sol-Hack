import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { generateKeyPairSync, sign } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { readFileSync, statSync } from 'node:fs';
import { createResearchQuote } from '../src/digital.js';
import { buyerOptions, buy, checkPurchase, payPurchase } from '../buyer/buy.js';

const options = () => buyerOptions(['--max-spend', '0.200001', '--query', 'battery recycling'], {});
const quote = (overrides = {}) => ({ id: 'quote-1', service: 'research', currency: 'USDC',
  input: options().input, ceiling_usd: '0.15', max_spend_usd: '0.200001',
  expires_at: new Date(Date.now() + 60_000).toISOString(), ...overrides });
const response = data => ({ ok: true, json: async () => data });
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const signingKey = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');

function acceptedPurchase(acceptedQuote, changes = {}) {
  const record = { id: 'purchase-1', quote_id: acceptedQuote.id, service: 'research', currency: 'USDC', network: 'localnet', status: 'paid',
    max_spend_usd: acceptedQuote.max_spend_usd, ceiling_usd: acceptedQuote.ceiling_usd,
    charged_usd: acceptedQuote.ceiling_usd, returned_usd: '0.00', settlement_tx: '1'.repeat(64), ...changes };
  const payload = { purchase_id: record.id, quote_id: record.quote_id, service: 'research', charge_usd: record.charged_usd, outcome: 'delivered', checks: { passed: true }, units_delivered: acceptedQuote.input.count,
    ...(acceptedQuote.quote_hash ? { quote_hash: acceptedQuote.quote_hash } : {}) };
  record.reading = { ...payload, signature: sign(null, Buffer.from(JSON.stringify(payload)), privateKey).toString('hex'), devicePublicKey: signingKey };
  return record;
}

function fakePay({ result, rejectPolicy = false, stalled = false, ignoreTerm = false }, calls) {
  return (command, args) => {
    calls.command = command;
    calls.args = args;
    calls.policyPath = args[args.indexOf('--permissions') + 1];
    calls.policy = readFileSync(calls.policyPath, 'utf8');
    calls.mode = statSync(calls.policyPath).mode & 0o777;
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.kill = (signal = 'SIGTERM') => {
      calls.killed = true;
      (calls.signals ??= []).push(signal);
      if (!ignoreTerm || signal === 'SIGKILL') setImmediate(() => { child.signalCode = signal; child.emit('exit'); });
      return true;
    };
    child.stdin.on('data', chunk => {
      const message = JSON.parse(String(chunk));
      calls.messages.push(message);
      if (stalled) return;
      if (message.id === 1) setImmediate(() => child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} })}\n`));
      if (message.id === 2) setImmediate(() => child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, result: rejectPolicy
        ? { isError: true, content: [{ type: 'text', text: 'invalid Solana network; Authorization: Bearer test-secret' }] }
        : { content: [{ type: 'text', text: JSON.stringify(result) }] } })}\n`));
    });
    return child;
  };
}

test('buyer requires the user to choose a limit and rejects malformed input before requests', () => {
  for (const args of [[], ['--max-spend', '0'], ['--max-spend', '-2'], ['--max-spend', '1e2'], ['--max-spend', '0.0000001']]) {
    assert.throws(() => buyerOptions([...args, '--query', 'battery recycling'], {}));
  }
  for (const count of ['0', '21', '3.1', '1e1']) assert.throws(() => buyerOptions(['--max-spend', '2', '--count', count, '--query', 'battery recycling'], {}));
  assert.equal(options().maxSpend, '0.200001');
  assert.equal(buyerOptions(['--max-spend', '2', 'battery', 'recycling'], {}).input.query, 'battery recycling');
  assert.throws(() => buyerOptions(['--max-spend', '2', '--query', 'battery recycling', '--desk', 'http://example.com'], {}));
  assert.throws(() => buyerOptions(['--max-spend', '2', '--query', 'battery recycling', '--desk', 'https://user:secret@example.com'], {}));
});

test('provider cannot raise the buyer cap by one USDC base unit or alter its task', async () => {
  for (const changed of [
    { ceiling_usd: '0.200002' }, { max_spend_usd: '100' },
    { input: { query: 'unrelated', count: 3 } }, { input: { query: 'battery recycling', count: 20 } },
    { currency: 'USDG' }, { id: '../other-purchase' }, { expires_at: '2000-01-01T00:00:00Z' },
  ]) {
    let attempted = false;
    await assert.rejects(buy(options(), { fetcher: async url => response(url.endsWith('/v1/services')
      ? { network: 'localnet', signing_public_key: signingKey, services: { research: {} } } : quote(changed)), purchase: async () => { attempted = true; } }));
    assert.equal(attempted, false);
  }
});

test('network mismatch stops before a quote or payment', async () => {
  const requests = [];
  await assert.rejects(buy(options(), { fetcher: async url => {
    requests.push(url); return response({ network: 'mainnet', services: { research: {} } });
  }, purchase: async () => assert.fail('payment must not run') }), /network/);
  assert.equal(requests.length, 1);
});

test('buyer sends its selected limit unchanged and uses auth only on authenticated API requests', async () => {
  const requests = [];
  const selected = { ...options(), apiKey: 'test-secret' };
  const result = await buy(selected, { fetcher: async (url, init) => {
    requests.push({ url, init });
    return response(url.endsWith('/v1/services') ? { network: 'localnet', signing_public_key: signingKey, services: { research: {} } } : quote());
  }, purchase: async (receivedOptions, receivedQuote) => {
    assert.equal(receivedOptions.maxSpend, '0.200001');
    assert.equal(receivedQuote.ceiling_usd, '0.15');
    return acceptedPurchase(receivedQuote);
  } });
  assert.equal(requests[0].init.headers, undefined);
  assert.equal(requests[1].init.headers.Authorization, 'Bearer test-secret');
  assert.equal(JSON.parse(requests[1].init.body).max_spend_usd, '0.200001');
  assert.equal(result.purchase.status, 'paid');
});

test('model-free buyer passes the caller cap to Pay and an idempotency key to the purchase', async () => {
  const calls = { messages: [] };
  const selected = { ...options(), network: 'mainnet', apiKey: 'test-secret' };
  const result = await payPurchase(selected, quote(), { spawnPay: fakePay({ result: { id: 'purchase-1', status: 'paid' } }, calls) });
  assert.equal(calls.command, 'pay');
  assert.deepEqual(calls.args.slice(0, 3), ['--mainnet', 'mcp', '--permissions']);
  assert.match(calls.policy, /max_payment: "\$0\.15"/);
  assert.equal(calls.policy.includes(selected.apiKey), false);
  assert.match(calls.policy, /origins: \["http:\/\/127\.0\.0\.1:8787"\]/);
  assert.match(calls.policy, /networks: \[mainnet\]/);
  const request = calls.messages.find(message => message.method === 'tools/call').params;
  assert.equal(request.name, 'curl');
  assert.equal(request.arguments.url, 'http://127.0.0.1:8787/v1/purchases/quote-1');
  assert.match(request.arguments.headers['Idempotency-Key'], /^[a-f0-9-]{36}$/);
  assert.equal(request.arguments.headers.Authorization, 'Bearer test-secret');
  assert.equal(result.id, 'purchase-1');
  assert.equal(calls.killed, true);
  assert.equal(calls.mode, 0o600);
  assert.throws(() => readFileSync(calls.policyPath), { code: 'ENOENT' });
});

test('unsupported sandbox policy fails closed without a second uncapped process', async () => {
  const calls = { messages: [] };
  let processes = 0;
  const transport = fakePay({ rejectPolicy: true }, calls);
  await assert.rejects(payPurchase(options(), quote(), { spawnPay: (...args) => { processes++; return transport(...args); } }), /never retry without the cap/);
  assert.equal(processes, 1);
  assert.equal(calls.args[0], '--sandbox');
  assert.match(calls.policy, /networks: \[localnet\]/);
});


test('buyer and service agree on normalized acceptance inputs', async () => {
  const selected = buyerOptions(['--max-spend', '0.25', '--query', ' battery recycling ', '--required-term', ' Recycling ', '--required-term', 'recycling', '--from-year', '2020'], {});
  const normalized = createResearchQuote({ service: 'research', input: selected.input, max_spend_usd: selected.maxSpend });
  const result = await buy(selected, { fetcher: async url => response(url.endsWith('/v1/services')
    ? { network: 'localnet', signing_public_key: signingKey, services: { research: {} } }
    : { ...quote(), ...normalized }), purchase: async (selectedOptions, acceptedQuote) => acceptedPurchase(acceptedQuote) });
  assert.deepEqual(result.quote.input.required_terms, ['recycling']);
  assert.equal(result.quote.input.from_year, 2020);
});


test('Pay rejection keeps credentials out of errors and removes policy files', async () => {
  const calls = { messages: [] };
  const selected = { ...options(), apiKey: 'test-secret' };
  await assert.rejects(payPurchase(selected, quote(), { spawnPay: fakePay({ rejectPolicy: true }, calls) }), error => {
    assert.equal(error.message.includes(selected.apiKey), false);
    assert.equal(error.message.includes('Authorization'), false);
    return true;
  });
  assert.equal(calls.killed, true);
  assert.throws(() => readFileSync(calls.policyPath), { code: 'ENOENT' });
});

test('timed-out Pay is stopped, including escalation for a process ignoring SIGTERM', async () => {
  const calls = { messages: [] };
  await assert.rejects(payPurchase(options(), quote(), {
    spawnPay: fakePay({ stalled: true, ignoreTerm: true }, calls), timeoutMs: 10,
  }), /Check the purchase log/);
  assert.throws(() => readFileSync(calls.policyPath), { code: 'ENOENT' });
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.deepEqual(calls.signals, ['SIGTERM', 'SIGKILL']);
});

test('a malformed price supplied by the provider is rejected without echoing it', async () => {
  let attempted = false;
  await assert.rejects(buy({ ...options(), apiKey: 'test-secret' }, {
    fetcher: async url => response(url.endsWith('/v1/services')
      ? { network: 'localnet', signing_public_key: signingKey, services: { research: {} } }
      : quote({ ceiling_usd: 'test-secret' })),
    purchase: async () => { attempted = true; },
  }), error => { assert.equal(error.message.includes('test-secret'), false); return true; });
  assert.equal(attempted, false);
});


test('returned purchase must preserve accepted quote, network and amounts', () => {
  const accepted = quote();
  for (const changed of [
    { quote_id: 'another-quote' }, { ceiling_usd: '0.20' }, { max_spend_usd: '1.00' },
    { network: 'mainnet' }, { charged_usd: '0.25' }, { returned_usd: '0.01' }, { settlement_tx: null },
    { status: 'interrupted', charged_usd: '0.15' },
  ]) assert.throws(() => checkPurchase({ ...acceptedPurchase(accepted), ...changed }, accepted, options(), signingKey));
});

test('buyer verifies receipt signature and rejects changed signed acceptance fields', () => {
  const accepted = quote();
  const result = acceptedPurchase(accepted);
  assert.equal(checkPurchase(result, accepted, options(), signingKey).status, 'paid');
  result.reading.units_delivered = 0;
  assert.throws(() => checkPurchase(result, accepted, options(), signingKey), /signature/);
});

test('buyer returns genuine unresolved states without claiming a refund', () => {
  const accepted = quote();
  const unresolved = { ...acceptedPurchase(accepted), status: 'settle_failed', charged_usd: null, returned_usd: null };
  assert.equal(checkPurchase(unresolved, accepted, options(), signingKey).charged_usd, null);
});

test('buyer exposes nonsecret retry identifiers before the payment tool call', async () => {
  const calls = { messages: [] };
  let requestRecord;
  await payPurchase(options(), quote(), { spawnPay: fakePay({ result: { id: 'purchase-1', status: 'paid' } }, calls), onRequest: record => { requestRecord = record; } });
  const toolRequest = calls.messages.find(message => message.method === 'tools/call').params.arguments;
  assert.equal(requestRecord.quote_id, 'quote-1');
  assert.equal(requestRecord.idempotency_key, toolRequest.headers['Idempotency-Key']);
  assert.deepEqual(Object.keys(requestRecord).sort(), ['ceiling_usd', 'idempotency_key', 'max_spend_usd', 'network', 'quote_id']);
});
