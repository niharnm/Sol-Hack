# Motto

## Digital-service demo: research-source pack

The primary console demo is now `POST /v1/rent/research` with `{ "query": "retrieval augmented generation" }`.
Motto fetches live Crossref public metadata and returns three distinct DOI-backed citation records.
It verifies record count, nonempty titles and unique DOI identifiers before charging the configured
$1.00 service price. Incomplete results or a provider failure charge nothing and return the full hold.
The signed reading includes the deliverable and every check result. Crossref metadata itself is public;
the paid service is packaging and structural validation, not access to a paid upstream API.
Checks do not establish semantic relevance, scientific quality, DOI resolution or full-text access.

Open the console and click **New purchase** to copy a sandbox command. A partner with Claude Code
access can run `node demo/run-agent.mjs` from the repository root. `npm run buyer` also defaults to
`research-brief`. See [the two-minute demo](../demo/TWO_MINUTE_PITCH.md).
The console defaults to digital purchases; earlier device demos remain available through a checkbox.


> An agent authorizes a ceiling. We check whether the need is already handled, settle what’s owed, and return the rest.

**Live:** https://motto.tail039d5c.ts.net (Pay.sh sandbox desk, runs on Nihar's laptop through Tailscale Funnel) | **Pay.sh catalog PR:** https://github.com/solana-foundation/pay-skills/pull/280

A deposit desk for agents buying things in the real world, and small digital deliveries handled the
same way. The agent puts the item's ceiling on hold ($0.10 to $10.00 USDC, priced per item), the desk
checks whether the need is already handled or delivers the item, then keeps the hold as the rental or
keeps only a small check fee and sends the rest back.
Built on Pay.sh and settled on Solana with the x402 `upto` scheme: the agent authorizes a ceiling,
the desk settles only what is owed, and the rest returns to the agent automatically.

The charger is the first check on the desk. The hotspot is the second. The check and the price change
per item. The rules do not.

## Prices and what each outcome settles to

| Item | Hold (ceiling) | Check fee | Covers | Already handled | Delivered or need is real | Never delivered or inconclusive | Check failed |
|---|---|---|---|---|---|---|---|
| `research` | $1.00 | none | three DOI-backed citation records with titles | no such outcome (a delivery, not a device check) | $1.00 charged | inconclusive (incomplete records): nothing charged, $1.00 returned | nothing charged, $1.00 returned |
| `charger` | $3.00 | $0.05 | one charging session, up to 4 hours | $0.05 charged, $2.95 returned | $3.00 charged | never delivered: $0.05 charged, $2.95 returned | nothing charged, $3.00 returned |
| `hotspot` | $8.00 | $0.10 | a day pass, up to 24 hours | $0.10 charged, $7.90 returned | $8.00 charged | settles the moment the need is real | nothing charged, $8.00 returned |
| `battery_pack` | $6.00 | $0.05 | one battery pack, up to 8 hours | $0.05 charged, $5.95 returned | $6.00 charged | settles the moment the need is real | nothing charged, $6.00 returned |
| `storage` | $2.00 | $0.02 | up to 100 GB of storage for 24 hours | $0.02 charged, $1.98 returned | $2.00 charged | settles the moment the need is real | nothing charged, $2.00 returned |
| `display` | $10.00 | $0.10 | one external monitor, up to 8 hours | $0.10 charged, $9.90 returned | $10.00 charged | never delivered: $0.10 charged, $9.90 returned | nothing charged, $10.00 returned |
| `verify` | $0.10 | $0.10 | one model-judged check of a stated condition | condition true: $0.10 charged, $0.00 returned | condition false: $0.10 charged, $0.00 returned | inconclusive: nothing charged, $0.10 returned | nothing charged, $0.10 returned |

The rules are the same for every item and are generated from these numbers, so `GET /v1/terms` serves
the exact sentence that applies, for example "Already handled: the $0.05 check fee is charged, $2.95
returned." Three items wait for a delivery: `research` (the records are fetched and validated),
`charger` (power arriving) and `display` (a monitor being connected); the other four settle the moment
the check says whether the need is real. `verify` is a pure check: a definitive verdict either way
costs the $0.10 fee, an inconclusive one costs nothing. `research` has no check fee: three valid records
cost $1.00, anything less costs nothing.

Every reading is signed by the desk's ed25519 key published at `/v1/terms` and returned to the agent
(a reading from a check that itself failed is returned unsigned and costs nothing); hardware
attestation is next. Optional receipt memos put the reason onchain
(`DESK REFUND hold:ab12 charger device_on_AC sig:1f2e3d4c`).

## How it works

1. The agent reads `GET /v1/terms` (free): the items, each item's hold ceiling and check fee, what
   the hold covers, the check question, the settlement rules, `max_hold_usd` (`"10.00"`, the highest
   ceiling), the desk `version` and its signing key (`devicePublicKey`).
2. It calls `POST /v1/rent/<item>`. The desk answers `402` with an x402 `upto` offer for that item's
   ceiling in USDC ($3.00 for the charger, sent as 3000000 base units). The agent's `pay` client
   signs and retries, and `@solana/pay-kit` escrows the ceiling. That is the hold: nothing has been
   paid to the desk yet. A retried request with the same `Idempotency-Key` header and payer returns
   the existing hold instead of opening a second one.
3. The desk runs the check on the device (power, network, battery, disk, displays, or a model judging
   a stated condition) or fetches the deliverable (`research`: Crossref records, validated), and signs
   the reading with its ed25519 key, the one `/v1/terms` publishes.
4. The desk settles what is owed: the check fee if the need was already handled (or, for the charger
   and the display, if the rental never delivered), the full hold if the need was real or the item was
   delivered. `verify` charges only its $0.10 fee on a definitive verdict either way. A failed or
   inconclusive check charges nothing. The rest of the hold returns to the agent.
5. The agent gets the outcome, the plain English rule, the signed reading and the settlement
   signature. The dashboard shows it live, and an optional receipt memo writes the reason onchain.

```
Claude (buyer)  --pay claude / pay mcp-->  Motto API (Express + @solana/pay-kit)
                                              | 402 upto offer, verify, escrow
                                              | run check (pmset / route) + sign reading
                                              | charge(actual) -> settle -> refund rest
                                              v
                                           Solana (Pay.sh sandbox for the demo, mainnet by config)
                                              ^
Dashboard (static page, live via SSE) <-------+   optional receipt tx with memo from desk wallet
```

## Run it (Pay.sh sandbox)

The sandbox needs no wallet. The `pay` commands need the Pay.sh CLI (`brew install pay`).

```bash
npm install
npm start                                   # http://127.0.0.1:8787 dashboard
curl -i -X POST http://127.0.0.1:8787/v1/rent/charger          # 402 with an x402 upto offer
pay --sandbox curl -X POST http://127.0.0.1:8787/v1/rent/charger
pay --sandbox curl -X POST http://127.0.0.1:8787/v1/rent/hotspot
```

Let Claude rent on its own, as a remote agent that cannot inspect the device. The packaged buyer runs Claude with
pay tools only (no shell, no files, none of the operator's settings), lets it read the terms and pick the item, then
checks its report against the desk's own hold log:

```bash
npm run buyer -- --list                       # situations: low-battery, plugged-in, battery-pack, big-download, no-wifi, two-screens, second-screen
npm run buyer -- --scenario big-download      # verified run (recorded under the earlier flat $1 pricing): picked storage, 450.8 GB free, refunded minus the check fee
npm run buyer -- "My laptop is at 12% and has a 3 hour render left"
npm run buyer -- --desk https://motto.tail039d5c.ts.net --mainnet --scenario no-wifi
```

On mainnet the buyer's pay MCP server enforces a $10.00 per payment cap (the highest ceiling) for the desk's origin only. pay 0.29 rejects
every permission rule in the sandbox ("invalid Solana network"), so sandbox runs have no pay-side cap and say so.

The same thing by hand:

```bash
echo "You are a personal agent running in the cloud for your user. Your user's laptop is at a hackathon and has a long job running; you cannot inspect the laptop yourself. A deposit desk sells refundable charger holds for that device; terms are at http://127.0.0.1:8787/v1/terms. Use your pay tools to read the terms and, if it makes sense, rent. Report in 3 short lines: what you paid, what came back, and why." \
  | pay --sandbox claude -p --allowedTools "mcp__pay__*" \
      --disallowedTools "Bash,Read,Glob,Grep,Write,Edit,WebFetch,WebSearch,Agent,NotebookEdit"
```

Also:

```bash
npm test                                          # tests for the checks and the HTTP API
npm run bench                                     # rerun the benchmark, rewrites bench/results.json
scripts/desk.sh restart                           # the desk behind the Funnel, under node --watch: src/ edits restart it, the public URL serves this checkout
scripts/desk.sh status                            # repo HEAD next to the commit the local and public /healthz report
tailscale funnel --bg 8787                        # permanent public URL: https://motto.tail039d5c.ts.net
cloudflared tunnel --url http://127.0.0.1:8787    # fallback: temporary URL (or: npm run tunnel)
```

## Dashboard

Open `http://127.0.0.1:8787/` while the desk runs. It is live over server-sent events (SSE): counters
for holds, rentals kept, holds refunded and dollars returned to agents, the newest hold as a large card
that flips from checking to kept or refunded, earlier holds below it, and a benchmark chart. Press `f`
for fullscreen. Sound is off until you click the Sound button.

## API

| Method and path | Paid | Purpose |
|---|---|---|
| `GET /v1/terms` | free | Items with `hold_usd`, `check_fee_usd`, `covers`, `charge_on_delivered` (`hold` or `fee`), the check question, params and settlement rules, plus `max_hold_usd`, `version`, `network` and the desk's signing key |
| `POST /v1/rent/research` | up to $1.00 | Body `{ "query": "..." }`. Fetches three distinct DOI-backed citation records from Crossref public metadata and validates count, titles and unique DOIs: delivered $1.00 charged; incomplete or provider failure: nothing charged |
| `POST /v1/rent/charger` | up to $3.00 | Is the device already drawing AC power? Body `{ "wait_seconds": 30 }` (clamped to 0 to 240) sets how long to wait for power on battery. Settles |
| `POST /v1/rent/hotspot` | up to $8.00 | Is the device already on the venue network? Settles |
| `POST /v1/rent/battery_pack` | up to $6.00 | Body `{ "min_percent": 50 }`. On AC or at least that charge: fee only, rest returned; below it: pack rental kept |
| `POST /v1/rent/storage` | up to $2.00 | Body `{ "needed_gb": 10 }`. Enough free disk: fee only, rest returned; not enough: storage rental kept |
| `POST /v1/rent/display` | up to $10.00 | Body `{ "wait_seconds": 30 }`. External display already connected: fee only, rest returned; one connected within the wait: kept; never: fee only, rest returned |
| `POST /v1/rent/verify` | up to $0.10 | Body `{ "condition": "...", "evidence_urls": [...] }`. A model judges the condition on device evidence and up to 3 URLs: true or false costs the $0.10 fee, unknown costs nothing |
| `GET /v1/holds` | free | Hold log |
| `GET /v1/holds/:id` | free | One hold by id, JSON 404 if unknown |
| `GET /v1/events` | free | Server-sent events for the dashboard |
| `GET /v1/bench` | free | Benchmark summary for the dashboard chart (per scenario data stays in `bench/results.json`) |
| `GET /openapi.json` | free | OpenAPI with `x-payment-info` offers, for the Pay.sh catalog (listing prepared in `CATALOG.md`) |
| `GET /healthz` | free | Health check: `ok`, `network`, `uptime_s`, `holds`, `version` |

A paid call returns `hold_id`, `item`, `hold_usd`, `check_fee_usd`, `outcome`, `decision` (`kept`,
`refunded`, or `settle_failed`), `charged_usd`, `returned_usd`, `reason` (the plain English rule),
`signed_reading`, `settlement_tx` and `network`. On `settle_failed` the money fields are null,
`settle_error` says why, and the item's ceiling stays held until the x402 timeout releases it; the
desk does not retry on its own. An unpaid call to `/v1/rent/*` gets the `402` with the x402 `upto`
offer for the item's ceiling in USDC base units (6 decimals: $3.00 = 3000000, $1.00 = 1000000).

## Verify a reading yourself

Every hold's `reading` carries a hex ed25519 `signature` and the `devicePublicKey` that `GET /v1/terms`
publishes. Ten lines of Node check it offline:

```js
import { createPublicKey, verify } from 'node:crypto';

const desk = 'http://127.0.0.1:8787';
const terms = await (await fetch(`${desk}/v1/terms`)).json();
const hold = await (await fetch(`${desk}/v1/holds/<hold_id>`)).json();
const { signature, devicePublicKey, ...payload } = hold.reading;
const key = createPublicKey({
  key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(devicePublicKey, 'hex')]),
  format: 'der', type: 'spki',
});
console.log(devicePublicKey === terms.devicePublicKey && verify(null, Buffer.from(JSON.stringify(payload)), key, Buffer.from(signature, 'hex')));
```

`node proof/verify.mjs` runs the same check over the recorded sandbox holds.

## Benchmark

A cheaper model with the desk beat the frontier model on wasted spend: Sonnet 5 with Motto
wasted $1.40 and missed no real need, Fable 5.1 alone wasted $77.00. Three runs on the same 50 generated
purchase scenarios (31 of them are real needs). The two runs without the desk choose between buy and
skip from text context. The third can also put a hold on the desk; it held in 49 scenarios and skipped 1.
Served at `GET /v1/bench`, rerun with `npm run bench`. Run time from `results.json`: `ranAt`
2026-09-30T21:37:51.489Z.

| Run | Model | Scenarios | Wasted (USD) | Missed needs | Real needs | Needs met | Total spend (USD) | Model cost (USD) | Avg latency (ms) |
|---|---|---|---|---|---|---|---|---|---|
| Fable 5.1 alone | `claude-fable-5-1` | 50 | 77.00 | 10 | 31 | 67.7% | 195.00 | 1.1983 | 5731 |
| Sonnet 5 alone | `claude-sonnet-5` | 50 | 46.00 | 18 | 31 | 41.9% | 115.00 | 0.1098 | 3620 |
| Sonnet 5 + Motto | `claude-sonnet-5` | 50 | 1.40 | 0 | 31 | 100% | 169.40 | 0.1214 | 3745 |

Wasted is money spent on needs that were already handled. A missed need is a real need the agent
skipped. With the desk, an already handled need costs only the check fee: the $1.40 in that row is the
check fees on the 18 already-handled scenarios it held (charger $0.05, hotspot $0.10); it skipped one
handled scenario. Benchmark recorded under the per-item pricing at 14:37 PDT on 2026-09-30.

> Scenarios are generated (bench/generate.js, seeded). Device states are simulated from each scenario's hidden truth; in the live product the desk reads the real device.

## Status and honesty

Everything runs in Pay.sh's sandbox. We chose not to run on mainnet for the hackathon: the mainnet path is configured (`NETWORK`, `RPC_URL`, `OPERATOR_KEY`, plus a few dollars of SOL for network fees) but has never been exercised.

The Pay.sh sandbox drops roughly one payment in five with a transient facilitator error. The desk
reports `settle_failed` and charges nothing, and the agent should retry once.

The desk runs on the demo laptop because the device checks read that laptop. In production the check
runs on the rented hardware, and the charger or venue hardware signs the reading instead of the desk's
key. The research pack packages public Crossref metadata; its checks validate structure (count, titles,
unique DOIs), not relevance, quality, DOI resolution or full-text access.

## Config

See `.env.example`. Mainnet needs `NETWORK=mainnet`, `RPC_URL` and `OPERATOR_KEY`. Keys live in env,
never in the repo.

- `CHARGER_WAIT_MS` (default 30000): how long the desk waits for power after a hold on battery.
- `DATA_DIR` (default `data`): the hold log `holds.jsonl` lives here and is reloaded on start, so
  counters survive a restart.
- `VENUE_GATEWAY`: default gateway IP of the venue network. If it is unset, every device counts as
  off the venue network and a hotspot hold is kept.
- `pay-permissions.yml`: spending cap for the buyer agent with `pay mcp --permissions` ($10.00 per
  payment, the highest ceiling, the same number `/v1/terms` reports as `max_hold_usd`).

## Proof (sandbox)

Everything runs in the Pay.sh sandbox (test USDC on localnet), so there are no Explorer links. Eight
holds recorded on the demo laptop on 2026-09-30 are exported with their readings, signed by the desk's
key, in `motto/proof/sandbox-holds.json`: three under the earlier flat $1 pricing and five under the
per-item prices. `node motto/proof/verify.mjs` checks each signature against the desk's key, that
charged plus returned adds up to that hold's own ceiling, and that the charge matches the outcome.
It does not confirm the sandbox transactions themselves.

Per-item prices:

- Refund (storage, enough free disk already): hold `0992a6d3`, $2.00 ceiling, $0.02 charged, $1.98 returned. Sandbox tx
  `3pnKJk3RtYuWK49SsvNcbCHLCe2FG4LJ5r4kPFqcfpHBgo1WNSsDyCsFUcLQogpR3wAcfuXb6b4MUBrvT8YhBK2`
- Refund (charger, on battery and power never arrived): hold `8b2c5933`, $3.00 ceiling, $0.05 charged, $2.95 returned. Sandbox tx
  `4uHR631xsCQnUgPpdUzCpLVf5FHD672MESvUwyBmLner6oiQzb6PeeLoCKdKJUwNNs8X7LDCSv4qbRZr6Fdmop9p`
- Refund (monitor, none connected before the timeout): hold `6db3b890`, $10.00 ceiling, $0.10 charged, $9.90 returned. Sandbox tx
  `yKVwQSCSYhRtac67FSUse4vBsFXcbtXidBKBoEZoT7zJ52LqXBGzK1C9KbTHHJxi5dtRhTwQArU9kQcWC88Qv57`
- Keep (hotspot, device off the venue network): hold `ba03e1a9`, $8.00 charged. Sandbox tx
  `4PpThwAW4xKNah1sy3jigBBSBFztt6TB3Yk7NyVGGkjwPV11xwvCELgihS4dWUM8L7NX1JVD2UNHqGqB8WRwPeAt`
- Keep (research, three DOI-backed records delivered): hold `b0c10007`, $1.00 charged. Sandbox tx
  `4eYnhMJzyDniByimZBS3Y43BywsRnEw7rwFKXY9A6iLHZQDvaZnooTGgXT8VD6ceMgJjFeJfA3Br5uXo2RQXpU1h`

Earlier flat $1 pricing:

- Refund (device already on AC, flat $1 pricing): hold `ac7fee75`, $0.01 charged, $0.99 returned. Sandbox tx
  `3bPfkmJsZcBWnNp3YPysCdXkDcc49WZiLymDEUq999xJzgR2V7qrwusarfHUVgWiF5apSguFcJ6PwinQBxLpEx8P`
- Keep (charging verified after a real plug-in, flat $1 pricing): hold `1f4dc261`, $1.00 charged. Sandbox tx
  `5DeywCCzf3LrGZGX8efajcHCH1mMWbxhi5kuPKzVB2fFN3521WFmGgWyy1qcaK14Zuodr8y7gTzEKNB1oXXXF2jH`
- Keep (hotspot, device off the venue network, flat $1 pricing): hold `4256f6d4`, $1.00 charged. Sandbox tx
  `5K7gvcKPhgtzQDobVgpT4gJ4yqvUjqicNzjsZnuvmYuBGV8oMAXCb6Frd1HG6APq5b2UFUqphgJvLESESBzrM1rd`

## What is next

New checks are new lines in the catalog (locker open, package delivered, parking spot free, battery
swap done). The payment side does not change. After that: metered billing, which needs an MPP session
channel because an x402 `upto` hold has one deposit, one claim and a 300 second lifetime;
hardware-signed readings (the charger or venue hardware signs, not only the desk); venue onboarding;
mainnet.

## Built today with

Pay.sh (`@solana/pay-kit` x402 upto), Solana, USDC, `@solana/kit`, Express, Claude.

Team: Nihar (product), Nithin (design, polish, demo).

### Typed research purchases in the local console

Open `http://127.0.0.1:8787`, enter a topic, and select **Find 3 sources**.
On localnet, the local console invokes the Pay.sh CLI against the existing paid
research endpoint. It fetches live Crossref metadata, checks three distinct DOI
identifiers and nonempty titles, signs the delivery, and attempts settlement.
The browser shows actual server transitions, verifies the signature locally,
and lets you download the complete receipt. No recorded playback is used.

The one-click buyer is restricted to loopback requests and test payments, with
one purchase at a time. Public/remote visitors get a paid API command instead;
they cannot spend the host wallet. Groq is not configured or used in this flow.
A citation pack is metadata, not a synthesized report or a quality guarantee.
If settlement is unconfirmed, inspect the existing purchase before retrying;
source delivery alone does not prove payment succeeded.
