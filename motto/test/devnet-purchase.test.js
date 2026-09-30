import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createResearchQuote } from '../src/digital.js';
import { devnetPurchase, DEVNET_USDC } from '../src/devnet.js';
import { runDevnetBuyer } from '../scripts/devnet-buy.mjs';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const signingKey = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
const input = { query: 'battery recycling', count: 3, required_terms: ['recycling'], from_year: 2020 };
const quote = (changes = {}) => ({ id: 'quote-devnet-123', ...createResearchQuote({ service: 'research', input, max_spend_usd: '2' }),
  currency: 'USDC', quote_hash: 'a'.repeat(64), created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString(), ...changes });

function receipt(accepted, changes = {}) {
  const purchase = { id: 'purchase-devnet-123', quote_id: accepted.id, service: 'research', currency: 'USDC', network: 'devnet', status: 'paid',
    max_spend_usd: accepted.max_spend_usd, ceiling_usd: accepted.ceiling_usd, charged_usd: accepted.ceiling_usd, returned_usd: '0.00', settlement_tx: '3'.repeat(88), ...changes };
  const payload = { purchase_id: purchase.id, quote_id: accepted.id, quote_hash: accepted.quote_hash, service: 'research', charge_usd: purchase.charged_usd,
    outcome: purchase.status === 'refunded' ? 'inconclusive' : 'delivered', checks: { passed: purchase.status !== 'refunded' }, units_delivered: purchase.status === 'refunded' ? 0 : accepted.input.count };
  purchase.reading = { ...payload, devicePublicKey: signingKey, signature: sign(null, Buffer.from(JSON.stringify(payload)), privateKey).toString('hex') };
  return purchase;
}

function transport(accepted = quote(), changes = {}) {
  const calls = { reads: [], client: [], payment: [], network: [], signer: [], rpc: [], identifiers: [] };
  const dependencies = {
    fetcher: async (url, init) => {
      calls.reads.push({ url, init });
      if (url.endsWith('/v1/services')) return Response.json({ network: changes.network ?? 'devnet', signing_public_key: changes.signingKey ?? signingKey, services: { research: {} } });
      return Response.json(accepted);
    },
    checkNetwork: async rpc => { calls.network.push(rpc); if (changes.wrongRpc) throw new Error('RPC is not Solana Devnet'); },
    getSigner: async role => { calls.signer.push(role); return { address: '11111111111111111111111111111111' }; },
    rpc: async (...args) => { calls.rpc.push(args); return changes.tokens ?? { value: [{ account: { data: { parsed: { info: { tokenAmount: { amount: changes.balance ?? '150000' } } } } } }] }; },
    createClient: async config => {
      calls.client.push(config);
      return { fetch: async (url, init) => {
        calls.payment.push({ url, init });
        return changes.paymentResponse ?? Response.json(changes.receipt ?? receipt(accepted));
      } };
    },
    onRequest: record => calls.identifiers.push(record),
  };
  return { calls, dependencies };
}

test('Devnet buyer validates caller input and requires spending permission before any transport', async () => {
  for (const args of [{ input }, { input, maxSpendUsd: 2 }, { input, maxSpendUsd: '0' }, { input: { ...input, count: '3' }, maxSpendUsd: '2' }, { input: { ...input, required_terms: null }, maxSpendUsd: '2' }, { input: { ...input, from_year: '2020' }, maxSpendUsd: '2' }, { input: { ...input, unexpected: true }, maxSpendUsd: '2' }, { quoteId: '../other', maxSpendUsd: '2' }]) {
    const { calls, dependencies } = transport();
    await assert.rejects(devnetPurchase(args, dependencies));
    assert.equal(calls.reads.length, 0);
    assert.equal(calls.signer.length, 0);
  }
});

test('create purchase quotes normalized input and restricts SDK to price, network and origin', async () => {
  const { calls, dependencies } = transport();
  const purchase = await devnetPurchase({ input: { ...input, query: ' battery recycling ', required_terms: [' Recycling ', 'RECYCLING'] }, maxSpendUsd: '2.00', port: 8787, rpcUrl: 'https://devnet-rpc.example' }, dependencies);
  assert.equal(purchase.status, 'paid');
  assert.deepEqual(JSON.parse(calls.reads[1].init.body), { service: 'research', input, max_spend_usd: '2.00' });
  assert.deepEqual(calls.network, ['https://devnet-rpc.example']);
  assert.deepEqual(calls.signer, ['buyer']);
  const config = calls.client[0];
  assert.equal(config.network, 'devnet');
  const candidate = { network: 'devnet', origin: 'http://127.0.0.1:8787', mint: DEVNET_USDC, amount: 150000n };
  assert.equal(config.permissions.authorize(candidate).maxAmountAtomic, 150000n);
  for (const changed of [{ amount: 150001n }, { network: 'mainnet' }, { origin: 'https://different.example' }]) assert.throws(() => config.permissions.authorize({ ...candidate, ...changed }));
  assert.match(calls.payment[0].url, /\/v1\/purchases\/quote-devnet-123$/);
  assert.match(calls.payment[0].init.headers['Idempotency-Key'], /^[0-9a-f-]{36}$/);
  assert.equal(calls.payment[0].init.redirect, 'error');
  assert.equal(calls.identifiers[0].ceiling_usd, '0.15');
});

test('reviewed quote is fetched, matched and purchased without creating another quote', async () => {
  const accepted = quote();
  const { calls, dependencies } = transport(accepted);
  await devnetPurchase({ quote: accepted, port: 8787 }, dependencies);
  assert.equal(calls.reads.length, 2);
  assert.ok(calls.reads[1].url.endsWith('/v1/quotes/' + accepted.id));
  assert.equal(calls.reads[1].init.method, undefined);
  const changed = transport({ ...accepted, quote_hash: 'b'.repeat(64) });
  await assert.rejects(devnetPurchase({ quote: accepted }, changed.dependencies), /differs from the reviewed quote/);
  assert.equal(changed.calls.client.length, 0);
});

test('quote-ID mode keeps stored task constraints and authenticates quote and payment', async () => {
  const accepted = quote();
  const { calls, dependencies } = transport(accepted);
  await devnetPurchase({ quoteId: accepted.id, maxSpendUsd: '2', desk: 'https://desk.example', apiKey: 'private-test-key' }, dependencies);
  assert.equal(calls.reads[0].init.headers, undefined);
  assert.equal(calls.reads[1].init.headers.Authorization, 'Bearer private-test-key');
  assert.equal(calls.payment[0].init.headers.Authorization, 'Bearer private-test-key');
  assert.equal(calls.client[0].permissions.authorize({ network: 'devnet', origin: 'https://desk.example', mint: DEVNET_USDC, amount: 150000n }).maxAmountAtomic, 150000n);
});

test('network, RPC, cap, task and expiry mismatches cannot start a paid request', async () => {
  for (const [accepted, changed] of [[quote(), { network: 'mainnet' }], [quote(), { wrongRpc: true }], [quote({ ceiling_usd: '2.000001' }), {}], [quote({ input: { ...input, count: 20 } }), {}], [quote({ expires_at: '2000-01-01T00:00:00Z' }), {}]]) {
    const { calls, dependencies } = transport(accepted, changed);
    await assert.rejects(devnetPurchase({ input, maxSpendUsd: '2' }, dependencies));
    assert.equal(calls.payment.length, 0);
    assert.equal(calls.client.length, 0);
  }
});

test('funding check uses the dynamic ceiling and cannot infer malformed balances', async () => {
  for (const changes of [{ balance: '149999' }, { tokens: {} }, { balance: '-1' }]) {
    const { calls, dependencies } = transport(quote(), changes);
    await assert.rejects(devnetPurchase({ input, maxSpendUsd: '2' }, dependencies), changes.balance === '149999' ? error => error.code === 'DEVNET_FUNDING' && error.message.includes('0.15 test USDC') : undefined);
    assert.equal(calls.client.length, 0);
  }
});

test('signed refunds succeed, unconfirmed states and modified signatures fail explicitly', async () => {
  const accepted = quote();
  const refunded = transport(accepted, { receipt: receipt(accepted, { status: 'refunded', charged_usd: '0.00', returned_usd: '0.15' }) });
  assert.equal((await devnetPurchase({ input, maxSpendUsd: '2' }, refunded.dependencies)).status, 'refunded');
  const unresolved = transport(accepted, { receipt: receipt(accepted, { status: 'settle_failed', charged_usd: null, returned_usd: null }) });
  await assert.rejects(devnetPurchase({ input, maxSpendUsd: '2' }, unresolved.dependencies), error => error.code === 'DEVNET_SETTLEMENT_UNCONFIRMED' && error.purchase.status === 'settle_failed');
  const tampered = receipt(accepted);
  tampered.reading.units_delivered = 0;
  await assert.rejects(devnetPurchase({ input, maxSpendUsd: '2' }, transport(accepted, { receipt: tampered }).dependencies), /signature/);
  await assert.rejects(devnetPurchase({ input, maxSpendUsd: '2' }, transport(accepted, { paymentResponse: Response.json({}, { status: 402 }) }).dependencies), /Inspect purchase history/);
});

test('Devnet CLI requires an explicit cap and rejects mainnet before network requests', async () => {
  await assert.rejects(runDevnetBuyer(['--query', 'battery recycling'], {}), /max-spend/);
  await assert.rejects(runDevnetBuyer(['--max-spend', '2', '--mainnet', '--query', 'battery recycling'], {}), /does not accept --mainnet/);
  await assert.rejects(runDevnetBuyer(['--quote-id', 'quote-1', '--mainnet', '--max-spend', '2'], {}));
  await assert.rejects(runDevnetBuyer(['--quote-id', 'quote-1'], {}), /maxSpendUsd/);
});

test('installed SDK normalizes a CAIP Devnet challenge and rejects a price above the quote', () => {
  const script = `
    import assert from 'node:assert/strict';
    const required = {x402Version:2,resource:{url:'https://desk.example/v1/purchases/quote'},accepts:[{scheme:'upto',network:'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',amount:'150001',asset:'${DEVNET_USDC}',payTo:'11111111111111111111111111111111',maxTimeoutSeconds:300}]};
    globalThis.fetch=async()=>new Response('{}',{status:402,headers:{'payment-required':Buffer.from(JSON.stringify(required)).toString('base64')}});
    const {createPayKitClient,ClientPermissions,usd}=await import('@solana/pay-kit/client');
    const client=await createPayKitClient({network:'devnet',rpcUrl:'https://rpc.example',signer:{address:'11111111111111111111111111111111'},accept:['x402'],permissions:ClientPermissions.builder().onlyNetwork('devnet').allowOrigin('https://desk.example').maxAmountPerPayment(usd('0.15')).build()});
    await assert.rejects(client.fetch('https://desk.example/v1/purchases/quote'),error=>error.rejections?.[0]?.code==='amount_exceeds_limit'&&error.rejections[0].limit===150000n);
  `;
  execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: new URL('..', import.meta.url), timeout: 5000 });
});
