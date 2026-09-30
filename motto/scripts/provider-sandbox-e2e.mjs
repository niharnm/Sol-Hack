import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  attestationSigningPayload,
  quoteSigningPayload,
  sha256Hex,
} from '../src/provider-protocol.js';

const mottoRoot = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const require = createRequire(import.meta.url);
const bs58 = require('bs58').default;

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createNetServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
    probe.on('error', reject);
  });
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

function command(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, options);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${file} timed out`));
    }, 180_000);
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', code => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${file} exited ${code}\n${stdout}\n${stderr}`));
    });
  });
}

const root = mkdtempSync(join(tmpdir(), 'motto-provider-e2e-'));
const quoteKeys = generateKeyPairSync('ed25519');
const attestorKeys = generateKeyPairSync('ed25519');
const publicHex = key => key.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
const payout = bs58.encode(randomBytes(32));
const providerToken = randomBytes(24).toString('base64url');
const calls = [];
let lastQuote;
let motto;
let provider;
let mottoLog = '';

try {
  const providerPort = await freePort();
  provider = createHttpServer(async (requestMessage, response) => {
    try {
      if (requestMessage.headers.authorization !== `Bearer ${providerToken}`) {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      const body = await readBody(requestMessage);
      calls.push(body.action);
      if (body.action === 'quote') {
        const quote = {
          version: 1,
          quote_id: `quote_${randomBytes(8).toString('hex')}`,
          provider_id: 'sandbox-provider',
          offer_id: 'signed-result',
          network: 'localnet',
          payout_address: payout,
          hold_usd: '0.01',
          settlement: {
            delivered_usd: '0.01',
            already_handled_usd: '0.00',
            not_delivered_usd: '0.00',
            inconclusive_usd: '0.00',
          },
          request_sha256: sha256Hex(body.request),
          attestor_id: 'sandbox-attestor',
          nonce: randomBytes(18).toString('base64url'),
          expires_at_ms: Date.now() + 240_000,
          fulfillment_timeout_seconds: 120,
        };
        lastQuote = quote;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          signed_quote: {
            quote,
            signature: sign(null, Buffer.from(quoteSigningPayload(quote)), quoteKeys.privateKey).toString('base64url'),
          },
        }));
        return;
      }
      if (body.action === 'fulfill') {
        const artifact = { type: 'sandbox_result', delivered: true, request: body.request };
        const now = Date.now();
        const attestation = {
          version: 1,
          attestation_id: `att_${randomBytes(8).toString('hex')}`,
          provider_id: lastQuote.provider_id,
          offer_id: lastQuote.offer_id,
          quote_id: lastQuote.quote_id,
          order_id: body.order.id,
          hold_id: body.order.hold_id,
          attestor_id: lastQuote.attestor_id,
          network: lastQuote.network,
          payout_address: lastQuote.payout_address,
          request_sha256: lastQuote.request_sha256,
          outcome: 'delivered',
          artifact_sha256: sha256Hex(artifact),
          nonce: randomBytes(18).toString('base64url'),
          issued_at_ms: now,
          expires_at_ms: Math.min(now + 30_000, body.order.fulfillment_deadline_ms),
        };
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          artifact,
          signed_attestation: {
            attestation,
            signature: sign(null, Buffer.from(attestationSigningPayload(attestation)), attestorKeys.privateKey).toString('base64url'),
          },
        }));
        return;
      }
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'unknown_action' }));
    } catch (error) {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: String(error?.message ?? error) }));
    }
  });
  await new Promise((resolve, reject) => {
    provider.once('error', reject);
    provider.listen(providerPort, '127.0.0.1', resolve);
  });

  const registryPath = join(root, 'providers.json');
  writeFileSync(registryPath, JSON.stringify({
    version: 1,
    providers: [{
      id: 'sandbox-provider',
      name: 'Sandbox Provider',
      payout_address: payout,
      quote_public_key: publicHex(quoteKeys.publicKey),
      fulfillment_url: `http://127.0.0.1:${providerPort}/motto`,
      attestors: [{ id: 'sandbox-attestor', public_key: publicHex(attestorKeys.publicKey) }],
      offers: [{
        id: 'signed-result',
        summary: 'Return a signed sandbox result',
        network: 'localnet',
        max_hold_usd: '0.01',
        fulfillment_timeout_seconds: 120,
        attestor_ids: ['sandbox-attestor'],
      }],
    }],
  }));

  const mottoPort = await freePort();
  motto = spawn(process.execPath, ['src/server.js'], {
    cwd: mottoRoot,
    env: {
      ...process.env,
      NETWORK: 'localnet',
      PORT: String(mottoPort),
      PUBLIC_ORIGIN: `http://127.0.0.1:${mottoPort}`,
      DATA_DIR: join(root, 'data'),
      DEVICE_KEY_PATH: join(root, 'device.pem'),
      MOTTO_PROVIDERS_FILE: registryPath,
      MOTTO_ALLOW_LOCAL_PROVIDERS: 'true',
      MOTTO_PROVIDER_TOKEN_SANDBOX_PROVIDER: providerToken,
    },
  });
  motto.stdout.setEncoding('utf8').on('data', chunk => { mottoLog += chunk; });
  motto.stderr.setEncoding('utf8').on('data', chunk => { mottoLog += chunk; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Motto startup timed out\n${mottoLog}`)), 20_000);
    const check = chunk => {
      if (!chunk.includes('Motto on')) return;
      clearTimeout(timer);
      resolve();
    };
    motto.stdout.on('data', check);
    motto.on('exit', code => {
      clearTimeout(timer);
      reject(new Error(`Motto exited ${code}\n${mottoLog}`));
    });
  });

  const base = `http://127.0.0.1:${mottoPort}`;
  const createdResponse = await fetch(`${base}/v1/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': `e2e-${randomBytes(12).toString('hex')}` },
    body: JSON.stringify({
      provider_id: 'sandbox-provider',
      offer_id: 'signed-result',
      request: { task: 'return a signed sandbox result' },
    }),
  });
  if (createdResponse.status !== 201) throw new Error(`Order creation failed ${createdResponse.status}: ${await createdResponse.text()}`);
  const created = await createdResponse.json();
  const paid = await command('pay', [
    '--sandbox', 'fetch', '-X', 'POST', `${base}${created.execute_path}`,
    '-H', `X-Motto-Order-Token: ${created.order_token}`,
  ], { cwd: mottoRoot, env: { ...process.env, NO_COLOR: '1' } });
  const result = JSON.parse(paid.stdout);
  const readResponse = await fetch(`${base}/v1/orders/${created.order.id}`, {
    headers: { 'x-motto-order-token': created.order_token },
  });
  const recorded = await readResponse.json();
  if (result.order?.payment_state !== 'settled' || result.order?.fulfillment_state !== 'verified') {
    throw new Error(`Unexpected paid result: ${paid.stdout}`);
  }
  if (result.payment?.charged_usd !== '0.01' || recorded.payment?.charged_usd !== '0.01') {
    throw new Error(`Unexpected settlement: ${paid.stdout}`);
  }
  if (!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(result.payment?.settlement_transaction ?? '')) {
    throw new Error(`Missing sandbox settlement transaction: ${paid.stdout}`);
  }
  if (calls.join(',') !== 'quote,fulfill') throw new Error(`Unexpected provider calls: ${calls.join(',')}`);
  if (result.order.payout_address !== payout) throw new Error('Settled order payout does not match the registry');
  console.log(JSON.stringify({
    ok: true,
    pay_version: (await command('pay', ['--version'])).stdout.trim(),
    network: result.order.network,
    provider_id: result.order.provider_id,
    payment_state: result.order.payment_state,
    fulfillment_state: result.order.fulfillment_state,
    charged_usd: result.payment.charged_usd,
    returned_usd: result.payment.returned_usd,
    settlement_transaction: result.payment.settlement_transaction,
    provider_calls: calls,
    payout_matches_registry: true,
  }, null, 2));
} catch (error) {
  console.error(mottoLog);
  throw error;
} finally {
  if (motto) motto.kill();
  if (provider) await new Promise(resolve => provider.close(resolve));
  rmSync(root, { recursive: true, force: true });
}
