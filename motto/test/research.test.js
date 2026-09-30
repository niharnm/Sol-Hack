import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicKey, verify } from 'node:crypto';
const dir=mkdtempSync(join(tmpdir(),'motto-research-'));
process.env.DEVICE_KEY_PATH=join(dir,'device.pem');
const {citationPack,checkResearch,researchRequestError}=await import('../src/research.js');
const {settlementFor}=await import('../src/settlement.js');
after(()=>rmSync(dir,{recursive:true,force:true}));
const items=[1,2,3].map(i=>({DOI:`10.1234/paper-${i}`,title:[`Paper ${i}`],publisher:'Test publisher'}));
test('research rejects missing or oversized topics before payment',()=>{
 for(const query of [undefined,'ab',' ', 'x'.repeat(201)])assert.ok(researchRequestError({query}));
 assert.equal(researchRequestError({query:'research agents'}),undefined);
});
test('citation validation rejects empty titles, invalid DOI and duplicate DOI',()=>{
 assert.equal(citationPack([items[0],items[0],{DOI:'bad',title:['Title']},{DOI:'10.1234/x',title:[]},...items.slice(1)]).length,3);
});
test('complete delivery is signed and earns the rental only after structural validation',async()=>{
 const updates=[];
 const r=await checkResearch({holdId:'research-1',query:'retrieval',onUpdate:e=>updates.push(e.status),fetcher:async()=>({ok:true,json:async()=>({message:{items}})})});
 assert.deepEqual(updates,['fetching','validating']);assert.equal(r.outcome,'delivered');assert.equal(r.deliverable.citations.length,3);assert.equal(settlementFor(r.outcome).charged_usd,'1.00');
 const {signature,devicePublicKey,...payload}=r;
 const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.from(devicePublicKey,'hex')]),format:'der',type:'spki'});
 assert.ok(verify(null,Buffer.from(JSON.stringify(payload)),key,Buffer.from(signature,'hex')));
 payload.deliverable.citations[0].title='Tampered';assert.equal(verify(null,Buffer.from(JSON.stringify(payload)),key,Buffer.from(signature,'hex')),false);
});
test('incomplete or failed provider results charge nothing',async()=>{
 for(const fetcher of [async()=>({ok:true,json:async()=>({message:{items:items.slice(0,1)}})}),async()=>({ok:false,status:503}),async()=>{throw new Error('timeout');}]){
 const r=await checkResearch({holdId:'fail',query:'retrieval',fetcher});assert.equal(r.outcome,'inconclusive');assert.equal(r.checks.passed,false);assert.equal(settlementFor(r.outcome).charged_usd,'0.00');assert.equal(settlementFor(r.outcome).returned_usd,'1.00');}
});
