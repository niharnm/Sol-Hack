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

The first start creates a 256-bit administrator token automatically. Motto stores the token at
`data/secrets/admin-token` with file mode `0600`; the credential record contains only its SHA-256
digest. Starting Motto again reuses the same credential.

To pair a remote browser with the private purchase console, create a five-minute, single-use link:

```bash
npm run pair -- --url https://your-motto-host --open
```

The link places the pairing code in the URL fragment. The console removes that fragment before its
first request, exchanges the code for an HttpOnly same-site session cookie, and never stores the
administrator token in browser-accessible storage. Run `npm run pair` again to pair another browser.
Use `npm run admin:status` to inspect non-secret credential and session counts.

Containers may supply either `MOTTO_ADMIN_TOKEN` or `MOTTO_ADMIN_TOKEN_FILE`. Do not set both. There
is no package `postinstall` script because dependency installation may run under the wrong account or
inside an image build.

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

## Pay CLI discovery

Pay and Motto have separate setup responsibilities. `npx @solana/pay claude` creates or opens the
buyer's Pay wallet and gives Claude Pay's provider tools. Motto's setup command creates credentials
for the operator who runs a Motto service.

This is valid Pay CLI syntax:

```bash
npx -y @solana/pay@1.0.26 --sandbox claude \
  'Use Motto at https://your-motto-host to buy one research pack about drinking-water delivery systems. Spend at most $1.00.'
```

The explicit URL is required until the Motto entry in the public Pay catalog is accepted and
published. [Catalog PR #280](https://github.com/solana-foundation/pay-skills/pull/280) is open, so a
fresh `npx @solana/pay claude` session cannot currently discover Motto by name. After publication,
Pay can present Motto as a matching provider, but the agent still decides which provider fits the
request.

Do not use a physical-product prompt such as “buy some water” as a working Motto example yet. The
current service has no seller connection, inventory reservation, recipient workflow, external order
ID, or signed physical delivery. Research remains the only verified end-to-end offer.

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
the on-device console, through a paired browser session, or with a bearer token read from the private
token file. Public clients can read aggregate status counts at `GET /v1/public/stats`, which does not
return payer addresses, queries, idempotency hashes, signed readings, or settlement records.

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
