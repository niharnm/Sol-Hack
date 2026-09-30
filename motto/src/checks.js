// Device checks for the desk. Each check answers one question:
// "is this need already handled?" and returns a signed reading.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { generateKeyPairSync, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const run = promisify(execFile);
const KEY_PATH = resolve(process.env.DEVICE_KEY_PATH ?? 'keys/device.pem');

function loadDeviceKey() {
  if (!existsSync(KEY_PATH)) {
    mkdirSync(dirname(KEY_PATH), { recursive: true });
    const { privateKey } = generateKeyPairSync('ed25519');
    writeFileSync(KEY_PATH, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  }
  const privateKey = createPrivateKey(readFileSync(KEY_PATH));
  const publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).subarray(-32);
  return { privateKey, publicKeyHex: publicKey.toString('hex') };
}

const device = loadDeviceKey();
export const devicePublicKey = device.publicKeyHex;

export function signReading(reading) {
  const payload = JSON.stringify(reading);
  const signature = sign(null, Buffer.from(payload), device.privateKey).toString('hex');
  return { ...reading, signature, devicePublicKey };
}

// Power: macOS reports the source on the first line of `pmset -g ps`,
// e.g. "Now drawing from 'AC Power'" or "Now drawing from 'Battery Power'".
export async function readPower() {
  if (process.env.MOCK_POWER) return { onPower: process.env.MOCK_POWER === 'ac', raw: `mock:${process.env.MOCK_POWER}` };
  const { stdout } = await run('pmset', ['-g', 'ps']);
  const raw = stdout.split('\n').slice(0, 2).join(' | ').trim();
  return { onPower: stdout.split('\n')[0].includes("'AC Power'"), raw };
}

// Network: "already handled" means the device is on the venue network.
// SSIDs are redacted on recent macOS without location permission, so the
// venue is identified by its default gateway (VENUE_GATEWAY).
export async function readNetwork() {
  const venue = process.env.VENUE_GATEWAY;
  let gateway = 'none';
  try {
    const { stdout } = await run('route', ['-n', 'get', 'default']);
    gateway = stdout.match(/gateway:\s*(\S+)/)?.[1] ?? 'none';
  } catch {
    // No default route means no connectivity at all.
  }
  return { onVenue: Boolean(venue) && gateway === venue, raw: `gateway=${gateway} venue=${venue ?? 'unset'}` };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Poll `read` once a second until `done(reading)` or the deadline. Returns the
// reading that satisfied it, or undefined on timeout.
async function waitFor(read, done, waitMs) {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await sleep(1000);
    const now = await read();
    if (done(now)) return now;
  }
  return undefined;
}

// A numeric request parameter (number or numeric string) clamped to [min, max], or the fallback.
export function numberIn(value, min, max, fallback) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

// The agent picks the charger wait window, but it has to end well inside the
// x402 offer's maxTimeoutSeconds (300) so the hold can still settle. Anything
// that is not a finite number (or a numeric string) gets the desk default.
const MAX_WAIT_SECONDS = 240;
export function chargerWaitMs(waitSeconds, fallbackMs) {
  const seconds = numberIn(waitSeconds, 0, MAX_WAIT_SECONDS, undefined);
  return seconds === undefined ? fallbackMs : seconds * 1000;
}

// Charger: already on power -> handled. Otherwise the rental is live and we
// wait up to `waitMs` for the cable to deliver power. Delivered -> keep the
// hold. Never delivered -> refund, the agent paid for nothing.
export async function checkCharger({ holdId, waitMs, onUpdate }) {
  const first = await readPower();
  if (first.onPower) {
    return signReading({ holdId, item: 'charger', outcome: 'already_handled', detail: 'device_on_AC', raw: first.raw, ts: Date.now() });
  }
  onUpdate?.({ status: 'waiting_for_power', raw: first.raw });
  const now = await waitFor(readPower, r => r.onPower, waitMs);
  if (now) {
    return signReading({ holdId, item: 'charger', outcome: 'delivered', detail: 'charging_verified', raw: now.raw, ts: Date.now() });
  }
  return signReading({ holdId, item: 'charger', outcome: 'not_delivered', detail: 'no_power_before_timeout', raw: first.raw, ts: Date.now() });
}

// Hotspot: on the venue network -> handled. Otherwise the device genuinely
// needs connectivity and the rental is real.
export async function checkHotspot({ holdId }) {
  const net = await readNetwork();
  return signReading({
    holdId,
    item: 'hotspot',
    outcome: net.onVenue ? 'already_handled' : 'delivered',
    detail: net.onVenue ? 'device_on_venue_network' : 'device_off_venue_network',
    raw: net.raw,
    ts: Date.now(),
  });
}

// Battery: `pmset -g batt` gives the source on line one and the charge on line two,
// e.g. "-InternalBattery-0 (id=...)	64%; discharging; 3:10 remaining present: true".
export async function readBattery() {
  if (process.env.MOCK_BATTERY) {
    const mock = process.env.MOCK_BATTERY;
    return { onPower: mock === 'ac', percent: mock === 'ac' ? 100 : Number(mock), raw: `mock:${mock}` };
  }
  const { stdout } = await run('pmset', ['-g', 'batt']);
  const lines = stdout.split('\n');
  const percent = Number(stdout.match(/(\d+)%/)?.[1] ?? NaN);
  if (!Number.isFinite(percent)) throw new Error('no battery reading from pmset');
  return { onPower: lines[0].includes("'AC Power'"), percent, raw: lines.slice(0, 2).join(' | ').replace(/\s+/g, ' ').trim() };
}

// Battery pack: the device is on AC, or has at least `minPercent` charge -> handled.
// Otherwise the battery really will not last and the pack rental is kept.
export async function checkBatteryPack({ holdId, minPercent }) {
  const batt = await readBattery();
  const handled = batt.onPower || batt.percent >= minPercent;
  return signReading({
    holdId,
    item: 'battery_pack',
    outcome: handled ? 'already_handled' : 'delivered',
    detail: batt.onPower ? 'device_on_AC' : handled ? `battery_${batt.percent}pct_at_least_${minPercent}` : `battery_${batt.percent}pct_below_${minPercent}`,
    raw: batt.raw,
    ts: Date.now(),
  });
}

// Storage: free space on the volume the job writes to (STORAGE_PATH, default /), from `df -k`.
export async function readDisk() {
  if (process.env.MOCK_FREE_GB) return { freeGb: Number(process.env.MOCK_FREE_GB), raw: `mock:${process.env.MOCK_FREE_GB}GB` };
  const path = process.env.STORAGE_PATH ?? '/';
  const { stdout } = await run('df', ['-k', path]);
  const cols = stdout.trim().split('\n').at(-1).split(/\s+/);
  const availKb = Number(cols[3]);
  if (!Number.isFinite(availKb)) throw new Error('no free space reading from df');
  const freeGb = Math.round((availKb * 1024) / 1e8) / 10;
  return { freeGb, raw: `path=${path} free_gb=${freeGb}` };
}

// Cloud storage: enough free disk for the job already -> handled. Otherwise the
// job really needs the space and the storage rental is kept.
export async function checkStorage({ holdId, neededGb }) {
  const disk = await readDisk();
  const handled = disk.freeGb >= neededGb;
  return signReading({
    holdId,
    item: 'storage',
    outcome: handled ? 'already_handled' : 'delivered',
    detail: handled ? `free_${disk.freeGb}gb_covers_${neededGb}gb` : `free_${disk.freeGb}gb_short_of_${neededGb}gb`,
    raw: disk.raw,
    ts: Date.now(),
  });
}

// Displays: `system_profiler SPDisplaysDataType -json`. Anything not marked internal is external.
export async function readDisplays() {
  if (process.env.MOCK_DISPLAY) return { external: process.env.MOCK_DISPLAY === 'external', raw: `mock:${process.env.MOCK_DISPLAY}` };
  const { stdout } = await run('system_profiler', ['SPDisplaysDataType', '-json'], { timeout: 10_000 });
  const screens = JSON.parse(stdout).SPDisplaysDataType?.flatMap(gpu => gpu.spdisplays_ndrvs ?? []) ?? [];
  const external = screens.filter(d => d.spdisplays_connection_type !== 'spdisplays_internal');
  return { external: external.length > 0, raw: `displays=${screens.length} external=${external.map(d => d._name).join(',') || 'none'}` };
}

// External display: one already connected -> handled. Otherwise the rental is live
// and we wait up to `waitMs` for a monitor to show up, like the charger.
export async function checkDisplay({ holdId, waitMs, onUpdate }) {
  const first = await readDisplays();
  if (first.external) {
    return signReading({ holdId, item: 'display', outcome: 'already_handled', detail: 'external_display_connected', raw: first.raw, ts: Date.now() });
  }
  onUpdate?.({ status: 'waiting_for_delivery', raw: first.raw });
  const now = await waitFor(readDisplays, r => r.external, waitMs);
  if (now) {
    return signReading({ holdId, item: 'display', outcome: 'delivered', detail: 'display_connected', raw: now.raw, ts: Date.now() });
  }
  return signReading({ holdId, item: 'display', outcome: 'not_delivered', detail: 'no_display_before_timeout', raw: first.raw, ts: Date.now() });
}
