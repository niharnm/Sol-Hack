# Motto: Build Plan

Name: **Motto** (earlier working name: Deposit Desk; alternatives: HoldBack, Proof Desk, Refundable).

One line: a deposit desk for agents buying things in the real world. The agent puts USDC on hold,
the desk checks whether the thing is already handled, then either keeps the money as the rental or
sends it back. Every settlement carries an onchain memo that says why.

## Target score (inferred rubric)

| Row | Target | What gets us there |
|---|---|---|
| It runs (25) | 25 | Deployed URL, both outcomes live on mainnet with cents, rehearsed 3x, backup video |
| Agent native (20) | 20 | Claude discovers the desk via Pay.sh, reads machine-readable terms, reasons about budget, gets a signed receipt |
| Pay.sh + Solana (20) | 20 | Sold behind `pay` gateway, memo on every settlement, user allowance cap, Payment Channels metering if stable |
| Novelty (15) | 15 | Second check (hotspot) live, device-signed check readings in the memo |
| Consumer + market (15) | 15 | Buyer line, business model, wedge slide with one verified market figure |
| Demo risk (5) | 5 | Hotspot, funded wallets, pre-opened Explorer tabs, warmed model, backup video |

## Architecture

```
 Claude (buyer agent)
   | pay mcp / pay claude  (discovers desk, sees price + terms)
   v
 Pay.sh gateway  (402 challenge, USDC settles to DESK wallet)
   | proxies paid request
   v
 Desk API (upstream)
   POST /hold      { check: "power" | "network", deviceId }   -> holdId, terms
   POST /settle    { holdId }  runs check, then:
                     already handled  -> REFUND tx (desk wallet -> agent wallet) + memo
                     not handled      -> KEEP, start rental, memo on a receipt tx
   GET  /holds     live feed for dashboard
   GET  /terms     machine-readable pricing + refund rules
   |
   v
 Device agent (runs on the demo laptop)
   power check:   pmset -g batt  -> "AC Power" vs "Battery Power"
   network check: curl a known URL with short timeout
   signs reading with a device ed25519 key -> signature goes into memo
   |
   v
 Solana (mainnet for final run, sandbox/devnet while building)
   Explorer shows: hold payment, refund or keep, memo text
 Dashboard (single page): hold amount, check result, settlement, Explorer links, running totals
```

Note on the hold: Pay.sh's `x402-upto` scheme IS the hold. The agent authorizes up to $1, the desk
settles actual usage ($0.01 check fee if already handled, $1.00 if the rental is real), and the
rest is refunded by the protocol. See COMMANDS.md. Fallback if upto is awkward behind the proxy:
fixed x402 charge into the desk wallet plus a USDC refund transfer with a memo. Payment Channels
(`mpp-session`, per minute metering) is the stretch goal. Note sessions fail closed under
`pay mcp --permissions`, so a metered demo cannot also show the allowance cap.

## Timeline (build window 11:00 to 16:00, submit by 15:40)

| Time | Goal | Done when |
|---|---|---|
| 10:40 to 11:00 | Install pay CLI, `pay setup`, fund wallets (sandbox first) | `pay whoami` works, sandbox call succeeds |
| 11:00 to 11:45 | Workshop. Ask Ludo the kickoff questions below | Answers written in this file |
| 11:45 to 12:30 | Desk API `/hold` + `/settle` + power check, behind local `pay` gateway, sandbox | One paid call end to end |
| 12:30 to 13:30 | Refund path + memo, keep path + memo, network check | Both outcomes produce Explorer links |
| 13:30 to 14:15 | Deploy gateway + API, `pay mcp` so Claude discovers and rents on its own | Claude completes a rental with no clicks |
| 14:15 to 15:00 | Dashboard, device signing, allowance cap. Payment Channels only if stable | Dashboard shows live settlements |
| 15:00 to 15:15 | Mainnet run with cents, record backup video | Two real mainnet tx links saved |
| 15:15 | FEATURE FREEZE | |
| 15:15 to 15:40 | README, 2 min video, catalog PR draft, submit | Submitted |
| 16:00 to 17:00 | Rehearse demo 3x, prep hotspot and tabs | |

## Roles (fill in names)

- Payments: pay gateway, wallets, refund + memo transactions
- Desk + device: API, checks, device signing
- Agent + demo: Claude via pay mcp, dashboard, pitch, video

Solo: follow the timeline top to bottom and cut from the bottom of the priority list.

## Priority (cut from the bottom)

1. Must: both outcomes live, memos, Claude buys via Pay.sh, network check, slide
2. Should: device-signed readings, allowance cap, catalog PR
3. Nice: Payment Channels metering

## Kickoff questions (ask organizers / Ludo)

- Judging criteria and weights? How are the top 5 chosen?
- Is code written before 11am allowed? Team size limit?
- Is mainnet expected or is sandbox fine?
- Does a Pay.sh catalog listing count? Can hackathon entries be fast-tracked?
- Are pay-kit / MPP sessions (Payment Channels) stable enough for a live demo today?
- Is there a Pay.sh refund primitive, or should refunds be a separate transfer?
- Submission format and link?

## Risks and fallbacks

| Risk | Fallback |
|---|---|
| Wallet setup eats time | Do `pay setup` before 11, use sandbox until 15:00 |
| Gateway command mismatch (`pay gate` vs `pay server`) | Check `pay --help`; fallback to `@x402/express` + `@x402/svm` middleware on devnet |
| Payment Channels unstable | Pay + refund transfer, channels on the roadmap slide |
| Mainnet funding fails | Demo sandbox, say so openly |
| Wifi | Phone hotspot, backup video cued |
| "The laptop reports on itself" | Device-signed readings now, charger-signed readings on roadmap |
| Keys leak | `.gitignore` keypairs and `.env` from minute one, secrets only in env |
