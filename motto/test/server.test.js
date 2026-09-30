// Server smoke test: boots src/server.js on a free port with a throwaway data
// dir and device key. The 402 offer needs the Pay.sh sandbox RPC, so this test
// needs network access.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAdminAuth } from '../src/admin-auth.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'desk-server-'));
const children = [];
let desk;

// Real keys and mainnet settings from the caller's shell never reach the test servers.
const env = { ...process.env };
for (const name of ['NETWORK', 'RPC_URL', 'OPERATOR_KEY', 'RECIPIENT', 'RECEIPT_KEY', 'RECEIPT_RPC_URL', 'CHARGER_WAIT_MS', 'MOTTO_ADMIN_TOKEN_FILE']) delete env[name];

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
    probe.on('error', reject);
  });
}

async function startDesk(extraEnv = {}) {
  const port = await freePort();
  const server = { base: `http://127.0.0.1:${port}`, log: '' };
  server.child = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env: { ...env, NETWORK: 'localnet', PORT: String(port), DATA_DIR: dir, DEVICE_KEY_PATH: join(dir, 'device.pem'), MOTTO_ADMIN_TOKEN: 'test-admin-token', MOCK_POWER: 'ac', ...extraEnv },
  });
  children.push(server.child);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`desk did not start:\n${server.log}`)), 15_000);
    const collect = chunk => {
      server.log += chunk;
      if (server.log.includes('Motto on')) {
        clearTimeout(timer);
        resolve();
      }
    };
    server.child.stdout.setEncoding('utf8').on('data', collect);
    server.child.stderr.setEncoding('utf8').on('data', collect);
    server.child.on('exit', code => {
      clearTimeout(timer);
      reject(new Error(`desk exited with ${code}:\n${server.log}`));
    });
  });
  return server;
}

// The server writes its log lines just before it responds, so give the pipe a moment.
async function assertLogged(server, pattern) {
  for (let i = 0; i < 50 && !pattern.test(server.log); i++) await new Promise(r => setTimeout(r, 20));
  assert.match(server.log, pattern);
}

before(async () => {
  // Two holds (one with a checking line before its final line), a torn line and
  // a blank line: the desk must come back with both holds in their final state.
  const lines = [
    { id: 'old00001', item: 'hotspot', status: 'checking', startedAt: 1000 },
    { id: 'old00001', item: 'hotspot', status: 'kept', startedAt: 1000, charged_usd: '1.00' },
    '{"id":"torn',
    '',
    { id: 'new00002', item: 'charger', status: 'refunded', startedAt: 2000, charged_usd: '0.01' },
    { id: 'cut00003', item: 'charger', status: 'waiting_for_power', startedAt: 3000 },
  ];
  writeFileSync(join(dir, 'holds.jsonl'), lines.map(l => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  desk = await startDesk();
});

after(() => {
  for (const child of children) child.kill();
  rmSync(dir, { recursive: true, force: true });
});

test('GET /v1/terms states the intermediary role and virtual-only offer', async () => {
  const res = await fetch(`${desk.base}/v1/terms`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.role, 'purchase_intermediary');
  assert.equal(body.scope, 'virtual_only');
  assert.deepEqual(Object.keys(body.items), ['research']);
  for (const [name, item] of Object.entries(body.items)) {
    assert.equal(body.endpoints[name], `POST /v1/buy/${name}`);
    assert.match(item.hold_usd, /^\d+\.\d{2}$/, `${name} has a price`);
    assert.match(item.check_fee_usd, /^\d+\.\d{2}$/, `${name} has a check fee`);
    assert.ok(item.covers, `${name} says what the hold buys`);
    assert.ok((name === 'research' ? item.rules.inconclusive : item.rules.already_handled) && item.rules.delivered && item.rules.check_failed, `${name} states its rules`);
    assert.equal(item.fulfillment.type, 'virtual');
  }
  assert.equal(body.max_hold_usd, '1.00');
  assert.match(body.devicePublicKey, /^[0-9a-f]{64}$/);
});

test('POST /v1/buy/research without payment returns the x402 upto offer', async () => {
  const res = await fetch(`${desk.base}/v1/buy/research`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'battery recycling' }) });
  assert.equal(res.status, 402);
  assert.match(res.headers.get('content-type'), /application\/json/);
  // The offer rides base64 JSON in the payment-required header and plain JSON in the body.
  const header = JSON.parse(Buffer.from(res.headers.get('payment-required'), 'base64').toString('utf8'));
  assert.equal(header.x402Version, 2);
  assert.equal(header.resource.url, `${desk.base}/v1/buy/research`);
  assert.equal(header.accepts[0].scheme, 'upto');
  assert.equal(header.accepts[0].amount, '1000000');
  assert.equal(header.accepts[0].maxTimeoutSeconds, 300);
  const body = await res.json();
  assert.equal(body.accepts[0].scheme, 'upto');
  assert.equal(body.accepts[0].protocol, 'x402');
  assert.equal(body.accepts[0].amount, '1000000');
  assert.equal(body.accepts[0].payTo, header.accepts[0].payTo);
});

test('legacy rental and physical purchase requests are rejected before payment', async () => {
  const requests = [
    ['/v1/rent/research', 410, 'legacy_rental_endpoint_removed'],
    ['/v1/rent/charger', 410, 'legacy_rental_endpoint_removed'],
    ...['charger', 'hotspot', 'battery_pack', 'storage', 'display', 'monitor'].map(name => [`/v1/buy/${name}`, 422, 'physical_purchase_not_supported']),
  ];
  for (const [path, status, error] of requests) {
    const res = await fetch(`${desk.base}${path}`, { method: 'POST' });
    assert.equal(res.status, status, path);
    assert.equal(res.headers.get('payment-required'), null, path);
    assert.equal((await res.json()).error, error, path);
  }
});

test('GET /openapi.json advertises only the canonical research purchase', async () => {
  const res = await fetch(`${desk.base}/openapi.json`);
  assert.equal(res.status, 200);
  const doc = await res.json();
  assert.deepEqual(Object.keys(doc.paths), ['/v1/buy/research']);
  const [offer] = doc.paths['/v1/buy/research'].post['x-payment-info'].offers;
  assert.deepEqual([offer.method, offer.scheme, offer.amount, offer.currency], ['x402', 'upto', '1000000', 'USDC']);
});

test('GET /healthz reports network, commit, uptime and hold count', async () => {
  const res = await fetch(`${desk.base}/healthz`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.network, 'localnet');
  assert.ok(Number.isInteger(body.uptime_s) && body.uptime_s >= 0);
  assert.equal(body.holds, 3);
  assert.ok(body.commit === null || /^[0-9a-f]{7,40}(-dirty)?$/.test(body.commit), `commit: ${body.commit}`);
});

test('GET /v1/holds reloads the log: last line per id, newest first, bad lines skipped', async () => {
  const res = await fetch(`${desk.base}/v1/holds`);
  assert.equal(res.status, 200);
  const { holds } = await res.json();
  assert.deepEqual(holds.map(h => [h.id, h.status]), [['cut00003', 'interrupted'], ['new00002', 'refunded'], ['old00001', 'kept']]);
  await assertLogged(desk, /Skipped 1 malformed line/);
});

test('GET /v1/holds/:id returns one hold or a JSON 404', async () => {
  const found = await fetch(`${desk.base}/v1/holds/old00001`);
  assert.equal(found.status, 200);
  assert.deepEqual(await found.json(), { id: 'old00001', item: 'hotspot', status: 'kept', startedAt: 1000, charged_usd: '1.00' });
  const missing = await fetch(`${desk.base}/v1/holds/nope`);
  assert.equal(missing.status, 404);
  assert.match(missing.headers.get('content-type'), /application\/json/);
  assert.equal(typeof (await missing.json()).error, 'string');
});

test('detailed holds and events reject public requests while redacted stats stay public', async () => {
  const publicHeaders = { 'x-forwarded-host': 'motto.example', 'x-forwarded-for': '203.0.113.10' };
  for (const path of ['/v1/holds', '/v1/holds/old00001', '/v1/events']) {
    const denied = await fetch(`${desk.base}${path}`, { headers: publicHeaders });
    assert.equal(denied.status, 401, path);
    assert.equal((await denied.json()).error, 'private_records_require_local_or_admin_access', path);
  }
  const allowed = await fetch(`${desk.base}/v1/holds/old00001`, { headers: { ...publicHeaders, authorization: 'Bearer test-admin-token' } });
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json()).id, 'old00001');
  const stats = await fetch(`${desk.base}/v1/public/stats`, { headers: publicHeaders });
  assert.equal(stats.status, 200);
  assert.deepEqual(await stats.json(), { total: 3, counts: { interrupted: 1, refunded: 1, kept: 1 } });
});

test('a one-time pairing link creates an HttpOnly browser session', async () => {
  const auth = createAdminAuth({ dataDir: dir, env: { MOTTO_ADMIN_TOKEN: 'test-admin-token' } });
  const pairing = auth.createPairing();
  const publicHeaders = { 'x-forwarded-host': 'motto.example', 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.10', origin: 'https://motto.example' };
  const paired = await fetch(`${desk.base}/v1/admin/pair`, {
    method: 'POST',
    headers: { ...publicHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ code: pairing.code }),
  });
  assert.equal(paired.status, 200);
  const setCookie = paired.headers.get('set-cookie');
  assert.match(setCookie, /^__Host-motto_admin=/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /SameSite=Strict/);
  const cookie = setCookie.split(';')[0];

  const session = await fetch(`${desk.base}/v1/admin/session`, { headers: { ...publicHeaders, cookie } });
  assert.equal(session.status, 200);
  assert.equal((await session.json()).via, 'session');
  const holds = await fetch(`${desk.base}/v1/holds`, { headers: { ...publicHeaders, cookie } });
  assert.equal(holds.status, 200);

  const replay = await fetch(`${desk.base}/v1/admin/pair`, {
    method: 'POST',
    headers: { ...publicHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ code: pairing.code }),
  });
  assert.equal(replay.status, 401);
});

test('pairing rejects a mismatched browser origin', async () => {
  const auth = createAdminAuth({ dataDir: dir, env: { MOTTO_ADMIN_TOKEN: 'test-admin-token' } });
  const pairing = auth.createPairing();
  const response = await fetch(`${desk.base}/v1/admin/pair`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-host': 'motto.example',
      'x-forwarded-proto': 'https',
      origin: 'https://attacker.example',
    },
    body: JSON.stringify({ code: pairing.code }),
  });
  assert.equal(response.status, 403);
});

test('unknown items and unknown /v1 routes return JSON 404', async () => {
  const item = await fetch(`${desk.base}/v1/buy/toString`, { method: 'POST' });
  assert.equal(item.status, 404);
  assert.equal(item.headers.get('payment-required'), null);
  assert.deepEqual((await item.json()).items, ['research']);
  const route = await fetch(`${desk.base}/v1/nope`);
  assert.equal(route.status, 404);
  assert.match(route.headers.get('content-type'), /application\/json/);
  assert.equal(typeof (await route.json()).error, 'string');
});

test('a malformed JSON body gets a JSON 400, not an HTML page', async () => {
  const res = await fetch(`${desk.base}/v1/buy/research`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' });
  assert.equal(res.status, 400);
  assert.match(res.headers.get('content-type'), /application\/json/);
  assert.equal(typeof (await res.json()).error, 'string');
  await assertLogged(desk, /POST \/v1\/buy\/research -> 400/);
});

test('a pay-kit failure (RPC unreachable) gets a JSON 500 without the stack', async () => {
  const broken = await startDesk({ RPC_URL: `http://127.0.0.1:${await freePort()}` });
  const res = await fetch(`${broken.base}/v1/buy/research`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'battery recycling' }) });
  assert.equal(res.status, 500);
  assert.match(res.headers.get('content-type'), /application\/json/);
  assert.deepEqual(await res.json(), { error: 'internal error' });
  await assertLogged(broken, /POST \/v1\/buy\/research -> 500/);
});


test('research rejects a missing topic before authorizing any payment', async () => {
  const before = await fetch(`${desk.base}/v1/holds`).then(r => r.json());
  const res = await fetch(`${desk.base}/v1/buy/research`, {method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  assert.equal(res.status,400);
  assert.match((await res.json()).error,/query/);
  const after = await fetch(`${desk.base}/v1/holds`).then(r => r.json());
  assert.equal(after.holds.length,before.holds.length);
});
