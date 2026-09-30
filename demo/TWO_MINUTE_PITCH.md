# Two-minute demo

Open http://127.0.0.1:8787. Click Sound on and press F for fullscreen. Start with the charger plugged in. The dashboard follows actual sandbox API events; no model reasoning is simulated. Use the terminal as the buyer, and say so.

| Time | Say | Do |
| --- | --- | --- |
| 0:00–0:15 | “An agent authorizes a dollar. We verify delivery, settle what’s owed, and return the rest.” | Show the three-step flow. |
| 0:15–0:40 | “This laptop is already plugged in. The desk checks before keeping the rental payment.” | Run the command below with the charger connected. Show $0.99 returned and the $0.01 check fee. |
| 0:40–1:15 | “Now it needs power. The deposit waits for delivery.” | Unplug. Run the same command. Wait until the screen says to plug in, then reconnect. Show the $1 settlement. |
| 1:15–1:40 | “This is backed by an API receipt: the device reading is signed, and the payment has a sandbox settlement signature.” | Click View API proof, then Open raw API. Optionally run the verification command below. |
| 1:40–2:00 | “Today it’s a charger. The same conditional payment pattern can support other verifiable services. This demo uses test USDC in Pay.sh’s sandbox.” | Return to the workflow. Close on the approved pitch. |

## Payment command — run for both cases

```bash
npx --yes --package @solana/pay pay --sandbox curl -sS -X POST http://127.0.0.1:8787/v1/rent/charger
```

Warm this up before the pitch. The first npx run may install the CLI. A slow or failed payment is not a successful settlement: wait for the result, show its status, and use a clearly labeled recording if the sandbox is unavailable. Do not start another hold while the first is pending.

## API proof, in the terminal

1. Without payment, show the actual 402 challenge and $1 `upto` offer:

```bash
curl -i -X POST http://127.0.0.1:8787/v1/rent/charger
```

2. Run the payment command above. The response includes `decision`, charged and returned amounts, `signed_reading`, and `settlement_tx`.
3. From the repository root, cryptographically verify the latest completed reading and check that charged + returned equals $1:

```bash
node demo/verify-proof.mjs
```

The verification script checks the reading against the desk's advertised public key. It does not independently confirm chain finality or prove a sensor cannot lie. Sandbox transaction signatures are not mainnet Explorer links.

## Start the local server if needed

```bash
cd motto
npm start
```

Default configuration is the sandbox. Keep real-wallet environment variables out of the demo shell. The server must run on the laptop being checked.
