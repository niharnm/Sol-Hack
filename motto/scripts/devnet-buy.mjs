import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { buyerOptions } from '../buyer/buy.js';
import { devnetPurchase, DEVNET_RPC } from '../src/devnet.js';

export async function runDevnetBuyer(args = process.argv.slice(2), env = process.env) {
  let options;
  if (args.some(arg => arg === '--quote-id' || arg.startsWith('--quote-id='))) {
    const { values } = parseArgs({ args, options: { 'quote-id': { type: 'string' }, desk: { type: 'string', default: env.DESK_URL ?? 'http://127.0.0.1:8787' }, 'max-spend': { type: 'string' } } });
    options = { quoteId: values['quote-id'], desk: values.desk, maxSpendUsd: values['max-spend'], apiKey: env.MOTTO_API_KEY };
  } else {
    const selected = buyerOptions(args, env);
    if (selected.network !== 'localnet') throw new Error('The Devnet buyer does not accept --mainnet');
    options = { desk: selected.desk, input: selected.input, maxSpendUsd: selected.maxSpend, apiKey: selected.apiKey };
  }
  const purchase = await devnetPurchase({ ...options, rpcUrl: env.RPC_URL ?? DEVNET_RPC }, {
    onRequest: request => console.error(JSON.stringify({ payment_request: request })),
  });
  console.log(JSON.stringify(purchase, null, 2));
  return purchase;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await runDevnetBuyer(); }
  catch (error) {
    console.error(error.message.replaceAll(process.env.MOTTO_API_KEY || '\0', '[redacted]'));
    process.exitCode = 1;
  }
}
