import { devnetSigner, devnetRpc, assertDevnet, DEVNET_RPC, DEVNET_USDC } from '../src/devnet.js';
const rpc=process.env.RPC_URL || DEVNET_RPC;
await assertDevnet(rpc);
for(const role of ['operator','buyer']) {
  const signer=await devnetSigner(role);
  let balance=await devnetRpc('getBalance',[signer.address],rpc);
  if(process.argv.includes('--airdrop')&&balance.value<10000000) {
    try {console.log(role,'airdrop requested:',await devnetRpc('requestAirdrop',[signer.address,1000000000],rpc));}
    catch(error){console.log(role,'airdrop unavailable:',error.message);}
    balance=await devnetRpc('getBalance',[signer.address],rpc);
  }
  const tokens=await devnetRpc('getTokenAccountsByOwner',[signer.address,{mint:DEVNET_USDC},{encoding:'jsonParsed'}],rpc);
  const usdc=tokens.value.reduce((sum,a)=>sum+Number(a.account.data.parsed.info.tokenAmount.amount)/1e6,0);
  console.log(JSON.stringify({network:'devnet',role,address:signer.address,sol:balance.value/1e9,usdc}));
}
console.log('Fund operator with Devnet SOL; fund buyer with Devnet USDC and SOL. Never send real funds to these test wallets.');
