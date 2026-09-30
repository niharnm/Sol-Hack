# Two-minute agent demo

The story is a purchasing agent with a task and a budget. The charger is a visible service-delivery check. The job is an illustrative scenario: this demo does not launch or supervise a real background job.

## Two-person setup

Run the buyer on the partner's computer that already has Claude Code access. A login on that computer does not sign in the other laptop. The simplest setup is to run Motto and the buyer on that same computer, share its dashboard, and plug/unplug its charger. This local launcher targets localhost; it will not control the other person's desk.

The repository also includes the general scenario buyer in `motto/buyer/buy.js`. On the partner's configured machine, `cd motto` then `npm run buyer -- --scenario low-battery` lets the agent select a service from the terms and checks its report against the hold log. Other supported scenarios are listed by `npm run buyer -- --list`. Use only verified service checks in the stage demo.

## Before the pitch

- Open http://127.0.0.1:8787 beside a terminal in the Sol-Hack repository folder. Click Sound on.
- Sign in to an account with Claude Code access: run `claude`, then `/login` if needed.
- Rehearse `node demo/run-agent.mjs` once. It restricts the model to Pay.sh MCP tools, uses sandbox payments, and asks for exactly one local charger purchase. The $1 ceiling comes from the desk's payment offer; the mission also instructs the model not to retry paid calls.
- The launcher prints actual assistant text and tool names. The dashboard follows actual desk events. It does not display fabricated model thoughts.
- Keep the direct API fallback ready. If model latency exceeds your time budget, show a clearly labeled recording or explain the direct fallback; do not imply that a manual API call is autonomous reasoning.

## On stage

| Time | Say | Do |
| --- | --- | --- |
| 0:00–0:20 | “Imagine my laptop has a long job running. I tell my agent: keep it powered, authorize up to a dollar, and only pay for a rental if power arrives.” | Point to the mission card. Start with the charger unplugged. |
| 0:20–0:45 | “Claude can read the seller’s terms and buy the service. It cannot inspect the laptop itself.” | Run `node demo/run-agent.mjs`. Show Claude reading terms and making its tool call in the terminal. |
| 0:45–1:10 | “The desk holds the authorization while it checks delivery.” | Wait for the dashboard's “Plug in the charger” state, then connect the cable. Show $1 settled. |
| 1:10–1:35 | “The agent receives a receipt it can use to report what happened: the outcome, amount, device reading, and payment signature.” | Show Claude's final response and click View API proof. |
| 1:35–1:50 | “If it was already plugged in—or power never arrived—the rental isn't kept. The agent gets $0.99 back after the one-cent check.” | Explain the alternate branch. A refund run can be shown during Q&A; avoid squeezing two model calls into two minutes. |
| 1:50–2:00 | “An agent authorizes a dollar. We verify delivery, settle what’s owed, and return the rest. This is test USDC in Pay.sh’s sandbox.” | Close on the workflow. |

## Real agent command

From the repository root:

```bash
node demo/run-agent.mjs
```

If Claude says the account lacks access, sign in with `/login` using a Claude Code-enabled account. The launcher does not bypass authentication. It stops after three minutes; an open desk hold may still settle, so check the dashboard before retrying.

## Direct API fallback — no model

```bash
npx --yes --package @solana/pay pay --sandbox curl -sS -X POST http://127.0.0.1:8787/v1/rent/charger | python3 -m json.tool
```

Connected before the call: refund. Unplugged, then connected when the desk is waiting: rental kept. No delivery within 30 seconds: refund. This command proves the payment/check flow, not an autonomous purchasing decision.

## API proof for questions

Show the unpaid HTTP 402 challenge and $1 `upto` offer:

```bash
curl -i -X POST http://127.0.0.1:8787/v1/rent/charger
```

After a successful payment, inspect View API proof and its raw API link. Verify the latest completed device reading from the repository root:

```bash
node demo/verify-proof.mjs
```

The script verifies the signature against the desk's advertised key and checks that charged plus returned equals $1. It does not independently confirm chain finality or prove the sensor cannot lie. Sandbox signatures are not mainnet Explorer links.

## Start the desk if needed

```bash
cd motto
npm start
```

Default configuration is sandbox. Keep real-wallet environment variables out of the demo shell. The server must run on the laptop being checked.
