import {devnetPurchase, DEVNET_RPC} from '../src/devnet.js';
const query=process.argv[2];
if(!query||query.trim().length<3||query.length>200)throw new Error('Usage: npm run buy:devnet -- "research topic" [desk URL]');
const desk=process.argv[3] ?? 'http://127.0.0.1:8787';
const terms=await fetch(new URL('/v1/terms',desk)).then(r=>r.json());
if(terms.network!=='devnet')throw new Error('This buyer only supports a Devnet desk.');
try{console.log(JSON.stringify(await devnetPurchase({query,desk,rpcUrl:process.env.RPC_URL||DEVNET_RPC}),null,2));}
catch(error){console.error(error.message);process.exitCode=1;}
