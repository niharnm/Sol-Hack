import { checkPurchase } from '../motto/buyer/buy.js';
import { assertDevnet, DEVNET_RPC, devnetRpc } from '../motto/src/devnet.js';

const base = new URL(process.env.DESK_URL ?? 'http://127.0.0.1:8787').origin;
const headers = process.env.MOTTO_API_KEY ? { Authorization: `Bearer ${process.env.MOTTO_API_KEY}` } : {};
const get = async path => {
  const response = await fetch(base + path, { headers, redirect: 'error', signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
};
const [history, services] = await Promise.all([get('/v1/purchases'), get('/v1/services')]);
if (!['localnet', 'devnet'].includes(services.network)) throw new Error('Expected a test-network desk.');
const purchase = history.purchases.find(p => p.service === 'research' && p.network === services.network && ['paid', 'refunded'].includes(p.status));
if (!purchase) throw new Error('No settled research purchase. Make a test purchase first.');
const quote = await get(`/v1/quotes/${encodeURIComponent(purchase.quote_id)}`);
checkPurchase(purchase, quote, { input: quote.input, maxSpend: quote.max_spend_usd, network: services.network }, services.signing_public_key);
let confirmation = 'Not independently checked';
if (services.network === 'devnet') {
  const rpcUrl = process.env.RPC_URL ?? DEVNET_RPC;
  await assertDevnet(rpcUrl);
  const status = await devnetRpc('getSignatureStatuses', [[purchase.settlement_tx], { searchTransactionHistory: true }], rpcUrl);
  const transaction = status?.value?.[0];
  if (!transaction || transaction.err || !['confirmed', 'finalized'].includes(transaction.confirmationStatus)) throw new Error('Devnet settlement is not confirmed by the selected RPC.');
  confirmation = transaction.confirmationStatus;
}
console.log(JSON.stringify({ purchase: purchase.id, quote: quote.id, network: services.network, receipt_signature: 'VERIFIED', status: purchase.status,
  ceiling_usd: purchase.ceiling_usd, charged_usd: purchase.charged_usd, returned_usd: purchase.returned_usd,
  settlement_tx: purchase.settlement_tx, chain_status: confirmation }, null, 2));
