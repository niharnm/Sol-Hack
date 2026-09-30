// Buyer agent: Claude asks Motto to purchase a supported virtual result, with pay tools only.
// It reads the service terms, decides whether the request matches the research service, pays under
// the published research ceiling, and reports. This script then checks the report against Motto's
// hold log, so the outcome does not rest on the model's word.
//
//   npm run buyer -- --scenario research-brief
//   npm run buyer -- "Buy three DOI-backed sources about battery recycling"
//   npm run buyer -- --desk https://example.com --mainnet --scenario research-brief
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const SCENARIOS = {
  'research-brief': 'Your user is preparing a technical brief and needs three DOI-backed source records about retrieval augmented generation. Buy the research pack for query "retrieval augmented generation" if its terms fit. Inspect the delivered citations and report their titles and DOI links. Structural checks do not establish relevance or paper quality.',
};

const TOOLS = ['mcp__pay__curl', 'mcp__pay__get_balance', 'mcp__pay__list_catalog', 'mcp__pay__search_catalog', 'mcp__pay__get_catalog_entry'];
const BLOCKED = ['Bash', 'Read', 'Glob', 'Grep', 'Write', 'Edit', 'WebFetch', 'WebSearch', 'Agent', 'NotebookEdit', 'mcp__pay__topup', 'mcp__pay__create_skill'];

// The cap comes from the selected service, not from unrelated entries in the terms response.
// Amounts are parsed as USDC base units so decimal strings are never rounded through Number.
export function serviceCeiling(terms, item = 'research') {
  const usd = terms?.items?.[item]?.hold_usd;
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(String(usd ?? ''));
  if (!match) throw new Error(`the desk does not publish a valid hold_usd for ${item}`);
  const units = BigInt(match[1]) * 1_000_000n + BigInt((match[2] ?? '').padEnd(6, '0'));
  if (units === 0n) throw new Error(`the desk publishes a zero hold_usd for ${item}`);
  const fraction = (units % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '').padEnd(2, '0');
  return `$${units / 1_000_000n}.${fraction}`;
}

export function buyerPrompt(desk, request, cap) {
  return `You are a purchasing agent for virtual services. Motto is an intermediary between buyer intent, a supported provider, payment, validation, and a signed receipt. Motto is not a device API and cannot inspect, control, charge, repair, or otherwise act on physical equipment.

User request: ${request}

Read the free terms at ${desk}/v1/terms with your pay curl tool. The supported purchase flow is POST ${desk}/v1/buy/research with JSON body {"query":"..."}. Buy at most one research result, at most once, only when it matches the user's request. Never pay more than ${cap}. If the user asks for a physical action, device state, or any unsupported service, do not make a payment. Do not retry a failed or timed-out paid request.

When done, reply with 2 short lines for your user, then a last line that is only this JSON. Use decision "held" whenever you opened a hold, whatever it settled to:
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
  const request = positionals.join(' ') || SCENARIOS[values.scenario ?? 'research-brief'];
  if (!request) throw new Error(`unknown scenario "${values.scenario}". Try --list.`);
  const desk = values.desk.replace(/\/$/, '');

  // Fail fast with a clear message if the desk is not up.
  const terms = await fetch(`${desk}/v1/terms`).then(r => r.json()).catch(() => undefined);
  if (!terms?.items) throw new Error(`no desk at ${desk} (GET /v1/terms failed)`);
  const network = values.mainnet ? 'mainnet' : 'localnet';
  if (terms.network !== network && !(network === 'mainnet' && terms.network === 'mainnet-beta')) {
    throw new Error(`desk is on ${terms.network}, buyer is on ${network}. Pass --mainnet only for a mainnet desk.`);
  }

  const cap = serviceCeiling(terms);

  // On mainnet the cap is enforced by the pay MCP server, not by the prompt: this desk's origin
  // only, the research service ceiling per payment. pay 0.29 rejects every permission rule in the sandbox
  // ("invalid Solana network" for Surfpool's chain id), so the sandbox runs without the cap and says so.
  const dir = mkdtempSync(join(tmpdir(), 'motto-buyer-'));
  try {
    const payArgs = [values.mainnet ? '--mainnet' : '--sandbox', 'mcp'];
    if (values.mainnet) {
      const permissions = join(dir, 'permissions.yml');
      writeFileSync(permissions, `origins: [${new URL(desk).origin}]\nnetworks: [mainnet]\nmax_payment: "${cap}"\nallow_any_asset: false\n`);
      payArgs.push('--permissions', permissions);
    }
    const mcp = join(dir, 'mcp.json');
    writeFileSync(mcp, JSON.stringify({ mcpServers: { pay: { command: 'pay', args: payArgs } } }));

    const capNote = values.mainnet ? `${cap} cap enforced by pay` : `sandbox: no pay cap, test funds, prompt cap ${cap}`;
    console.log(`Buyer (${values.model}, pay tools only, ${capNote}) -> ${desk}`);
    console.log(`Request: ${request}\n`);
    const started = Date.now();
    const raw = await runClaude(
      ['-p', '--model', values.model, '--setting-sources', 'local', '--mcp-config', mcp, '--strict-mcp-config', '--allowedTools', TOOLS.join(','), '--disallowedTools', BLOCKED.join(','), '--output-format', 'json'],
      buyerPrompt(desk, request, cap),
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
