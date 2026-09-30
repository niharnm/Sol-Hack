# Pay.sh catalog listing

Prepared for a PR to github.com/solana-foundation/pay-skills. `service_url` is set to https://motto.tail039d5c.ts.net.

## What is here

`catalog/providers/motto/rentals/` is exactly what the PR adds. In the pay-skills fork it lands at `providers/motto/rentals/` (FQN `motto/rentals`):

- `PAY.md`: listing frontmatter plus notes for agents. Started with `pay catalog scaffold`, then written by hand.
- `openapi.json`: reviewed snapshot of `GET /openapi.json` plus docs. The registry rejects remote OpenAPI URLs, so it is committed. `payTo` and `feePayer` are left out on purpose; the live 402 is authoritative.

The directory name must equal `name:` (`rentals`) or `pay catalog check` fails, hence the registry layout.

## Before the PR

1. `service_url` in `PAY.md` is https://motto.tail039d5c.ts.net: this Mac, published with `tailscale funnel --bg 8787`. It must stay up (Mac awake, Motto running, Funnel on) until the PR merges, because CI probes it at PR time and again on merge.
2. Reread the `Status:` paragraph in `PAY.md`. It says the desk is demoed in the Pay.sh sandbox. Edit it if the URL serves a mainnet desk. Never present a sandbox desk as a live mainnet service.
3. Optional: add `sandbox_service_url: https://...` for a sandbox desk that uses `https://402.surfnet.dev` as its RPC.

## Commands (run on 2026-09-30, opened https://github.com/solana-foundation/pay-skills/pull/280)

```bash
# 1. Fork and clone outside this repo
HERE="$(git rev-parse --show-toplevel)"; cd "$(mktemp -d)"
gh repo fork solana-foundation/pay-skills --clone --default-branch-only && cd pay-skills
git checkout -b add-motto

# 2. Copy the listing, set the URL, refuse to continue if a placeholder is left
cp -R "$HERE/motto/catalog/providers/motto" providers/
F=providers/motto/rentals/PAY.md
grep -rnE 'MOTTO_PUBLIC_URL|PLACEHOLDER|YOUR_REAL_DOMAIN' providers/motto && echo STOP || echo clean

# 3. Check: static first, then the probe that PR CI runs (the desk must be reachable)
pay catalog check "$F" --no-probe
pay catalog check . --files "$F" --currencies USDC,USDT --probe-timeout 15 --probe-concurrency 5 -v --summary-out ../verdict.md

# 4. Commit, push, open the PR with the real verdict in the body
git add providers/motto && git commit -m "feat(catalog): add Motto" && git push -u origin add-motto
{ echo "Adds motto/rentals: refundable USDC holds for real-world rentals (charger, hotspot, battery pack, storage, monitor) and a verify-anything check, x402 upto on Solana. Six paid endpoints, one free terms endpoint, OpenAPI snapshot beside PAY.md."; echo; cat ../verdict.md; } > ../body.md
gh pr create --repo solana-foundation/pay-skills --base main --head "$(gh api user --jq .login):add-motto" --title "feat(catalog): add Motto" --body-file ../body.md
```

## Status when this was prepared

- Static check passes: `pay catalog check <PAY.md> --no-probe` and `pay catalog check . --no-probe` (3 endpoints).
- Live probe passes against https://motto.tail039d5c.ts.net (`pay catalog check . --files providers/motto/rentals/PAY.md --currencies USDC,USDT`, exit 0): both paid endpoints return a 402 x402 `upto` USDC challenge, Solana verdict pass 2/2. The probe prints `FAIL expected 402, got 200` for the free `GET /v1/terms`; it is listed as free in the verdict and does not fail the check.
- Merge gate: every paid endpoint must return a 402 x402 or MPP challenge for Solana mainnet USDC or USDT. The sandbox desk already advertises the mainnet network id and USDC mint, but it is backed by the Surfpool sandbox RPC, so holds settle only in the Pay.sh sandbox.
- Keep the desk reachable until the PR is merged.
- `/openapi.json` summaries in `src/server.js` match the sidecar and are under the registry's 63 char cap.
