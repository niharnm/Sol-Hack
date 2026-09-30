# Pay.sh catalog listing

Prepared for a PR to github.com/solana-foundation/pay-skills. One value needs a real public URL first.

## What is here

`catalog/providers/deposit-desk/rentals/` is exactly what the PR adds. In the pay-skills fork it lands at `providers/deposit-desk/rentals/` (FQN `deposit-desk/rentals`):

- `PAY.md`: listing frontmatter plus notes for agents. Started with `pay catalog scaffold`, then written by hand.
- `openapi.json`: reviewed snapshot of `GET /openapi.json` plus docs. The registry rejects remote OpenAPI URLs, so it is committed. `payTo` and `feePayer` are left out on purpose; the live 402 is authoritative.

The directory name must equal `name:` (`rentals`) or `pay catalog check` fails, hence the registry layout.

## Replace before the PR

1. `service_url` in `PAY.md` is the placeholder `https://DESK_PUBLIC_URL`. Set it to the desk's permanent https base URL: a domain name, no IP, no trailing slash. A quick `trycloudflare.com` URL passes but dies when cloudflared stops, and CI probes it at PR time and again on merge.
2. Reread the `Status:` paragraph in `PAY.md`. It says the desk is demoed in the Pay.sh sandbox. Edit it if the URL serves a mainnet desk. Never present a sandbox desk as a live mainnet service.
3. Optional: add `sandbox_service_url: https://...` for a sandbox desk that uses `https://402.surfnet.dev` as its RPC.

## Commands (prepared, not yet run against the real repo)

```bash
# 1. Fork and clone outside this repo
HERE="$(git rev-parse --show-toplevel)"; cd "$(mktemp -d)"
gh repo fork solana-foundation/pay-skills --clone --default-branch-only && cd pay-skills
git checkout -b add-deposit-desk

# 2. Copy the listing, set the URL, refuse to continue if a placeholder is left
cp -R "$HERE/deposit-desk/catalog/providers/deposit-desk" providers/
F=providers/deposit-desk/rentals/PAY.md; URL=https://YOUR_REAL_DOMAIN
sed -i.bak "s|^service_url: .*|service_url: $URL|" "$F" && rm "$F.bak"
grep -rnE 'DESK_PUBLIC_URL|PLACEHOLDER|YOUR_REAL_DOMAIN' providers/deposit-desk && echo STOP || echo clean

# 3. Check: static first, then the probe that PR CI runs (the desk must be reachable)
pay catalog check "$F" --no-probe
pay catalog check . --files "$F" --currencies USDC,USDT --probe-timeout 15 --probe-concurrency 5 -v --summary-out ../verdict.md

# 4. Commit, push, open the PR with the real verdict in the body
git add providers/deposit-desk && git commit -m "feat(catalog): add Deposit Desk" && git push -u origin add-deposit-desk
{ echo "Adds deposit-desk/rentals: refundable USDC holds for real-world rentals (charger, hotspot), x402 upto on Solana. Two paid endpoints, one free terms endpoint, OpenAPI snapshot beside PAY.md."; echo; cat ../verdict.md; } > ../body.md
gh pr create --repo solana-foundation/pay-skills --base main --head "$(gh api user --jq .login):add-deposit-desk" --title "feat(catalog): add Deposit Desk" --body-file ../body.md
```

## Status when this was prepared

- Static check passes: `pay catalog check <PAY.md> --no-probe` and `pay catalog check . --no-probe` (3 endpoints).
- Probe not run, no public https URL existed. With the placeholder host it fails on DNS and reports BLOCK.
- Merge gate: every paid endpoint must return a 402 x402 or MPP challenge for Solana mainnet USDC or USDT. The sandbox desk already advertises the mainnet network id and USDC mint, but it is backed by the Surfpool sandbox RPC, so holds settle only in the Pay.sh sandbox.
- Keep the desk reachable until the PR is merged.
- `/openapi.json` summaries in `src/server.js` are 76 and 90 chars; the registry caps them at 63 (shown in the OS payment prompt). The sidecar uses short ones; shorten `server.js` to match.
