# Motto

Motto lets an AI agent buy a digital result within a spending limit chosen by its user. The agent obtains a quote, authorizes that task's price through Pay.sh, and receives a deliverable with a signed acceptance record. Motto settles the payment only after the agreed checks pass.

The current service retrieves citation records from Crossref. A request specifies a topic, record count, optional required title terms, and optional publication years. Crossref metadata is public and free. Motto charges for retrieval, packaging, and explicit record checks.

## Spending and acceptance

Your `max_spend_usd` is the maximum authorized for one purchase. The service calculates its own quote from the configured per-record price and requested count. It rejects a quote above your limit. It does not increase that limit or reserve the entire limit when the task costs less. This is a per-purchase permission, not a daily or account-wide budget.

A complete citation pack earns its quoted price. Incomplete results, upstream errors, or failed acceptance checks earn zero. There is no partial-delivery charge. A settlement failure leaves charge and return amounts unknown until reconciled, and must not be reported as a completed refund.

Acceptance checks cover:

- The requested number of records.
- Valid DOI identifier format and distinct canonical DOI identifiers.
- Nonempty titles, no more than 500 characters each.
- Every supplied title term, matched as a literal substring without case sensitivity.
- Publication years within the supplied bounds, when requested.

These checks do not establish scientific quality, semantic relevance, DOI resolution, or full-text access. A signed record proves that the operator signed the recorded result. It is not an independent attestation of the upstream data.

## Run locally

Use Node.js 22.13 or newer and install the [Pay.sh CLI](https://github.com/solana-foundation/pay#installation). The service defaults to the Pay.sh sandbox and binds to loopback. Node versions that treat SQLite as experimental may print a warning.

```bash
cd motto
npm install
lsof -i:8787
npm start
```

Open `http://127.0.0.1:8787/` for the purchase console. Configure an API key to protect the operator workspace; it is required on mainnet or a remote bind. `.env.example` documents the variables, but Node does not load `.env` automatically. Export them in the launching shell, or use Node's `--env-file` support after creating your local configuration.

```bash
node --env-file=.env src/server.js
```

The local console's sandbox purchase flow is available when the Pay CLI is installed and no workspace API key is configured. It uses test funds. It is not evidence of mainnet operation.

## Buy a citation pack

The direct buyer requires a limit from the caller. The amount below is illustrative; choose the limit for your task. It runs Pay's MCP `curl` tool directly and does not start a model.

```bash
npm run buyer -- --max-spend 0.25 --count 3 --query "battery recycling"
npm run buyer -- --max-spend 0.25 --count 3 --query "battery recycling" \
  --required-term recycling --from-year 2020
```

For a configured mainnet service, export `MOTTO_API_KEY` securely, then select mainnet explicitly:

```bash
npm run buyer -- --desk https://your-service.example --mainnet \
  --max-spend 0.25 --count 3 --query "battery recycling"
```

The buyer checks the network, task, expiry, currency, and quote ceiling before requesting payment. It caps Pay at the accepted quote ceiling, which must fit your chosen limit, using a temporary policy scoped to that service origin and network. API keys travel in request headers and are not printed. The policy is removed when the process exits.

Pay.sh 0.29.0 documents caps for `pay mcp`, not standalone `pay curl`. That version may reject sandbox permission policies. The buyer fails closed when a policy is unsupported. It does not retry with an uncapped process. Use a Pay version that supports the selected network and permission policy. [Pay permissions](https://github.com/solana-foundation/pay#-ai-native-with-mcp).

Agents can use the HTTP API with their own Pay tools and enforced payment permission. The server-side quote ceiling is an additional check; an unattended buyer must also enforce its cap before signing the payment challenge.

## API

`GET /v1/services` is public. Quote creation and purchase history use `Authorization: Bearer <MOTTO_API_KEY>` when configured. The API key grants access to one operator workspace, including its purchases. This is not a customer account or tenant isolation system.

| Method and path | Purpose |
| --- | --- |
| `GET /v1/services` | Network, research pricing and acceptance rules, signing public key |
| `POST /v1/quotes` | Validate a task and user limit; create an expiring quote |
| `GET /v1/quotes/:id` | Inspect one stored quote |
| `POST /v1/purchases/:quoteId` | Authorize the quoted USDC ceiling through x402 `upto`, execute the task, and settle |
| `GET /v1/purchases` | Persistent purchase records, readings, and settlement results |
| `GET /v1/purchases/:id` | One purchase record |
| `POST /v1/console/purchases` | Local-only, unauthenticated sandbox workspace convenience purchase using test funds |
| `GET /healthz` | Service health and configured network |

Create a quote without paying. `MAX_SPEND` is your chosen per-purchase limit; the server must not choose it for you. Set `MOTTO_API_KEY` only when the service requires authentication. Avoid shell tracing while credentials are in use.

```bash
DESK=http://127.0.0.1:8787
MAX_SPEND=0.25
curl --fail-with-body --silent --show-error "$DESK/v1/quotes" \
  -H "Authorization: Bearer $MOTTO_API_KEY" \
  -H 'Content-Type: application/json' \
  --data "{\"service\":\"research\",\"input\":{\"query\":\"battery recycling\",\"count\":3,\"required_terms\":[\"recycling\"],\"from_year\":2020},\"max_spend_usd\":\"$MAX_SPEND\"}"
```

The response includes `id`, normalized `input`, `max_spend_usd`, `ceiling_usd`, `unit_price_usd`, `acceptance`, `created_at`, `expires_at`, and `currency`. Prices use decimal strings with at most six fractional digits. Acceptance terms and price are fixed in the quote. Quotes default to a 120-second expiry.

To make a Pay-backed purchase with the same task and caller-selected limit, use the direct buyer:

```bash
npm run buyer -- --desk "$DESK" --max-spend "$MAX_SPEND" \
  --query "battery recycling" --count 3 --required-term recycling --from-year 2020
```

This creates and validates its own fresh quote, prints a nonsecret payment-request record with the quote ID and idempotency key before starting Pay, then calls `POST /v1/purchases/:quoteId` through Pay with a UUID `Idempotency-Key`. Retain the printed key and quote ID to inspect an uncertain result. The buyer checks returned purchase fields and verifies the reading signature against the service’s published key. This verifies the operator signature rather than independent truth or onchain finality. Do not create a fresh purchase blindly after a timeout or settlement error.

The payment response includes the purchase `id`, `status`, `charged_usd`, `returned_usd`, signed `reading`, `settlement_tx`, and `network`. Successful delivery is `paid`; zero-charge settlement is `refunded`. `settle_failed` and `interrupted` describe unresolved states rather than successful payments. Quotes and purchase records persist in SQLite under `DATA_DIR`.

## Configuration

| Variable | Default or requirement |
| --- | --- |
| `HOST`, `PORT` | `127.0.0.1`, `8787` |
| `NETWORK` | `localnet`; mainnet is explicit |
| `RPC_URL` | Sandbox RPC defaults to `https://402.surfnet.dev:8899`; mainnet requires an RPC |
| `MOTTO_API_KEY` | At least 32 characters; required for real networks or a remote bind |
| `PUBLIC_BASE_URL` | Trusted canonical origin for remote paid requests; HTTPS required on real networks |
| `OPERATOR_KEY` | Required on mainnet; never commit a private key |
| `RESEARCH_UNIT_USD` | `0.05` per accepted citation record |
| `RESEARCH_MAX_SPEND_USD` | `1000`, upper bound on the caller's requested per-purchase limit |
| `QUOTE_TTL_SECONDS` | `120` |
| `DATA_DIR` | `data` |
| `DEVICE_KEY_PATH` | `keys/device.pem`, local Ed25519 signing key |

Keep `DATA_DIR` and the signing key on durable private storage. `pay-permissions.yml` is a deny-by-default example; select your own limit and trusted origin before using it. The signed reading and settlement transaction are the current receipt; this server does not post separate memo transactions.

## Verification and current limits

```bash
npm test
```

Tests use controlled upstream responses and payment transports to check quote limits, acceptance, persistence, authentication, replay behavior, and buyer permission handling. They do not prove real mainnet settlement. Mainnet has not been tested or deployed as part of this change. This implementation is a single-service, single-operator system; wider production use still needs operational monitoring and settlement reconciliation.

The older device checks, physical rental scripts, slides, benchmark results, catalog material, and recorded sandbox holds are historical artifacts. They do not establish delivery or payment performance for this digital service. Do not use those benchmark numbers as evidence for the current product.
