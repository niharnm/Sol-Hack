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

const root = fileURLToPath(new URL('..', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'desk-server-'));
const children = [];
let desk;

// Real keys and mainnet settings from the caller's shell never reach the test servers.
const env = { ...process.env };
for (const name of ['NETWORK', 'RPC_URL', 'OPERATOR_KEY', 'RECIPIENT', 'RECEIPT_KEY', 'RECEIPT_RPC_URL', 'CHARGER_WAIT_MS']) delete env[name];

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
    env: { ...env, PORT: String(port), DATA_DIR: dir, DEVICE_KEY_PATH: join(dir, 'device.pem'), MOCK_POWER: 'ac', ...extraEnv },
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

test('GET /v1/terms lists the items', async () => {
  const res = await fetch(`${desk.base}/v1/terms`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(Object.keys(body.items), ['charger', 'hotspot', 'battery_pack', 'storage', 'display', 'verify']);
  for (const [name, item] of Object.entries(body.items)) {
    assert.equal(body.endpoints[name], `POST /v1/rent/${name}`);
    assert.equal(item.hold_usd, '1.00');
    assert.ok(item.rules.already_handled && item.rules.delivered && item.rules.check_failed, `${name} states its rules`);
  }
  assert.match(body.devicePublicKey, /^[0-9a-f]{64}$/);
});

test('POST /v1/rent/charger without payment returns the x402 upto offer', async () => {
  const res = await fetch(`${desk.base}/v1/rent/charger`, { method: 'POST' });
  assert.equal(res.status, 402);
  assert.match(res.headers.get('content-type'), /application\/json/);
  // The offer rides base64 JSON in the payment-required header and plain JSON in the body.
  const header = JSON.parse(Buffer.from(res.headers.get('payment-required'), 'base64').toString('utf8'));
  assert.equal(header.x402Version, 2);
  assert.equal(header.resource.url, `${desk.base}/v1/rent/charger`);
  assert.equal(header.accepts[0].scheme, 'upto');
  assert.equal(header.accepts[0].amount, '1000000');
  assert.equal(header.accepts[0].maxTimeoutSeconds, 300);
  const body = await res.json();
  assert.equal(body.accepts[0].scheme, 'upto');
  assert.equal(body.accepts[0].protocol, 'x402');
  assert.equal(body.accepts[0].amount, '1000000');
  assert.equal(body.accepts[0].payTo, header.accepts[0].payTo);
});

test('POST /v1/rent/verify without a condition is a 400 before any hold', async () => {
  const res = await fetch(`${desk.base}/v1/rent/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 400);
  assert.equal(res.headers.get('payment-required'), null);
  assert.match((await res.json()).error, /condition is required/);
  const ok = await fetch(`${desk.base}/v1/rent/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ condition: 'The laptop has 20 GB free' }) });
  assert.equal(ok.status, 402);
});

test('GET /openapi.json advertises the payment offers', async () => {
  const res = await fetch(`${desk.base}/openapi.json`);
  assert.equal(res.status, 200);
  const doc = await res.json();
  for (const path of ['/v1/rent/charger', '/v1/rent/hotspot', '/v1/rent/battery_pack', '/v1/rent/storage', '/v1/rent/display', '/v1/rent/verify']) {
    const [offer] = doc.paths[path].post['x-payment-info'].offers;
    assert.deepEqual([offer.method, offer.scheme, offer.amount, offer.currency], ['x402', 'upto', '1000000', 'USDC']);
  }
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

test('unknown items and unknown /v1 routes return JSON 404', async () => {
  const item = await fetch(`${desk.base}/v1/rent/toString`, { method: 'POST' });
  assert.equal(item.status, 404);
  assert.deepEqual((await item.json()).items, ['charger', 'hotspot', 'battery_pack', 'storage', 'display', 'verify']);
  const route = await fetch(`${desk.base}/v1/nope`);
  assert.equal(route.status, 404);
  assert.match(route.headers.get('content-type'), /application\/json/);
  assert.equal(typeof (await route.json()).error, 'string');
});

test('a malformed JSON body gets a JSON 400, not an HTML page', async () => {
  const res = await fetch(`${desk.base}/v1/rent/charger`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' });
  assert.equal(res.status, 400);
  assert.match(res.headers.get('content-type'), /application\/json/);
  assert.equal(typeof (await res.json()).error, 'string');
  await assertLogged(desk, /POST \/v1\/rent\/charger -> 400/);
});

test('a pay-kit failure (RPC unreachable) gets a JSON 500 without the stack', async () => {
  const broken = await startDesk({ RPC_URL: `http://127.0.0.1:${await freePort()}` });
  const res = await fetch(`${broken.base}/v1/rent/charger`, { method: 'POST' });
  assert.equal(res.status, 500);
  assert.match(res.headers.get('content-type'), /application\/json/);
  assert.deepEqual(await res.json(), { error: 'internal error' });
  await assertLogged(broken, /POST \/v1\/rent\/charger -> 500/);
});
