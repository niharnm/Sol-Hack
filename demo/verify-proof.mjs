// Read-only verification of a completed test-network hold.
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
if (!['localnet','devnet'].includes(terms.network)) throw new Error('Expected a test-network desk.');
const hold = holds.find(h => h.network===terms.network && ['kept', 'refunded'].includes(h.status) && h.reading?.signature);
if (!hold) throw new Error('No completed signed hold. Run a test payment first.');
const { signature, devicePublicKey, ...payload } = hold.reading;
if (devicePublicKey !== terms.devicePublicKey || payload.holdId !== hold.id) throw new Error('Reading does not match the desk and hold.');
const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(devicePublicKey, 'hex')]), format: 'der', type: 'spki' });
if (!verify(null, Buffer.from(JSON.stringify(payload)), key, Buffer.from(signature, 'hex'))) throw new Error('Invalid reading signature.');
const holdUsd = hold.hold_usd ?? terms.items?.[hold.item]?.hold_usd;
const charged = toBaseUnits(hold.charged_usd);
if (charged + toBaseUnits(hold.returned_usd) !== toBaseUnits(holdUsd)) throw new Error(`Amounts do not add up to the $${holdUsd} hold.`);
if (hold.check_fee_usd !== undefined) {
  const fee = toBaseUnits(hold.check_fee_usd);
  const onDelivered = hold.charge_on_delivered ?? (hold.item === 'verify' ? 'fee' : 'hold');
  const expected = { delivered: onDelivered === 'fee' ? fee : toBaseUnits(holdUsd), already_handled: fee, not_delivered: fee, check_failed: 0n, inconclusive: 0n }[hold.outcome];
  if (expected === undefined) throw new Error(`Unknown outcome ${hold.outcome}.`);
  if (charged !== expected) throw new Error(`Outcome ${hold.outcome} should charge ${expected} base units, the hold charged ${charged}.`);
}
let chainStatus=null;
if(terms.network==='devnet'){
  if(!hold.settlementTx)throw new Error('No settlement transaction to verify.');
  const rpc=await fetch('https://api.devnet.solana.com',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getSignatureStatuses',params:[[hold.settlementTx],{searchTransactionHistory:true}]}),signal:AbortSignal.timeout(15000)}).then(r=>r.json());
  chainStatus=rpc.result?.value?.[0];
  if(!chainStatus||chainStatus.err||!['confirmed','finalized'].includes(chainStatus.confirmationStatus))throw new Error('Devnet settlement is not confirmed by the public RPC.');
}
console.log(JSON.stringify({ hold: hold.id, network: terms.network, device_signature: 'VERIFIED', outcome: hold.outcome, hold_usd: holdUsd, charged_usd: hold.charged_usd, returned_usd: hold.returned_usd, settlement_tx: hold.settlementTx ?? null, chain_status: chainStatus?.confirmationStatus ?? 'Not independently checked' }, null, 2));
