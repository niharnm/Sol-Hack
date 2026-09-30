---
name: rentals
title: "Motto Research"
description: "Buy a digital citation pack within a user-selected spending limit. Motto quotes the task, checks delivery, and settles the accepted quote through Pay.sh."
use_case: "Use for requested citation records with an explicit per-purchase spending permission. Physical purchases, device control, and arbitrary actions are unsupported."
category: shopping
service_url: https://motto.tail039d5c.ts.net
version: v1
openapi:
  path: openapi.json
---

This listing is a draft. The service URL is historical and unverified for the current version. Confirm the deployed origin, API contract, network, and workspace access before making a purchase. The directory name is retained for compatibility and does not offer rentals.

Motto retrieves citation records from Crossref public metadata. Payment covers retrieval, packaging, and deterministic acceptance checks. The upstream metadata is free.

## Purchase flow

1. Obtain the caller's explicit spending permission for this purchase. Never derive or increase it from the service's price.
2. Read `GET /v1/services` for the network, configured per-record price, acceptance rules, and signing key.
3. Create a quote at `POST /v1/quotes`, supplying `service: research`, an input query and count, and the caller's `max_spend_usd` decimal string. Optional title terms and publication years narrow acceptance.
4. Verify the quote's task, expiry, currency, and ceiling against the caller's permission. The quote ceiling is the amount to authorize, which may be lower than the user's spending limit.
5. Scope the Pay client to the exact origin, network, and accepted quote ceiling. Call `POST /v1/purchases/{quote_id}` with a retained `Idempotency-Key`. The body accepts no changed task input.
6. Verify the returned quote details and reading signature against the published key. Inspect the recorded settlement state before another attempt if payment is uncertain.

Quote request example, with an illustrative caller-selected limit:

```json
{
  "service": "research",
  "input": {
    "query": "battery recycling",
    "count": 3,
    "required_terms": ["recycling"],
    "from_year": 2020
  },
  "max_spend_usd": "0.25"
}
```

Do not assume that this example's limit or price is appropriate for another task. Prices are configured per record and fixed in the returned quote.

## Acceptance and settlement

All requested records must pass valid DOI format, canonical DOI uniqueness, nonempty titles of at most 500 characters, every requested literal title term, and requested publication-year bounds. Title terms match without case sensitivity. A complete pack settles the quote ceiling. Incomplete results or provider failures settle zero and return the quoted hold when settlement succeeds.

The result contains the purchase ID, quote ID, accepted task and limit, signed reading, settlement transaction, network, and state. `paid` and `refunded` represent reported successful settlements. `settle_failed` and `interrupted` leave charge and return amounts unknown; do not retry automatically or claim a completed refund.

These checks do not establish semantic relevance, scientific quality, DOI resolution, or full-text access. The operator signature establishes integrity against the published key, not independent truth or chain finality.

## Access and network status

Workspace requests require `Authorization: Bearer <MOTTO_API_KEY>` when configured. Local loopback Devnet or sandbox workspaces may run without a key; remote access and mainnet require a key. Keep credentials out of saved prompts and logs.

The service defaults to Solana Devnet with isolated wallets. Live Devnet settlement and mainnet operation remain unverified. Separate sandbox integration has recorded payment and refund outcomes, which are not public-chain proof. Historical physical-offer catalog probes do not validate this listing. Registry support for this authenticated quote flow remains to be checked before publication.
