// Motto: agents put USDC on hold for a real-world rental, the desk
// checks whether the need is already handled, then settles only what is owed.
// Built on Pay.sh's x402 `upto` scheme: authorize a ceiling, settle actual usage,
// the rest goes back to the agent.
import express from 'express';
import { execFileSync } from 'node:child_process';
import { consolePurchase, localConsole } from './console-purchase.js';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPayKit, Signer, usage, usd } from '@solana/pay-kit';
import { devicePublicKey } from './checks.js';
import { ITEMS, MAX_HOLD_USD, publicTerms } from './items.js';
import { postReceipt } from './receipt.js';
import { settlementFor } from './settlement.js';

const PORT = Number(process.env.PORT ?? 8787);
const NETWORK = process.env.NETWORK ?? 'localnet';
const RPC_URL = process.env.RPC_URL ?? (NETWORK === 'localnet' ? 'https://402.surfnet.dev:8899' : undefined);
// Hold log location. Tests and parallel runs point this at a scratch directory.
const DATA_DIR = process.env.DATA_DIR ?? 'data';
const HOLDS_FILE = join(DATA_DIR, 'holds.jsonl');
// Enough history for the dashboard counters without growing memory forever.
const MAX_HOLDS = 500;
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const SETTLE_FAILED_REASON = 'Settlement was not confirmed: charge and return amounts are unknown until the transaction is inspected. A retry, even with the same Idempotency-Key, opens a fresh hold.';
// Statuses a retried request may be answered from. A failed or interrupted settlement cannot be
// retried on the same hold (pay-kit memoizes settle()), so those retries open a fresh one.
const REPLAYABLE = new Set(['checking', 'waiting_for_power', 'waiting_for_delivery', 'judging', 'fetching', 'validating', 'settling', 'kept', 'refunded']);

const operatorSigner = await Signer.env('OPERATOR_KEY');
const pay = await createPayKit({
  network: NETWORK,
  rpcUrl: RPC_URL,
  accept: ['x402'],
  ...(operatorSigner || process.env.RECIPIENT
    ? { operator: { ...(operatorSigner ? { signer: operatorSigner } : {}), ...(process.env.RECIPIENT ? { recipient: process.env.RECIPIENT } : {}) } }
    : {}),
  pricing: Object.fromEntries(
    Object.entries(ITEMS).map(([name, item]) => [name, usage(usd(item.hold_usd), { description: `Refundable $${item.hold_usd.replace(/\.00$/, '')} ${name.replace('_', ' ')} hold` })]),
  ),
});

// Hold log: in memory for the dashboard, appended to disk for the record.
mkdirSync(DATA_DIR, { recursive: true });
const holds = loadHolds();
const listeners = new Set();
function publish(hold) {
  const i = holds.findIndex(h => h.id === hold.id);
  const steps = holds[i]?.steps ?? hold.steps ?? [];
  hold = { ...hold, steps: steps.at(-1)?.status === hold.status ? steps : [...steps, { status: hold.status, at: Date.now() }] };
  // A late update (receipt) for a hold already evicted from memory is logged but not re-inserted.
  const evicted = i === -1 && hold.status !== 'checking' && holds.length >= MAX_HOLDS;
  if (i !== -1) holds[i] = hold;
  else if (!evicted) holds.unshift(hold);
  if (holds.length > MAX_HOLDS) holds.pop();
  try {
    appendFileSync(HOLDS_FILE, JSON.stringify(hold) + '\n');
  } catch (error) {
    // The payment is already authorized at this point: a full disk must not stop settle().
    console.error(`hold log write failed for ${hold.id}:`, error.message);
  }
  for (const send of listeners) send(hold);
}

// Rebuild the log on start so counters survive a restart. The file has one line
// per publish, so the last line for an id is that hold's latest state.
function loadHolds() {
  let text;
  try {
    text = readFileSync(HOLDS_FILE, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const latest = new Map();
  let skipped = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let hold;
    try {
      hold = JSON.parse(line);
    } catch {
      // A torn write (crash mid-append) must not stop the desk from starting.
    }
    if (typeof hold?.id !== 'string') {
      skipped++;
      continue;
    }
    // A hold still checking when the desk went down never settled; say so instead of showing it as live.
    if (['checking', 'waiting_for_power', 'waiting_for_delivery', 'waiting_for_display', 'judging', 'fetching', 'validating', 'settling'].includes(hold.status)) {
      hold = { ...hold, status: 'interrupted', detail: 'desk restarted during the check' };
    }
    latest.set(hold.id, hold);
  }
  if (skipped) console.warn(`Skipped ${skipped} malformed line(s) in ${HOLDS_FILE}`);
  return [...latest.values()].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0)).slice(0, MAX_HOLDS);
}

// Settlement headers carry the transaction signature; x402 puts it in a
// base64 JSON header. Pull out any base58-looking signature we can find.
function extractSignature(headers) {
  for (const value of Object.values(headers)) {
    for (const candidate of [value, safeBase64(value)]) {
      const match = candidate?.match(/"(?:transaction|signature|txHash)"\s*:\s*"([1-9A-HJ-NP-Za-km-z]{64,90})"/);
      if (match) return match[1];
    }
  }
  return undefined;
}
function safeBase64(value) {
  try {
    return Buffer.from(value, 'base64').toString('utf8');
  } catch {
    return undefined;
  }
}

function toWebRequest(req) {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
  // x402 v2 binds the offer to the exact absolute URL the agent requested. Behind a tunnel that
  // URL is https on the public host, which arrive here as the forwarded headers.
  const proto = String(req.headers['x-forwarded-proto'] ?? 'http').split(',')[0].trim() || 'http';
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost').split(',')[0].trim();
  return new Request(`${proto}://${host}${req.originalUrl}`, { method: req.method, headers });
}

const app = express();
app.use(express.json());
app.use(express.static('public'));

app.get('/v1/terms', (req, res) => {
  res.json({
    service: 'Motto',
    console_purchase: localConsole(req, NETWORK, PORT),
    version: VERSION,
    summary: 'Refundable holds for agents buying real-world things. The rental is charged only if the need is real; a check that finds it already handled costs the item\'s check fee.',
    why_hold:
      'You are acting for a user on a device you cannot inspect. The desk runs the check on the device itself and returns a reading signed by the desk key published here. Hold the item\'s price when your user may need it: if the need is already handled you pay only the check fee and the rest returns, if it is real the rental starts immediately. Send an Idempotency-Key header so a retry after a timeout answers the same hold instead of opening a second one.',
    max_hold_usd: MAX_HOLD_USD,
    network: NETWORK,
    scheme: 'x402 upto: you authorize the hold, the desk settles only what is owed, the rest returns to you.',
    devicePublicKey,
    items: publicTerms(),
    endpoints: Object.fromEntries(Object.keys(ITEMS).map(name => [name, `POST /v1/rent/${name}`])),
  });
});

// Which repo revision this desk runs, so the public URL can be checked against `git log`.
// "-dirty" means src/ or public/ differ from that commit; null when git is unavailable.
function gitRevision() {
  const git = args => execFileSync('git', args, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  try {
    const sha = git(['rev-parse', '--short', 'HEAD']);
    return git(['status', '--porcelain', '--', 'src', 'public']) ? `${sha}-dirty` : sha;
  } catch {
    return null;
  }
}
app.post('/v1/console/purchase', consolePurchase({ network: NETWORK, port: PORT }));

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, version: VERSION, network: NETWORK, commit: gitRevision(), uptime_s: Math.round(process.uptime()), holds: holds.length });
});

app.get('/v1/holds', (_req, res) => res.json({ holds }));

app.get('/v1/holds/:id', (req, res) => {
  const hold = holds.find(h => h.id === req.params.id);
  if (!hold) return res.status(404).json({ error: `no hold "${req.params.id}"` });
  res.json(hold);
});

// Benchmark summary for the dashboard chart (full per-scenario data stays in bench/results.json).
app.get('/v1/bench', (_req, res) => {
  try {
    const { ranAt, note, runs } = JSON.parse(readFileSync('bench/results.json', 'utf8'));
    res.json({ ranAt, note, runs: runs.map(({ results, ...summary }) => summary) });
  } catch {
    res.status(404).json({ error: 'no benchmark results yet; run `npm run bench`' });
  }
});

app.get('/v1/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  const send = hold => res.write(`data: ${JSON.stringify(hold)}\n\n`);
  listeners.add(send);
  req.on('close', () => listeners.delete(send));
});

// The agent's Idempotency-Key, hashed so the hold log (public at /v1/holds) never shows it.
function idempotencyKeyOf(req) {
  const key = req.get('idempotency-key');
  if (typeof key !== 'string' || !key.trim() || key.length > 256) return undefined;
  return createHash('sha256').update(key).digest('hex').slice(0, 24);
}

// What the agent is told about a hold, built from the hold record so a first answer and an
// idempotent replay say exactly the same thing.
function responseFor(hold) {
  const settled = ['kept', 'refunded', 'settle_failed'].includes(hold.status);
  const reason =
    hold.status === 'settle_failed' ? SETTLE_FAILED_REASON
    : hold.status === 'interrupted' ? 'The desk restarted during the check: nothing was charged and settlement did not run.'
    : settled ? ITEMS[hold.item].rules[hold.outcome] ?? hold.detail
    : `The check is still running: poll GET /v1/holds/${hold.id}.`;
  return {
    hold_id: hold.id,
    item: hold.item,
    status: hold.status,
    outcome: hold.outcome,
    decision: settled ? hold.status : undefined,
    hold_usd: hold.hold_usd,
    check_fee_usd: hold.check_fee_usd,
    charged_usd: hold.charged_usd ?? null,
    returned_usd: hold.returned_usd ?? null,
    settle_error: hold.settleError,
    reason,
    signed_reading: hold.reading,
    settlement_tx: hold.settlementTx,
    network: hold.network ?? NETWORK,
  };
}

app.post('/v1/rent/:item', async (req, res, next) => {
  const item = req.params.item;
  if (!Object.hasOwn(ITEMS, item)) return res.status(404).json({ error: `unknown item "${item}"`, items: Object.keys(ITEMS) });
  // Reject a request the check cannot run before any money is held.
  const invalid = ITEMS[item].validate?.(req.body);
  if (invalid) return res.status(400).json({ error: invalid, params: ITEMS[item].params });

  let result;
  try {
    result = await pay.requirePayment(toWebRequest(req), item);
  } catch (error) {
    return next(error);
  }
  if ('respond' in result || result.status === 402) {
    const response = 'respond' in result ? result.respond : result.response;
    const body = Buffer.from(await response.arrayBuffer());
    // A 402 on a request that already carries payment is a rejected proof; log why.
    if (req.headers['payment-signature'] || req.headers['x-payment']) {
      let reason;
      try {
        const { code, detail } = JSON.parse(body.toString('utf8'));
        reason = [code, detail].filter(Boolean).join(': ');
      } catch {}
      console.warn(`POST ${req.originalUrl} payment rejected: ${reason || 'no reason given'}`);
    }
    res.status(response.status);
    response.headers.forEach((value, name) => res.setHeader(name, value));
    return res.send(body);
  }

  // A retry of the same request (same agent, same Idempotency-Key) after a timeout must not open
  // a second rental. The new escrow is released untouched and the earlier hold is answered again.
  const idempotencyKey = idempotencyKeyOf(req);
  const prior = idempotencyKey && holds.find(h => h.idempotency_key === idempotencyKey && h.payer === result.payment.payer && h.item === item && REPLAYABLE.has(h.status));
  if (prior) {
    try {
      await result.settle();
    } catch (error) {
      console.error(`hold ${prior.id}: releasing the replayed escrow failed:`, error?.message ?? error);
    }
    res.setHeader('idempotent-replayed', 'true');
    return res.json(responseFor(prior));
  }

  const hold = {
    id: randomUUID().slice(0, 8),
    item,
    network: NETWORK,
    ...(item === 'research' ? { query: req.body.query.trim(), provider: 'Crossref' } : {}),
    payer: result.payment.payer,
    hold_usd: ITEMS[item].hold_usd,
    check_fee_usd: ITEMS[item].check_fee_usd,
    covers: ITEMS[item].covers,
    ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
    status: 'checking',
    startedAt: Date.now(),
  };

  // From here the agent's hold is escrowed. Whatever happens, settle() must run once so the
  // escrow is released now rather than at the x402 timeout (pay-kit memoizes settle()).
  let settleStarted = false;
  try {
    publish(hold);

    let reading;
    try {
      reading = await ITEMS[item].run({ holdId: hold.id, body: req.body, onUpdate: u => publish({ ...hold, ...u }) });
    } catch (error) {
      reading = { holdId: hold.id, item, outcome: 'check_failed', detail: String(error?.message ?? error), ts: Date.now() };
    }

    publish({ ...hold, status: 'settling', reading, outcome: reading.outcome });
    const { keep, chargeBaseUnits } = settlementFor(ITEMS[item], reading.outcome);
    settleStarted = true;
    // Never setting the meter settles 0, so a desk-side check failure costs the agent nothing.
    if (chargeBaseUnits > 0n) result.charge.charge(chargeBaseUnits);

    let settlementHeaders = {};
    let settleError;
    try {
      settlementHeaders = await result.settle();
    } catch (error) {
      settleError = String(error?.message ?? error);
    }
    for (const [name, value] of Object.entries(settlementHeaders)) res.setHeader(name, value);
    const { decision, charged_usd, returned_usd } = settlementFor(ITEMS[item], reading.outcome, settleError);

    const memo = `DESK ${keep ? 'KEEP' : 'REFUND'} hold:${hold.id} ${item} ${reading.detail} sig:${(reading.signature ?? '').slice(0, 8)}`;
    const settled = {
      ...hold,
      status: settleError ? 'settle_failed' : decision,
      outcome: reading.outcome,
      detail: reading.detail,
      charged_usd,
      returned_usd,
      settlementTx: extractSignature(settlementHeaders),
      settleError,
      reading,
      memo: settleError ? undefined : memo,
      settledAt: Date.now(),
    };
    publish(settled);

    // The receipt carries the reason onchain. Best effort, never blocks the agent, and never
    // claims KEEP or REFUND for a settlement that did not go through.
    if (!settleError) {
      postReceipt(memo)
        .then(receiptTx => receiptTx && publish({ ...settled, receiptTx }))
        .catch(error => publish({ ...settled, receiptError: String(error?.message ?? error) }));
    }

    res.json(responseFor(settled));
  } catch (error) {
    // The desk itself failed after the hold opened. Settle now (the meter is still zero unless the
    // failure came from settle() itself) so the agent's escrow is released, then report the error.
    if (!settleStarted) {
      try {
        await result.settle();
      } catch (settleError) {
        console.error(`hold ${hold.id}: settle after a desk error failed:`, settleError?.message ?? settleError);
      }
    }
    publish({ ...hold, status: 'settle_failed', detail: 'desk error after the hold opened', settleError: String(error?.message ?? error), settledAt: Date.now() });
    next(error);
  }
});

// OpenAPI with payment offers, used by `pay gate --openapi` and the pay-skills catalog.
// Summaries stay under the registry's 63 character cap (they show in the OS payment prompt).
app.get('/openapi.json', async (_req, res, next) => {
  try {
    res.json(
      await pay.openapi(
        Object.entries(ITEMS).map(([name, item]) => ({ method: 'POST', path: `/v1/rent/${name}`, gate: name, summary: item.summary })),
        { info: { title: 'Motto', version: '1.0.0', description: 'Refundable holds for agents renting real-world things.' } },
      ),
    );
  } catch (error) {
    next(error);
  }
});

// Unknown API routes answer in JSON like the rest of the API.
app.use('/v1', (req, res) => res.status(404).json({ error: `no route ${req.method} ${req.originalUrl}` }));

// Bad JSON bodies and pay-kit or RPC failures go back as JSON. Express's default
// HTML error page would leak stack traces and file paths to the agent.
app.use((error, req, res, next) => {
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
  console.error(`${req.method} ${req.originalUrl} -> ${status}`, status < 500 ? error.message : error);
  if (res.headersSent) return next(error);
  res.status(status).json({ error: status < 500 ? error.message : 'internal error' });
});

app.listen(PORT, () => {
  console.log(`Motto on http://127.0.0.1:${PORT}  network=${NETWORK}  recipient=${pay.config.operator.recipient}  holds=${holds.length}`);
  console.log(`Device key ${devicePublicKey}`);
});
