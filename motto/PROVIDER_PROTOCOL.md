# Motto Provider Protocol

This contract lets Motto coordinate a registered merchant while Pay.sh handles the buyer's x402
authorization. Motto obtains and verifies the quote, owns the private order state, requests
fulfillment, verifies the result, chooses the allowed settlement amount, and records the outcome.
The merchant receives payment directly from the x402 hold.

## Boundaries

- Offers must be virtual or venue-local and finish within 1 to 180 seconds.
- A provider has one registered Solana payout address and one Ed25519 quote key.
- Each offer names one or more registered Ed25519 attestation keys.
- A quote key and an attestation key must be different.
- Key separation proves that different keys signed the messages. The registry operator must still
  verify any claim that the attestation organization is independent from the merchant.
- Missing, invalid, mismatched, replayed, expired, or late evidence approves a zero charge.
- The hold pays one merchant wallet. Motto does not collect a fee or split the hold.
- Settlement failure is terminal as `settlement_unknown` until the transaction is inspected.

## Registry

Set `MOTTO_PROVIDERS_FILE` to an operator-controlled JSON file with this shape:

```json
{
  "version": 1,
  "providers": [
    {
      "id": "paper-shop",
      "name": "Paper Shop",
      "payout_address": "<32-byte Solana address in base58>",
      "quote_public_key": "<32-byte Ed25519 public key in hex>",
      "fulfillment_url": "https://merchant.example/motto",
      "attestors": [
        {
          "id": "delivery-service",
          "public_key": "<different 32-byte Ed25519 public key in hex>"
        }
      ],
      "offers": [
        {
          "id": "research-pack",
          "summary": "Buy a signed research pack",
          "network": "devnet",
          "max_hold_usd": "2.00",
          "fulfillment_timeout_seconds": 30,
          "attestor_ids": ["delivery-service"]
        }
      ]
    }
  ]
}
```

Production provider URLs must use HTTPS. Loopback HTTP is accepted only when
`MOTTO_ALLOW_LOCAL_PROVIDERS=true` and Motto runs on localnet or Devnet. Configure the private
provider token as `MOTTO_PROVIDER_TOKEN_<PROVIDER_ID>`, with the id uppercased and every
non-alphanumeric character changed to an underscore.

Set `PUBLIC_ORIGIN` to the externally reachable Motto origin when it runs behind a proxy. x402 binds
the payment proof to the exact execute URL.

## Quote request

Motto sends an authenticated `POST` to the provider's registered `fulfillment_url` before any
payment challenge:

```json
{
  "version": 1,
  "action": "quote",
  "provider_id": "paper-shop",
  "offer_id": "research-pack",
  "network": "devnet",
  "request": { "query": "battery recycling" }
}
```

Headers include `Authorization: Bearer <provider-token>`, `Content-Type: application/json`, and the
buyer's `Idempotency-Key`. The provider must return exactly:

```json
{
  "signed_quote": {
    "quote": {
      "version": 1,
      "quote_id": "quote_01",
      "provider_id": "paper-shop",
      "offer_id": "research-pack",
      "network": "devnet",
      "payout_address": "<registered Solana address>",
      "hold_usd": "1.25",
      "settlement": {
        "delivered_usd": "1.25",
        "already_handled_usd": "0.10",
        "not_delivered_usd": "0.00",
        "inconclusive_usd": "0.00"
      },
      "request_sha256": "<canonical request SHA-256 in lowercase hex>",
      "attestor_id": "delivery-service",
      "nonce": "<16 to 128 base64url characters>",
      "expires_at_ms": 1790790000000,
      "fulfillment_timeout_seconds": 30
    },
    "signature": "<unpadded base64url Ed25519 signature>"
  }
}
```

The signed bytes are the newline-joined fields returned by `quoteSigningPayload` in
`src/provider-protocol.js`. Motto binds the quote to the registered provider, offer, payout, network,
price ceiling, timeout, allowed attestor, request digest, nonce, and expiry.

## Order and payment

The buyer creates an order with `POST /v1/orders` and receives an `order_token` plus an
`execute_path`. Exact retries with the same `Idempotency-Key` return the existing order without
requesting a second quote. Reusing the key with changed input returns `409`.

The execute route requires `X-Motto-Order-Token` or a bearer token. Without a payment proof it returns
an x402 `upto` `402` challenge. The maximum is `hold_usd`, and `payTo` is the registered merchant
wallet. A Pay.sh client authorizes the hold and repeats the exact request with its payment proof.

## Fulfillment request

After payment authorization, Motto sends another authenticated `POST` to the same provider URL:

```json
{
  "version": 1,
  "action": "fulfill",
  "order": {
    "id": "<order id>",
    "hold_id": "<hold id>",
    "network": "devnet",
    "payout_address": "<registered Solana address>",
    "request_sha256": "<quote-bound request digest>",
    "fulfillment_deadline_ms": 1790790000000
  },
  "signed_quote": { "quote": {}, "signature": "<quote signature>" },
  "request": { "query": "battery recycling" }
}
```

The `Idempotency-Key` header is the Motto order id. The provider must return exactly
`artifact` and `signed_attestation`:

```json
{
  "artifact": { "delivered": true, "result": {} },
  "signed_attestation": {
    "attestation": {
      "version": 1,
      "attestation_id": "attestation_01",
      "provider_id": "paper-shop",
      "offer_id": "research-pack",
      "quote_id": "quote_01",
      "order_id": "<order id>",
      "hold_id": "<hold id>",
      "attestor_id": "delivery-service",
      "network": "devnet",
      "payout_address": "<registered Solana address>",
      "request_sha256": "<quote-bound request digest>",
      "outcome": "delivered",
      "artifact_sha256": "<canonical artifact SHA-256 in lowercase hex>",
      "nonce": "<16 to 128 base64url characters>",
      "issued_at_ms": 1790790000000,
      "expires_at_ms": 1790790030000
    },
    "signature": "<unpadded base64url Ed25519 signature>"
  }
}
```

Allowed outcomes are `delivered`, `already_handled`, `not_delivered`, and `inconclusive`. The signed
bytes are produced by `attestationSigningPayload` in `src/provider-protocol.js`. Motto verifies every
order, hold, quote, provider, offer, network, payout, request, artifact, attestor, nonce, and time
binding before selecting the quote's settlement amount for that outcome.

## Current verification status

The automated suite exercises registry validation, signature and replay checks, private order
capabilities, idempotency, provider authentication, response limits, direct provider payout in a
real PayKit `upto` challenge, evidence-before-charge behavior, zero settlement on provider or
evidence failure, and the terminal unknown-settlement state.

`npm run test:provider-sandbox` adds a paid system check. It starts a throwaway registered provider,
starts Motto on localnet, creates an order, invokes `pay --sandbox fetch`, returns signed delivery
evidence, and requires a settled $0.01 result with a transaction signature and matching payout.
This passed three consecutive runs with `pay 0.29.0` on 2026-09-30. It remains sandbox evidence. A
funded Devnet payment and any mainnet payment are still unverified.
