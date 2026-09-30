# Two-minute virtual-service demo

The buyer needs research sources for a technical brief. Motto acts as the intermediary between that intent, a supported research provider, payment, result validation, and a signed receipt. Motto does not inspect devices or carry out physical requests.

## Setup

For the sandbox demo, start Motto explicitly on localnet:

```bash
cd motto
NETWORK=localnet npm start
```

Open http://127.0.0.1:8787 beside a terminal. On a computer with Claude Code access, run this from the repository root:

```bash
node demo/run-agent.mjs
```

The runner gives Claude only Pay.sh tools. The model's tool calls appear in the terminal. Motto records the payment and delivery flow, but it does not receive the buyer's private reasoning or tool trace.

## Pitch

| Time | Say | Show |
| --- | --- | --- |
| 0:00 to 0:20 | "An agent needs three research sources and has a fixed budget. It asks Motto to buy a supported virtual result." | New purchase and the research request. |
| 0:20 to 0:45 | "Motto is the middleman. It connects the request to the provider and coordinates payment. It is not the provider, and it cannot perform physical actions." | Run the agent. Show the buyer intent and authorization steps. |
| 0:45 to 1:10 | "The provider returns live Crossref records. Motto checks that three records arrived, each has a title, and the DOI identifiers are distinct." | Read one title and open its DOI link. |
| 1:10 to 1:35 | "The deliverable and validation checks are signed together. The buyer can verify that the receipt came from this Motto instance and was not changed." | Select Provider & validation, then Signed receipt and Verify signature. |
| 1:35 to 1:50 | "The full service price is charged only when the structural checks pass. An incomplete result or provider failure returns the authorization." | Payment summary and raw API record. Do not stage a false failure as a live event. |
| 1:50 to 2:00 | "That is Motto: buyer intent in, supported virtual result and verifiable receipt out." | Close on the sources and receipt. |

## Direct sandbox purchase

Use this if the model runner is unavailable. It follows the same paid endpoint without putting a model in the loop.

```bash
npx --yes --package @solana/pay pay --sandbox curl -sS \
  -X POST http://127.0.0.1:8787/v1/buy/research \
  -H 'Content-Type: application/json' \
  -d '{"query":"retrieval augmented generation"}'
```

Change `query` to purchase a different source pack. Do not retry while a request remains pending. This command uses test USDC on Pay.sh's sandbox. It does not prove mainnet readiness or independent chain finality.

For Solana Devnet, start the default Devnet desk with `npm start`, fund the generated buyer wallet as instructed by the CLI, then run:

```bash
cd motto
npm run buy:devnet -- "retrieval augmented generation"
```

Devnet uses test tokens. It is separate from Pay.sh's local sandbox and from mainnet.

## Proof

An unpaid request should return a payment challenge:

```bash
curl -i -X POST http://127.0.0.1:8787/v1/buy/research \
  -H 'Content-Type: application/json' \
  -d '{"query":"retrieval augmented generation"}'
```

Verify the newest completed research receipt from the repository root:

```bash
node demo/verify-proof.mjs
```

On localnet, the script verifies the Ed25519 receipt signature and amount arithmetic but cannot independently confirm a public-chain transaction. On Devnet, it also queries the public Devnet RPC for the reported settlement transaction. Crossref metadata is publicly available. The configured price covers Motto's packaged and structurally checked service, not an upstream Crossref fee. The demo does not prove semantic relevance, paper quality, DOI resolution, or full-text availability. A valid signature proves source and integrity, not truth by itself.
