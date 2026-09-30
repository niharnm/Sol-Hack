# Deposit Desk: Full Project Plan

Status: plan updated with benchmark, pitch and team split. Build starts when both of us say ready.
Event: Agent Hackathon, Solana Foundation + The AI Collective, San Francisco, 2026-09-30.
Repo: https://github.com/niharnm/Sol-Hack (private). Team: Nihar (product), Nithin (design, polish, demo).

Detail sheets from research live in `prep/` (COMMANDS.md, CHECKS_AND_CHAIN.md, PITCH_AND_DEMO.md,
SUBMISSION_TEMPLATE.md, PLAN.md). This file is the single source of truth; it supersedes prep/PLAN.md.

---

## 0. Team and Git workflow (read first)

Two people push to `main` at the same time, so every change starts and ends with a pull.

**Ownership (who edits what):**

| Area | Owner | Files |
|---|---|---|
| Product: desk server, checks, payments, receipts, benchmark, mainnet, Pay.sh catalog | Nihar | `deposit-desk/src/`, `deposit-desk/bench/`, `deposit-desk/package.json`, `deposit-desk/.env.example` |
| Look and demo: dashboard, sounds, animations, slides, video, README polish, demo script, QA of the full flow | Nithin | `deposit-desk/public/`, `slides/`, `demo/`, `deposit-desk/README.md`, `prep/PITCH_AND_DEMO.md` |
| This plan | Both | `PROJECT_PLAN.md` (small edits, pull right before editing) |

Contract between the two halves: the dashboard only depends on the API in section 7 (`/v1/terms`,
`/v1/holds`, `/v1/events`, `/v1/bench`). If Nihar changes a response shape, update section 7 in the
same commit and tell Nithin.

**Every time, in this order:**

```bash
git pull --rebase                 # before you start anything
# ...work in your own files...
git add <your files>              # never `git add -A` blindly; check `git status` first
git commit -m "short clear message"
git pull --rebase                 # again, right before pushing
git push
```

Rules:
- Pull before starting work, before every commit, and before every push. Commit and push small and often (every 20 to 30 minutes at most).
- Stay in your own files. If you must touch the other person's file, message them first.
- Conflict: stop, resolve it keeping both people's intent, run the app, then push. Never force push. Never `git reset --hard` on shared history.
- `package-lock.json`: only Nihar adds dependencies. Nithin asks if a package is needed.
- Secrets never go in Git: `.env`, `keys/`, keypair files are gitignored. Check `git status` before committing.
- Nithin setup: `git clone https://github.com/niharnm/Sol-Hack && cd Sol-Hack/deposit-desk && npm install && npm start`, then open http://127.0.0.1:8787. The sandbox needs no wallet; install `pay` (`brew install pay`) to trigger holds with `pay --sandbox curl -X POST http://127.0.0.1:8787/v1/rent/charger`.

---

## 1. The event

| Item | Fact |
|---|---|
| Theme | "Build something an agent would buy." A product, service, or API meant for agents. Consumer-focused. |
| Hosts | Solana Foundation, The AI Collective (presented by Solana San Francisco) |
| Schedule | 10:00 doors, 11:00 kickoff + Pay.sh workshop with Ludo, 16:00 submissions close, 17:00 top 5 live demos, 18:00 winners |
| Prizes | $1,500 / $500 / $250, one pool, no tracks |
| Not published | Judging criteria, judges, rules on pre-built code, team size, submission format |

**Ludo = Ludo Galabru**, creator of Pay.sh at the Solana Foundation (also Surfpool, Txtx; co-author of the
Solana HTTP payment auth draft). Very likely judging or advising judges.

## 2. What judges will reward (inferred from past rubrics and judges' public positions)

| Weight | Factor | What it means for us |
|---|---|---|
| 25 | It really runs | Agent pays live, gets value, transaction visible. Deployed, not localhost only |
| 20 | Built for agents | Agent discovers the desk, reads price and rules, pays with no human in the loop |
| 20 | Pay.sh + Solana | Uses Pay.sh natively (x402 `upto`), Solana-only economics visible |
| 15 | Novelty | Not a trading bot, wallet, API wrapper, marketplace or phone agent |
| 15 | Consumer + market | A real person benefits, non-speculative reason to pay, startup story |
| 5 | Demo risk | Backups, hotspot, funded wallets, warmed model |

Only 5 teams demo, so the 15:40 submission must win the top-5 slot on its own: repo, live URL, 2 min
video, Explorer links, Pay.sh listing or PR, "Pay.sh" and "x402" in the tagline.

Research sources and details: past winners (Solana x402 hackathon, SKALE/Coinbase SF, Colosseum,
Agent Natives), market data (x402 Bazaar oversupply, "the missing primitive is confidence"),
Solana novelty (Payment Channels, Subscriptions & Allowances). See conversation research notes
summarized in prep/.

## 3. The product

**One line:** a deposit desk for agents buying things in the real world. The agent puts $1 USDC on
hold, the desk checks whether the need is already handled, then keeps the money as the rental or sends
it back.

**Tagline:** "Agents only pay for things that actually happened."

**Positioning:** the desk is the company. The charger is the first check, the hotspot the second.
The check changes, the money does not. We show finished cases, not a catalog.

**Who buys:**
1. Primary story: an agent buying what it needs to keep working. A long-running Claude job on a laptop
   at low battery rents a charger so the task finishes.
2. Consumer story (slide): your personal agent rents a charger, battery pack, hotspot or locker for you
   on the go, and never pays for something you already have.

**Why this wins on the rubric:**
- The hold maps exactly onto Pay.sh's own `upto` primitive (Ludo's work).
- Physical-world wow moment (plug a cable in, money settles), like the self-paying chip that won
  Solana's x402 hackathon.
- Answers the real market gap: agents need confidence before spending, not another paid API.
- Deterministic on stage: a machine check, not a human or an LLM judgement.

## 4. Core mechanism (verified in docs and SDK source)

Pay.sh x402 `upto` scheme, via `@solana/pay-kit` 0.12.0:

1. Agent calls `POST /v1/rent/<item>` with no payment. Desk replies `402` with an x402 offer:
   `scheme: upto`, `amount: 1000000` (USDC base units = $1.00), network Solana.
2. Agent's `pay` client signs and retries. pay-kit verifies and escrows the ceiling onchain
   (the "hold").
3. Desk runs the check and records usage with `pay.charge(req).charge(baseUnits)`.
4. Desk calls `settle()`. Only the recorded amount is transferred to the desk; the rest returns to the
   agent. Settlement signature comes back in the response headers.

SDK facts (read from pay-kit source):
- Declare the gate with `usage(usd('1.00'))` in `createPayKit({ pricing })`. Usage gates are x402 only,
  so `accept: ['x402']`.
- `Charge.charge(n)` clamps to the ceiling; never setting it settles `0`.
- If the handler throws, pay-kit still seals the channel and refunds.
- Mainnet refuses the demo signer; needs `OPERATOR_KEY` and a real RPC.

Settlement amounts:

| Outcome | Charged | Returned |
|---|---|---|
| Already handled | $0.01 check fee | $0.99 |
| Need is real and delivered | $1.00 | $0.00 |
| Charger: power never arrived | $0.01 | $0.99 |

The 1 cent check fee is also the business model.

## 5. Checks (the part that changes per item)

| Item | Question | Source on macOS | Already handled | Need is real |
|---|---|---|---|---|
| Charger | Is the device on AC power? | `pmset -g ps` first line: `Now drawing from 'AC Power'` vs `'Battery Power'` (AC verified on this Mac; battery string to verify by unplugging once) | On AC at hold time | On battery, then AC appears within the wait window (default 30s) |
| Hotspot | Is the device on the venue network? | Default gateway from `route -n get default`, compared to `VENUE_GATEWAY` (SSIDs are redacted on macOS 27 without location permission, verified) | Gateway equals venue gateway | Any other gateway (e.g. phone hotspot) |

Current venue gateway reading on this Mac: `10.104.0.1` (confirm this is the venue wifi).

Signed readings: each reading `{holdId, item, outcome, detail, raw, ts}` is signed with a device
ed25519 key; signature and device public key go back to the agent and into the memo. Answer to "what
stops the device lying": device-signed now, charger or venue hardware signed next.

Edge cases to handle:
- Charger wait window must be shorter than the x402 `maxTimeoutSeconds` (300s in the offer). 30s is safe.
- Check throws: settle the $0.01 fee (or 0) and report `check_failed`, never keep $1.
- Settlement fails: report `settle_failed`, keep the reading, do not retry blindly.
- Two holds at once: each hold is independent; the dashboard shows both.

## 6. Architecture

```
Claude (buyer)  --pay claude / pay mcp-->  Deposit Desk API (Express + @solana/pay-kit)
                                              | 402 upto offer, verify, escrow
                                              | run check (pmset / route) + sign reading
                                              | charge(actual) -> settle -> refund rest
                                              v
                                           Solana (sandbox Surfpool while building, mainnet final)
                                              ^
Dashboard (static page, live via SSE) <-------+   optional receipt tx with memo from desk wallet
```

Decision: use pay-kit inside our own server, not the `pay gate api` proxy. Reason: the proxy has no
documented way for the upstream to report actual usage, while pay-kit's `Charge` meter does exactly
that. Ask Ludo to confirm.

The desk runs on the demo laptop because the checks read that laptop. A public URL comes from a
`cloudflared` tunnel. Honest framing: in production the check runs on the rented hardware.

## 7. API

| Method + path | Paid | Purpose |
|---|---|---|
| `GET /v1/terms` | free | Items, hold, fee, check question, refund rules, device public key |
| `POST /v1/rent/charger` | up to $1 | Body `{ wait_seconds }`. Runs charger check, settles |
| `POST /v1/rent/hotspot` | up to $1 | Runs network check, settles |
| `GET /v1/holds` | free | Hold log |
| `GET /v1/events` | free | Server-sent events for the dashboard |
| `GET /openapi.json` | free | OpenAPI with `x-payment-info` offers, for the Pay.sh catalog |
| `GET /v1/bench` | free | Benchmark results for the dashboard chart (to build, section 12) |

Response to the agent: `hold_id, item, outcome, decision (kept|refunded), charged_usd, returned_usd,
reason (plain English rule), signed_reading, settlement_tx, network`.

## 8. Onchain extras

- **Receipt memo:** desk wallet posts a memo-only tx per settlement:
  `DESK REFUND hold:ab12 charger device_on_AC sig:1f2e3d4c`. Use the legacy memo program
  `MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr` (Explorer renders it). Build the instruction by hand;
  `@solana-program/memo` 0.15 needs kit 8 but pay-kit pins kit 6.
- **Allowance cap:** on stage use `pay mcp --permissions` with `max_payment: "$1.00"`; show an over-cap
  attempt refused. Onchain Subscriptions & Allowances program is a stretch only.
- **Payment Channels (per-minute metering):** stretch only. Note `mpp-session` fails closed under
  `pay mcp --permissions`, so it cannot be combined with the cap demo.

Addresses: USDC mainnet `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`, devnet
`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`.

## 9. Buyer agent

- Build and test: `pay --sandbox curl -X POST <url>/v1/rent/charger`.
- Demo: Claude runs as a remote agent with pay tools only (no shell), so it cannot check the device
  itself and relies on the desk. Exact command in `deposit-desk/README.md`. Verified: Claude read the
  terms, held $1, got the signed reading, $0.99 came back, and called the hold "cheap insurance".
  Without the tool limit, Claude ran `pmset` itself and skipped renting, which is why the buyer is
  positioned as a cloud agent acting for a user's device.
- Final run with mainnet. Claude reads `/v1/terms`, reasons about
  the $1 hold and the refund rule, pays, reports the outcome.
- Discovery: listing in the Pay.sh catalog (`pay catalog scaffold`, `pay catalog check`, PR to
  `solana-foundation/pay-skills`) so Claude finds it with `pay skills search`. Needs a production https
  URL; a PR can be opened even if not merged by 17:00.

## 10. Dashboard (Nithin)

Single page served by the desk at `/`. Current version works (counters, live hold cards via SSE).
Nithin owns making it stage ready:
- Readable from the back of the room: huge counters for holds, kept, refunded, and "$ returned to agents".
- Big state change per hold: CHECKING, then KEPT (amber) or REFUNDED (green), with an animation.
- Sound: cash register on KEPT, a "coin back" sound on REFUNDED.
- Explorer links on mainnet holds; sandbox holds clearly labelled "sandbox".
- A benchmark view (section 12) with the wasted-spend chart.
- Optional "ask the room" screen: "Is this laptop plugged in? Should the agent pay?"

## 11. Demo (3 minutes, Nithin owns script and polish, Nihar runs the product)

Judges and the room decide together; at the YC hackathon the winners were the demos that got the most
applause. So the demo is built for energy and clarity, and every beat must make sense to a non-expert.

1. Hook (15s): "Agents are starting to spend money in the real world. They should never pay for something that already happened."
2. Refund (35s): ask the room "Is this laptop plugged in? Should the agent pay?" Claude (cloud agent, pay tools only) holds $1, desk checks, $0.99 slides back. Coin sound.
3. Keep (40s): unplug, hand the cable to someone in the audience. Claude holds $1, audience member plugs in, dashboard flips to KEPT. Cash register sound.
4. Second check (20s): hotspot, same desk, different check. "The check changes. The money does not."
5. Benchmark (25s): chart from section 12. "A cheaper model with Deposit Desk beat the frontier model on wasted spend."
6. Why middleman + Solana (25s): section 13 story in three lines.
7. Close (20s): real product, listed on Pay.sh, every new check is a new line in the catalog. End on the live counter.

Backups: phone hotspot, recorded backup video, mainnet Explorer tx open in a tab, model warmed.

## 12. Benchmark: "a cheaper model with the desk beats the frontier model" (Nihar)

Goal: a real, rerunnable result that shows we are technically better than a frontier model alone.

- **Scenarios:** about 50 personal-agent purchase situations generated by a script and committed to the
  repo (`bench/scenarios.json`): phone may need a charger, laptop may need a hotspot, and so on. Each has
  a hidden ground-truth device state (already handled or real need).
- **Agent A (frontier alone):** Fable 5.1 (`claude-fable-5-1`) gets the user's request and context text and decides buy or skip.
- **Agent B (ours):** Sonnet 5 (`claude-sonnet-5`) with the Deposit Desk hold: it holds, the desk checks the (simulated) device state, settles.
- **Metrics:** dollars wasted on unneeded purchases, real needs missed, total spend, cost per decision (model tokens + fees), latency.
- **Why we win:** no model can see whether a phone is plugged in; the frontier model guesses, the desk checks.
- **Honesty:** the slide says scenarios are generated and device states are simulated in the benchmark.
  Numbers are whatever the run produces; we report them as measured. Script and results live in `bench/`
  and are served at `GET /v1/bench` for the dashboard.
- Budget: about 75 minutes. If the frontier run is slow, run a 20-scenario subset and say so.

## 13. Pitch narrative: why the middleman matters (Nithin writes slides, Nihar checks facts)

- Every market of strangers needed a trusted middleman who held the money:
  PayPal became the trust layer for eBay (eBay bought it); Stripe sits between businesses and banks.
- In AI: OpenRouter sits between apps and model providers and routes the traffic; Pay.sh itself is a
  middleman between agents and paid APIs.
- Agents are the next strangers spending money. Someone has to hold the deposit. That is us.
- Solana link: a middleman charging 1 cent per check only works when a settlement costs a fraction of a
  cent. On card rails the fee is larger than our whole margin.
- Rule: any funding, revenue or usage number on a slide must be looked up and cited first.

## 14. Honesty rules for the demo and slides

- Live demo runs in the Pay.sh sandbox so nothing flakes, and we say so in one line: "Live demo is in
  Pay.sh's sandbox for reliability; here is the same flow on Solana mainnet with real USDC." Show one
  mainnet Explorer transaction.
- No invented statistics. Every number is measured by us (benchmark, settlement time, fees, live
  counters) or cited from a source.
- Things too slow for stage are shown as a recorded run or a transaction link, labelled as such.

## 15. Real product and expansion

- It is a real API today: `/v1/terms`, x402 `upto` holds, OpenAPI with payment offers, listed in the
  Pay.sh catalog (pay-skills PR).
- Expansion = new checks as small plugins, the payment side never changes: power, network, then locker
  open, package delivered, parking spot free, battery swap done.
- Business: 1 cent per check plus a share of kept rentals; venues list their own checks.

## 16. Build plan

| Step | Owner | Output | Status |
|---|---|---|---|
| B1 | Nihar | Desk server with charger hold, sandbox | Done |
| B2 | Nihar | Keep path, wait window, hotspot | Done (all three charger outcomes verified with a real unplug) |
| B3 | Nithin | Dashboard stage-ready (section 10) | Basic version done, polish to do |
| B4 | Nihar | Signed readings + receipt memo | Readings done; memo needs SOL in desk wallet |
| B5 | Nihar | Claude buyer run (remote agent, pay tools only) | Done |
| B6 | Nihar | Benchmark (section 12) + `/v1/bench` | To do |
| B7 | Nihar | Tunnel + one mainnet run with cents | Needs $5 USDC + 0.02 SOL |
| B8 | Nihar | OpenAPI + Pay.sh catalog PR | OpenAPI done, PR to do |
| B9 | Nithin | Slides (middleman, benchmark, why Solana), sounds, demo script | To do |
| B10 | Nithin | README polish, 2 min video, submission | To do, submit by 15:40 |

Feature freeze 15:15. Rehearse 3 times 16:00 to 17:00. Both of us run the full demo at least once before freeze.

## 17. Risks

| Risk | Mitigation |
|---|---|
| Mainnet wallet setup needs Touch ID / keychain | Nihar runs `pay setup --backend keychain` in their own terminal |
| Mainnet funding | `pay topup` (PayPal, Venmo, Apple Pay, wallet); about $5 USDC plus a little SOL for the desk fee payer |
| upto settlement quirks on mainnet | Test with 1 cent early; fallback is sandbox demo, said openly |
| Venue wifi blocks the tunnel | Phone hotspot |
| Pre-built code rules | Ask at kickoff; disclose anything written before 11:00 |
| Keys leak | `.gitignore` covers `.env`, `keys/`, keypairs; secrets only in env |

## 18. Open questions (ask Ludo / organizers)

1. Judging criteria, how top 5 are picked, submission link and format.
2. Is code written before 11:00 allowed? Team size?
3. Mainnet expected, or sandbox fine?
4. Behind `pay gate api` proxy, how does an upstream report actual `upto` usage? (We plan pay-kit direct.)
5. Can `upto` settle 0? Any minimum?
6. Can hackathon entries be fast-tracked into the Pay.sh catalog?
7. Are MPP sessions / Payment Channels stable enough for a live demo?

## 19. Mac setup checklist

| Item | Status |
|---|---|
| Node 26, npm, pnpm, bun, python3, gh, docker, vercel CLI, claude CLI | Installed |
| Project dependencies (`deposit-desk/node_modules`) | Installed, server boots |
| `pay` CLI 0.29.0 | Installed, sandbox paid calls verified |
| Sandbox wallet | 999 USDC on localnet (auto funded by pay) |
| Mainnet pay account (buyer agent) | `uGYpMV8USCcDhyysbFeqFTNMMFX4dqczzg47xC33Woi` (Apple Keychain) |
| Mainnet funds (buyer) | Done: 5.00 USDC confirmed with `pay whoami` |
| Desk wallet (operator, fee payer, receipts) | `7Y4oheKe91GGFHN3sPZadu3cYkH1GKi1AJ9XRW5ZRviu`, keypair `keys/desk.json` (gitignored, mode 600). Balance 0 SOL. BLOCKER for mainnet: send ~0.02 SOL. Devnet and sandbox faucets were rate limited / down when tried |
| `cloudflared` tunnel | Installed and tested: public URL served `/v1/terms` and returned `402` on a hold |
| Local mainnet config | `deposit-desk/.env.mainnet` (gitignored). No secrets in it; keys passed at launch |
| Agent spending cap | `deposit-desk/pay-permissions.yml` (max $1.00 per payment) |
| Venue gateway | `10.104.0.1` set as `VENUE_GATEWAY`; confirm it is the venue wifi |
| Nithin repo access | Invite sent to `nithinaru`, pending acceptance |
| Solana CLI | Not installed (Homebrew lock). Not needed |
| Benchmark | Done, results in `deposit-desk/bench/results.json` |

## 20. Launch commands (demo day)

```bash
cd deposit-desk
# Sandbox (default, used for the live demo)
npm start
# Mainnet (one proof transaction), once the desk wallet has SOL
OPERATOR_KEY="$(cat ../keys/desk.json)" RECEIPT_KEY="$(cat ../keys/desk.json)" node --env-file=.env.mainnet src/server.js
# Public URL
cloudflared tunnel --url http://127.0.0.1:8787
# Trigger a hold by hand
pay --sandbox curl -X POST http://127.0.0.1:8787/v1/rent/charger
pay --mainnet curl -X POST http://127.0.0.1:8787/v1/rent/charger
# Claude as the buyer: see deposit-desk/README.md (pay tools only, no shell)
# Rerun benchmark
npm run bench
```
