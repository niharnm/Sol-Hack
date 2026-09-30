import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createKeyPairSignerFromBytes } from '@solana/kit';
import { createPayKitClient, ClientPermissions, usd } from '@solana/pay-kit/client';

export const DEVNET_RPC = 'https://api.devnet.solana.com';
export const DEVNET_USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
export async function devnetSigner(role) {
  if (!['operator', 'buyer'].includes(role)) throw new Error('Unknown wallet role');
  const directory = process.env.DEVNET_KEYS_DIR ?? 'keys/devnet';
  const path = `${directory}/${role}.json`;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { readFileSync(path); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const bytes = Buffer.concat([privateKey.export({format:'der',type:'pkcs8'}).subarray(-32), publicKey.export({format:'der',type:'spki'}).subarray(-32)]);
    try { writeFileSync(path, JSON.stringify([...bytes]), {flag:'wx', mode:0o600}); } catch (error) { if(error.code!=='EEXIST')throw error; }
  }
  return createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(path,'utf8'))));
}
export async function devnetRpc(method, params = [], rpcUrl = DEVNET_RPC) {
  const response=await fetch(rpcUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new Error(`Devnet RPC HTTP ${response.status}`);
  const body=await response.json();if(body.error)throw new Error(body.error.message);return body.result;
}
export async function assertDevnet(rpcUrl) {
  const genesis=await devnetRpc('getGenesisHash',[],rpcUrl);
  if(genesis!=='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG')throw new Error('Refusing Devnet mode: RPC is not Solana Devnet.');
}
export async function devnetPurchase({query,port,desk,rpcUrl=DEVNET_RPC}) {
  const origin=new URL(desk ?? `http://127.0.0.1:${port}`).origin;
  if(!/^https?:/.test(origin))throw new Error('Desk must use HTTP or HTTPS');
  await assertDevnet(rpcUrl);
  const signer=await devnetSigner('buyer');
  const tokens=await devnetRpc('getTokenAccountsByOwner',[signer.address,{mint:DEVNET_USDC},{encoding:'jsonParsed'}],rpcUrl);
  const balance=tokens.value.reduce((sum,a)=>sum+BigInt(a.account.data.parsed.info.tokenAmount.amount),0n);
  if(balance<1000000n){const error=new Error(`Devnet buyer needs at least 1 test USDC: ${signer.address}. Fund it at faucet.circle.com (Solana Devnet).`);error.code='DEVNET_FUNDING';throw error;}
  const client=await createPayKitClient({network:'devnet',rpcUrl,signer,accept:['x402'],
    permissions:ClientPermissions.builder().onlyNetwork('devnet').allowOrigin(origin).maxAmountPerPayment(usd('1.00')).build()});
  const response=await client.fetch(`${origin}/v1/buy/research`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query}),signal:AbortSignal.timeout(90000)});
  const receipt=await response.json();
  if(!response.ok||!receipt.hold_id)throw new Error('Devnet purchase did not return a receipt. Check wallet funding and existing requests before retrying.');
  return receipt;
}
