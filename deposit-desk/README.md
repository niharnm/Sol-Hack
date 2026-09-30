# Deposit Desk

> Agents only pay for things that actually happened.

A deposit desk for agents buying things in the real world. The agent puts $1 USDC on hold, the desk
checks whether the need is already handled, then keeps the money as the rental or sends it back.
Sold through Pay.sh, settled on Solana with the x402 `upto` scheme: the agent authorizes a ceiling,
the desk settles only what is owed, and the rest returns to the agent automatically.

The charger is the first check on the desk. The hotspot is the second. The check changes. The money
does not.

| Item | Check | Already handled | Need is real |
|---|---|---|---|
| Charger | Is the device drawing AC power? | $0.01 check fee, $0.99 back | Power delivered within 30s: $1.00 kept. Never delivered: $0.99 back |
| Hotspot | Is the device on the venue network? | $0.01 check fee, $0.99 back | $1.00 kept |

Every reading is signed by a device ed25519 key and returned to the agent. Optional receipt memos put
the reason onchain (`DESK REFUND hold:ab12 charger device_on_AC sig:1f2e3d4c`).

## Run it (Pay.sh sandbox)

```bash
npm install
npm start                                   # http://127.0.0.1:8787 dashboard
curl -i -X POST http://127.0.0.1:8787/v1/rent/charger          # 402 with an x402 upto offer
pay --sandbox curl -X POST http://127.0.0.1:8787/v1/rent/charger
pay --sandbox curl -X POST http://127.0.0.1:8787/v1/rent/hotspot
```

Let Claude rent on its own:

```bash
pay --sandbox claude "You're running a long job on this laptop. Terms are at http://127.0.0.1:8787/v1/terms. Make sure you have power, and only pay what you need."
```

## Endpoints

- `GET /v1/terms` machine-readable items, holds, checks and refund rules (free)
- `POST /v1/rent/charger` `{ "wait_seconds": 30 }` usage gate, up to $1
- `POST /v1/rent/hotspot` usage gate, up to $1
- `GET /v1/holds`, `GET /v1/events` hold log and live feed for the dashboard
- `GET /openapi.json` OpenAPI with payment offers for the Pay.sh catalog

## Config

See `.env.example`. Mainnet needs `NETWORK=mainnet`, `RPC_URL` and `OPERATOR_KEY`. Keys live in env,
never in the repo.

## Proof onchain

- Refund case: _add Explorer link_
- Keep case: _add Explorer link_

## Built today with

Pay.sh (`@solana/pay-kit` x402 upto), Solana, USDC, `@solana/kit`, Express, Claude.
