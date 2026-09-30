// Read-only verification of the newest completed sandbox hold.
import { createPublicKey, verify } from 'node:crypto';
const base = 'http://127.0.0.1:8787';
const get = async path => {
  const response = await fetch(base + path);
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
};
const [{ holds }, terms] = await Promise.all([get('/v1/holds'), get('/v1/terms')]);
if (terms.network !== 'localnet') throw new Error('Expected the sandbox desk.');
const hold = holds.find(h => ['kept', 'refunded'].includes(h.status) && h.reading?.signature);
if (!hold) throw new Error('No completed signed hold. Run the sandbox payment first.');
const { signature, devicePublicKey, ...payload } = hold.reading;
if (devicePublicKey !== terms.devicePublicKey || payload.holdId !== hold.id) throw new Error('Reading does not match the desk and hold.');
const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(devicePublicKey, 'hex')]), format: 'der', type: 'spki' });
if (!verify(null, Buffer.from(JSON.stringify(payload)), key, Buffer.from(signature, 'hex'))) throw new Error('Invalid reading signature.');
const total = Math.round(Number(hold.charged_usd) * 100) + Math.round(Number(hold.returned_usd) * 100);
if (total !== 100) throw new Error('Amounts do not add up to the $1 hold.');
console.log(JSON.stringify({ hold: hold.id, network: terms.network, device_signature: 'VERIFIED', outcome: hold.outcome, charged_usd: hold.charged_usd, returned_usd: hold.returned_usd, settlement_tx: hold.settlementTx ?? null, note: 'Signature and amounts verified locally. Settlement signature is reported by the API; this script does not independently confirm chain finality.' }, null, 2));
