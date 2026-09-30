// Deposit Desk: agents put USDC on hold for a real-world rental, the desk
// checks whether the need is already handled, then settles only what is owed.
// Built on Pay.sh's x402 `upto` scheme: authorize a ceiling, settle actual usage,
// the rest goes back to the agent.
import express from 'express';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { createPayKit, Signer, usage, usd } from '@solana/pay-kit';
import { checkCharger, checkHotspot, devicePublicKey } from './checks.js';
import { postReceipt } from './receipt.js';

const PORT = Number(process.env.PORT ?? 8787);
const NETWORK = process.env.NETWORK ?? 'localnet';
const RPC_URL = process.env.RPC_URL ?? (NETWORK === 'localnet' ? 'https://402.surfnet.dev:8899' : undefined);
const CHARGER_WAIT_MS = Number(process.env.CHARGER_WAIT_MS ?? 30_000);

// USDC has 6 decimals: $1.00 hold, $0.01 check fee.
const HOLD_BASE_UNITS = 1_000_000n;
const CHECK_FEE_BASE_UNITS = 10_000n;

const ITEMS = {
  charger: {
    hold_usd: '1.00',
    check_fee_usd: '0.01',
    check: 'Is the device already drawing AC power?',
    rules: {
      already_handled: 'Device already on power: charge the $0.01 check fee, $0.99 returned.',
      delivered: `Device on battery, power delivered within ${CHARGER_WAIT_MS / 1000}s: rental kept, $1.00 charged.`,
      not_delivered: 'Power never arrived: charge the $0.01 check fee, $0.99 returned.',
    },
  },
  hotspot: {
    hold_usd: '1.00',
    check_fee_usd: '0.01',
    check: 'Is the device already on the venue network?',
    rules: {
      already_handled: 'Device already on venue network: charge the $0.01 check fee, $0.99 returned.',
      delivered: 'Device off venue network: hotspot rental kept, $1.00 charged.',
    },
  },
};

const operatorSigner = await Signer.env('OPERATOR_KEY');
const pay = await createPayKit({
  network: NETWORK,
  rpcUrl: RPC_URL,
  accept: ['x402'],
  ...(operatorSigner || process.env.RECIPIENT
    ? { operator: { ...(operatorSigner ? { signer: operatorSigner } : {}), ...(process.env.RECIPIENT ? { recipient: process.env.RECIPIENT } : {}) } }
    : {}),
  pricing: {
    charger: usage(usd(ITEMS.charger.hold_usd), { description: 'Refundable $1 charger hold' }),
    hotspot: usage(usd(ITEMS.hotspot.hold_usd), { description: 'Refundable $1 hotspot hold' }),
  },
});

// Hold log: in memory for the dashboard, appended to disk for the record.
mkdirSync('data', { recursive: true });
const holds = [];
const listeners = new Set();
function publish(hold) {
  const i = holds.findIndex(h => h.id === hold.id);
  if (i === -1) holds.unshift(hold);
  else holds[i] = hold;
  appendFileSync('data/holds.jsonl', JSON.stringify(hold) + '\n');
  for (const send of listeners) send(hold);
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
  return new Request(`http://${req.headers.host ?? 'localhost'}${req.originalUrl}`, { method: req.method, headers });
}

const app = express();
app.use(express.json());
app.use(express.static('public'));

app.get('/v1/terms', (_req, res) => {
  res.json({
    service: 'Deposit Desk',
    summary: 'Refundable holds for agents renting real-world things. You only pay if the need is real.',
    network: NETWORK,
    scheme: 'x402 upto: you authorize the hold, the desk settles only what is owed, the rest returns to you.',
    devicePublicKey,
    items: ITEMS,
    endpoints: { charger: 'POST /v1/rent/charger', hotspot: 'POST /v1/rent/hotspot' },
  });
});

app.get('/v1/holds', (_req, res) => res.json({ holds }));

app.get('/v1/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  const send = hold => res.write(`data: ${JSON.stringify(hold)}\n\n`);
  listeners.add(send);
  req.on('close', () => listeners.delete(send));
});

app.post('/v1/rent/:item', async (req, res, next) => {
  const item = req.params.item;
  if (!ITEMS[item]) return res.status(404).json({ error: `unknown item "${item}"`, items: Object.keys(ITEMS) });

  let result;
  try {
    result = await pay.requirePayment(toWebRequest(req), item);
  } catch (error) {
    return next(error);
  }
  if ('respond' in result || result.status === 402) {
    const response = 'respond' in result ? result.respond : result.response;
    res.status(response.status);
    response.headers.forEach((value, name) => res.setHeader(name, value));
    return res.send(Buffer.from(await response.arrayBuffer()));
  }

  const hold = {
    id: randomUUID().slice(0, 8),
    item,
    payer: result.payment.payer,
    hold_usd: ITEMS[item].hold_usd,
    status: 'checking',
    startedAt: Date.now(),
  };
  publish(hold);

  let reading;
  try {
    reading =
      item === 'charger'
        ? await checkCharger({ holdId: hold.id, waitMs: Number(req.body?.wait_seconds ?? CHARGER_WAIT_MS / 1000) * 1000, onUpdate: u => publish({ ...hold, ...u }) })
        : await checkHotspot({ holdId: hold.id });
  } catch (error) {
    reading = { holdId: hold.id, item, outcome: 'check_failed', detail: String(error?.message ?? error), ts: Date.now() };
  }

  const keep = reading.outcome === 'delivered';
  result.charge.charge(keep ? HOLD_BASE_UNITS : CHECK_FEE_BASE_UNITS);
  const charged = keep ? '1.00' : '0.01';
  const returned = keep ? '0.00' : '0.99';

  let settlementHeaders = {};
  let settleError;
  try {
    settlementHeaders = await result.settle();
  } catch (error) {
    settleError = String(error?.message ?? error);
  }
  for (const [name, value] of Object.entries(settlementHeaders)) res.setHeader(name, value);

  const memo = `DESK ${keep ? 'KEEP' : 'REFUND'} hold:${hold.id} ${item} ${reading.detail} sig:${(reading.signature ?? '').slice(0, 8)}`;
  const settled = {
    ...hold,
    status: settleError ? 'settle_failed' : keep ? 'kept' : 'refunded',
    outcome: reading.outcome,
    detail: reading.detail,
    charged_usd: charged,
    returned_usd: returned,
    settlementTx: extractSignature(settlementHeaders),
    settleError,
    reading,
    memo,
    settledAt: Date.now(),
  };
  publish(settled);

  // The receipt carries the reason onchain. Best effort, never blocks the agent.
  postReceipt(memo)
    .then(receiptTx => receiptTx && publish({ ...settled, receiptTx }))
    .catch(error => publish({ ...settled, receiptError: String(error?.message ?? error) }));

  res.json({
    hold_id: hold.id,
    item,
    outcome: reading.outcome,
    decision: keep ? 'kept' : 'refunded',
    charged_usd: charged,
    returned_usd: returned,
    reason: ITEMS[item].rules[reading.outcome] ?? reading.detail,
    signed_reading: reading,
    settlement_tx: settled.settlementTx,
    network: NETWORK,
  });
});

// OpenAPI with payment offers, used by `pay gate --openapi` and the pay-skills catalog.
app.get('/openapi.json', async (_req, res, next) => {
  try {
    res.json(
      await pay.openapi(
        [
          { method: 'POST', path: '/v1/rent/charger', gate: 'charger', summary: 'Hold $1 for a charger; refunded minus $0.01 if the device already has power.' },
          { method: 'POST', path: '/v1/rent/hotspot', gate: 'hotspot', summary: 'Hold $1 for a hotspot; refunded minus $0.01 if the device is already on the venue network.' },
        ],
        { info: { title: 'Deposit Desk', version: '1.0.0', description: 'Refundable holds for agents renting real-world things.' } },
      ),
    );
  } catch (error) {
    next(error);
  }
});

app.listen(PORT, () => {
  console.log(`Deposit Desk on http://127.0.0.1:${PORT}  network=${NETWORK}  recipient=${pay.config.operator.recipient}`);
  console.log(`Device key ${devicePublicKey}`);
});
