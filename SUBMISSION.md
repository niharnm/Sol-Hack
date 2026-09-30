# Motto

Motto is the purchase intermediary between a buyer agent and providers of virtual goods and services.
A user asks Claude through the Solana Pay or Pay CLI flow to buy something. Motto matches the intent
to a supported offer, coordinates the provider, validates delivery, settles the authorized amount,
and returns the result and receipt.

Repository: `https://github.com/niharnm/Sol-Hack`

Team: Nihar, product and service. Nithin, design and demo.

## Product boundary

Motto is virtual only. It does not control a computer or other physical device, and it is not an
open-ended API that can carry out arbitrary instructions. A request such as `charge my computer` is
rejected as unsupported before any payment challenge or hold is created.

The HTTP service and x402 exchange are internal plumbing for the buyer client. The buyer-facing
experience starts when a user asks Claude to buy a supported result.

## Active offer

The catalog currently contains one offer, a $1.00 research pack:

- Input: a research query from 3 to 200 characters.
- Provider: Crossref public metadata.
- Delivery: three distinct DOI-backed citation records with nonempty titles.
- Validation: record count, title presence, and unique DOI values.
- Complete delivery: $1.00 charged.
- Incomplete delivery or provider failure: $0.00 charged and the full hold released.
- Output: citations, validation results, stated limits, signed reading, settlement status, and receipt.

The canonical internal operation is `POST /v1/buy/research`. The paid work is intent routing,
provider coordination, packaging, and validation. Crossref metadata is public. The checks do not
establish topical relevance, scientific quality, DOI resolution, or full-text access.

The service also has an optional operator-approved provider protocol for adding virtual merchant
offers without making Motto the seller. `GET /v1/providers` lists configured offers. Motto requests
and verifies a signed quote, creates a private order, returns an x402 `upto` challenge that pays the
registered merchant wallet, verifies signed delivery evidence, and settles the quote's amount for
the verified outcome. The built-in catalog remains limited to `research` unless a provider registry
is explicitly configured.

## Why the intermediary matters

A buyer agent can authorize payment, but authorization alone does not prove delivery. Motto gives the
buyer one controlled purchase path:

1. accept a virtual purchase intent;
2. match it to a defined offer;
3. reject unsupported intent before payment;
4. place a capped x402 `upto` hold;
5. obtain and validate the provider result;
6. settle only when the stated delivery rule passes; and
7. return a signed result and receipt.

The provider remains responsible for the source data. Motto is responsible for routing, coordination,
validation, settlement, and the buyer record.

## Payment model

The buyer authorizes a ceiling of 1 USDC. That is not an unconditional payment. A complete research
pack settles at $1.00. An incomplete pack or provider failure settles at $0.00 and releases the hold.

Each purchase should carry an `Idempotency-Key`. Eligible retries with the same payer and key return
the recorded hold instead of opening a second one. Settlement failures are reported separately because
the final charge and return amounts must be confirmed from the transaction.

## Evidence and current limits

Public Solana Devnet is the default configured environment, and startup checks the RPC genesis hash.
The Devnet code path and unpaid offer have been exercised. A paid Devnet purchase is not yet verified;
it requires funded operator and buyer wallets, a completed purchase, and transaction confirmation.

Pay.sh sandbox proof files are localnet history. They verify saved readings and accounting behavior,
not Devnet or mainnet transactions. Mainnet is configured as an option and has not been exercised.

The automated provider tests use the real PayKit challenge generator and confirm that a configured
order advertises `upto`, the quoted ceiling, and the merchant payout wallet. Provider fulfillment and
settlement transitions are covered with controlled test doubles. On 2026-09-30, the separate system
check completed three consecutive paid provider orders through `pay 0.29.0` and the hosted sandbox.
Each run verified signed delivery evidence and settled $0.01 test USDC to the registry wallet. This
does not prove Devnet or mainnet settlement.

The Tailscale address used during the event was `https://motto.tail039d5c.ts.net`. Its existence does
not confirm that the current build is deployed or reachable. The pay-skills catalog work must also be
described from its current pull request and probe state, not from the presence of local listing files.

## Run and inspect

```bash
cd motto
npm install
lsof -i:8787
npm start
curl http://127.0.0.1:8787/v1/terms
curl -i -X POST http://127.0.0.1:8787/v1/buy/research \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: submission-demo-1' \
  -d '{"query":"refundable settlement for autonomous purchases"}'
npm test
npm run test:provider-sandbox
```

The unpaid purchase request should return a `402` x402 `upto` offer for 1 USDC. A payment-aware buyer
client authorizes the hold and retries the request.

## Signed result

The signed reading records the query, provider, citation pack, structural checks, known limits, and
timestamp. The public verification key is exposed in the free terms. Signature verification confirms
that the saved reading was signed by the advertised Motto key. It does not prove the quality or truth
of a cited paper.

## Inactive event history

The event prototype previously demonstrated charger, hotspot, battery pack, storage, display, and
generic verification scenarios. Those physical and device-check offers are inactive. They are not
catalog offers and are not part of the current buyer flow.

The earlier benchmark used generated purchase scenarios and simulated device states. Its results are
historical evidence for that prototype only. They do not measure the current research offer or prove
physical fulfillment.

## Next work

- Complete a funded Devnet research purchase and confirm its transaction.
- Verify the public service reports the intended commit and virtual-only catalog.
- Run the catalog static check and live probe against the one research operation.
- Add another virtual offer only after its provider, deliverable, checks, pricing, settlement, and
  failure behavior are defined and tested.
