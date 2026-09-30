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

function signReading(reading) {
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

// Charger: already on power -> handled. Otherwise the rental is live and we
// wait up to `waitMs` for the cable to deliver power. Delivered -> keep the
// hold. Never delivered -> refund, the agent paid for nothing.
export async function checkCharger({ holdId, waitMs, onUpdate }) {
  const first = await readPower();
  if (first.onPower) {
    return signReading({ holdId, item: 'charger', outcome: 'already_handled', detail: 'device_on_AC', raw: first.raw, ts: Date.now() });
  }
  onUpdate?.({ status: 'waiting_for_power', raw: first.raw });
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await sleep(1000);
    const now = await readPower();
    if (now.onPower) {
      return signReading({ holdId, item: 'charger', outcome: 'delivered', detail: 'charging_verified', raw: now.raw, ts: Date.now() });
    }
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
