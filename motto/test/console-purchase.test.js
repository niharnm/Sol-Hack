import test from 'node:test';
import assert from 'node:assert/strict';
import { consolePurchase } from '../src/console-purchase.js';
function request(overrides={}) { return {socket:{remoteAddress:'127.0.0.1'},headers:{host:'localhost:8787','x-motto-console':'1',origin:'http://localhost:8787'},body:{query:'battery recycling'},...overrides}; }
function response(){return {code:200,status(code){this.code=code;return this;},json(value){this.body=value;return this;}};}
test('console buyer rejects mainnet, remote, forwarded and cross-origin requests without spawning',async()=>{
  for(const [network,req] of [['mainnet',request()],['localnet',request({socket:{remoteAddress:'10.0.0.2'}})],['localnet',request({headers:{host:'localhost:8787','x-forwarded-host':'public.example','x-motto-console':'1'}})],['localnet',request({headers:{host:'localhost:8787',origin:'https://evil.example','x-motto-console':'1'}})],['localnet',request({headers:{host:'localhost:8787'}})]]){
    const res=response();await consolePurchase({network,port:8787,run:()=>assert.fail('must not spawn')})(req,res);assert.equal(res.code,403);
  }
});
test('console validates topic before spending',async()=>{const res=response();await consolePurchase({network:'localnet',port:8787,run:()=>assert.fail('must not spawn')})(request({body:{query:''}}),res);assert.equal(res.code,400);});
test('console passes user input as one JSON argument, to fixed test-network endpoint',async()=>{
  const query="$(touch /tmp/nope); ' & batteries";
  const res=response();await consolePurchase({network:'localnet',port:8787,run:async(file,args)=>{
    assert.equal(file,'npx');assert.ok(args.includes('--sandbox'));assert.ok(args.includes('http://127.0.0.1:8787/v1/rent/research'));assert.deepEqual(JSON.parse(args.at(-1)),{query});return {stdout:'{"hold_id":"abc"}'};
  }})(request({body:{query}}),res);assert.equal(res.body.hold_id,'abc');
});
test('console serializes purchases and releases its lock after errors',async()=>{
  let finish;const handler=consolePurchase({network:'localnet',port:8787,run:()=>new Promise(resolve=>finish=resolve)});
  const first=response(),second=response();const pending=handler(request(),first);await handler(request(),second);assert.equal(second.code,409);
  finish({stdout:'invalid'});await pending;assert.equal(first.code,502);
  const third=response();const next=handler(request(),third);finish({stdout:'{"hold_id":"ok"}'});await next;assert.equal(third.code,200);
});
