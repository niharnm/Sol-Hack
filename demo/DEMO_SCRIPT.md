# Deposit Desk: 3 minute demo script

Seven beats, 3:00 total. The live demo runs in Pay.sh's sandbox (test USDC). Nihar runs the product.
Nithin narrates. Sources: `PROJECT_PLAN.md` sections 11, 12, 13, 14 and 20, `prep/PITCH_AND_DEMO.md`,
`deposit-desk/README.md`.

## Who does what

| Who | Does |
|---|---|
| Nihar | Runs every command on the demo laptop. Unplugs the charger cable and hands it to the volunteer. Advances the slides. |
| Nithin | Narrates every beat, asks the room, briefs the volunteer, watches the clock. |
| Volunteer (audience) | Plugs the cable back into the laptop in beat 3, and only when Nithin says so. |

## Timeline

| Time | Beat | Screen | Length |
|---|---|---|---|
| 0:00 | 1. Hook | Slide 1, then slide 2 | 15s |
| 0:15 | 2. Refund | Terminal (left) and dashboard (right) | 35s |
| 0:50 | 3. Keep | Terminal and dashboard | 40s |
| 1:30 | 4. Second check | Terminal and dashboard | 20s |
| 1:50 | 5. Benchmark | Slide 3 (or the dashboard benchmark chart) | 25s |
| 2:15 | 6. Why middleman, why Solana | Slide 4 | 25s |
| 2:40 | 7. Close | Dashboard fullscreen, live counter | 20s |

## Stage setup

- Laptop A is the demo laptop and the desk runs on it, because the checks read this laptop. Charger
  cable within reach. Laptop starts on AC power.
- Screen: left half Claude terminal, right half dashboard (`http://127.0.0.1:8787/`). Put the slides in
  their own fullscreen window (`open slides/index.html` from the repo root) so switching is one
  keystroke. Slide keys: arrow keys or click, `f` for fullscreen.
- Phone hotspot on. Backup video cued in a browser tab (TODO before demo: record the backup video and
  cue it). Mainnet Explorer transaction open in a tab only if a mainnet proof run happened (TODO
  before demo: Explorer link, or skip).
- Sound: click the Sound button on the dashboard until it reads Sound on, then test the volume.
  Browsers block audio until a click, so click the page once after any reload. Kept and Refunded each
  play their own sound.
- Model warmed with one call right before walking up: run the buyer command once (below).
- Volunteer picked and briefed before the demo starts.

## Commands

Start the desk from the repo root. Start it while the laptop is on the venue wifi so the hotspot check
compares against the real venue gateway, then join the phone hotspot:

```bash
cd deposit-desk
VENUE_GATEWAY="$(route -n get default | awk '/gateway:/{print $2}')" npm start     # sandbox, http://127.0.0.1:8787
```

Pre-flight, with the laptop on AC power:

```bash
curl -s http://127.0.0.1:8787/v1/terms | head -c 300
pay --sandbox curl -X POST http://127.0.0.1:8787/v1/rent/charger     # expect refunded, $0.99 back
pay --sandbox curl -X POST http://127.0.0.1:8787/v1/rent/hotspot     # phone hotspot: expect kept. Venue wifi: expect refunded
```

Sandbox quirk measured on 2026-09-30: about 1 in 10 to 15 sandbox paid calls fails inside pay-kit's
channel broadcast against the sandbox RPC (the desk logs `payment rejected: invalid_upto_svm_channel_broadcast`),
usually as a 30 second stall followed by `Server returned 402 again after payment` or a `settle_failed`
card on the dashboard. The retry settles in about 4 seconds. So run the pre-flight holds above right
before walking up, and if a hold on stage takes longer than 15 seconds, say "sandbox is warming up"
and rerun the same command.

Test holds show up on the dashboard counters, and the hold log (`deposit-desk/data/holds.jsonl`) is
reloaded when the desk starts, so the counters survive a restart. That is fine: at the close read the
live numbers off the screen, never a number you did not see.

The buyer command (Claude as a remote agent, pay tools only, no shell). Paste it once, then recall it
with the up arrow for beat 3:

```bash
echo "You are a personal agent running in the cloud for your user. Your user's laptop is at a hackathon and has a long job running; you cannot inspect the laptop yourself. A deposit desk sells refundable charger holds for that device; terms are at http://127.0.0.1:8787/v1/terms. Use your pay tools to read the terms and, if it makes sense, rent. Report in 3 short lines: what you paid, what came back, and why." \
  | pay --sandbox claude -p --allowedTools "mcp__pay__*" \
      --disallowedTools "Bash,Read,Glob,Grep,Write,Edit,WebFetch,WebSearch,Agent,NotebookEdit"
```

Direct fallback and beat 4 (same desk, same money path, no model in the loop):

```bash
pay --sandbox curl -X POST http://127.0.0.1:8787/v1/rent/charger
pay --sandbox curl -X POST http://127.0.0.1:8787/v1/rent/hotspot
```

Optional public URL, if a judge or the submission needs it:

```bash
cloudflared tunnel --url http://127.0.0.1:8787
```

## The script

### Beat 1. Hook (0:00 to 0:15)

Screen: slide 1. Press right to slide 2 (the loop) for the last 5 seconds.

Nithin: "An agent authorizes a dollar. We verify delivery, settle what’s owed, and return the rest."

Nihar: nothing to run. Laptop on AC power, desk running.

### Beat 2. Refund (0:15 to 0:50)

Screen: terminal and dashboard.

Nithin, to the room: "Is this laptop plugged in? Should the agent pay?" Take a second for answers.
"Our buyer is Claude, a cloud agent working for the user. It has pay tools only, no shell, so it cannot
look at the laptop."

Nihar runs the buyer command.

Expect: the big word on the dashboard goes Checking, then Refunded (green), with the refund sound.
Claude reports three short lines: what it paid, what came back, why.

Nithin: "The desk checked the laptop. It is already on power. One cent for the check, $0.99 back.
Nobody clicked anything."

If Claude has not placed the hold by about 0:35, Ctrl-C and run the direct charger command instead.

### Beat 3. Keep (0:50 to 1:30)

Physical steps: Nihar unplugs the cable (the laptop is now on battery) and hands the cable to the
volunteer. The volunteer stands at the laptop's port and does NOT plug in yet.

Nithin, to the volunteer: "When the dashboard says the device is on battery and waiting for power,
plug it in."

Nihar runs the buyer command again (up arrow).

Expect: the big word says Checking and the line under it says "Device is on battery. Waiting for power
to arrive". The desk waits up to 30 seconds (`CHARGER_WAIT_MS`, default 30000). The volunteer plugs in,
the next check reads AC power, and the word flips to Kept (amber), with the keep sound.

Nithin: "Now the need is real. The laptop was on battery, power arrived, so the desk keeps the dollar."

Edge cases:
- Nobody plugs in within 30 seconds: the desk charges the $0.01 fee and returns $0.99, because power
  never arrived. Narrate it as the third outcome: "If the power never comes, the agent pays one cent for
  the check, nothing for the charger."
- The volunteer plugs in too early, before the desk reads the battery: the desk sees AC power and
  refunds. Say "that is the first case again" and move on to beat 4.

### Beat 4. Second check (1:30 to 1:50)

Nihar runs the direct hotspot command.

Setup: the laptop is on the phone hotspot (joined before the demo). The desk was started on the venue
wifi with `VENUE_GATEWAY` set to that wifi's gateway, so the check now reads a different default
gateway: device off the venue network, need is real, $1.00 kept. The word goes Kept (amber).

Nithin: "Same desk, different check: is this laptop on the venue network? It is on my phone's hotspot,
so the need is real and the dollar is kept. The check changes. The money does not."

Variant: if the laptop is on the venue wifi, the same command is refunded ($0.01 fee, $0.99 back).
Narrate whichever happens.

### Beat 5. Benchmark (1:50 to 2:15)

Screen: slide 3, or click the Benchmark button in the dashboard header to jump to its benchmark
chart. Every number comes from `deposit-desk/bench/results.json`.

Nithin: "Fifty generated scenarios, the same for every run. Fable 5.1 alone wasted sixteen dollars.
Sonnet 5 alone wasted seven and missed sixteen real needs. Sonnet 5 with the desk wasted nineteen
cents and missed none. A cheaper model with Deposit Desk beat the frontier model on wasted spend.
Scenarios are generated and device states are simulated; the live desk reads the real device."

### Beat 6. Why the middleman, why Solana (2:15 to 2:40)

Screen: slide 4.

Nithin, three lines:
1. "Every market of strangers needed a middleman who holds the money: PayPal for eBay, Stripe between
   businesses and banks, OpenRouter between apps and model providers."
2. "Pay.sh sits between agents and paid APIs, and agents are the next strangers spending money. Someone
   has to hold the deposit."
3. "A one cent check only works when a settlement costs a fraction of a cent. That is why Solana."

Do not quote funding, revenue or usage figures about any company. Any such number must be looked up and
cited first (`PROJECT_PLAN.md` section 13).

### Beat 7. Close (2:40 to 3:00)

Screen: dashboard, press `f` for fullscreen. End on the live counter.

Nithin: "Live demo runs in Pay.sh's sandbox. Going live on mainnet is a config switch plus a few dollars
of SOL for network fees. Every new check is a new line in the catalog: locker, parking, battery swap.
The desk has settled [N] holds and returned [$X] to agents today. The check changes. The money does
not."

Read [N] and [$X] off the counters on screen. Do not say mainnet has been run: the mainnet path is
configured but has not been exercised end to end.

TODO before demo: the plan says to close on "listed on Pay.sh". Say that only if the catalog PR is
merged. If it is open say "submitted to the Pay.sh catalog". Otherwise say "ready for the Pay.sh
catalog" (PR link: TODO before submit).

## Backups

| If | Then |
|---|---|
| Claude is slow or errors | Ctrl-C and run the direct charger command. Say: "Same desk, same money path." |
| Venue wifi is down or blocks the tunnel | Use the phone hotspot. The desk and the dashboard are local. |
| The volunteer is late or early | See the beat 3 edge cases. Both outcomes are real desk outcomes. |
| Sound fails | Check the Sound button, click the page once, or say the state out loud: "kept", "refunded". |
| Dashboard stops updating | Reload `http://127.0.0.1:8787/`. |
| Desk crashed | Restart it with the start command above, then reload the dashboard. The hold log is reloaded, so the counters survive. |
| Nothing works | Play the recorded backup video and say it is a recording (TODO before demo: record and cue it). |

Things too slow for stage are shown as a recorded run or a transaction link, labelled as such.
Sandbox holds have no Explorer link; say so if asked.

## Numbers you may say

From `deposit-desk/bench/results.json` (50 scenarios, 31 real needs):

| Run | Wasted | Missed needs | Needs met |
|---|---|---|---|
| Fable 5.1 alone | $16.00 | 2 | 93.5% |
| Sonnet 5 alone | $7.00 | 16 | 48.4% |
| Sonnet 5 + Deposit Desk | $0.19 | 0 | 100% |

Plus the live counters on the dashboard. No other numbers unless they are on screen or in
`PROJECT_PLAN.md`.

## Likely judge questions

- **What stops the device lying?** Today the desk signs each reading with an ed25519 device key, and
  the signature and device public key go back to the agent and into the receipt memo. In the demo the
  desk and the device are the same laptop, so the honest answer is that it trusts that device. Next,
  the charger or venue hardware signs the reading, and in production the check runs on the rented
  hardware.
- **Why would an agent rent a charger?** A long-running Claude job on a laptop at low battery needs
  power to finish. A consumer's personal agent rents a charger, hotspot or locker for its user on the
  go. It cannot see the device, so it needs the desk to say whether the need is real.
- **Why not Stripe?** A 1 cent check only works when a settlement costs a fraction of a cent. On card
  rails the fee is larger than our whole margin. The agent also needs no account or API key: it pays
  per call in USDC.
- **Why not just check first, then pay?** The agent cannot check, because it cannot see the device.
  The hold is the commitment: the money is escrowed, the desk checks, then settles only what is owed.
  Same pattern as a hotel card hold, with the reason attached. Nothing is paid to the desk until it
  settles.
- **Can the desk overcharge?** No. The hold is a ceiling: the desk can settle at most the $1.00 the
  agent authorized. The agent side cap is `pay-permissions.yml` (max $1.00 per payment).
- **Is this mainnet or real money?** Live demo runs in Pay.sh's sandbox. Going live on mainnet is a
  config switch plus a few dollars of SOL for network fees. If a mainnet proof exists, open its
  Explorer link (TODO before demo).
- **Is the benchmark fair?** It measures buying decisions with and without a device check. Scenarios
  are generated and seeded (`bench/generate.js`), device states are simulated from each scenario's
  hidden truth, and every run gets the same 50 scenarios. The no-desk runs see only text context, the
  way a cloud agent does, and the desk run can also hold. Rerun it with `npm run bench`.
- **What if something breaks mid-hold?** If the check fails the desk reports `check_failed` and charges
  nothing, never the $1.00. If the desk itself crashes after the hold opened, it settles the hold at
  zero on the way out; if that settle fails too, the escrow returns to the agent when the x402 offer
  times out (300 seconds). If settlement fails the desk reports `settle_failed`, keeps the reading, and
  does not retry on its own.
- **How does an agent find the desk?** It reads `GET /v1/terms`. `GET /openapi.json` carries the x402
  payment offers for the Pay.sh catalog, so agents can find it with `pay skills search` once the
  listing is merged (PR link: TODO before submit).
- **How does it make money?** 1 cent per check plus a share of kept rentals. Venues list their own
  checks.
- **What is next?** New checks as catalog lines (locker, parking, battery swap), hardware-signed
  readings, venue onboarding, Payment Channels for per minute metering.

## Rehearsal

Both Nihar and Nithin run the full demo at least once before the 15:15 feature freeze. Rehearse three
times between 16:00 and 17:00. Top 5 live demos start at 17:00.
