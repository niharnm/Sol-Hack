import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createKeyPairSignerFromBytes } from '@solana/kit';
import { createPayKitClient, ClientPermissions, usd } from '@solana/pay-kit/client';
import { buyerOptions, checkQuote, checkPurchase } from '../buyer/buy.js';
import { formatUsd, toBaseUnits } from './settlement.js';

export const DEVNET_RPC = 'https://api.devnet.solana.com';
export const DEVNET_USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
export async function devnetSigner(role) {
  if (!['operator', 'buyer'].includes(role)) throw new Error('Unknown wallet role');
  const directory = process.env.DEVNET_KEYS_DIR ?? 'keys/devnet';
  const path = `${directory}/${role}.json`;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { readFileSync(path); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const bytes = Buffer.concat([privateKey.export({format:'der',type:'pkcs8'}).subarray(-32), publicKey.export({format:'der',type:'spki'}).subarray(-32)]);
    try { writeFileSync(path, JSON.stringify([...bytes]), {flag:'wx', mode:0o600}); } catch (error) { if(error.code!=='EEXIST')throw error; }
  }
  return createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(path,'utf8'))));
}
export async function devnetRpc(method, params = [], rpcUrl = DEVNET_RPC) {
  const response=await fetch(rpcUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new Error(`Devnet RPC HTTP ${response.status}`);
  const body=await response.json();if(body.error)throw new Error(body.error.message);return body.result;
}
export async function assertDevnet(rpcUrl) {
  const genesis=await devnetRpc('getGenesisHash',[],rpcUrl);
  if(genesis!=='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG')throw new Error('Refusing Devnet mode: RPC is not Solana Devnet.');
}
function researchOptions(selectedInput, maxSpendUsd, desk, apiKey) {
  const args = ['--desk', desk, '--max-spend', maxSpendUsd];
  if (!selectedInput || typeof selectedInput !== 'object' || Array.isArray(selectedInput) ||
    Object.keys(selectedInput).some(key => !['query', 'count', 'required_terms', 'from_year', 'to_year'].includes(key)) ||
    typeof selectedInput.query !== 'string' || !Number.isInteger(selectedInput.count) ||
    (selectedInput.required_terms !== undefined && (!Array.isArray(selectedInput.required_terms) || selectedInput.required_terms.some(term => typeof term !== 'string')))) throw new Error('Invalid research input');
  if (typeof maxSpendUsd !== 'string') throw new Error('An explicit decimal maxSpendUsd is required');
  args.push('--query', selectedInput.query, '--count', String(selectedInput.count));
  for (const term of selectedInput.required_terms ?? []) args.push('--required-term', term);
  for (const field of ['from_year', 'to_year']) {
    if (selectedInput[field] !== undefined) {
      if (!Number.isInteger(selectedInput[field])) throw new Error(`${field} must be an integer`);
      args.push(`--${field.replace('_', '-')}`, String(selectedInput[field]));
    }
  }
  return { ...buyerOptions(args, { MOTTO_API_KEY: apiKey }), network: 'devnet' };
}

export async function devnetPurchase({ quote, quoteId = quote?.id, input = quote?.input,
  maxSpendUsd = quote?.max_spend_usd, port, desk, rpcUrl = DEVNET_RPC, apiKey = process.env.MOTTO_API_KEY },
{ fetcher = fetch, rpc = devnetRpc, getSigner = devnetSigner, createClient = createPayKitClient,
  checkNetwork = assertDevnet, onRequest = () => {} } = {}) {
  if (quoteId !== undefined && (typeof quoteId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(quoteId))) throw new Error('A valid quote ID is required');
  if (quote && quote.id !== quoteId) throw new Error('The reviewed quote and quote ID differ');
  if (!input && !quoteId) throw new Error('Research input or a reviewed quote ID is required');
  const origin = desk ?? `http://127.0.0.1:${port ?? 8787}`;
  let options = researchOptions(input ?? { query: 'reviewed citation pack', count: 1 }, maxSpendUsd, origin, apiKey);
  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  const request = async (path, init = {}) => {
    const response = await fetcher(`${options.desk}${path}`, { ...init, redirect: 'error', signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Devnet desk request failed (${response.status}); no payment attempted`);
    return response.json();
  };
  const services = await request('/v1/services');
  if (services.network !== 'devnet') throw new Error('This buyer only supports a Devnet desk; no payment attempted');
  if (!services.services?.research || typeof services.signing_public_key !== 'string' || !/^[0-9a-f]{64}$/i.test(services.signing_public_key)) throw new Error('Devnet desk has no research service or valid receipt signing key');
  let acceptedQuote;
  if (quoteId) {
    const stored = await request(`/v1/quotes/${encodeURIComponent(quoteId)}`, { headers });
    if (stored.id !== quoteId) throw new Error('Desk returned a different quote ID; no payment attempted');
    if (!input) options = researchOptions(stored.input, maxSpendUsd, origin, apiKey);
    acceptedQuote = checkQuote(stored, options);
    if (quote && ['quote_hash', 'ceiling_usd', 'unit_price_usd', 'created_at', 'expires_at'].some(field => stored[field] !== quote[field])) throw new Error('The stored quote differs from the reviewed quote; no payment attempted');
  } else {
    acceptedQuote = checkQuote(await request('/v1/quotes', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ service: 'research', input: options.input, max_spend_usd: options.maxSpend }) }), options);
  }
  await checkNetwork(rpcUrl);
  const signer = await getSigner('buyer');
  const tokens = await rpc('getTokenAccountsByOwner', [signer.address, { mint: DEVNET_USDC }, { encoding: 'jsonParsed' }], rpcUrl);
  if (!Array.isArray(tokens?.value)) throw new Error('Devnet RPC returned invalid token accounts');
  const balance = tokens.value.reduce((sum, account) => {
    const amount = account?.account?.data?.parsed?.info?.tokenAmount?.amount;
    if (typeof amount !== 'string' || !/^\d{1,32}$/.test(amount)) throw new Error('Devnet RPC returned an invalid token balance');
    return sum + BigInt(amount);
  }, 0n);
  const ceiling = toBaseUnits(acceptedQuote.ceiling_usd);
  if (balance < ceiling) {
    const error = new Error(`Devnet buyer needs at least ${formatUsd(ceiling)} test USDC for this quote: ${signer.address}. Fund it at faucet.circle.com (Solana Devnet).`);
    error.code = 'DEVNET_FUNDING';
    throw error;
  }
  checkQuote(acceptedQuote, options);
  const client = await createClient({ network: 'devnet', rpcUrl, signer, accept: ['x402'],
    permissions: ClientPermissions.builder().onlyNetwork('devnet').allowOrigin(options.desk).maxAmountPerPayment(usd(acceptedQuote.ceiling_usd)).build() });
  const key = randomUUID();
  onRequest({ quote_id: acceptedQuote.id, idempotency_key: key, network: 'devnet', max_spend_usd: options.maxSpend, ceiling_usd: acceptedQuote.ceiling_usd });
  const response = await client.fetch(`${options.desk}/v1/purchases/${encodeURIComponent(acceptedQuote.id)}`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: '{}',
    redirect: 'error', signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok) throw new Error(`Devnet payment request failed (${response.status}). Inspect purchase history before retrying.`);
  const purchase = checkPurchase(await response.json(), acceptedQuote, options, services.signing_public_key);
  if (!['paid', 'refunded'].includes(purchase.status)) {
    const error = new Error(`Devnet purchase ${purchase.id} is ${purchase.status}; settlement is unconfirmed. Inspect this purchase before retrying.`);
    error.code = 'DEVNET_SETTLEMENT_UNCONFIRMED';
    error.purchase = purchase;
    throw error;
  }
  return purchase;
}
