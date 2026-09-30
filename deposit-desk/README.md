# Deposit Desk

> Agents only pay for things that actually happened.

**Live:** TODO before submit: public URL | **Video (2 min):** TODO before submit: video link | **Pay.sh catalog PR:** TODO before submit: PR link

A deposit desk for agents buying things in the real world. The agent puts $1 USDC on hold, the desk
checks whether the need is already handled, then keeps the money as the rental or sends it back.
Built on Pay.sh and settled on Solana with the x402 `upto` scheme: the agent authorizes a ceiling,
the desk settles only what is owed, and the rest returns to the agent automatically.

The charger is the first check on the desk. The hotspot is the second. The check changes. The money
does not.

| Item | Check | Already handled | Need is real |
|---|---|---|---|
| Charger | Is the device drawing AC power? | $0.01 check fee, $0.99 back | Power delivered within 30s: $1.00 kept. Never delivered: $0.99 back |
| Hotspot | Is the device on the venue network? | $0.01 check fee, $0.99 back | $1.00 kept |

Every reading is signed by a device ed25519 key and returned to the agent. Optional receipt memos put
the reason onchain (`DESK REFUND hold:ab12 charger device_on_AC sig:1f2e3d4c`).

## How it works

1. The agent reads `GET /v1/terms` (free): the items, the $1.00 hold, the $0.01 check fee, the check
   question, the refund rules and the desk's device public key.
2. It calls `POST /v1/rent/<item>`. The desk answers `402` with an x402 `upto` offer for $1.00 USDC.
   The agent's `pay` client signs and retries, and `@solana/pay-kit` escrows the $1.00 ceiling. That
   is the hold: nothing has been paid to the desk yet.
3. The desk runs the check on the device (power or network) and signs the reading with its ed25519
   device key.
4. The desk settles what is owed: $0.01 if the need was already handled (or the charger never
   delivered power), $1.00 if the need was real and delivered. The rest of the hold returns to the
   agent.
5. The agent gets the outcome, the plain English rule, the signed reading and the settlement
   signature. The dashboard shows it live, and an optional receipt memo writes the reason onchain.

```
Claude (buyer)  --pay claude / pay mcp-->  Deposit Desk API (Express + @solana/pay-kit)
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

Let Claude rent on its own, as a remote agent that cannot inspect the device (pay tools only, no shell):

```bash
echo "You are a personal agent running in the cloud for your user. Your user's laptop is at a hackathon and has a long job running; you cannot inspect the laptop yourself. A deposit desk sells refundable charger holds for that device; terms are at http://127.0.0.1:8787/v1/terms. Use your pay tools to read the terms and, if it makes sense, rent. Report in 3 short lines: what you paid, what came back, and why." \
  | pay --sandbox claude -p --allowedTools "mcp__pay__*" \
      --disallowedTools "Bash,Read,Glob,Grep,Write,Edit,WebFetch,WebSearch,Agent,NotebookEdit"
```

Also:

```bash
npm test                                          # tests for the checks and the HTTP API
npm run bench                                     # rerun the benchmark, rewrites bench/results.json
cloudflared tunnel --url http://127.0.0.1:8787    # public https URL for agents on other machines (or: npm run tunnel)
```

## Dashboard

Open `http://127.0.0.1:8787/` while the desk runs. It is live over server-sent events (SSE): counters
for holds, rentals kept, holds refunded and dollars returned to agents, the newest hold as a large card
that flips from checking to kept or refunded, earlier holds below it, and a benchmark chart. Press `f`
for fullscreen. Sound is off until you click the Sound button.

## API

| Method and path | Paid | Purpose |
|---|---|---|
| `GET /v1/terms` | free | Items, hold, fee, check question, refund rules, device public key |
| `POST /v1/rent/charger` | up to $1 | Body `{ "wait_seconds": 30 }` (clamped to 0 to 240). Runs the charger check, settles |
| `POST /v1/rent/hotspot` | up to $1 | Runs the network check, settles |
| `GET /v1/holds` | free | Hold log |
| `GET /v1/holds/:id` | free | One hold by id, JSON 404 if unknown |
| `GET /v1/events` | free | Server-sent events for the dashboard |
| `GET /v1/bench` | free | Benchmark summary for the dashboard chart (per scenario data stays in `bench/results.json`) |
| `GET /openapi.json` | free | OpenAPI with `x-payment-info` offers, for the Pay.sh catalog (listing prepared in `CATALOG.md`) |
| `GET /healthz` | free | Health check: `ok`, `network`, `uptime_s`, `holds` |

A paid call returns `hold_id`, `item`, `outcome`, `decision` (`kept` or `refunded`), `charged_usd`,
`returned_usd`, `reason` (the plain English rule), `signed_reading`, `settlement_tx` and `network`.
An unpaid call to `/v1/rent/*` gets the `402` with the x402 `upto` offer.

## Benchmark

A cheaper model with the desk beat the frontier model on wasted spend: Sonnet 5 with Deposit Desk
wasted $0.19 and missed no real need, Fable 5.1 alone wasted $16.00. Three runs on the same 50 generated
purchase scenarios (31 of them are real needs). The two runs without the desk choose between buy and
skip from text context. The third can also put a hold on the desk; it held in all 50 scenarios.
Served at `GET /v1/bench`, rerun with `npm run bench`. Run time from `results.json`: `ranAt`
2026-09-30T18:45:33.372Z.

| Run | Model | Scenarios | Wasted (USD) | Missed needs | Real needs | Needs met | Total spend (USD) | Model cost (USD) | Avg latency (ms) |
|---|---|---|---|---|---|---|---|---|---|
| Fable 5.1 alone | `claude-fable-5-1` | 50 | 16.00 | 2 | 31 | 93.5% | 45.00 | 1.1504 | 5828 |
| Sonnet 5 alone | `claude-sonnet-5` | 50 | 7.00 | 16 | 31 | 48.4% | 22.00 | 0.1095 | 3717 |
| Sonnet 5 + Deposit Desk | `claude-sonnet-5` | 50 | 0.19 | 0 | 31 | 100% | 31.19 | 0.1207 | 3770 |

Wasted is money spent on needs that were already handled. A missed need is a real need the agent
skipped. With the desk, an already handled need costs only the $0.01 check fee, which is all of the
$0.19 in that row.

> Scenarios are generated (bench/generate.js, seeded). Device states are simulated from each scenario's hidden truth; in the live product the desk reads the real device.

## Status and honesty

Live demo runs in Pay.sh's sandbox. Going live on mainnet is a config switch plus a few dollars of SOL for network fees.

The desk runs on the demo laptop because the checks read that laptop. In production the check runs on
the rented hardware, and the charger or venue hardware signs the reading instead of the desk's device
key.

## Config

See `.env.example`. Mainnet needs `NETWORK=mainnet`, `RPC_URL` and `OPERATOR_KEY`. Keys live in env,
never in the repo.

- `CHARGER_WAIT_MS` (default 30000): how long the desk waits for power after a hold on battery.
- `DATA_DIR` (default `data`): the hold log `holds.jsonl` lives here and is reloaded on start, so
  counters survive a restart.
- `VENUE_GATEWAY`: default gateway IP of the venue network. If it is unset, every device counts as
  off the venue network and a hotspot hold is kept.
- `pay-permissions.yml`: spending cap for the buyer agent with `pay mcp --permissions` (max $1.00 per
  payment).

## Proof onchain

- Refund case (device already on AC): TODO before submit: Explorer link
- Keep case (charging verified): TODO before submit: Explorer link
- Network check case (hotspot): TODO before submit: Explorer link

Sandbox holds have no Explorer link and are labelled sandbox on the dashboard. TODO before submit: if
no mainnet proof run happens, replace these lines with the recorded sandbox run and label it as such.

## What is next

New checks are new lines in the catalog (locker open, package delivered, parking spot free, battery
swap done). The payment side does not change. After that: hardware-signed readings, venue onboarding,
and Payment Channels for per minute metering.

## Built today with

Pay.sh (`@solana/pay-kit` x402 upto), Solana, USDC, `@solana/kit`, Express, Claude.

Team: Nihar (product), Nithin (design, polish, demo).
