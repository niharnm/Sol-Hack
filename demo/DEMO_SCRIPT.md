# Motto: 3 minute virtual-service demo

Seven beats, 3:00 total. The live demo uses Pay.sh's sandbox and test USDC. Nihar runs the product. Nithin narrates.

## Product boundary

Motto is the middleman for supported virtual purchases. A buyer agent sends an intent and budget. Motto routes the request to the supported provider, validates the returned result, coordinates settlement, and returns the result with a signed receipt.

Motto is not a general device API. A request such as "charge my computer" is unsupported because the software cannot connect a cable, inspect the computer, or confirm that physical work happened. Unsupported physical requests must not create a payment.

## Who does what

| Who | Does |
| --- | --- |
| Nihar | Runs the buyer or direct purchase command and advances the slides. |
| Nithin | Narrates each beat and watches the clock. |
| Motto | Connects buyer intent to the supported research provider, validates the result, and returns the payment outcome and signed receipt. |

## Timeline

| Time | Beat | Screen | Length |
| --- | --- | --- | --- |
| 0:00 | 1. Boundary | Slide 1 | 20s |
| 0:20 | 2. Buyer intent | Terminal and console | 25s |
| 0:45 | 3. Provider result | Console | 35s |
| 1:20 | 4. Validation | Console inspector | 30s |
| 1:50 | 5. Payment and receipt | Console inspector | 30s |
| 2:20 | 6. Why the middleman | Slide 4 | 25s |
| 2:45 | 7. Close | Console fullscreen | 15s |

## Stage setup

- Start the sandbox desk from the repository root:

  ```bash
  cd motto
  NETWORK=localnet npm start
  ```

- Open http://127.0.0.1:8787 beside a terminal.
- Keep `node demo/verify-proof.mjs` ready in another terminal tab.
- Run one preflight purchase immediately before the demo. The console should show a completed research purchase with three citations.
- If the model runner is unavailable, use the direct sandbox command and state that the model is not in that fallback path.

## Commands

Check the desk and its published research terms:

```bash
curl -s http://127.0.0.1:8787/v1/terms
```

Run the Claude buyer with Pay.sh tools only:

```bash
node demo/run-agent.mjs
```

Direct sandbox fallback:

```bash
npx --yes --package @solana/pay pay --sandbox curl -sS \
  -X POST http://127.0.0.1:8787/v1/buy/research \
  -H 'Content-Type: application/json' \
  -d '{"query":"retrieval augmented generation"}'
```

Do not retry a failed or timed-out paid request until the console and hold log confirm that no purchase is still pending. A retry can open another hold.

Optional Devnet path:

```bash
cd motto
npm start
npm run buy:devnet -- "retrieval augmented generation"
```

The default server network is Devnet. The Devnet buyer uses a generated test wallet and requires test USDC. Follow the funding message printed by the CLI. Devnet test tokens are not mainnet funds.

## The script

### Beat 1. Boundary, 0:00 to 0:20

Screen: slide 1.

Nithin: "Motto helps agents buy supported virtual results. It sits between buyer intent, a provider, payment, validation, and a signed receipt. It does not claim that software can perform a physical action."

Nihar: no command. Keep the console visible.

### Beat 2. Buyer intent, 0:20 to 0:45

Screen: terminal and console.

Nithin: "The buyer needs three DOI-backed sources about retrieval augmented generation. It reads the free terms and authorizes no more than the published research ceiling."

Nihar runs `node demo/run-agent.mjs`.

Expect: the agent reads `GET /v1/terms` and makes one paid `POST /v1/buy/research`. The console shows the authorization and research query.

If Claude cannot start, run the direct fallback. Say: "This is the same paid Motto endpoint without the model in the loop."

### Beat 3. Provider result, 0:45 to 1:20

Screen: Purchased deliverable.

Nithin: "Motto passes the request to the supported research provider. Crossref returns live citation metadata. Motto packages the response for the buyer."

Nihar opens one DOI link and reads one title from the console.

Do not claim that Motto read the papers or proved their quality. The provider supplies metadata, not full text.

### Beat 4. Validation, 1:20 to 1:50

Screen: Under the hood, then Provider & validation.

Nithin: "Before settlement, Motto checks the published contract: three records, three distinct DOI identifiers, and a nonempty title for each record. These are structural checks. They do not prove semantic relevance or paper quality."

Nihar shows the validation fields and the delivered citations.

### Beat 5. Payment and receipt, 1:50 to 2:20

Screen: Payment summary and Signed receipt.

Nithin: "If the structural checks pass, Motto settles the service price. If the provider fails or returns an incomplete pack, Motto returns the authorization. The result and checks are signed together."

Nihar selects Verify signature. If asked for terminal proof, run:

```bash
node demo/verify-proof.mjs
```

On localnet, this verifies the Ed25519 receipt signature and the payment arithmetic. It does not independently confirm a public-chain transaction. On Devnet, it also asks the public Devnet RPC about the reported settlement signature.

### Beat 6. Why the middleman, 2:20 to 2:45

Screen: slide 4.

Nithin:

1. "The buyer agent should not need a separate account and integration for every virtual provider."
2. "Motto accepts the buyer's intent and budget, calls the supported provider, checks the result, and returns one receipt."
3. "Payment does not make an impossible request possible. If the service is unsupported or physical, Motto must reject it before charging."

### Beat 7. Close, 2:45 to 3:00

Screen: console fullscreen, ending on the sources and receipt.

Nithin: "Buyer intent in. Supported virtual result, payment outcome, and signed receipt out. That is Motto's role as the middleman."

Do not say the sandbox run is mainnet. Do not describe test USDC as real money. Do not say the receipt proves the sources are true or relevant.

## Backups

| If | Then |
| --- | --- |
| Claude is slow or unavailable | Stop the model runner and use the direct sandbox command. Label it as the no-model fallback. |
| The paid request times out | Inspect the console and hold log before retrying. The original request may still settle. |
| The console stops updating | Reload http://127.0.0.1:8787/. |
| Crossref returns an incomplete pack | Show the returned authorization as the designed failure outcome. Do not fake a successful delivery. |
| Signature verification fails | Show the error. Do not claim the receipt was verified. |
| Network access fails | Use a recorded run and label it as recorded. |

## Likely judge questions

- **Is Motto an API?** Motto exposes a purchase interface, but the product role is the intermediary. The buyer asks for a supported virtual result. Motto coordinates the provider call, validation, payment, and receipt.
- **Can it charge or inspect my computer?** No. Without an authorized hardware integration and evidence source, software cannot perform or verify that physical action. This project does not offer that capability and must not charge for it.
- **What does the research check prove?** It proves only that the returned pack has three records with distinct DOI identifiers and nonempty titles. It does not prove relevance, quality, DOI resolution, or full-text access.
- **What does the signature prove?** A valid Ed25519 signature proves that the receipt came from the matching Motto signing key and that the signed payload was not changed. It does not prove that every fact in the provider data is true.
- **Is this mainnet?** The stage command uses Pay.sh's local sandbox and test USDC. The optional Devnet path also uses test tokens. Neither is a mainnet payment.
- **Why not call Crossref directly?** Crossref metadata is public. This demo charges for Motto's packaged service: purchase coordination, a defined output contract, validation, payment handling, and a signed receipt. It does not claim an upstream Crossref fee.
- **What happens if the provider fails?** An incomplete result or provider failure does not earn the research price. Motto reports the outcome and returns the authorization according to the published terms.
- **How does an agent find the service?** It reads `GET /v1/terms` and the OpenAPI document, then uses `POST /v1/buy/research` for the supported purchase.
