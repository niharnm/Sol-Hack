# Digital research purchase walk-through

Motto sells a checked digital result within spending permission supplied by the caller. The buyer obtains an immutable quote, authorizes that quoted ceiling, receives citation records, and inspects the signed acceptance and settlement record. The dashboard tracks purchases and receipts. It does not compose tasks or authorize spending.

## Start and inspect

From `motto/`, use Node.js 22.13 or newer:

```bash
lsof -i:8787
npm start
```

The default is Solana Devnet with isolated test wallets. Open `http://127.0.0.1:8787/` for the tracker. Read the Devnet operator and buyer addresses with `npm run devnet:status`; test SOL and test USDC funding are separate prerequisites. See [the README](../motto/README.md) for configuration and funding instructions. Mainnet has not been exercised.

## Create the purchase through the buyer

Choose a per-purchase spending permission. The amount below is illustrative, rather than a fixed product price:

```bash
npm run buy:devnet -- --desk http://127.0.0.1:8787 \
  --max-spend 0.50 --count 3 --query "battery recycling" \
  --required-term recycling --from-year 2020
```

The buyer quotes the task and rejects any ceiling above that permission. Pay SDK permissions enforce the exact accepted ceiling, service origin, and Devnet network before signing. The printed quote ID and idempotency key identify the attempt. The command does not start a model.

For an already reviewed quote, retain its original spending permission and use:

```bash
npm run buy:devnet -- --desk http://127.0.0.1:8787 \
  --quote-id replace-with-quote-id --max-spend 0.50
```

Do not create a fresh purchase after a timeout or uncertain settlement until the original record is inspected.

## What to show in the tracker

| Step | Show | Explain |
| --- | --- | --- |
| Permission and quote | Caller limit and quoted ceiling | Only the task price is held, even when the user permits more |
| Digital delivery | Citation titles, DOI links, and publication years | Crossref provides free public metadata; Motto packages and checks it |
| Acceptance | Required count, distinct DOI identifiers, titles, and requested terms or years | Every requested record must pass; this does not prove relevance or scientific quality |
| Receipt | Signed reading and signature verification | The operator signed the result; this does not establish independent truth |
| Settlement | `paid`, `refunded`, or an unresolved state | Charge and return amounts stay unknown when settlement is unconfirmed |

A complete pack earns the immutable quoted price. Incomplete delivery earns zero when the zero-charge settlement succeeds. The full quoted hold returns in that case. Unused spending permission was never held and is not a refund.

## Verification

From the repository root:

```bash
node demo/run-research-tests.mjs
node demo/verify-proof.mjs
```

The test runner uses controlled responses and makes no payments. The proof reader verifies a stored settled purchase against its quote and the published receipt key. On Devnet it also checks the reported transaction through the genesis-checked public RPC. On localnet it does not independently establish public-chain finality. Neither command proves scientific quality or mainnet readiness.

## Sandbox alternative

Stop or reuse the existing server deliberately, then start the sandbox from `motto/`:

```bash
lsof -i:8787
npm run start:sandbox
```

The canonical MCP buyer is:

```bash
npm run buyer -- --max-spend 0.50 --count 3 --query "battery recycling"
```

From the repository root, `demo/run-agent.mjs` forwards the same arguments to that model-free buyer:

```bash
node demo/run-agent.mjs --max-spend 0.50 --count 3 --query "battery recycling"
```

The installed Pay 0.29 MCP path rejected capped sandbox requests with an invalid network permission error. It fails closed and does not retry without permission enforcement. Separate local sandbox integration has recorded a successful paid delivery and refund; a later zero-charge SDK settlement error remained unconfirmed and was not retried. Test-network evidence does not establish Devnet or mainnet settlement.

Older physical examples, fixed one-dollar purchase routes, holds endpoints, and model-driven stage scripts describe retired behavior. The current purchasing contract is `POST /v1/quotes` followed by `POST /v1/purchases/{quote_id}`.
