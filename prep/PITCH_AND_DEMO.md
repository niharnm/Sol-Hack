# Pitch and Demo Script (3 minutes)

## Selected pitch

> An agent authorizes a dollar. We verify delivery, settle what’s owed, and return the rest.

## Stage setup

- Laptop A (demo laptop): device agent running, charger cable within reach, wifi toggle visible
- Screen: left half Claude terminal, right half dashboard. Explorer opens in a new tab per settlement
- Phone hotspot on. Backup video cued in a browser tab. One earlier Explorer tx already open
- Model warmed with one call right before walking up

## Script

**0:00 Hook (15s)**
"An agent authorizes a dollar. We verify delivery, settle what’s owed, and return the rest."

**0:15 Case 1: refund (40s)**
Laptop is plugged in. Tell Claude: "You're at low battery on a long job. Make sure you have power."
Claude finds the desk through Pay.sh, reads the terms ($1 hold, refundable if already powered),
holds $1. Check runs: already on AC. Dollar back. Open Explorer: memo reads the reason.
Line: "It paid, it checked, it got its dollar back. Nobody clicked anything."

**0:55 Case 2: keep (40s)**
Unplug. Claude rents again. Plug the cable in. Check verifies charging. Rental kept, memo on chain.
Line: "Now the rental is real, so the desk keeps the dollar."

**1:35 Case 3: same desk, new check (25s)**
Laptop is on the phone hotspot, not the venue wifi. Claude holds $1 for venue connectivity. Check:
not on venue network, so the rental is real and the dollar is kept. Switch to venue wifi, hold
again, check passes, dollar returns (minus the 1 cent check fee). The desk stays online the whole
time. See CHECKS_AND_CHAIN.md for the check options.
Line: "The check changed. The money did not. That is the product."

**2:00 Why Solana (20s)**
"Each settlement costs a fraction of a cent and carries its reason onchain. On card rails a 30 cent
fee eats a third of a $1 hold. The hold also comes out of a weekly allowance the user set, so the
agent can never overspend."

**2:20 Business and close (40s)**
"The desk is the company. Every real world check is a new line: charger, battery pack, hotspot,
locker. Venues list checks, we take a small fee per settled hold. Consumer agents are already
making expensive mistakes buying things. This is the guardrail."
Close on the number: "Today the desk settled N holds and returned $X that agents would have wasted."

## Likely judge questions

- **What stops the device lying?** Today the device signs each reading and the signature is in the
  memo. Next, the charger or venue hardware signs it.
- **Why would an agent rent a charger?** Long running agents on laptops and phones need power and
  connectivity to finish work. Consumer agents rent for their user on the go.
- **Why not Stripe?** Fees and settlement time kill $1 holds. No accounts or API keys for agents.
- **Why not just check first, then pay?** The hold is the commitment. It reserves the resource and
  proves intent; the check decides settlement. Same pattern as a hotel card hold, but settled in
  seconds with a reason attached.
- **What is next?** More checks, venue onboarding, Payment Channels for per minute metering.

## Slides (max 4)

1. Title + tagline + live URL
2. The loop: hold -> check -> keep or refund (one diagram)
3. Catalog of checks (charger, battery, hotspot, locker) + business model
4. Why Solana + Pay.sh, roadmap (signed hardware readings, Payment Channels)
