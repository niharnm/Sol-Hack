// Device check unit tests. MOCK_POWER is read on every readPower call, so
// flipping it mid-wait stands in for someone plugging the cable in.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, verify } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// checks.js loads (or creates) the device key on import, so point it at a
// throwaway key before importing. The real keys/device.pem is never touched.
const dir = mkdtempSync(join(tmpdir(), 'desk-checks-'));
process.env.DEVICE_KEY_PATH = join(dir, 'device.pem');
const { chargerWaitMs, checkCharger, checkHotspot, devicePublicKey, readNetwork, readPower } = await import('../src/checks.js');
after(() => rmSync(dir, { recursive: true, force: true }));

// ed25519 SPKI DER is this fixed 12-byte prefix followed by the raw 32-byte key.
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

// A reading is signed over the JSON of its fields before signature and key are attached.
function assertSigned(reading) {
  const { signature, devicePublicKey: keyHex, ...payload } = reading;
  assert.equal(keyHex, devicePublicKey);
  const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(keyHex, 'hex')]), format: 'der', type: 'spki' });
  const sig = Buffer.from(signature, 'hex');
  assert.ok(verify(null, Buffer.from(JSON.stringify(payload)), key, sig), 'signature verifies');
  const forged = { ...payload, outcome: payload.outcome === 'delivered' ? 'already_handled' : 'delivered' };
  assert.equal(verify(null, Buffer.from(JSON.stringify(forged)), key, sig), false, 'tampered reading is rejected');
}

test('device key is created at DEVICE_KEY_PATH and matches devicePublicKey', () => {
  const pem = readFileSync(process.env.DEVICE_KEY_PATH);
  const raw = createPublicKey(createPrivateKey(pem)).export({ type: 'spki', format: 'der' }).subarray(-32);
  assert.equal(raw.toString('hex'), devicePublicKey);
});

test('readPower follows MOCK_POWER', async () => {
  process.env.MOCK_POWER = 'ac';
  assert.deepEqual(await readPower(), { onPower: true, raw: 'mock:ac' });
  process.env.MOCK_POWER = 'battery';
  assert.deepEqual(await readPower(), { onPower: false, raw: 'mock:battery' });
});

test('charger on AC: already_handled', async () => {
  process.env.MOCK_POWER = 'ac';
  const reading = await checkCharger({ holdId: 'h-ac', waitMs: 5000 });
  assert.equal(reading.holdId, 'h-ac');
  assert.equal(reading.outcome, 'already_handled');
  assert.equal(reading.detail, 'device_on_AC');
  assertSigned(reading);
});

test('charger on battery, power never arrives: not_delivered', async () => {
  process.env.MOCK_POWER = 'battery';
  const updates = [];
  const reading = await checkCharger({ holdId: 'h-bat', waitMs: 1000, onUpdate: u => updates.push(u) });
  assert.equal(reading.outcome, 'not_delivered');
  assert.equal(reading.detail, 'no_power_before_timeout');
  assert.deepEqual(updates, [{ status: 'waiting_for_power', raw: 'mock:battery' }]);
  assertSigned(reading);
});

test('charger on battery, power arrives mid-wait: delivered', async () => {
  process.env.MOCK_POWER = 'battery';
  const plugIn = setTimeout(() => (process.env.MOCK_POWER = 'ac'), 300);
  const reading = await checkCharger({ holdId: 'h-plug', waitMs: 5000 });
  clearTimeout(plugIn);
  assert.equal(reading.outcome, 'delivered');
  assert.equal(reading.detail, 'charging_verified');
  assert.equal(reading.raw, 'mock:ac');
  assertSigned(reading);
});

test('two holds at once each get their own reading', async () => {
  // Both start on battery; power arrives at 1.5s. The 1s hold has already
  // timed out by then, the 4s hold sees the power on its next poll.
  process.env.MOCK_POWER = 'battery';
  const plugIn = setTimeout(() => (process.env.MOCK_POWER = 'ac'), 1500);
  const [short, long] = await Promise.all([
    checkCharger({ holdId: 'h-short', waitMs: 1000 }),
    checkCharger({ holdId: 'h-long', waitMs: 4000 }),
  ]);
  clearTimeout(plugIn);
  assert.deepEqual([short.holdId, short.outcome], ['h-short', 'not_delivered']);
  assert.deepEqual([long.holdId, long.outcome], ['h-long', 'delivered']);
  assertSigned(short);
  assertSigned(long);
});

test('chargerWaitMs clamps wait_seconds to [0, 240] and falls back on bad input', () => {
  const fallback = 30_000;
  assert.equal(chargerWaitMs(1, fallback), 1000);
  assert.equal(chargerWaitMs(2.5, fallback), 2500);
  assert.equal(chargerWaitMs(0, fallback), 0);
  assert.equal(chargerWaitMs(-5, fallback), 0);
  assert.equal(chargerWaitMs(240, fallback), 240_000);
  assert.equal(chargerWaitMs(10_000, fallback), 240_000);
  assert.equal(chargerWaitMs('5', fallback), 5000);
  assert.equal(chargerWaitMs(' 12 ', fallback), 12_000);
  for (const bad of [undefined, null, '', 'abc', NaN, Infinity, -Infinity, {}, [], true]) {
    assert.equal(chargerWaitMs(bad, fallback), fallback, `input ${String(bad)}`);
  }
});

test('readNetwork and checkHotspot follow VENUE_GATEWAY', async t => {
  delete process.env.VENUE_GATEWAY;
  const unset = await readNetwork();
  assert.equal(unset.onVenue, false);
  const gateway = unset.raw.match(/^gateway=(\S+) venue=unset$/)?.[1];
  assert.ok(gateway, `unexpected raw reading: ${unset.raw}`);
  const off = await checkHotspot({ holdId: 'h-off' });
  assert.deepEqual([off.outcome, off.detail], ['delivered', 'device_off_venue_network']);
  assertSigned(off);

  process.env.VENUE_GATEWAY = '203.0.113.1'; // TEST-NET-3, never a real gateway
  assert.equal((await readNetwork()).onVenue, false);

  if (gateway === 'none') return t.skip('no default route on this machine, cannot test the venue match');
  process.env.VENUE_GATEWAY = gateway;
  const on = await readNetwork();
  assert.deepEqual(on, { onVenue: true, raw: `gateway=${gateway} venue=${gateway}` });
  const handled = await checkHotspot({ holdId: 'h-on' });
  assert.deepEqual([handled.outcome, handled.detail], ['already_handled', 'device_on_venue_network']);
  assertSigned(handled);
});
