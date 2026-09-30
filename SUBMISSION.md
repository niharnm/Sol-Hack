# Motto

> An agent authorizes a ceiling. We check whether the need is already handled, settle what’s owed, and return the rest. A deposit desk for agents buying things in the real world, built on Pay.sh x402 `upto` holds and settled in USDC on Solana.

**Live:** https://motto.tail039d5c.ts.net (Pay.sh sandbox desk, runs on Nihar's laptop through Tailscale Funnel) | **Pay.sh listing / PR:** https://github.com/solana-foundation/pay-skills/pull/280

**Repo:** https://github.com/niharnm/Sol-Hack | **Team:** Nihar (product), Nithin (design, polish, demo)

## The problem

Agents are starting to spend money in the real world, and the agent that pays is often not where the
device is. A cloud agent working for a user's laptop cannot see whether the laptop is already plugged
in, so it either guesses or pays for something that already happened.

## What we built

A deposit desk with seven items, each priced on its own: a digital research-source pack (three
DOI-backed citation records from Crossref public metadata, structurally validated before charging)
and six device checks. The agent puts the item's ceiling in USDC on hold. The desk delivers the item
or checks the device. If the need is already handled, the desk keeps a small check fee and the rest
returns to the agent. If the item is delivered or the need is real, the desk keeps the hold as the
price. Anything less than a delivery or a definitive check charges nothing.

| Item | Hold (ceiling) | Check fee | Covers | Already handled | Delivered or need is real | Never delivered or inconclusive | Check failed |
|---|---|---|---|---|---|---|---|
| `research` | $1.00 | none | three DOI-backed citation records with titles | no such outcome (a delivery, not a device check) | $1.00 charged | inconclusive (incomplete records): nothing charged, $1.00 returned | nothing charged, $1.00 returned |
| `charger` | $3.00 | $0.05 | one charging session, up to 4 hours | $0.05 charged, $2.95 returned | $3.00 charged | never delivered: $0.05 charged, $2.95 returned | nothing charged, $3.00 returned |
| `hotspot` | $8.00 | $0.10 | a day pass, up to 24 hours | $0.10 charged, $7.90 returned | $8.00 charged | settles the moment the need is real | nothing charged, $8.00 returned |
| `battery_pack` | $6.00 | $0.05 | one battery pack, up to 8 hours | $0.05 charged, $5.95 returned | $6.00 charged | settles the moment the need is real | nothing charged, $6.00 returned |
| `storage` | $2.00 | $0.02 | up to 100 GB of storage for 24 hours | $0.02 charged, $1.98 returned | $2.00 charged | settles the moment the need is real | nothing charged, $2.00 returned |
| `display` | $10.00 | $0.10 | one external monitor, up to 8 hours | $0.10 charged, $9.90 returned | $10.00 charged | never delivered: $0.10 charged, $9.90 returned | nothing charged, $10.00 returned |
| `verify` | $0.10 | $0.10 | one model-judged check of a stated condition | condition true: $0.10 charged, $0.00 returned | condition false: $0.10 charged, $0.00 returned | inconclusive: nothing charged, $0.10 returned | nothing charged, $0.10 returned |

The charger is the first check (is the device on AC power?), the hotspot is the second (is the device
on the venue network?). Three items wait for a delivery: the research pack, the charger and the
display; the other four settle the moment the check says whether the need is real. `verify` is a pure
check and charges only its fee on a definitive verdict either way. The check and the price change per
item. The rules do not: they are generated from the numbers above, and `GET /v1/terms` serves the
exact sentence that applies, along with `max_hold_usd` (`"10.00"`) and the desk `version`.

The hold is Pay.sh's own x402 `upto` scheme: the agent authorizes a ceiling, the desk settles only
what it is owed, and the rest returns automatically. No custom refund code.

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

## How it works

1. A buyer agent (Claude via `pay claude` or `pay mcp`) reads the desk's terms at `GET /v1/terms`:
   the items, each item's hold ceiling and check fee, what the hold covers, the check question and
   the settlement rules. `GET /openapi.json` carries the x402 offers for the Pay.sh catalog. The
   listing is prepared in `motto/CATALOG.md` and `motto/catalog/`
   (PR: https://github.com/solana-foundation/pay-skills/pull/280).
2. The agent calls `POST /v1/rent/<item>`. The desk answers `402` with an x402 `upto` offer for that
   item's ceiling in USDC ($3.00 for the charger, sent as 3000000 base units), the agent's `pay`
   client signs and retries, and `@solana/pay-kit` escrows the ceiling. That is the hold. A retried
   request with the same `Idempotency-Key` header and payer returns the existing hold instead of
   opening a second one.
3. The desk runs the check for that item (power, network, battery, disk, display, or a model judging
   a stated condition) or fetches the deliverable (research: Crossref records, validated), and signs
   the reading with its ed25519 key, published at `/v1/terms`. The signed reading goes back to the
   agent.
4. Already handled: the check fee is charged and the rest returns to the agent ($0.05 charged, $2.95
   back for the charger). Need is real or item delivered: the hold is kept as the price ($3.00 for the
   charger, $1.00 for the research pack). Charger or monitor never delivered: the fee, the rest
   returns. Failed or inconclusive check, or an incomplete research pack: nothing charged. Each settlement can carry a receipt memo with the reason
   (`DESK REFUND hold:ab12 charger device_on_AC sig:1f2e3d4c`), and the dashboard shows every hold
   live.

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

## Run it

The sandbox needs no wallet. The `pay` commands need the Pay.sh CLI (`brew install pay`).

```bash
cd motto
npm install
npm start                                   # http://127.0.0.1:8787 dashboard
curl -i -X POST http://127.0.0.1:8787/v1/rent/charger          # 402 with an x402 upto offer
pay --sandbox curl -X POST http://127.0.0.1:8787/v1/rent/charger
pay --sandbox curl -X POST http://127.0.0.1:8787/v1/rent/hotspot
npm test                                    # run the tests
npm run bench                               # rerun the benchmark
```

Let Claude rent on its own, as a remote agent that cannot inspect the device (pay tools only, no shell):

```bash
echo "You are a personal agent running in the cloud for your user. Your user's laptop is at a hackathon and has a long job running; you cannot inspect the laptop yourself. A deposit desk sells refundable charger holds for that device; terms are at http://127.0.0.1:8787/v1/terms. Use your pay tools to read the terms and, if it makes sense, rent. Report in 3 short lines: what you paid, what came back, and why." \
  | pay --sandbox claude -p --allowedTools "mcp__pay__*" \
      --disallowedTools "Bash,Read,Glob,Grep,Write,Edit,WebFetch,WebSearch,Agent,NotebookEdit"
```

## Benchmark

A cheaper model with the desk beat the frontier model on wasted spend: Sonnet 5 with Motto
wasted $1.40 and missed no real need, Fable 5.1 alone wasted $77.00. Same 50 generated purchase
scenarios for every run, 31 of them real needs. The two runs without the desk choose between buy and
skip from text context. The third can also put a hold on the desk, and it held in 49 scenarios and
skipped 1. Results are in `motto/bench/results.json` (`ranAt` 2026-09-30T21:37:51.489Z) and served at
`GET /v1/bench`. Benchmark recorded under the per-item pricing at 14:37 PDT on 2026-09-30.

| Run | Model | Scenarios | Wasted (USD) | Missed needs | Real needs | Needs met | Total spend (USD) | Model cost (USD) | Avg latency (ms) |
|---|---|---|---|---|---|---|---|---|---|
| Fable 5.1 alone | `claude-fable-5-1` | 50 | 77.00 | 10 | 31 | 67.7% | 195.00 | 1.1983 | 5731 |
| Sonnet 5 alone | `claude-sonnet-5` | 50 | 46.00 | 18 | 31 | 41.9% | 115.00 | 0.1098 | 3620 |
| Sonnet 5 + Motto | `claude-sonnet-5` | 50 | 1.40 | 0 | 31 | 100% | 169.40 | 0.1214 | 3745 |

> Scenarios are generated (bench/generate.js, seeded). Device states are simulated from each scenario's hidden truth; in the live product the desk reads the real device.

## Who it is for and how it makes money

- An agent buying what it needs to keep working: a long-running Claude job on a laptop at low battery
  rents a charger so the task finishes.
- A consumer's personal agent rents a charger, battery pack, hotspot or locker on the go, and pays
  only the check fee (2 to 10 cents) when the user already has it.
- Business: a few cents per check plus a share of kept rentals. Venues list their own checks.

## Why Pay.sh and Solana

- The hold maps exactly onto Pay.sh's x402 `upto` scheme: authorize a ceiling, settle actual usage,
  the rest returns.
- A middleman charging a few cents per check only works when a settlement costs a fraction of a cent.
  On card rails the fee is larger than our whole margin.
- The agent pays per call in USDC with no account and no API key.

## Honest limits

- Everything runs in Pay.sh's sandbox. We chose not to run on mainnet for the hackathon: the mainnet path is configured (a config switch plus a few dollars of SOL for network fees) but has never been exercised.
- The Pay.sh sandbox drops roughly one payment in five with a transient facilitator error. The desk
  reports `settle_failed` and charges nothing, and the agent should retry once.
- The desk runs on the demo laptop because the checks read that laptop. Readings are signed by the
  desk's ed25519 key, published at `/v1/terms`. In production the check runs on the rented hardware,
  and the hardware signs the reading instead of the desk's key.
- The research pack packages public Crossref metadata; the paid service is packaging and structural
  validation (count, titles, unique DOIs), not relevance, quality, DOI resolution or full-text access.
- The benchmark uses generated scenarios and simulated device states (see the note above), and was
  recorded under the per-item pricing at 14:37 PDT on 2026-09-30.
- The Pay.sh catalog listing points at https://motto.tail039d5c.ts.net and passed the registry's live
  probe (6/6 paid endpoints, run under the flat $1 pricing before the research item existed; the probe
  is rerun after the desk restarts with seven items and per-item ceilings). The pull request to
  `solana-foundation/pay-skills` is open and not merged yet:
  https://github.com/solana-foundation/pay-skills/pull/280
  The desk runs in the Pay.sh sandbox, not as a live mainnet service.

## Built today with

Pay.sh (`@solana/pay-kit`, x402 `upto`), Solana, USDC, `@solana/kit`, Express, Claude (the buyer agent
through the `pay` CLI, and the benchmark models Fable 5.1 and Sonnet 5).

**Pre-existing work, disclosed.** The project plan (`PROJECT_PLAN.md`) and the research notes in
`prep/` were prepared ahead of the build and saved on event day at 11:01 to 11:04 PDT, around the
11:00 kickoff. They are planning and research only, with no product code, and the plan was updated
during the event (benchmark, team split, pitch). Beyond the npm
dependencies above, all code in this repository (desk server, checks, receipts, benchmark, dashboard,
slides, demo script) was written at the event. The first commit is at 11:20 PDT on 2026-09-30. We list
this because our plan says to disclose anything written before 11:00 (`PROJECT_PLAN.md` section 17).

## What is next

New checks are new lines in the catalog: locker open, package delivered, parking spot free, battery
swap done. The payment side does not change. After that:

- Metered billing (hours of hotspot, per minute storage) needs an MPP session channel, because an
  x402 `upto` hold has one deposit, one claim and a 300 second lifetime.
- Hardware-signed readings: the charger or venue hardware signs, not only the desk.
- Mainnet: the path is configured and has not been exercised; a first run with cents is the next step.
- Venue onboarding.
