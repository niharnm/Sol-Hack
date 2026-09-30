# Commands and Config Sheet (verified from pay.sh docs, 2026-09-30)

## Key finding: the hold is native to Pay.sh

The `x402-upto` scheme authorizes a ceiling, settles actual usage, and refunds the rest. That is the
deposit desk loop, built into the gateway:

- Agent authorizes up to $1.00 (the hold)
- Desk runs the check
- Already handled: charge only `min_usd` (e.g. $0.01 check fee), $0.99 refunded
- Not handled: charge the full $1.00, rental is real

Why this matters: no custom refund code, no separate transfer, and it uses Ludo's own primitive.
It also gives the business model for free: a 1 cent check fee on every hold.
`x402-upto` is allowed under `pay mcp` permission policies (sessions and subscriptions are not).
Confirm at the workshop: whether `min_usd` can be 0 and the exact SDK call to settle usage.

## Install and wallet (before 11:00)

```bash
brew install pay            # or: npm install -g @solana/pay
pay --version
pay setup                   # creates account, keychain backend on macOS
pay whoami
pay topup --sandbox         # sandbox wallet is auto funded
pay --sandbox curl https://debugger.pay.sh/mpp/quote/AAPL   # first paid call
```

Network flags go before the subcommand: `--sandbox` (hosted Surfpool), `--local`, `--mainnet`.

## Seller gateway

```bash
pay server scaffold paywall.yml                      # starter file
pay --sandbox server demo                            # reference demo + debugger at http://127.0.0.1:1402/
pay --sandbox gate api paywall.yml --bind 127.0.0.1:1402
pay gate api paywall.yml --openapi openapi.json --public-url https://<deployed-host>
curl -fsS http://127.0.0.1:1402/__402/health
```

`pay gate api` is canonical (`pay server start` is legacy). Only paths in `endpoints[]` are exposed.

## Draft paywall.yml (fill upstream URL at build time)

```yaml
# yaml-language-server: $schema=https://pay.sh/docs-assets/provider.schema.json
name: deposit-desk
subdomain: deposit-desk
title: 'Deposit Desk'
description: 'Refundable holds for agents renting real-world things. Pay only if the check says you need it.'
category: shopping
version: v1

routing:
  type: proxy
  url: http://127.0.0.1:8787/        # Desk API upstream; deployed URL later

operator:
  currencies:
    usd: ['USDC']
  network: localnet                    # sandbox forces localnet; mainnet for final run
  fee_payer: true

endpoints:
  - method: GET
    path: 'v1/terms'
    description: 'Machine-readable items, hold amounts, checks and refund rules (free).'

  - method: GET
    path: 'v1/holds'
    description: 'Recent holds and settlements (free, feeds the dashboard).'

  - method: POST
    path: 'v1/rent/charger'
    description: 'Hold up to $1 for a charger. Refunded minus check fee if the device is already on power.'
    metering:
      schemes: [x402-upto]
      min_usd: 0.01
      dimensions:
        - direction: usage
          unit: requests
          scale: 1
          tiers:
            - price_usd: 1.00

  - method: POST
    path: 'v1/rent/hotspot'
    description: 'Hold up to $1 for a hotspot. Refunded minus check fee if the device already has connectivity.'
    metering:
      schemes: [x402-upto]
      min_usd: 0.01
      dimensions:
        - direction: usage
          unit: requests
          scale: 1
          tiers:
            - price_usd: 1.00
```

## Upstream settle call (pay-kit, TypeScript)

Package: `@solana/pay-kit` (also Rust, Go, Python). For `upto`: declare `usage(usd('1.00'))`, then
record actual consumption with `pay.charge(req)?.charge(...)`. `pay.express` sets settlement
headers. Exact signatures: read https://pay.sh/docs/sdk/typescript/schemes at build time.

Open question: when the upstream is behind `routing: proxy`, how does it report actual usage back
to the gateway? If unclear, run the Desk API with pay-kit directly (pay-kit as the paywall in the
app) instead of the proxy gateway. Ask Ludo.

## Buyer agent

```bash
pay --sandbox claude                       # Claude Code with pay MCP tools
pay --sandbox --debugger claude
pay mcp --permissions ./pay-permissions.yml
```

`pay-permissions.yml` (this is the user's allowance cap on stage):

```yaml
origins: [https://<deployed-host>]
networks: [mainnet]
max_payment: "$1.00"
allow_any_asset: false
```

MCP tools exposed: `pay.search`, `pay.endpoints`, `pay.curl`, `pay.balance`, `pay.validate_provider`.

## Catalog listing (pay-skills PR)

```bash
pay catalog scaffold <org>/deposit-desk https://<deployed-host>/openapi.json
pay catalog check providers/<org>/deposit-desk/PAY.md     # expect: PAY.md check successful
pay skills search "deposit"                               # after merge
```

PAY.md rules: `name` matches folder; `description` 64 to 255 chars; `use_case` 32 to 255 chars and
starts with "Use for" or "Use when"; `category` from enum (`shopping` fits); `service_url` must be
production https (no localhost); `openapi: { path: openapi.json }` committed next to PAY.md
(`openapi.url` is rejected by CI); no TODO values; paid endpoints must accept Solana mainnet USDC.

Draft frontmatter:

```yaml
---
name: deposit-desk
title: "Deposit Desk"
description: "Refundable holds for AI agents renting real-world things like chargers and hotspots. The desk checks whether the need is already met and refunds the hold minus a one cent check fee, or keeps it as the rental."
use_case: "Use when an agent needs power or connectivity for a device and should only pay if the device does not already have it."
category: shopping
service_url: https://<deployed-host>
openapi:
  path: openapi.json
---
```

## Deploy (pick one)

Image: `ghcr.io/solana-foundation/pay:latest`. Health: `GET /__402/health`.
Secrets: `PAY_RPC_URL`, `PAY_PAYMENT_RECIPIENT`, `PAY_MPP_CHALLENGE_SECRET` (`openssl rand -hex 32`,
keep stable), `PAY_OPERATOR_KEYPAIR` (Vercel env signer), `UPSTREAM_BASE_URL`.

Vercel (container, beta):
```dockerfile
ARG PAY_IMAGE=ghcr.io/solana-foundation/pay:latest
FROM ${PAY_IMAGE}
WORKDIR /app
COPY paywall.yml /app/paywall.yml
CMD ["gate", "api", "/app/paywall.yml", "--openapi", "https://<desk-api>/openapi.json"]
```
```bash
vercel link
vercel env add UPSTREAM_BASE_URL production
vercel env add PAY_RPC_URL production
vercel env add PAY_PAYMENT_RECIPIENT production
vercel env add PAY_MPP_CHALLENGE_SECRET production
vercel env add PAY_OPERATOR_KEYPAIR production
vercel deploy --prod
```
Probe the production alias, not a preview URL (previews may sit behind SSO).

Cloud Run alternative: `docker build`, `docker push`, `terraform apply` per pay.sh docs.

Simplest fallback if deploy fights you: keep gateway local and expose it with a tunnel
(e.g. `cloudflared tunnel --url http://127.0.0.1:1402`). Catalog PR needs a real https domain.
