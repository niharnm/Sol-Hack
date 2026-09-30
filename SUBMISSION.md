# Motto

> An agent authorizes a dollar. We verify delivery, settle what’s owed, and return the rest. A deposit desk for agents buying things in the real world, built on Pay.sh x402 `upto` holds and settled in USDC on Solana.

**Live:** https://motto.tail039d5c.ts.net (Pay.sh sandbox desk, runs on Nihar's laptop through Tailscale Funnel) | **Video (2 min):** TODO before submit: video link | **Pay.sh listing / PR:** https://github.com/solana-foundation/pay-skills/pull/280

**Repo:** https://github.com/niharnm/Sol-Hack (TODO before submit: the repo is private today, make it public or add the judges) | **Team:** Nihar (product), Nithin (design, polish, demo)

## The problem

Agents are starting to spend money in the real world, and the agent that pays is often not where the
device is. A cloud agent working for a user's laptop cannot see whether the laptop is already plugged
in, so it either guesses or pays for something that already happened.

## What we built

A deposit desk. The agent puts $1 USDC on hold. The desk checks the device. If the need is already
handled, the desk keeps a $0.01 check fee and $0.99 returns to the agent. If the need is real, the
desk keeps the $1.00 as the rental.

The charger is the first check (is the device on AC power?), the hotspot is the second (is the device
on the venue network?). The check changes. The money does not.

The hold is Pay.sh's own x402 `upto` scheme: the agent authorizes a ceiling, the desk settles only
what it is owed, and the rest returns automatically. No custom refund code.

## Proof (sandbox)

Everything runs in the Pay.sh sandbox (test USDC on localnet), so there are no Explorer links. These
three holds were recorded on the demo laptop on 2026-09-30 and are exported with their device-signed
readings in `motto/proof/sandbox-holds.json`. `node motto/proof/verify.mjs` checks each signature
against the desk's device key and that charged plus returned equals the $1.00 hold. It does not
confirm the sandbox transactions themselves.

- Refund (device already on AC): hold `ac7fee75`, $0.01 charged, $0.99 returned. Sandbox tx
  `3bPfkmJsZcBWnNp3YPysCdXkDcc49WZiLymDEUq999xJzgR2V7qrwusarfHUVgWiF5apSguFcJ6PwinQBxLpEx8P`
- Keep (charging verified after a real plug-in): hold `1f4dc261`, $1.00 charged. Sandbox tx
  `5DeywCCzf3LrGZGX8efajcHCH1mMWbxhi5kuPKzVB2fFN3521WFmGgWyy1qcaK14Zuodr8y7gTzEKNB1oXXXF2jH`
- Keep (hotspot, device off the venue network): hold `4256f6d4`, $1.00 charged. Sandbox tx
  `5K7gvcKPhgtzQDobVgpT4gJ4yqvUjqicNzjsZnuvmYuBGV8oMAXCb6Frd1HG6APq5b2UFUqphgJvLESESBzrM1rd`

## How it works

1. A buyer agent (Claude via `pay claude` or `pay mcp`) reads the desk's terms at `GET /v1/terms`:
   the items, the $1.00 hold, the $0.01 check fee, the check question and the refund rules.
   `GET /openapi.json` carries the x402 offers for the Pay.sh catalog. The listing is prepared in
   `motto/CATALOG.md` and `motto/catalog/` (PR: https://github.com/solana-foundation/pay-skills/pull/280).
2. The agent calls `POST /v1/rent/<item>`. The desk answers `402` with an x402 `upto` offer for $1.00
   USDC, the agent's `pay` client signs and retries, and `@solana/pay-kit` escrows the $1.00 ceiling.
   That is the hold.
3. The desk runs the check for that item (power or network) and signs the reading with its ed25519
   device key. The signed reading goes back to the agent.
4. Already handled: $0.01 check fee, $0.99 returns to the agent. Need is real: the $1.00 is kept as
   the rental. Charger never delivers power: $0.01, $0.99 returns. Each settlement can carry a receipt
   memo with the reason (`DESK REFUND hold:ab12 charger device_on_AC sig:1f2e3d4c`), and the dashboard
   shows every hold live.

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
wasted $0.19 and missed no real need, Fable 5.1 alone wasted $16.00. Same 50 generated purchase
scenarios for every run, 31 of them real needs. The two runs without the desk choose between buy and
skip from text context. The third can also put a hold on the desk, and it held in all 50 scenarios.
Results are in `motto/bench/results.json` (`ranAt` 2026-09-30T18:45:33.372Z) and served at
`GET /v1/bench`.

| Run | Model | Scenarios | Wasted (USD) | Missed needs | Real needs | Needs met | Total spend (USD) | Model cost (USD) | Avg latency (ms) |
|---|---|---|---|---|---|---|---|---|---|
| Fable 5.1 alone | `claude-fable-5-1` | 50 | 16.00 | 2 | 31 | 93.5% | 45.00 | 1.1504 | 5828 |
| Sonnet 5 alone | `claude-sonnet-5` | 50 | 7.00 | 16 | 31 | 48.4% | 22.00 | 0.1095 | 3717 |
| Sonnet 5 + Motto | `claude-sonnet-5` | 50 | 0.19 | 0 | 31 | 100% | 31.19 | 0.1207 | 3770 |

> Scenarios are generated (bench/generate.js, seeded). Device states are simulated from each scenario's hidden truth; in the live product the desk reads the real device.

## Who it is for and how it makes money

- An agent buying what it needs to keep working: a long-running Claude job on a laptop at low battery
  rents a charger so the task finishes.
- A consumer's personal agent rents a charger, battery pack, hotspot or locker on the go, and pays
  only the 1 cent check fee when the user already has it.
- Business: 1 cent per check plus a share of kept rentals. Venues list their own checks.

## Why Pay.sh and Solana

- The hold maps exactly onto Pay.sh's x402 `upto` scheme: authorize a ceiling, settle actual usage,
  the rest returns.
- A middleman charging 1 cent per check only works when a settlement costs a fraction of a cent. On
  card rails the fee is larger than our whole margin.
- The agent pays per call in USDC with no account and no API key.

## Honest limits

- Everything runs in Pay.sh's sandbox. We chose not to run on mainnet for the hackathon: the mainnet path is configured (a config switch plus a few dollars of SOL for network fees) but has never been exercised.
- The desk runs on the demo laptop because the checks read that laptop. In production the check runs
  on the rented hardware, and the hardware signs the reading instead of the desk's device key.
- The benchmark uses generated scenarios and simulated device states (see the note above).
- The Pay.sh catalog listing points at https://motto.tail039d5c.ts.net and passes the registry's live
  probe (6/6 paid endpoints). The pull request to `solana-foundation/pay-skills` is open and not merged
  yet: https://github.com/solana-foundation/pay-skills/pull/280
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
swap done. The payment side does not change. After that: hardware-signed readings (the charger or
venue hardware signs, not only the desk), venue onboarding, and Payment Channels for per minute
metering.
