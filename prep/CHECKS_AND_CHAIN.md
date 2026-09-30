# Checks and Onchain Notes (verified 2026-09-30 unless marked UNV)

## Device checks (macOS)

**Power (charger item)**
- `pmset -g ps` first line: `Now drawing from 'AC Power'` (verified on this Mac) or
  `Now drawing from 'Battery Power'` (UNV, confirm by unplugging once)
- Check: `pmset -g ps | head -1 | grep -q "'AC Power'"` -> exit 0 means already on power
- Keep case "charging verified": poll every 1s after the hold until the line flips to AC Power

**Network (hotspot item)**
- `curl -s -m 5 http://captive.apple.com/hotspot-detect.html | grep -q Success` -> online
- Captive portals return a different body, so this beats ping
- Stage problem: turning wifi off also cuts the desk. Options, best first:
  1. Check a *named* network: `networksetup -getairportnetwork en0` (UNV on current macOS; may
     need `ipconfig getsummary en0`). "Is the device on the venue wifi?" If not, the hotspot rental
     is real. Laptop stays online via phone hotspot the whole time.
  2. Run the device agent on a second laptop or phone that actually goes offline, and let it
     report back when it reconnects.
  3. Check reachability of a specific target host that you can block and unblock.

**Signed readings**
- Device holds an ed25519 key. Each reading = `{item, result, raw, ts, holdId}` signed, the
  signature (short hash) goes into the settlement memo. Device pubkey shown on the dashboard.

## Onchain building blocks

| Thing | ID / package | Status |
|---|---|---|
| USDC mainnet | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | Circle docs |
| USDC devnet | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` | faucet.circle.com (Solana Devnet) |
| Memo (v4) | `Memo4c2pN8afCj432Lb7RMVKi9PbQnnW7ewFFaV3oAH`, `@solana-program/memo` 0.15.0, `getAddMemoInstruction` | Verified on devnet + mainnet |
| Token | `@solana-program/token` 0.17.0: `getTransferCheckedInstruction`, `findAssociatedTokenPda`, `getCreateAssociatedTokenIdempotentInstructionAsync` | Names verified, args UNV |
| Kit | `@solana/kit` 8.4.0 | Current recommended lib |
| Payment Channels | program `CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX`, `@solana/mpp` 0.7.0 + `mppx` 0.12.0 | Devnet + mainnet, audited, SDK pre-1.0 |
| Allowances | program `De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44`, `@solana/subscriptions` 0.5.0 | Devnet + mainnet, audited |

Memo caveat: some explorers or indexers may only parse the legacy memo program
(`MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`). If the memo does not render on Explorer, switch to
`LEGACY_MEMO_PROGRAM_ADDRESS_V3` from the same package. Test this once early.

## Memo formats (short, readable on Explorer)

- `DESK REFUND hold:<id> charger device_on_AC sig:<8 chars>`
- `DESK KEEP hold:<id> charger charging_verified 14:02 sig:<8 chars>`
- `DESK KEEP hold:<id> hotspot not_on_venue_wifi sig:<8 chars>`

Where the memo goes depends on the settlement path:
- **upto path:** settlement is done by the Pay.sh gateway, so we cannot add our memo to that tx.
  Post a separate tiny "receipt" tx from the desk wallet (0 or 1 micro USDC transfer + memo)
  referencing the hold. Explorer then shows payment tx + receipt tx.
- **fallback path (fixed charge + refund transfer):** memo goes in the refund tx itself.

## Allowance (user cap), two levels

1. **Simple, on stage:** `pay mcp --permissions` with `max_payment: "$1.00"` and an origin allowlist.
   Show an over-cap attempt being refused. Zero extra code.
2. **Stretch, onchain:** `@solana/subscriptions` fixed delegation from user wallet to agent key,
   `getCreateFixedDelegationOverlayInstructionAsync({ delegator, delegatee, tokenMint, amount,
   expiryTs, nonce })`. Pulls past the cap fail with `AMOUNT_EXCEEDS_LIMIT`. Only if time allows;
   it does not plug into Pay.sh payments directly.

## Payment Channels (stretch only)

- Flow: 402 session challenge, client deposits into channel escrow, per request signed cumulative
  vouchers checked off chain, server settles with `settle_and_seal` + `distribute` (merchant paid,
  unused refunded, channel closed).
- Server: `Mppx.create({ methods: [solana.session({ operator, recipient, cap, currency: 'USDC',
  decimals: 6, network: 'devnet', pricing: { perDelivery }, signer, rpc })], secretKey })`
- `network` defaults to `'mainnet'`: set `'devnet'` explicitly while building.
- Channels do not auto close: set `closeDelayMs` or settle manually, or funds stay locked.
- Estimate 2 to 4 h for a devnet happy path. Only attempt if core is done by 14:00.
- Sessions fail closed under `pay mcp --permissions`, so a metered demo cannot show the cap.

## Wallet checklist

- Desk wallet (recipient): pubkey noted, keypair only in env, never in repo
- Agent wallet: `pay setup` account, sandbox funded; mainnet funded with ~$5 USDC via `pay topup`
- Fee payer needs SOL on mainnet (small amount)
- `.gitignore`: `*.json` keypairs, `.env*`, `~/.config/pay` never copied into repo
