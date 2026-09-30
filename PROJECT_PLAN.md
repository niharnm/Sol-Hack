# Motto: Project Plan

Status: active scope corrected to virtual purchases only.

Repository: `https://github.com/niharnm/Sol-Hack`

## 1. Product definition

Motto is the intermediary between a buyer agent and a provider of a virtual good or service. The user
does not browse Motto as an API product. They ask Claude through the Solana Pay or Pay CLI flow to buy
something. Motto then:

1. interprets the purchase intent;
2. matches it to a supported catalog offer;
3. rejects unsupported or physical requests before payment;
4. coordinates the selected provider;
5. validates the returned work;
6. settles the authorized amount under the offer's rules; and
7. returns the result and receipt to the buyer client.

HTTP routes, x402 challenges, holds, provider calls, and signatures are internal payment and delivery
plumbing. They support the buyer flow but are not a promise that Motto can perform arbitrary actions.

## 2. Scope boundary

Motto supports virtual goods and services only. The current catalog publishes one offer, a research
pack built from Crossref public metadata.

An optional operator-approved registry can publish additional virtual merchant offers through
`GET /v1/providers`. Each configured offer fixes the provider endpoint, payout wallet, quote key,
allowed attestation keys, network, hold ceiling, and a fulfillment deadline of at most 180 seconds.
These offers do not expand the built-in catalog or its static OpenAPI document.

Motto does not inspect, control, charge, rent, move, or deliver physical devices. For example,
`charge my computer` is rejected as unsupported before an x402 offer or hold is created. The request
must not be redirected to a generic check that could charge the user without delivering the requested
physical result.

Future offers may be added only when all fulfillment, validation, pricing, settlement, and failure
rules can be completed through an authorized virtual provider flow.

## 3. Current offer

| Field | Research offer |
|---|---|
| Catalog id | `research` |
| Canonical route | `POST /v1/buy/research` |
| Input | `{ "query": "..." }`, 3 to 200 characters |
| Provider | Crossref public metadata |
| Deliverable | Three distinct DOI-backed citation records with nonempty titles |
| Hold ceiling | $1.00 USDC |
| Delivered settlement | $1.00 charged, $0.00 returned |
| Incomplete or failed settlement | $0.00 charged, $1.00 returned |
| Signed output | Query, provider, citations, structural checks, limitations, timestamp, signature, and public key |

The paid work is routing, provider coordination, packaging, and validation. Crossref metadata remains
public. Structural validation does not establish topical relevance, scientific quality, DOI
resolution, or full-text access.

## 4. Success criteria

- The terms, catalog, OpenAPI sidecar, buyer flow, dashboard copy, and submission describe the same
  virtual-only product.
- The only published paid catalog operation is `POST /v1/buy/research`.
- Unsupported and physical intent returns a clear client error before payment middleware runs.
- A missing or invalid research query returns `400` before payment.
- The unpaid valid request returns the expected x402 `upto` offer for 1 USDC.
- A paid retry obtains the provider result, validates it, signs the reading, and settles exactly once.
- An incomplete result or provider failure costs nothing.
- Idempotent retries do not open a second eligible hold for the same payer and key.
- Network and settlement claims match current evidence.
- A configured merchant order obtains its signed quote before payment, pays the registered merchant
  wallet directly, verifies the registered attestation before charging, and records an unknown state
  instead of guessing when settlement cannot be confirmed.

## 5. Architecture

```text
User intent
   |
   v
Claude through Solana Pay or Pay CLI
   |
   v
Motto intent router
   | unsupported or physical: reject before payment
   | supported research offer: continue
   v
x402 upto hold for 1 USDC
   |
   v
Crossref provider request
   |
   v
Structural validation and signed result
   |
   v
Settle $1.00 on complete delivery, otherwise settle $0.00
   |
   v
Result and receipt returned to the buyer client
```

The buyer client is the public entry point. The internal HTTP service should remain small, explicit,
and closed to unsupported catalog items.

## 6. Internal interface

| Method and path | Role |
|---|---|
| `GET /v1/terms` | Free description of the active offer, rules, network, version, and signing key |
| `POST /v1/buy/research` | One paid virtual purchase operation |
| `GET /v1/providers` | Free list of operator-approved merchant offers and terms |
| `POST /v1/orders` | Obtain a merchant quote and create a private order |
| `GET /v1/orders/{id}` | Read a private order with its capability token |
| `POST /v1/orders/{id}/execute` | Authorize, fulfill, verify, and settle a configured merchant order |
| `GET /openapi.json` | Machine-readable contract for the active catalog offer |
| `GET /healthz` | Operational health and current version information |

Operator and dashboard routes are private operational interfaces. They are not offers and must not be
presented as public purchasing capabilities.

## 7. Validation and settlement

Validation runs after payment authorization and before a charge is settled. The research result passes
only when:

- exactly three usable citation records are returned;
- each record has a nonempty title;
- each record has a DOI; and
- the DOI values are distinct.

Any failed condition makes the result incomplete and costs $0.00. Provider exceptions also cost
$0.00. A settlement error is reported separately because the final charge and return amounts are not
known until the transaction is inspected.

Every completed reading is signed with the key published in the terms. Signature verification proves
which Motto key signed the saved reading. It does not prove the quality or truth of the cited work.

## 8. Network evidence

Public Solana Devnet is the default configured environment. Startup verifies the RPC genesis hash.
The Devnet code path and unpaid x402 offer have been exercised. Paid Devnet settlement remains
unverified until funded wallets complete a purchase and the transaction is confirmed on Devnet.

Pay.sh sandbox proof files are localnet history. They can verify saved signatures and arithmetic but
do not confirm Devnet or mainnet settlement. Mainnet support is configuration only and has not been
exercised.

The generic provider suite generates a real PayKit `upto` challenge and asserts that its amount and
`payTo` wallet match the signed merchant quote and registry. Controlled payment objects cover the
post-authorization state machine. The paid system check then runs the same path with
`pay --sandbox fetch`. It completed three consecutive $0.01 test-USDC settlements with `pay 0.29.0`
on 2026-09-30. This is localnet evidence only.

The event Tailscale URL and the open pay-skills pull request are not proof of a current deployment,
catalog merge, or mainnet availability. Check the live endpoint, reported commit, network, sidecar,
and current pull request state before making any such claim.

## 9. Catalog work

The catalog entry must contain only the research offer. The sidecar path is
`motto/catalog/providers/motto/rentals/openapi.json`; the directory name is retained for compatibility
with the existing catalog branch, but it does not authorize physical rentals.

Before any catalog update:

1. regenerate or compare the sidecar with the active service contract;
2. confirm that no physical or generic verification operations are present;
3. run the static catalog check;
4. probe the exact service URL and record the result;
5. label the network accurately; and
6. state whether the pull request is open, merged, or blocked based on current evidence.

## 10. Verification plan

Run the smallest relevant check after each change, then the full set before submission:

```bash
cd motto
npm test
npm run test:provider-sandbox
npm run devnet:status
node proof/verify.mjs
```

Add focused tests for:

- the canonical research route;
- physical intent rejection before payment;
- invalid query rejection before payment;
- the unpaid `402` amount and scheme;
- complete delivery settlement;
- incomplete and provider-failure refunds;
- signed-result verification;
- idempotent retry behavior;
- provider quote acquisition before payment;
- merchant payout binding in the PayKit `402` challenge;
- signed fulfillment evidence before charge approval; and
- zero settlement on invalid or late evidence plus terminal handling for unknown settlement.

Before starting a local server, run `lsof -i:8787` and reuse or stop the existing process deliberately.

## 11. Team workflow

Nihar owns the purchase service, payments, validation, catalog contract, and network evidence. Nithin
owns the dashboard, slides, and demo presentation. Shared documents must be checked against the active
service contract before they are published.

Preserve unrelated changes. Pull before editing, stage named files only, inspect the staged diff, run
the relevant checks, and pull again before pushing. A change is not deployed or merged merely because
it exists in the local repository.

## 12. Inactive history

The original event demo included charger, hotspot, battery pack, storage, display, and generic
verification scenarios. Those physical and device-check offers are inactive and must not appear in
the current catalog, buyer instructions, or product claims.

The recorded benchmark and sandbox holds remain historical engineering evidence. They may be shown
only with their original generated-scenario, simulated-device, localnet, pricing, and date limits. They
do not prove current virtual-offer performance, physical fulfillment, paid Devnet settlement, or
mainnet settlement.
