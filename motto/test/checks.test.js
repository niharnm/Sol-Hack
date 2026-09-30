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
const { chargerWaitMs, checkBatteryPack, checkCharger, checkDisplay, checkHotspot, checkStorage, devicePublicKey, numberIn, readNetwork, readPower } =
  await import('../src/checks.js');
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

test('battery pack: AC or enough charge is handled, low charge is a real need', async t => {
  t.after(() => delete process.env.MOCK_BATTERY);
  process.env.MOCK_BATTERY = 'ac';
  const onAc = await checkBatteryPack({ holdId: 'b1', minPercent: 50 });
  assert.deepEqual([onAc.outcome, onAc.detail], ['already_handled', 'device_on_AC']);
  assertSigned(onAc);
  process.env.MOCK_BATTERY = '64';
  assert.equal((await checkBatteryPack({ holdId: 'b2', minPercent: 50 })).outcome, 'already_handled');
  process.env.MOCK_BATTERY = '18';
  const low = await checkBatteryPack({ holdId: 'b3', minPercent: 50 });
  assert.deepEqual([low.outcome, low.detail], ['delivered', 'battery_18pct_below_50']);
  assertSigned(low);
});

test('storage: enough free disk is handled, too little is a real need', async t => {
  t.after(() => delete process.env.MOCK_FREE_GB);
  process.env.MOCK_FREE_GB = '120';
  const plenty = await checkStorage({ holdId: 's1', neededGb: 50 });
  assert.deepEqual([plenty.outcome, plenty.detail], ['already_handled', 'free_120gb_covers_50gb']);
  process.env.MOCK_FREE_GB = '3.5';
  const short = await checkStorage({ holdId: 's2', neededGb: 50 });
  assert.deepEqual([short.outcome, short.detail], ['delivered', 'free_3.5gb_short_of_50gb']);
  assertSigned(short);
});

test('display: connected is handled, connected mid-wait is delivered, never is not_delivered', async t => {
  t.after(() => delete process.env.MOCK_DISPLAY);
  process.env.MOCK_DISPLAY = 'external';
  assert.equal((await checkDisplay({ holdId: 'd1', waitMs: 0 })).outcome, 'already_handled');
  process.env.MOCK_DISPLAY = 'internal';
  const updates = [];
  const never = await checkDisplay({ holdId: 'd2', waitMs: 1200, onUpdate: u => updates.push(u.status) });
  assert.deepEqual([never.outcome, updates], ['not_delivered', ['waiting_for_delivery']]);
  setTimeout(() => (process.env.MOCK_DISPLAY = 'external'), 300);
  const plugged = await checkDisplay({ holdId: 'd3', waitMs: 5000 });
  assert.deepEqual([plugged.outcome, plugged.detail], ['delivered', 'display_connected']);
  assertSigned(plugged);
});

test('numberIn clamps numeric params and falls back on bad input', () => {
  assert.equal(numberIn(30, 1, 100, 50), 30);
  assert.equal(numberIn('150', 1, 100, 50), 100);
  assert.equal(numberIn(-5, 1, 100, 50), 1);
  for (const bad of [undefined, null, '', 'abc', NaN, Infinity, {}, [5]]) assert.equal(numberIn(bad, 1, 100, 50), 50);
});

test('real device readers return a reading on this Mac', { skip: process.platform !== 'darwin' }, async () => {
  const { readBattery, readDisk, readDisplays } = await import('../src/checks.js');
  assert.ok(Number.isFinite((await readBattery()).percent));
  assert.ok((await readDisk()).freeGb > 0);
  assert.equal(typeof (await readDisplays()).external, 'boolean');
});
