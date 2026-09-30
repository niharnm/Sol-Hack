// Read-only verification of the newest completed sandbox hold.
import { createPublicKey, verify } from 'node:crypto';
const base = 'http://127.0.0.1:8787';
const get = async path => {
  const response = await fetch(base + path);
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
};
// '3.00' -> 3000000n (USDC has 6 decimals), so sub-cent fees compare exactly.
const toBaseUnits = usd => {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(String(usd));
  if (!m) throw new Error(`Not a USD amount: ${JSON.stringify(usd)}.`);
  return BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? '').padEnd(6, '0'));
};
const [{ holds }, terms] = await Promise.all([get('/v1/holds'), get('/v1/terms')]);
if (terms.network !== 'localnet') throw new Error('Expected the sandbox desk.');
const hold = holds.find(h => ['kept', 'refunded'].includes(h.status) && h.reading?.signature);
if (!hold) throw new Error('No completed signed hold. Run the sandbox payment first.');
const { signature, devicePublicKey, ...payload } = hold.reading;
if (devicePublicKey !== terms.devicePublicKey || payload.holdId !== hold.id) throw new Error('Reading does not match the desk and hold.');
const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(devicePublicKey, 'hex')]), format: 'der', type: 'spki' });
if (!verify(null, Buffer.from(JSON.stringify(payload)), key, Buffer.from(signature, 'hex'))) throw new Error('Invalid reading signature.');
const holdUsd = hold.hold_usd ?? terms.items?.[hold.item]?.hold_usd;
const charged = toBaseUnits(hold.charged_usd);
if (charged + toBaseUnits(hold.returned_usd) !== toBaseUnits(holdUsd)) throw new Error(`Amounts do not add up to the $${holdUsd} hold.`);
// Charge matches the outcome, when the record says what the fee was: delivered charges the hold (the
// fee for a pure check such as verify), already handled and not delivered charge the fee, the rest nothing.
if (hold.check_fee_usd !== undefined) {
  const fee = toBaseUnits(hold.check_fee_usd);
  const onDelivered = hold.charge_on_delivered ?? (hold.item === 'verify' ? 'fee' : 'hold');
  const expected = { delivered: onDelivered === 'fee' ? fee : toBaseUnits(holdUsd), already_handled: fee, not_delivered: fee, check_failed: 0n, inconclusive: 0n }[hold.outcome];
  if (expected === undefined) throw new Error(`Unknown outcome ${hold.outcome}.`);
  if (charged !== expected) throw new Error(`Outcome ${hold.outcome} should charge ${expected} base units, the hold charged ${charged}.`);
}
console.log(JSON.stringify({ hold: hold.id, network: terms.network, device_signature: 'VERIFIED', outcome: hold.outcome, hold_usd: holdUsd, charged_usd: hold.charged_usd, returned_usd: hold.returned_usd, settlement_tx: hold.settlementTx ?? null, note: 'Signature and amounts verified locally. Settlement signature is reported by the API; this script does not independently confirm chain finality.' }, null, 2));
