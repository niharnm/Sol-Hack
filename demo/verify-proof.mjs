// Read-only verification of a completed test-network hold.
import { createPublicKey, verify } from 'node:crypto';
const base = 'http://127.0.0.1:8787';
const get = async path => {
  const response = await fetch(base + path);
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
};
const [{ holds }, terms] = await Promise.all([get('/v1/holds'), get('/v1/terms')]);
if (!['localnet','devnet'].includes(terms.network)) throw new Error('Expected a test-network desk.');
const hold = holds.find(h => h.network===terms.network && ['kept', 'refunded'].includes(h.status) && h.reading?.signature);
if (!hold) throw new Error('No completed signed hold. Run a test payment first.');
const { signature, devicePublicKey, ...payload } = hold.reading;
if (devicePublicKey !== terms.devicePublicKey || payload.holdId !== hold.id) throw new Error('Reading does not match the desk and hold.');
const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(devicePublicKey, 'hex')]), format: 'der', type: 'spki' });
if (!verify(null, Buffer.from(JSON.stringify(payload)), key, Buffer.from(signature, 'hex'))) throw new Error('Invalid reading signature.');
const total = Math.round(Number(hold.charged_usd) * 100) + Math.round(Number(hold.returned_usd) * 100);
if (total !== 100) throw new Error('Amounts do not add up to the $1 hold.');
let chainStatus=null;
if(terms.network==='devnet'){
  if(!hold.settlementTx)throw new Error('No settlement transaction to verify.');
  const rpc=await fetch('https://api.devnet.solana.com',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getSignatureStatuses',params:[[hold.settlementTx],{searchTransactionHistory:true}]}),signal:AbortSignal.timeout(15000)}).then(r=>r.json());
  chainStatus=rpc.result?.value?.[0];
  if(!chainStatus||chainStatus.err||!['confirmed','finalized'].includes(chainStatus.confirmationStatus))throw new Error('Devnet settlement is not confirmed by the public RPC.');
}
console.log(JSON.stringify({hold:hold.id,network:terms.network,device_signature:'VERIFIED',outcome:hold.outcome,charged_usd:hold.charged_usd,returned_usd:hold.returned_usd,settlement_tx:hold.settlementTx??null,chain_status:chainStatus?.confirmationStatus??'Not independently checked'},null,2));
