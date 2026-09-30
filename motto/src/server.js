import { createPayKit, Signer } from '@solana/pay-kit';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { createApp } from './app.js';
import { PurchaseStore } from './store.js';
import { devicePublicKey, signReading } from './checks.js';
import { digitalService } from './digital.js';

const network = process.env.NETWORK ?? 'localnet';
const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 8787);
const apiKey = process.env.MOTTO_API_KEY;
const publicBaseUrl = process.env.PUBLIC_BASE_URL;
if (!['localnet', 'mainnet', 'mainnet-beta', 'devnet'].includes(network)) throw new Error('Unsupported NETWORK');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535');
if ((network !== 'localnet' || !['127.0.0.1', '::1', 'localhost'].includes(host)) && (!apiKey || apiKey.length < 32)) throw new Error('Real networks or external binding require MOTTO_API_KEY of at least 32 characters');
if (apiKey && apiKey.length < 32) throw new Error('MOTTO_API_KEY must contain at least 32 characters');
if (network !== 'localnet' && (!publicBaseUrl || !publicBaseUrl.startsWith('https://'))) throw new Error('Real-network payments require an HTTPS PUBLIC_BASE_URL');
if (network !== 'localnet' && (!process.env.OPERATOR_KEY || !process.env.RPC_URL)) throw new Error('Real-network payments require OPERATOR_KEY and RPC_URL');
digitalService();
const operatorSigner = await Signer.env('OPERATOR_KEY');
const pay = await createPayKit({ network, accept: ['x402'],
  rpcUrl: process.env.RPC_URL ?? (network === 'localnet' ? 'https://402.surfnet.dev:8899' : undefined),
  ...(operatorSigner ? { operator: { signer: operatorSigner } } : {}) });
let consolePay = false;
if (network === 'localnet' && !apiKey) {
  try {
    execFileSync('pay', ['--version'], { stdio: 'ignore', timeout: 3000 });
    consolePay = true;
  } catch { console.warn('Pay.sh CLI unavailable; purchases require an external Pay.sh client.'); }
}
const store = new PurchaseStore(join(process.env.DATA_DIR ?? 'data', 'purchases.sqlite'));
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const app = createApp({ pay, store, signReading, signingPublicKey: devicePublicKey, network, apiKey,
  publicBaseUrl, consolePay, quoteTtlSeconds: Number(process.env.QUOTE_TTL_SECONDS ?? 120), version });
const server = app.listen(port, host, () => console.log(`Motto on http://${host}:${port} network=${network}`));
server.on('error', error => { console.error(error.message); store.close(); process.exitCode = 1; });
function shutdown() {
  server.close(() => { store.close(); process.exit(0); });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
