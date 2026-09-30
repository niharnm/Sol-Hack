# Pay.sh catalog draft

This directory describes Motto's digital research service. Physical rentals, device control, and generic verification purchases are retired. The current API creates an immutable quote within the caller's spending permission, then executes that quote through Pay.sh x402 `upto`.

`catalog/providers/motto/rentals/` retains its historical directory and catalog name for compatibility. Its contents must describe the current digital quote flow. Neither this directory nor its name establishes an active external listing.

| Step | Operation | Payment |
| --- | --- | --- |
| Discover | `GET /v1/services` | Free |
| Quote | `POST /v1/quotes` with research input and user-selected `max_spend_usd` | Free |
| Purchase | `POST /v1/purchases/{quote_id}` with required `Idempotency-Key` | Authorize the accepted quote ceiling, within the user's limit |
| Inspect | `GET /v1/purchases/{id}` | Workspace access required when configured |

The price is configured per citation record, rather than fixed at one dollar. A complete pack passing its requested count, DOI, title, title-term, and year checks earns its quoted price. Incomplete or failed delivery earns zero. Unconfirmed settlement keeps charge and return amounts unknown.

Crossref metadata is public and free. The paid service retrieves, packages, and checks records. The checks do not establish semantic relevance, scientific quality, DOI resolution, or full-text access. The signed reading records the operator's acceptance decision, not independent truth.

## Before external submission

1. Verify the exact service origin, deployed version, network, and API-key access requirements.
2. Compare this sidecar with the deployed `/openapi.json`.
3. Confirm quote creation rejects invalid input and prices above caller permission before payment.
4. Create a quote and inspect its unpaid purchase challenge. The price must equal that quote's ceiling.
5. Check that the registry supports an authenticated, two-step quote and purchase flow with a quote ID in the paid route. Do not replace that contract with a fixed-price endpoint to satisfy a probe.
6. Run applicable catalog validation and the appropriate live probe. Record the actual results and any registry limitation.
7. Verify the external pull request state separately before calling the listing published or merged.

The event origin was `https://motto.tail039d5c.ts.net`. The saved `service_url` is historical and has not been verified for the current version. Older catalog probes covered retired endpoints and pricing; they do not verify this draft.

The service defaults to public Solana Devnet with isolated test wallets. Live Devnet settlement and mainnet operation remain unverified. Sandbox payment and refund records are test-network evidence only. A registry requiring mainnet settlement or a single static paid operation may require additional work before this listing can be submitted.
