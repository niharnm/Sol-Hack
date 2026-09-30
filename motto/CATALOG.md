# Pay.sh catalog listing

This directory contains a draft catalog entry for Motto's one active virtual offer, the research pack.
It must not publish physical rentals, device checks, or a generic verification purchase.

## Files

`catalog/providers/motto/rentals/` contains the files copied to the pay-skills catalog branch:

- `PAY.md`: buyer guidance and listing metadata.
- `openapi.json`: a reviewed sidecar for `POST /v1/buy/research` only.

The existing directory is named `rentals` because the catalog requires the directory name to match
the `name` field. The name is retained for compatibility with the open catalog branch. It does not
describe the active product and does not authorize physical offers.

## Product rule

The buyer-facing entry point is Claude through the Solana Pay or Pay CLI flow. Motto routes supported
intent to the research offer, coordinates Crossref as the public metadata provider, validates the
pack, settles the capped hold, and returns a signed result and receipt.

HTTP is internal payment plumbing. Motto is not an open-ended API. Unsupported or physical requests,
including `charge my computer`, must be rejected before payment.

## Offer published by this listing

| Operation | Ceiling | Delivered | Not delivered |
|---|---:|---|---|
| `POST /v1/buy/research` | $1.00 USDC | Three distinct DOI-backed records with titles, $1.00 charged | Incomplete result or provider failure, $0.00 charged and the hold released |

The structural checks do not establish relevance, quality, DOI resolution, or full-text access.

## Verification before catalog submission

1. Confirm the deployed service reports the intended commit and network at `/healthz`.
2. Confirm `GET /v1/terms` lists only active virtual offers.
3. Confirm an unsupported physical request is rejected before a `402` response.
4. Confirm an unpaid valid research request returns an x402 `upto` offer for 1 USDC.
5. Compare the deployed `/openapi.json` with the committed sidecar.
6. Run the catalog static check.
7. Run the catalog live probe against the exact service URL.
8. Record whether the pull request is open, merged, or blocked based on current evidence.

The event URL was `https://motto.tail039d5c.ts.net`. Do not infer current reachability or deployment
from that address. The previous catalog probe covered six inactive physical endpoints under older
pricing. That probe is legacy evidence and does not verify this listing.

## Network limits

The project defaults to public Solana Devnet. The Devnet code path and unpaid offer have been
exercised, but paid Devnet settlement remains unverified. Saved Pay.sh sandbox holds are localnet
history, not Devnet or mainnet transaction proof. Mainnet has not been exercised.

If the registry requires a mainnet offer, this listing is not ready to merge until Motto has an
exercised mainnet purchase or the registry explicitly accepts the configured Devnet offer. Do not
label a sandbox or Devnet service as mainnet to satisfy a probe.
