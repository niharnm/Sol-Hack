import { createPayKit, Signer } from '@solana/pay-kit';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { createApp } from './app.js';
import { PurchaseStore } from './store.js';
import { devicePublicKey, signReading } from './checks.js';
import { digitalService } from './digital.js';
import { DEVNET_RPC, devnetSigner, assertDevnet, devnetPurchase } from './devnet.js';

const network = process.env.NETWORK ?? 'devnet';
const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 8787);
const apiKey = process.env.MOTTO_API_KEY;
const publicBaseUrl = process.env.PUBLIC_BASE_URL;
if (!['localnet', 'mainnet', 'mainnet-beta', 'devnet'].includes(network)) throw new Error('Unsupported NETWORK');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535');
const mainnet = ['mainnet', 'mainnet-beta'].includes(network);
if ((mainnet || !['127.0.0.1', '::1', 'localhost'].includes(host)) && (!apiKey || apiKey.length < 32)) throw new Error('Mainnet or external binding requires MOTTO_API_KEY of at least 32 characters');
if (apiKey && apiKey.length < 32) throw new Error('MOTTO_API_KEY must contain at least 32 characters');
if (mainnet && (!publicBaseUrl || !publicBaseUrl.startsWith('https://'))) throw new Error('Real-network payments require an HTTPS PUBLIC_BASE_URL');
if (mainnet && (!process.env.OPERATOR_KEY || !process.env.RPC_URL)) throw new Error('Real-network payments require OPERATOR_KEY and RPC_URL');
digitalService();
const rpcUrl = process.env.RPC_URL || (network === 'devnet' ? DEVNET_RPC : network === 'localnet' ? 'https://402.surfnet.dev:8899' : undefined);
if (network === 'devnet') await assertDevnet(rpcUrl);
const operatorSigner = network === 'devnet' ? Signer.from(await devnetSigner('operator')) : mainnet ? await Signer.env('OPERATOR_KEY') : undefined;
const pay = await createPayKit({ network, accept: ['x402'],
  rpcUrl,
  ...(operatorSigner ? { operator: { signer: operatorSigner } } : {}) });
let consolePay = false;
if (network === 'localnet' && !apiKey) {
  try {
    execFileSync('pay', ['--version'], { stdio: 'ignore', timeout: 3000 });
    consolePay = true;
  } catch { console.warn('Pay.sh CLI unavailable; purchases require an external Pay.sh client.'); }
}
const store = new PurchaseStore(join(process.env.DATA_DIR || `data/${mainnet ? 'mainnet' : network}`, 'purchases.sqlite'));
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
let revision = null;
try {
  const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain', '--', 'src', 'public'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  revision = `${sha}${dirty ? '-dirty' : ''}`;
} catch { console.warn('Git revision unavailable for this service process.'); }
const app = createApp({ pay, store, signReading, signingPublicKey: devicePublicKey, network, apiKey, revision,
  publicBaseUrl, consolePay, consoleDevnet: network === 'devnet' ? quote => devnetPurchase({ quote, port, rpcUrl }) : undefined, quoteTtlSeconds: Number(process.env.QUOTE_TTL_SECONDS ?? 120), version });
const server = app.listen(port, host, () => console.log(`Motto on http://${host}:${port} network=${network}`));
server.on('error', error => { console.error(error.message); store.close(); process.exitCode = 1; });
function shutdown() {
  server.close(() => { store.close(); process.exit(0); });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
