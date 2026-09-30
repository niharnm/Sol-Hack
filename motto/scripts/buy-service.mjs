import { runDevnetBuyer } from './devnet-buy.mjs';

try { await runDevnetBuyer(); }
catch (error) {
  console.error(error.message.replaceAll(process.env.MOTTO_API_KEY || '\0', '[redacted]'));
  process.exitCode = 1;
}
