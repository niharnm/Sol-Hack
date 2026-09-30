// Offline check of the recorded sandbox holds in sandbox-holds.json: each device reading is
// signed by the desk's device key, belongs to its hold, and the amounts add up to the $1 hold.
//   node proof/verify.mjs
import { createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';

const proof = JSON.parse(readFileSync(new URL('./sandbox-holds.json', import.meta.url)));
const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(proof.devicePublicKey, 'hex')]), format: 'der', type: 'spki' });
let failed = 0;
for (const hold of proof.holds) {
  const { signature, devicePublicKey, ...payload } = hold.reading;
  const cents = Math.round(Number(hold.charged_usd) * 100) + Math.round(Number(hold.returned_usd) * 100);
  const ok = devicePublicKey === proof.devicePublicKey && payload.holdId === hold.id && cents === 100
    && verify(null, Buffer.from(JSON.stringify(payload)), key, Buffer.from(signature, 'hex'));
  if (!ok) failed++;
  console.log(`${ok ? 'VERIFIED' : 'FAILED  '} ${hold.id} ${hold.item} ${hold.outcome} charged $${hold.charged_usd} returned $${hold.returned_usd} tx ${hold.settlementTx}`);
}
console.log(`network: ${proof.network}. Signatures and amounts checked offline; this does not confirm the sandbox transactions.`);
process.exit(failed ? 1 : 0);
