# Two-minute digital-service demo

The buyer needs research sources for a technical brief. Motto delivers a real citation pack, checks explicit acceptance conditions, and returns a signed receipt alongside the payment result.

## Setup

Run the Motto server (`cd motto && npm start`). Open http://127.0.0.1:8787 beside a terminal. The console defaults to digital purchases; earlier device demos are available using the sidebar checkbox.

On the partner's laptop with Claude Code access, run this from the repository root:

```bash
node demo/run-agent.mjs
```

The launcher uses the local desk on that same computer. Your partner's Claude login does not carry over to your laptop. The model's tool calls appear in the terminal; the console accurately marks buyer telemetry as external.

## Pitch

| Time | Say | Show |
| --- | --- | --- |
| 0:00–0:20 | “An agent is preparing a technical brief. It needs three research sources, and has a one-dollar budget.” | New purchase and its acceptance conditions. |
| 0:20–0:45 | “It reads the terms and authorizes a maximum payment. Motto now has to deliver.” | Run the agent, or label the direct API fallback as manual. Watch the execution graph. |
| 0:45–1:10 | “These are actual source records fetched from Crossref, not placeholder results.” | Read one title and show its DOI link in Purchased deliverable. |
| 1:10–1:35 | “We check that three records arrived, their DOI identifiers are distinct, and each has a title. The delivered pack and checks are signed together.” | Select Evidence check, inspect the checks, then Signed receipt and Verify signature. |
| 1:35–1:50 | “The full service price is charged only when those checks pass. An incomplete result or provider failure returns the whole authorization.” | Settlement ledger and raw API record. Do not stage a fake failure as a live event. |
| 1:50–2:00 | “Motto connects an agent's purchase to an inspectable deliverable. Live data, test USDC, on Pay.sh's Solana sandbox.” | Close on the sources and receipt. |

## Direct sandbox purchase — no model required

```bash
npx --yes --package @solana/pay pay --sandbox curl -sS \
  -X POST http://127.0.0.1:8787/v1/rent/research \
  -H 'Content-Type: application/json' \
  -d '{"query":"retrieval augmented generation"}'
```

Change `query` to another topic to purchase a different source pack. Do not retry while a purchase remains pending. On a funded mainnet setup, the same route uses a real payment, but this local demo remains sandbox. An Exa purchase is a separate provider integration and is not implied by this demo.

## Proof

Unpaid challenge:

```bash
curl -i -X POST http://127.0.0.1:8787/v1/rent/research \
  -H 'Content-Type: application/json' \
  -d '{"query":"retrieval augmented generation"}'
```

Signature verification from the repository root:

```bash
node demo/verify-proof.mjs
```

Crossref metadata is publicly available. The configured $1 price is for Motto's packaged, structurally checked service, not an upstream Crossref charge. The demo does not prove semantic relevance, paper quality, DOI resolution, full-text availability, or independent blockchain finality. A valid signature proves source and integrity, not truth by itself.
