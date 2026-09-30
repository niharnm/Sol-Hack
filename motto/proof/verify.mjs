// Offline check of the recorded sandbox holds in sandbox-holds.json: each device reading is
// signed by the desk's device key, belongs to its hold, charged plus returned equals the hold's
// own hold_usd, and (when the record carries check_fee_usd) the charge matches the outcome.
// Amounts are compared in USDC base units (6 decimals) so sub-cent fees are exact.
//   node motto/proof/verify.mjs
import { createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';

// '3.00' -> 3000000n. Only plain decimal strings with up to 6 places are accepted.
function toBaseUnits(usd) {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(String(usd));
  if (!m) throw new Error(`not a USD amount: ${JSON.stringify(usd)}`);
  return BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? '').padEnd(6, '0'));
}

// What the desk charges for an outcome: delivered charges the hold (the fee for a pure check such
// as verify), already handled and not delivered charge the fee, a failed or inconclusive check is free.
function expectedCharge(hold) {
  const fee = toBaseUnits(hold.check_fee_usd);
  const onDelivered = hold.charge_on_delivered ?? (hold.item === 'verify' ? 'fee' : 'hold');
  switch (hold.outcome) {
    case 'delivered': return onDelivered === 'fee' ? fee : toBaseUnits(hold.hold_usd);
    case 'already_handled':
    case 'not_delivered': return fee;
    case 'check_failed':
    case 'inconclusive': return 0n;
    default: return undefined;
  }
}

const proof = JSON.parse(readFileSync(new URL('./sandbox-holds.json', import.meta.url)));
const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(proof.devicePublicKey, 'hex')]), format: 'der', type: 'spki' });
let failed = 0;
for (const hold of proof.holds) {
  const { signature, devicePublicKey, ...payload } = hold.reading;
  const problems = [];
  if (devicePublicKey !== proof.devicePublicKey) problems.push('reading signed by a different key');
  if (payload.holdId !== hold.id) problems.push('reading belongs to another hold');
  try {
    const charged = toBaseUnits(hold.charged_usd);
    if (charged + toBaseUnits(hold.returned_usd) !== toBaseUnits(hold.hold_usd)) problems.push(`charged plus returned is not the $${hold.hold_usd} hold`);
    if (hold.check_fee_usd !== undefined) {
      const expected = expectedCharge(hold);
      if (expected === undefined) problems.push(`unknown outcome ${hold.outcome}`);
      else if (charged !== expected) problems.push(`outcome ${hold.outcome} should charge ${expected} base units, record charges ${charged}`);
    }
  } catch (error) {
    problems.push(error.message);
  }
  if (!verify(null, Buffer.from(JSON.stringify(payload)), key, Buffer.from(signature, 'hex'))) problems.push('signature does not verify');
  const ok = problems.length === 0;
  if (!ok) failed++;
  console.log(`${ok ? 'VERIFIED' : 'FAILED  '} ${hold.id} ${hold.item} ${hold.outcome} hold $${hold.hold_usd} charged $${hold.charged_usd} returned $${hold.returned_usd} tx ${hold.settlementTx}${ok ? '' : ` (${problems.join('; ')})`}`);
}
const verified = proof.holds.length - failed;
if (proof.holds.length === 0) {
  failed++;
  console.log('FAILED   no holds recorded');
}
console.log(`network: ${proof.network}. ${verified} of ${proof.holds.length} holds verified. Signatures and amounts checked offline; this does not confirm the sandbox transactions.`);
process.exit(failed ? 1 : 0);
