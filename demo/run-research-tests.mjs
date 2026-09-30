// Three real provider requests with test USDC. No mainnet payments or fabricated records.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync } from 'node:fs';
import { createPublicKey, verify } from 'node:crypto';
const run=promisify(execFile);
const base='http://127.0.0.1:8787';
const terms=await fetch(base+'/v1/terms').then(r=>r.json());
if(terms.network!=='localnet')throw new Error('This test runner only supports the sandbox.');
const cases=['machine learning for drug discovery','lithium ion battery recycling','AI safety evaluation'];
const records=[];
for(const query of cases){
  console.log(`Buying research pack: ${query}`);
  const {stdout}=await run('npx',['--yes','--package','@solana/pay','pay','--sandbox','curl','-sS','-X','POST',base+'/v1/rent/research','-H','Content-Type: application/json','-d',JSON.stringify({query})],{timeout:90000,maxBuffer:1024*1024});
  const response=stdout.trim().split('\n').map(line=>{try{return JSON.parse(line);}catch{return null;}}).find(value=>value?.hold_id);
  if(!response)throw new Error('No payment receipt returned. Inspect the desk before retrying.');
  const hold=await fetch(base+'/v1/holds/'+response.hold_id).then(r=>r.json());
  const {signature,devicePublicKey,...payload}=response.signed_reading??{};
  const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.from(devicePublicKey??'','hex')]),format:'der',type:'spki'});
  const signatureValid=verify(null,Buffer.from(JSON.stringify(payload)),key,Buffer.from(signature??'','hex'))&&devicePublicKey===terms.devicePublicKey;
  const stages=(hold.steps??[]).map(s=>s.status);
  const passed=response.decision==='kept'&&payload.checks?.passed===true&&payload.deliverable?.citations?.length===3&&signatureValid&&['checking','fetching','validating','kept'].every(s=>stages.includes(s));
  records.push({query,passed,signature_verified:signatureValid,response,steps:hold.steps});
  console.log(`${passed?'PASS':'FAIL'} · ${response.hold_id} · ${response.decision} · ${stages.join(' → ')}`);
}
writeFileSync(new URL('../motto/proof/research-tests.json',import.meta.url),JSON.stringify({recordedAt:new Date().toISOString(),network:'localnet',note:'Actual sandbox purchases against live Crossref metadata. Payment signatures are API-reported; chain finality was not independently queried.',records},null,2)+'\n');
if(records.some(r=>!r.passed))process.exitCode=1;
