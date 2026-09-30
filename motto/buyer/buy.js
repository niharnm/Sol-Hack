// Buyer agent: Claude acting for a user it cannot see, with pay tools only.
// It reads the desk's terms, decides whether a hold makes sense, pays under a
// $1.00 per-payment cap, and reports. Then this script checks the agent's report
// against the desk's own hold log, so the outcome does not rest on the model's word.
//
//   npm run buyer -- --scenario low-battery
//   npm run buyer -- "My laptop is at 12% and has a 3 hour render left"
//   npm run buyer -- --desk https://motto.tail039d5c.ts.net --mainnet --scenario no-wifi
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

// Situations the user's agent might be in. The agent never sees the device state;
// the desk does. Each maps to one item, but the agent has to pick it from the terms.
export const SCENARIOS = {
  'research-brief': 'Your user is preparing a technical brief and needs three DOI-backed source records about retrieval augmented generation. Buy the research pack for query "retrieval augmented generation" if its terms fit. Inspect the delivered citations and report their titles and DOI links. Structural checks do not establish relevance or paper quality.',
  'low-battery': 'Your user left their laptop running a long training job at a hackathon table. Their last message said the battery was getting low and they are away for an hour.',
  'plugged-in': 'Your user\'s laptop is running a long job at a hackathon. They may or may not have plugged it in before walking off; you have no way to tell.',
  'battery-pack': 'Your user is heading out with their laptop for a 2 hour train ride with no outlets and needs a job to keep running. They want at least 50% battery for it.',
  'big-download': 'Your user asked you to download a 60 GB dataset onto their laptop tonight. You do not know how much free disk the laptop has.',
  'no-wifi': 'Your user\'s laptop must upload results in the next ten minutes. They might have left the venue wifi range.',
  'two-screens': 'Your user wants their laptop driving two external monitors for a trading-desk style setup and asked you to buy an adapter only if that is not already working. You cannot see their desk.',
  'second-screen': 'Your user is about to give a demo and asked for an external monitor at their desk. They may already have one connected.',
};

const TOOLS = ['mcp__pay__curl', 'mcp__pay__get_balance', 'mcp__pay__list_catalog', 'mcp__pay__search_catalog', 'mcp__pay__get_catalog_entry'];
const BLOCKED = ['Bash', 'Read', 'Glob', 'Grep', 'Write', 'Edit', 'WebFetch', 'WebSearch', 'Agent', 'NotebookEdit', 'mcp__pay__topup', 'mcp__pay__create_skill'];

export function buyerPrompt(desk, situation) {
  return `You are a personal agent running in the cloud for your user. You cannot inspect their devices yourself.

Situation: ${situation}

A deposit desk rents real-world items to agents with refundable USDC holds. Its terms are free at ${desk}/v1/terms. Use your pay curl tool to read them, decide which item (if any) fits the situation, and rent it only if it makes sense for your user. Rentals are POST ${desk}/v1/rent/<item> with an optional JSON body of the item's params. Rent at most one item, at most once. Never pay more than $1.00.

When done, reply with 2 short lines for your user, then a last line that is only this JSON (decision is "held" whenever you opened a hold, whatever it settled to):
{"decision":"held"|"skipped","item":<item or null>,"hold_id":<id or null>,"charged_usd":<string or null>,"returned_usd":<string or null>,"why":<one sentence>}`;
}

// The last {...} line in the agent's reply.
export function parseReport(text) {
  const line = String(text).trim().split('\n').reverse().find(l => l.trim().startsWith('{'));
  if (!line) return undefined;
  try {
    return JSON.parse(line.trim().replace(/^```(json)?|```$/g, ''));
  } catch {
    return undefined;
  }
}

function runClaude(args, stdin, cwd) {
  return new Promise((resolve, reject) => {
    // Run from an empty directory with no user settings, so the buyer sees only this prompt and
    // the pay tools, never the operator's own CLAUDE.md, memory or plugins.
    const child = spawn('claude', args, { cwd, stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.setEncoding('utf8').on('data', c => (out += c));
    child.on('error', reject);
    child.on('exit', code => (code === 0 ? resolve(out) : reject(new Error(`claude exited with ${code}: ${out.slice(-500)}`))));
    child.stdin.end(stdin);
  });
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      desk: { type: 'string', default: process.env.DESK_URL ?? 'http://127.0.0.1:8787' },
      scenario: { type: 'string' },
      mainnet: { type: 'boolean', default: false },
      model: { type: 'string', default: 'sonnet' },
      list: { type: 'boolean', default: false },
    },
  });
  if (values.list) {
    for (const [name, text] of Object.entries(SCENARIOS)) console.log(`${name.padEnd(14)} ${text}`);
    return;
  }
  const situation = positionals.join(' ') || SCENARIOS[values.scenario ?? 'research-brief'];
  if (!situation) throw new Error(`unknown scenario "${values.scenario}". Try --list.`);
  const desk = values.desk.replace(/\/$/, '');

  // Fail fast with a clear message if the desk is not up.
  const terms = await fetch(`${desk}/v1/terms`).then(r => r.json()).catch(() => undefined);
  if (!terms?.items) throw new Error(`no desk at ${desk} (GET /v1/terms failed)`);
  const network = values.mainnet ? 'mainnet' : 'localnet';
  if (terms.network !== network && !(network === 'mainnet' && terms.network === 'mainnet-beta')) {
    throw new Error(`desk is on ${terms.network}, buyer is on ${network}. Pass --mainnet only for a mainnet desk.`);
  }

  // On mainnet the cap is enforced by the pay MCP server, not by the prompt: this desk's origin
  // only, $1.00 per payment. pay 0.29 rejects every permission rule in the sandbox ("invalid
  // Solana network" for Surfpool's chain id), so the sandbox runs without the cap and says so.
  const dir = mkdtempSync(join(tmpdir(), 'motto-buyer-'));
  try {
    const payArgs = [values.mainnet ? '--mainnet' : '--sandbox', 'mcp'];
    if (values.mainnet) {
      const permissions = join(dir, 'permissions.yml');
      writeFileSync(permissions, `origins: [${new URL(desk).origin}]\nnetworks: [mainnet]\nmax_payment: "$1.00"\nallow_any_asset: false\n`);
      payArgs.push('--permissions', permissions);
    }
    const mcp = join(dir, 'mcp.json');
    writeFileSync(mcp, JSON.stringify({ mcpServers: { pay: { command: 'pay', args: payArgs } } }));

    const cap = values.mainnet ? '$1.00 cap enforced by pay' : 'sandbox: no pay cap, test funds';
    console.log(`Buyer (${values.model}, pay tools only, ${cap}) -> ${desk}`);
    console.log(`Situation: ${situation}\n`);
    const started = Date.now();
    const raw = await runClaude(
      ['-p', '--model', values.model, '--setting-sources', 'local', '--mcp-config', mcp, '--strict-mcp-config', '--allowedTools', TOOLS.join(','), '--disallowedTools', BLOCKED.join(','), '--output-format', 'json'],
      buyerPrompt(desk, situation),
      dir,
    );
    const result = JSON.parse(raw);
    const text = result.result ?? '';
    console.log(text.split('\n').filter(l => !l.trim().startsWith('{')).join('\n').trim());
    const report = parseReport(text);
    console.log(`\nAgent report: ${JSON.stringify(report ?? 'none')}`);
    console.log(`Time ${((Date.now() - started) / 1000).toFixed(1)}s, model cost $${Number(result.total_cost_usd ?? 0).toFixed(4)}`);

    // Cross-check against the desk: the hold log is the source of truth, not the model.
    if (report?.hold_id) {
      const hold = await fetch(`${desk}/v1/holds/${encodeURIComponent(report.hold_id)}`).then(r => (r.ok ? r.json() : undefined));
      if (!hold) {
        console.log(`Desk check: FAILED, the desk has no hold ${report.hold_id}`);
        process.exitCode = 1;
      } else {
        const match = hold.item === report.item && hold.charged_usd === report.charged_usd && hold.returned_usd === report.returned_usd;
        console.log(`Desk check: ${match ? 'verified' : 'MISMATCH'}. Desk says ${hold.item} ${hold.status}, charged $${hold.charged_usd}, returned $${hold.returned_usd} (${hold.detail}).`);
        if (!match) process.exitCode = 1;
      }
    } else {
      console.log('Desk check: no hold opened.');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}
