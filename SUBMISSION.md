# Motto

Motto lets AI agents purchase digital results within a spending limit chosen by the user. It quotes a task, checks the delivered result against explicit requirements, then settles the accepted work through Pay.sh and USDC on Solana.

The implemented service retrieves citation packs from public Crossref metadata. Agents choose a topic, record count, optional required title terms, and optional publication years. The service prices each requested record, rejects quotes above the caller's permission, and preserves the quoted price and acceptance rules until expiry.

A complete pack earns the quoted amount. Incomplete results or upstream failures earn zero. Acceptance requires the requested number of records, distinct DOI identifiers of valid format, nonempty titles, and any requested literal title terms and publication-year bounds. These checks do not establish semantic relevance or scientific quality. Crossref metadata is free; the paid work is retrieval, packaging, and validation.

The product includes an authenticated quote and purchase API, persistent SQLite records, signed acceptance readings, a purchase console, and a direct buyer command. The buyer uses Pay's MCP payment tool without starting a model. It requires an explicit per-purchase limit and applies that limit through an origin- and network-scoped Pay permission policy. Unsupported policies fail closed.

Configuration defaults to the sandbox and loopback. Mainnet requires explicit configuration. Mainnet payment and public deployment have not been verified for this version. Tests use controlled provider responses and payment transports; their results are not proof of real settlement. The API represents one operator workspace, without separate customer accounts or aggregate budget tracking.

Earlier physical rental demos, generated scenario benchmarks, catalog material, slides, and saved sandbox holds are historical. They are not evidence for the current digital product, and this document makes no new external submission or deployment claim.

Implementation and operating instructions: [motto/README.md](motto/README.md). Product contract and remaining work: [PROJECT_PLAN.md](PROJECT_PLAN.md).
