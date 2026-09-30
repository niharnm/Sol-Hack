// Run from motto/: node scripts/buy-service.mjs charger '{}' https://your-desk 3.00
// Uses only a local Devnet buyer with an exact-origin, reviewed per-payment limit.
import {randomUUID} from 'node:crypto';
import {createPayKitClient, ClientPermissions, usd} from '@solana/pay-kit/client';
import {assertDevnet, devnetSigner, DEVNET_RPC} from '../src/devnet.js';

const [item, payload, desk, reviewedCeiling, requestKey=randomUUID()]=process.argv.slice(2);
try {
  if(!item || !payload || !desk || !reviewedCeiling)throw new Error('Usage: node scripts/buy-service.mjs <service> <JSON body> <desk URL> <reviewed ceiling USD> [request key]');
  const body=JSON.parse(payload), origin=new URL(desk).origin;
  if(!['http:','https:'].includes(new URL(origin).protocol))throw new Error('Desk must use HTTP or HTTPS.');
  if(!body || Array.isArray(body) || typeof body!=='object')throw new Error('The request body must be a JSON object.');
  const response=await fetch(new URL('/v1/terms',origin),{signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new Error('Unable to read the desk terms.');
  const terms=await response.json(), contract=terms.items?.[item];
  if(terms.network!=='devnet')throw new Error('This buyer only supports Solana Devnet.');
  if(!Object.hasOwn(terms.items??{},item) || !/^[a-z_]+$/.test(item))throw new Error('Unknown service.');
  const ceiling=Number(contract.hold_usd);
  if(!/^\d+(?:\.\d{1,2})?$/.test(reviewedCeiling)||!Number.isFinite(ceiling)||ceiling<=0||ceiling!==Number(reviewedCeiling))throw new Error('Service price changed or ceiling is invalid. Review the current terms before buying.');
  if(!/^[a-zA-Z0-9-]{1,128}$/.test(requestKey))throw new Error('Invalid request key.');
  const rpcUrl=process.env.RPC_URL||DEVNET_RPC;
  await assertDevnet(rpcUrl);
  const signer=await devnetSigner('buyer');
  const client=await createPayKitClient({network:'devnet',rpcUrl,signer,accept:['x402'],
    permissions:ClientPermissions.builder().onlyNetwork('devnet').allowOrigin(origin).maxAmountPerPayment(usd(reviewedCeiling)).build()});
  const purchase=await client.fetch(`${origin}/v1/rent/${item}`,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':requestKey},body:JSON.stringify(body),signal:AbortSignal.timeout(300000)});
  const receipt=await purchase.json();
  if(!purchase.ok||!receipt.hold_id)throw new Error('No purchase receipt returned. Inspect existing holds before retrying.');
  console.log(JSON.stringify(receipt,null,2));
  if(receipt.decision==='settle_failed')console.error('Payment unconfirmed. Inspect this hold before retrying: the server may create another hold even with the same request key.');
}catch(error){console.error(error.message);process.exitCode=1;}
