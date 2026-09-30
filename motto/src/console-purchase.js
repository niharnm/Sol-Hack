import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { researchRequestError } from './research.js';
const exec = promisify(execFile);

// Only the local console can spend this machine's test wallet. Never forwards to mainnet.
export function localConsole(req, network, port) {
  return network === 'localnet'
    && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)
    && [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(req.headers.host)
    && !req.headers['x-forwarded-host'] && !req.headers['x-forwarded-for'];
}
export function consolePurchase({ network, port, run = exec }) {
  let busy = false;
  return async (req, res) => {
    if (!localConsole(req, network, port) || req.headers['x-motto-console'] !== '1')
      return res.status(403).json({ error: 'Open the console on the hosting laptop at localhost to run a test purchase. Remote buyers use the paid API.' });
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`)
      return res.status(403).json({ error: 'Origin not allowed' });
    const invalid = researchRequestError(req.body);
    if (invalid) return res.status(400).json({ error: invalid });
    if (busy) return res.status(409).json({ error: 'A purchase is already running. Wait for its receipt.' });
    busy = true;
    try {
      const { stdout } = await run('npx', ['--yes', '--package', '@solana/pay', 'pay', '--sandbox', 'curl', '-sS', '-X', 'POST',
        `http://127.0.0.1:${port}/v1/rent/research`, '-H', 'Content-Type: application/json', '-d', JSON.stringify({ query: req.body.query.trim() })],
        { timeout: 90000, maxBuffer: 1024 * 1024 });
      const receipt = JSON.parse(stdout);
      if (!receipt.hold_id) throw new Error('No receipt');
      res.json(receipt);
    } catch {
      res.status(502).json({ error: 'The buyer did not return a receipt. Check recent requests before retrying; the purchase may have reached the server.' });
    } finally { busy = false; }
  };
}
