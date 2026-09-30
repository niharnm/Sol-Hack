# Digital research purchase explanation

“Give your agent a spending limit. Motto quotes the digital work it needs, checks the delivered result, and settles the accepted work.”

The current service retrieves citation packs from Crossref public metadata. The agent requests a topic, count, and optional title-term or publication-year requirements. Crossref metadata is free; the paid service retrieves, packages, and checks it.

| Time | Explain | Show |
| --- | --- | --- |
| 0:00 to 0:25 | The caller chooses a maximum per purchase; the quoted task price can be lower | Buyer request and returned quote |
| 0:25 to 0:55 | The agent authorizes only that quote through a client scoped to the price, origin, and network | Nonsecret request identifiers and purchase record |
| 0:55 to 1:20 | All requested citation records must satisfy DOI, title, and requested term or year checks | Delivered records and acceptance results |
| 1:20 to 1:40 | A complete pack earns the quote price; failed acceptance earns zero when settlement succeeds | Recorded charge and return, or explicit unconfirmed state |
| 1:40 to 2:00 | The signed reading establishes integrity against the operator key | Tracker receipt verification |

The dashboard tracks the result and receipt. Purchase input and spending authorization happen through the buyer or API.

For a funded default Devnet workspace, run from `motto/`:

```bash
npm run buy:devnet -- --max-spend 0.50 --count 3 --query "battery recycling" \
  --required-term recycling --from-year 2020
```

Choose the limit for the task. Neither the service nor the buyer may raise it. Devnet uses isolated test wallets; test tokens have no monetary value. Mainnet operation is unverified. The buyer does not start a model.

From the repository root, verify recorded test-network evidence with:

```bash
node demo/verify-proof.mjs
```

The reader verifies the recorded quote, settlement amounts, and receipt signature. Devnet additionally requires public-RPC transaction confirmation. Sandbox signatures and amounts do not independently prove public-chain finality.

Acceptance does not establish semantic relevance, scientific quality, DOI resolution, or full-text access. The operator's signature is not independent proof of the source data. Unconfirmed settlement must not be described as a successful refund, and must not be retried automatically.

See [the walk-through](DEMO_SCRIPT.md) for setup, sandbox limitations, and commands. Historical fixed-price and physical rental examples are retired.
