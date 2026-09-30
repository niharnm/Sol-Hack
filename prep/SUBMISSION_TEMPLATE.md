# Motto (README template, fill at 15:15)

> Agents only pay for things that actually happened. A deposit desk for agents buying the real
> world, sold on Pay.sh, settled on Solana with the reason written onchain.

**Live:** <deployed URL>  |  **Video (2 min):** <link>  |  **Pay.sh listing / PR:** <link>

## Proof onchain
- Refund case (device already on AC): <Explorer link>
- Keep case (charging verified): <Explorer link>
- Network check case: <Explorer link>

## How it works
1. A buyer agent (Claude via `pay mcp`) discovers the desk on Pay.sh and reads its terms.
2. It pays a $1 hold in USDC through the Pay.sh gateway (x402 / MPP on Solana).
3. The desk runs the check for that item (power, network). The device signs the reading.
4. Already handled: USDC is refunded. Not handled: the rental is kept. Each settlement has a memo.

<architecture diagram>

## Run it
```
<exact commands, filled in during build>
```

## Built today with
Pay.sh, x402 / MPP, Solana, USDC, Claude. List any pre-existing code or templates used.

## What is next
Hardware-signed readings, venue onboarding, Payment Channels for per minute metering.
