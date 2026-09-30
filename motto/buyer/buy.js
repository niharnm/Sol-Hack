import { spawn } from 'node:child_process';
import { createPublicKey, randomUUID, verify } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { formatUsd, toBaseUnits } from '../src/settlement.js';

export function buyerOptions(args, env = process.env) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    desk: { type: 'string', default: env.DESK_URL ?? 'http://127.0.0.1:8787' },
    query: { type: 'string' }, count: { type: 'string', default: '3' },
    'max-spend': { type: 'string' }, mainnet: { type: 'boolean', default: false },
    'required-term': { type: 'string', multiple: true },
    'from-year': { type: 'string' }, 'to-year': { type: 'string' },
  } });
  if (!values['max-spend'] || values['max-spend'].length > 32 || !/^\d+(?:\.\d{1,6})?$/.test(values['max-spend']) || toBaseUnits(values['max-spend']) <= 0n) {
    throw new Error('--max-spend is required and must be a positive USD decimal with at most six decimal places');
  }
  if (values.query && positionals.length) throw new Error('Use --query or a positional query, not both');
  const query = (values.query ?? positionals.join(' ')).trim();
  if (query.length < 3 || query.length > 200 || /[\u0000-\u001f\u007f]/.test(query)) throw new Error('A query of 3 to 200 characters is required');
  if (!/^\d+$/.test(values.count) || Number(values.count) < 1 || Number(values.count) > 20) {
    throw new Error('--count must be an integer from 1 to 20');
  }
  const deskUrl = new URL(values.desk);
  if (deskUrl.username || deskUrl.password || deskUrl.search || deskUrl.hash || deskUrl.pathname !== '/') {
    throw new Error('--desk must be an HTTP(S) origin without credentials, a path, query, or fragment');
  }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(deskUrl.hostname);
  if (deskUrl.protocol !== 'https:' && !(local && deskUrl.protocol === 'http:')) {
    throw new Error('--desk must use HTTPS, except for a local HTTP server');
  }
  if (!local && !env.MOTTO_API_KEY) throw new Error('Set MOTTO_API_KEY for a remote desk');
  const terms = values['required-term'] ?? [];
  if (terms.length > 5 || terms.some(term => !term.trim() || term.length > 100 || /[\u0000-\u001f\u007f]/.test(term))) {
    throw new Error('--required-term accepts up to five nonempty terms of at most 100 characters');
  }
  const input = { query, count: Number(values.count), required_terms: [...new Set(terms.map(term => term.trim().toLowerCase()))] };
  for (const option of ['from-year', 'to-year']) {
    if (values[option] !== undefined) {
      if (!/^\d{4}$/.test(values[option]) || Number(values[option]) < 1000) throw new Error(`--${option} must be a four-digit year`);
      input[option.replace('-', '_')] = Number(values[option]);
    }
  }
  if (input.from_year && input.to_year && input.from_year > input.to_year) throw new Error('--from-year must not exceed --to-year');
  return { desk: deskUrl.origin, network: values.mainnet ? 'mainnet' : 'localnet',
    maxSpend: formatUsd(toBaseUnits(values['max-spend'])), input, apiKey: env.MOTTO_API_KEY };
}

export function checkQuote(quote, options, now = Date.now()) {
  if (!quote || typeof quote.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(quote.id)) throw new Error('Desk returned an invalid quote ID');
  if (quote.service !== 'research' || quote.currency !== 'USDC') throw new Error('Desk returned the wrong service or currency');
  if (typeof quote.ceiling_usd !== 'string' || quote.ceiling_usd.length > 32 || !/^\d+(?:\.\d{1,6})?$/.test(quote.ceiling_usd) || toBaseUnits(quote.ceiling_usd) <= 0n || toBaseUnits(quote.ceiling_usd) > toBaseUnits(options.maxSpend)) {
    throw new Error('Quote exceeds your spending limit or has an invalid ceiling; no payment attempted');
  }
  if (typeof quote.max_spend_usd !== 'string' || quote.max_spend_usd.length > 32 || !/^\d+(?:\.\d{1,6})?$/.test(quote.max_spend_usd) || toBaseUnits(quote.max_spend_usd) !== toBaseUnits(options.maxSpend)) {
    throw new Error('Quote changed your spending limit; no payment attempted');
  }
  for (const field of ['query', 'count', 'required_terms', 'from_year', 'to_year']) {
    if (JSON.stringify(quote.input?.[field]) !== JSON.stringify(options.input[field])) {
      throw new Error(`Quote changed ${field}; no payment attempted`);
    }
  }
  if (!Number.isFinite(Date.parse(quote.expires_at)) || Date.parse(quote.expires_at) <= now) throw new Error('Quote expired; no payment attempted');
  return quote;
}

export async function payPurchase(options, quote, { spawnPay = spawn, timeoutMs = 120_000, onRequest = () => {} } = {}) {
  checkQuote(quote, options);
  const dir = mkdtempSync(join(tmpdir(), 'motto-buyer-'));
  const permissions = join(dir, 'permissions.yml');
  writeFileSync(permissions, `origins: [${JSON.stringify(options.desk)}]\nnetworks: [${options.network}]\nmax_payment: "$${quote.ceiling_usd}"\nallow_any_asset: false\n`, { mode: 0o600 });
  try {
    const idempotencyKey = randomUUID();
    onRequest({ quote_id: quote.id, idempotency_key: idempotencyKey, network: options.network, max_spend_usd: options.maxSpend, ceiling_usd: quote.ceiling_usd });
    return await new Promise((resolve, reject) => {
      const child = spawnPay('pay', [options.network === 'mainnet' ? '--mainnet' : '--sandbox', 'mcp', '--permissions', permissions], { stdio: ['pipe', 'pipe', 'ignore'] });
      let buffer = '';
      let done = false;
      const finish = (error, result) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        child.stdin.destroy();
        child.stdout.destroy();
        if (child.kill()) {
          const forceStop = setTimeout(() => {
            if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
          }, 1000);
          forceStop.unref();
          child.once('exit', () => clearTimeout(forceStop));
        }
        if (error) reject(error); else resolve(result);
      };
      const timer = setTimeout(() => finish(new Error('Pay timed out. Check the purchase log before attempting another purchase.')), timeoutMs);
      const send = message => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
      child.on('error', () => finish(new Error('Could not start Pay. Install the Pay.sh CLI and verify pay --version.')));
      child.stdin.on('error', () => finish(new Error('Pay closed its input before completing the purchase.')));
      child.on('exit', () => finish(new Error('Pay exited before completing the purchase. Verify your CLI supports the origin, network, and max_payment permission policy. No uncapped fallback is allowed.')));
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        buffer += chunk;
        if (buffer.length > 10_000_000) return finish(new Error('Pay response exceeded the buyer response limit'));
        for (;;) {
          const end = buffer.indexOf('\n');
          if (end < 0 || done) break;
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          let message;
          try { message = JSON.parse(line); } catch { return finish(new Error('Pay returned an invalid MCP response')); }
          if (message.id !== 1 && message.id !== 2) continue;
          if (message.error) return finish(new Error('Pay rejected the request. Verify your permission policy and account before retrying.'));
          if (message.id === 1) {
            send({ method: 'notifications/initialized' });
            send({ id: 2, method: 'tools/call', params: { name: 'curl', arguments: {
              url: `${options.desk}/v1/purchases/${encodeURIComponent(quote.id)}`, method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey,
                ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}) }, body: {},
            } } });
          } else {
            if (message.result?.isError) return finish(new Error('Pay refused or failed the purchase. Pay.sh 0.29 may reject sandbox permission policies. Use a CLI with supported capped sandbox payments; never retry without the cap. Check the purchase log before another attempt.'));
            try {
              const content = message.result?.content?.filter(part => part.type === 'text').map(part => part.text).join('\n');
              const result = JSON.parse(content);
              if (!result.id || !result.status) throw new Error('Missing purchase record');
              finish(undefined, result);
            } catch { finish(new Error('Pay did not return a purchase record. Check the desk purchase log before another attempt.')); }
          }
        }
      });
      send({ id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'motto-buyer', version: '1.0.0' } } });
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function checkPurchase(purchase, quote, options, signingKey) {
  const statuses = ['fetching', 'validating', 'settling', 'paid', 'refunded', 'settle_failed', 'interrupted'];
  if (!purchase || typeof purchase.id !== 'string' || !statuses.includes(purchase.status) || purchase.quote_id !== quote.id || purchase.service !== quote.service || purchase.currency !== 'USDC') {
    throw new Error('Payment response does not match the accepted quote. Inspect purchase history before retrying.');
  }
  if (purchase.network !== options.network && !(options.network === 'mainnet' && purchase.network === 'mainnet-beta')) throw new Error('Purchase network differs from the accepted network');
  for (const field of ['max_spend_usd', 'ceiling_usd']) {
    if (typeof purchase[field] !== 'string' || purchase[field].length > 32 || !/^\d+(?:\.\d{1,6})?$/.test(purchase[field]) || toBaseUnits(purchase[field]) !== toBaseUnits(quote[field])) {
      throw new Error('Purchase amount differs from the accepted quote. Inspect purchase history before retrying.');
    }
  }
  const terminal = ['paid', 'refunded'].includes(purchase.status);
  if (terminal) {
    const charged = purchase.status === 'paid' ? quote.ceiling_usd : '0.00';
    const returned = purchase.status === 'refunded' ? quote.ceiling_usd : '0.00';
    if (purchase.charged_usd !== charged || purchase.returned_usd !== returned || typeof purchase.settlement_tx !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(purchase.settlement_tx)) throw new Error('Purchase has inconsistent settlement amounts or no settlement transaction');
  } else if (purchase.charged_usd !== null || purchase.returned_usd !== null) throw new Error('Unconfirmed purchase must not report settled amounts');
  if (terminal || purchase.reading) {
    const reading = purchase.reading;
    if (!reading || reading.purchase_id !== purchase.id || reading.quote_id !== quote.id || reading.service !== quote.service || (quote.quote_hash && reading.quote_hash !== quote.quote_hash) || reading.devicePublicKey !== signingKey || typeof reading.signature !== 'string' || !/^[0-9a-f]{128}$/i.test(reading.signature)) throw new Error('Receipt does not match the accepted quote or published signer');
    const { signature, devicePublicKey, ...payload } = reading;
    const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(signingKey, 'hex')]), format: 'der', type: 'spki' });
    if (!verify(null, Buffer.from(JSON.stringify(payload)), key, Buffer.from(signature, 'hex'))) throw new Error('Receipt signature is invalid');
    if (terminal && (reading.charge_usd !== purchase.charged_usd || (purchase.status === 'paid' && (reading.outcome !== 'delivered' || reading.checks?.passed !== true || reading.units_delivered !== quote.input.count)))) throw new Error('Receipt acceptance does not match the settlement');
  }
  return purchase;
}

export async function buy(options, { fetcher = fetch, purchase = payPurchase, onRequest = () => {} } = {}) {
  const headers = options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {};
  const request = async (path, init) => {
    const response = await fetcher(`${options.desk}${path}`, { ...init, redirect: 'error', signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Desk request failed (${response.status}) at ${path}; no payment attempted`);
    return response.json();
  };
  const services = await request('/v1/services');
  if (services.network !== options.network && !(options.network === 'mainnet' && services.network === 'mainnet-beta')) {
    throw new Error(`Desk network differs from buyer ${options.network}; no payment attempted`);
  }
  if (!services.services?.research) throw new Error('Desk does not offer the research service');
  if (typeof services.signing_public_key !== 'string' || !/^[0-9a-f]{64}$/i.test(services.signing_public_key)) throw new Error('Desk did not publish a valid receipt signing key');
  const quote = checkQuote(await request('/v1/quotes', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ service: 'research', input: options.input, max_spend_usd: options.maxSpend }) }), options);
  const result = checkPurchase(await purchase(options, quote, { onRequest }), quote, options, services.signing_public_key);
  return { quote, purchase: result };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await buy(buyerOptions(process.argv.slice(2)), { onRequest: request => console.error(JSON.stringify({ payment_request: request })) });
    console.log(JSON.stringify(result, null, 2));
    if (!['paid', 'refunded'].includes(result.purchase.status)) process.exitCode = 1;
  } catch (error) {
    // Do not echo subprocess logs, request headers, or fetch errors containing credentials.
    const message = error.message.replaceAll(process.env.MOTTO_API_KEY || '\0', '[redacted]');
    console.error(message);
    process.exitCode = 1;
  }
}
