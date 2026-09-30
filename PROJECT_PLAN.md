# Motto project plan

Motto sells digital results to AI agents within a spending limit chosen by the user. The current service retrieves and validates citation packs from public Crossref metadata. Payment covers retrieval, packaging, and explicit checks. The upstream records are free.

## Product contract

1. The user chooses a per-purchase spending limit. The service cannot set or increase it.
2. The agent requests a quote for a topic, citation count, optional title terms, and optional publication years.
3. Motto rejects a quote above that permission and fixes the task, price, and acceptance rules until expiry.
4. The agent uses Pay.sh with a payment permission scoped to the service origin, network, and caller's limit.
5. Motto retrieves the records, applies the acceptance checks, and signs the result.
6. A complete pack earns the quoted price. Incomplete delivery earns zero. Settlement errors remain unresolved until checked.

The price is configurable per record. The caller's permission, quoted task ceiling, and actual settlement are separate values. There is no aggregate or daily budget feature.

## Acceptance

Every requested record needs a distinct canonical DOI of valid format and a nonempty title of at most 500 characters. Supplied literal title terms must all match without case sensitivity. Supplied publication-year bounds must hold. These rules do not guarantee semantic relevance, scientific quality, full-text access, or DOI resolution.

## Implementation scope

| Component | Responsibility |
| --- | --- |
| Digital service | Validate input, calculate exact USDC prices, fetch and check metadata |
| Quote and purchase API | Expiring quotes, authenticated operator workspace, persistent records, idempotent purchase requests |
| Payment integration | Pay.sh x402 `upto` authorization and settlement with explicit unresolved states |
| Buyer command | User-selected spending permission, quote validation, model-free Devnet SDK or sandbox/mainnet MCP call, no uncapped fallback |
| Console | Create digital tasks and display quotes, delivery checks, and purchase outcomes |

Use the existing Express and Pay.sh dependencies. Node.js 22.13 or newer supplies SQLite support. Configuration defaults to loopback and Solana Devnet. Devnet uses separate local operator and buyer wallets, verifies the RPC genesis hash, and stores state under data/devnet by default. Loopback Devnet needs no API key. Remote binding requires an API key, and remote paid requests need a trusted canonical origin. Mainnet requires an explicit operator signer, RPC, API key, and a trusted public HTTPS origin. The separate localnet sandbox remains available.

## Verification

Verify exact decimal arithmetic, budget rejection, fixed quote terms, expiry, authentication, provider failures, acceptance criteria, durable records, and repeated requests. Inspect the complete diff and run available tests. A local test or mock payment result must not be described as verified mainnet operation.

Do not run models, make real payments, publish the service, or change external catalog listings as part of this build. Preserve unrelated changes. Create a scoped pull request after verification; merge only with an explicit request.

## Remaining operational work

Mainnet settlement and deployment are unverified. Wider production use needs deployment configuration, protected durable storage, monitoring, and a reconciliation procedure for uncertain settlement. The API currently grants access to one operator workspace rather than isolated customer accounts. Assess whether packaging public metadata provides enough customer value before adding more paid services.

Historical device rental code, generated benchmarks, slides, demo scripts, catalog material, and sandbox proof files remain for reference. They do not validate the current digital service. Earlier event planning and research are historical and do not define this product's acceptance criteria.
