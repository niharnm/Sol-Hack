# Motto

Motto is a purchase intermediary for virtual goods and services. A buyer asks Claude through the
Solana Pay or Pay CLI flow to buy something. Motto maps that intent to a supported offer, coordinates
the provider, validates the returned work, settles the authorized amount, and returns a signed result
and receipt.

Motto is not an open-ended API and it does not operate a user's computer or other physical device.
A request such as `charge my computer` is unsupported and must be rejected before any payment is
requested. HTTP and x402 are internal payment plumbing between the buyer client, Motto, and the
provider. They are not the product surface a person needs to understand or call directly.

## Active offer

The catalog currently publishes one virtual offer:

| Offer | Price ceiling | Delivery | Charge rule |
|---|---:|---|---|
| `research` | $1.00 USDC | Three distinct DOI-backed citation records with titles | $1.00 only when all three records pass structural checks; otherwise $0.00 |

The research pack uses Crossref public metadata. The paid work is provider coordination, packaging,
and structural validation. It does not sell access to Crossref or full text.

Motto checks that the result contains three records, each title is nonempty, and the DOI values are
distinct. These checks do not establish topical relevance, scientific quality, DOI resolution, or
full-text access.

## Buyer flow

1. The user asks Claude to buy a supported virtual result, for example a research pack on a topic.
2. The Pay CLI or Pay MCP presents the request to Motto.
3. Motto matches the intent to the `research` offer. Unsupported and physical requests stop here,
   before a payment challenge or hold is created.
4. The buyer authorizes an x402 `upto` hold of 1 USDC.
5. Motto asks the registered provider for the research pack and validates the response.
6. A complete result settles at $1.00. An incomplete result or provider failure settles at $0.00 and
   releases the hold.
7. Motto returns the deliverable, validation results, signed reading, settlement status, and receipt
   to the buyer client.

The canonical internal purchase route is:

```http
POST /v1/buy/research
Content-Type: application/json

{ "query": "retrieval augmented generation" }
```

The route is documented for client integration and testing. The normal buyer-facing entry point is
the Solana Pay or Pay CLI conversation with Claude.

## Settlement model

Motto uses the x402 `upto` scheme. The buyer authorizes a ceiling, not an unconditional transfer.
For the active offer:

- Complete pack: $1.00 charged and $0.00 returned.
- Incomplete pack: $0.00 charged and $1.00 returned.
- Provider or validation failure: $0.00 charged and $1.00 returned.
- Settlement failure: charge and return amounts remain unknown until the transaction is inspected.

Send an `Idempotency-Key` with a purchase. A retry with the same payer and key can return the existing
hold instead of creating another one when the recorded state permits replay.

## Run locally

Install dependencies and start the service:

```bash
cd motto
npm install
npm start
```

Inspect the free terms and request the active offer:

```bash
curl http://127.0.0.1:8787/v1/terms
curl -i -X POST http://127.0.0.1:8787/v1/buy/research \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: research-demo-1' \
  -d '{"query":"retrieval augmented generation"}'
```

The unpaid purchase call returns a `402` x402 `upto` offer. A payment-aware client authorizes the
hold and retries the same request.

Useful checks:

```bash
npm test
npm run devnet:status
node demo/verify-proof.mjs
```

## Network status

Public Solana Devnet is the default configured network. Startup checks the Devnet RPC genesis hash.
`npm start` creates isolated operator and buyer keys under gitignored `keys/devnet/` and keeps Devnet
history under `data/devnet/`.

The Devnet code path and unpaid offer have been exercised. A paid Devnet purchase still requires a
funded operator wallet and a buyer wallet with Devnet SOL and Devnet USDC. Do not describe the project
as having a verified paid Devnet settlement until that run and its transaction confirmation succeed.

Recorded Pay.sh sandbox holds are historical localnet evidence. They verify the saved Motto reading
and accounting rules, but they do not prove a Devnet or mainnet transaction. Mainnet is configured as
an option and has not been exercised.

The public Tailscale address used during the event was
`https://motto.tail039d5c.ts.net`. Treat it as an environment address, not proof that the current build
is deployed or reachable. Verify `/healthz`, the reported commit, the network, and the active catalog
before using it.

## Internal service surface

| Method and path | Payment | Purpose |
|---|---|---|
| `GET /v1/terms` | Free | Active offer, price, rules, network, version, and signing key |
| `POST /v1/buy/research` | Up to $1.00 USDC | Route the research intent, obtain and validate the pack, then settle |
| `GET /healthz` | Free | Process health, version, network, commit, uptime, and hold count |
| `GET /openapi.json` | Free | Machine-readable description of the one active paid offer |

Other routes used by the dashboard or operator are internal and are not catalog offers.

Detailed hold records and the live event stream are private. They are available from loopback for
the on-device console, or remotely with `Authorization: Bearer <MOTTO_ADMIN_TOKEN>`. Public clients
can read aggregate status counts at `GET /v1/public/stats`, which does not return payer addresses,
queries, idempotency hashes, signed readings, or settlement records.

## Signed result

The research reading includes the query, provider, citation pack, check results, limitations,
timestamp, ed25519 signature, and public key. Verify the signature before trusting the result. A valid
signature proves that the recorded reading was signed by the advertised Motto key. It does not prove
that Crossref ranked the records well or that the cited work is correct.

## Unsupported physical requests

Motto has no authority or hardware connection to inspect, charge, move, rent, or deliver a physical
device. Physical intent is rejected before payment. It is not converted into a virtual verification
request, and the user is not charged for asking.

Historical charger, hotspot, battery, storage, display, and generic verification demos are inactive.
Their sandbox results and benchmark remain development history only. They are not published offers,
not proof of physical delivery, and not part of the current buyer flow.

## Buyer result recovery

The website lists the live catalog and generates purchase commands plus a private recovery ticket.
For Devnet, run the generated `scripts/buy-service.mjs` command from `motto/`; it uses the existing
Pay SDK and requires a funded Devnet buyer. Pay CLI can review terms and retrieve results for free.
The UI labels test networks and does not infer a charge from delivery alone.

Before paying, generate 32 random bytes as 64 lowercase hexadecimal characters. Send them in
`X-Motto-Recovery-Key` on the paid request and retain the key privately. The Devnet buyer does this
automatically, or accepts the website-generated key as its final argument. After a timeout, send
`POST /v1/results/recover` with `Authorization: Bearer <key>`; this never authorizes or retries a
payment. Pending results can be retrieved again using the same key. Missing results mean wait and
recover again, not pay again. Failed/interrupted settlement requires operator reconciliation.

Only a SHA-256 digest is stored with the authorized hold. The key grants read access to that one
purchase, including its deliverable; it is not a wallet signature or an account-wide credential.
Keep recovery tickets private. Downloadable purchase receipts omit the key. Recovery survives a
restart when the hold log is writable and covers the latest 500 retained holds. Existing purchases
without a key cannot acquire one retroactively. A new key with an old idempotency key does not replace
the original recovery key. The UI never stores recovery keys in browser persistent storage.
