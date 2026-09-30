// A Claude buyer with only Pay.sh tools; all payments use sandbox USDC.
//   DESK_URL=http://127.0.0.1:8787 node demo/run-agent.mjs
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
const desk = (process.env.DESK_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const ITEM = 'research';

// The mission's ceiling is the item's hold_usd from the desk's own terms, so the text never states a stale number.
async function ceilingFor(item) {
  const response = await fetch(`${desk}/v1/terms`);
  if (!response.ok) throw new Error(`Could not read desk terms: HTTP ${response.status}`);
  const terms = await response.json();
  if (terms.network !== 'localnet') throw new Error('This Claude runner uses sandbox payments. For Devnet run: cd motto && npm run buy:devnet -- "research topic"');
  const usd = terms.items?.[item]?.hold_usd;
  if (!usd) throw new Error(`The desk does not publish a price for ${item}.`);
  return `$${usd} test USDC`;
}
const ceiling = await ceilingFor(ITEM);

const mission = `You are a purchasing agent for virtual services. Motto is an intermediary between your user's intent, a supported provider, payment, validation, and a signed receipt. It is not a device API and cannot perform or verify physical actions. Your user needs three DOI-backed sources about retrieval augmented generation for a technical research brief. Use only Pay.sh tools and only ${desk}. Read GET /v1/terms, explain the research pack price and acceptance conditions briefly, then make exactly ONE paid POST /v1/buy/${ITEM} with JSON body {"query":"retrieval augmented generation"}. Authorize no more than ${ceiling}. Do not retry a failed or timed-out paid request. Inspect the returned signed_reading.deliverable and checks. Report the actual titles and DOI links, checks passed or failed, hold ID, amount charged and amount returned. A structural citation check is not proof of relevance or paper quality. Do not claim to have read the papers, verified the signature yourself, or run a mainnet payment.`;
const config = JSON.stringify({ mcpServers: { pay: { command: 'npx', args: ['--yes', '--package', '@solana/pay', 'pay', '--sandbox', 'mcp'] } } });
console.log(`\nDEMO MISSION: Ask Motto to buy three DOI-backed research sources. Authorize up to ${ceiling}.\nClaude buyer · Pay.sh sandbox tools only · desk ${desk}\n`);
const child = spawn('claude', ['-p', '--verbose', '--output-format', 'stream-json', '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--allowedTools', 'mcp__pay__*', '--mcp-config', config], { cwd: tmpdir(), stdio: ['pipe', 'pipe', 'inherit'] });
child.stdin.end(mission);
const lines = createInterface({ input: child.stdout });
let resultSeen = false;
let failed = false;
lines.on('line', line => {
  let event;
  try { event = JSON.parse(line); } catch { return; }
  if (event.type === 'assistant') {
    for (const part of event.message?.content ?? []) {
      if (part.type === 'text') console.log(`AGENT: ${part.text}\n`);
      if (part.type === 'tool_use') console.log(`TOOL: ${part.name}`);
    }
  }
  if (event.type === 'result') {
    resultSeen = true;
    failed = Boolean(event.is_error);
    if (failed) console.error(`AGENT ERROR: ${event.result ?? event.subtype}`);
    console.log(failed ? '\nAgent run failed. Check the desk before retrying.' : '\nAgent run finished. Open View API proof on the dashboard.');
  }
});
const timeout = setTimeout(() => {
  failed = true;
  console.error('Agent exceeded 3 minutes. Stopping the buyer; an open hold may still settle. Check the dashboard before retrying.');
  child.kill('SIGTERM');
}, 180_000);
child.on('error', error => {
  clearTimeout(timeout);
  console.error(`Could not start Claude: ${error.message}. Install/sign in to Claude first, or use the documented direct sandbox command.`);
  process.exitCode = 1;
});
child.on('exit', code => {
  clearTimeout(timeout);
  if (!resultSeen) console.error('No agent result received. Confirm Claude is signed in.');
  process.exitCode = code || (failed || !resultSeen ? 1 : 0);
});
