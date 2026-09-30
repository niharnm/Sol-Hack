# Deposit Desk: Full Project Plan

Status: plan approved, building from `deposit-desk/`.
Event: Agent Hackathon, Solana Foundation + The AI Collective, San Francisco, 2026-09-30.
Repo: https://github.com/niharnm/Sol-Hack (private, empty, remote connected, nothing pushed).

Detail sheets from research live in `prep/` (COMMANDS.md, CHECKS_AND_CHAIN.md, PITCH_AND_DEMO.md,
SUBMISSION_TEMPLATE.md, PLAN.md). This file is the single source of truth; it supersedes prep/PLAN.md.

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
- Demo: `pay --sandbox claude "<task>"`, final run with mainnet. Claude reads `/v1/terms`, reasons about
  the $1 hold and the refund rule, pays, reports the outcome.
- Discovery: listing in the Pay.sh catalog (`pay catalog scaffold`, `pay catalog check`, PR to
  `solana-foundation/pay-skills`) so Claude finds it with `pay skills search`. Needs a production https
  URL; a PR can be opened even if not merged by 17:00.

## 10. Dashboard

Single page served by the desk: counters (holds, kept, refunded, dollars returned to agents), a live
card per hold (item, status, check detail, device signature, settlement and receipt links to Explorer
on mainnet). Dark, large type, readable from the back of the room.

## 11. Demo (3 minutes)

1. Hook (15s): agents are starting to buy the real world; they should not pay for things that already happened.
2. Refund (40s): laptop plugged in, Claude rents a charger, check says already on AC, $0.99 back, Explorer memo.
3. Keep (40s): unplug, Claude rents again, plug in within the window, charging verified, $1 kept.
4. Second check (25s): on phone hotspot, Claude rents venue connectivity, rental kept; switch to venue wifi, refunded.
5. Why Solana (20s): sub-cent settlement with the reason onchain; card fee would eat 30% of a $1 hold; capped by the user's allowance.
6. Business and close (40s): the desk is the company, every check is a catalog line, 1 cent per hold; close on "N holds settled, $X returned today".

Backups: phone hotspot, backup video, earlier Explorer tx open, model warmed.

## 12. Build plan (start only after this plan is approved)

| Step | Output | Done when |
|---|---|---|
| B1 | Desk server with charger gate, sandbox | `pay --sandbox curl` returns a settled refund |
| B2 | Keep path + wait window, hotspot gate | Both outcomes for both items settle |
| B3 | Dashboard + SSE | Live cards update during a hold |
| B4 | Signed readings + receipt memo | Memo visible on Explorer (mainnet) |
| B5 | Claude buyer run | Claude completes a rental unprompted |
| B6 | Tunnel + mainnet run with cents | Two mainnet Explorer links |
| B7 | OpenAPI + catalog PR draft | `pay catalog check` passes |
| B8 | README, video, submit | Submitted by 15:40 |

Feature freeze 15:15. Rehearse 3 times 16:00 to 17:00.

Decision: keep `deposit-desk/` as the starting point. It was written after 11:00 kickoff, matches this
plan, and already covers B1 and B3 plus most of B2 and B4: a sandbox refund (charger, device on AC) and
a sandbox keep (hotspot, off venue network) both settled with real settlement signatures. Still to
verify: the charger keep path by unplugging, the receipt memo, and the mainnet run.

## 13. Risks

| Risk | Mitigation |
|---|---|
| Mainnet wallet setup needs Touch ID / keychain | Nihar runs `pay setup --backend keychain` in their own terminal |
| Mainnet funding | `pay topup` (PayPal, Venmo, Apple Pay, wallet); about $5 USDC plus a little SOL for the desk fee payer |
| upto settlement quirks on mainnet | Test with 1 cent early; fallback is sandbox demo, said openly |
| Venue wifi blocks the tunnel | Phone hotspot |
| Pre-built code rules | Ask at kickoff; disclose anything written before 11:00 |
| Keys leak | `.gitignore` covers `.env`, `keys/`, keypairs; secrets only in env |

## 14. Open questions (ask Ludo / organizers)

1. Judging criteria, how top 5 are picked, submission link and format.
2. Is code written before 11:00 allowed? Team size?
3. Mainnet expected, or sandbox fine?
4. Behind `pay gate api` proxy, how does an upstream report actual `upto` usage? (We plan pay-kit direct.)
5. Can `upto` settle 0? Any minimum?
6. Can hackathon entries be fast-tracked into the Pay.sh catalog?
7. Are MPP sessions / Payment Channels stable enough for a live demo?

## 15. Mac setup checklist

| Item | Status |
|---|---|
| Node 26, npm, pnpm, bun, python3, gh, docker, vercel CLI | Installed |
| `pay` CLI 0.29.0 | Installed, sandbox paid call verified |
| Sandbox wallet | Created by pay, 999 USDC on localnet |
| Mainnet pay account (buyer agent) | Created: `uGYpMV8USCcDhyysbFeqFTNMMFX4dqczzg47xC33Woi` (Apple Keychain), confirmed with `pay whoami` |
| Mainnet funds | TODO Nihar: `pay topup` about $5 USDC |
| `cloudflared` (public URL tunnel) | Installed 2026.9.3 |
| Solana CLI | Not installed (Homebrew lock). Optional; wallets can be made with `pay account new` |
| Desk wallet (operator + fee payer + receipt) | Created: `7Y4oheKe91GGFHN3sPZadu3cYkH1GKi1AJ9XRW5ZRviu`, keypair at `keys/desk.json` (gitignored, mode 600). TODO: send it ~0.02 SOL on mainnet for fees |
| Venue gateway | Current reading `10.104.0.1`; confirm it is the venue wifi |
| Git repo + remote | Initialized at this folder, remote `origin` = Sol-Hack, nothing committed or pushed |
| Vercel CLI | 59.11.2 (outdated; `npm i -g vercel@latest` if we deploy there) |
