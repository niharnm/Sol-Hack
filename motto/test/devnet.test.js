import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {devnetSigner,assertDevnet} from '../src/devnet.js';
test('isolated test wallets persist and have private filesystem permissions',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'motto-devnet-'));const previous=process.env.DEVNET_KEYS_DIR;process.env.DEVNET_KEYS_DIR=dir;
  try{const a=await devnetSigner('operator'),again=await devnetSigner('operator'),b=await devnetSigner('buyer');assert.equal(a.address,again.address);assert.notEqual(a.address,b.address);assert.equal(statSync(join(dir,'operator.json')).mode&0o777,0o600);await assert.rejects(devnetSigner('../other'));}
  finally{if(previous===undefined)delete process.env.DEVNET_KEYS_DIR;else process.env.DEVNET_KEYS_DIR=previous;rmSync(dir,{recursive:true});}
});
test('Devnet mode rejects another cluster even when RPC is reachable',async()=>{
  const fetch=globalThis.fetch;
  try{globalThis.fetch=async()=>({ok:true,json:async()=>({result:'mainnet-genesis'})});await assert.rejects(assertDevnet('https://rpc.example'),/not Solana Devnet/);
    globalThis.fetch=async()=>({ok:true,json:async()=>({result:'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'})});await assertDevnet('https://rpc.example');}
  finally{globalThis.fetch=fetch;}
});
