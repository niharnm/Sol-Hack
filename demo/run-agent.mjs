// A real Claude buyer with only Pay.sh tools; all payments use sandbox USDC.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
const mission = `You are a research purchasing agent. Your user needs three DOI-backed sources about retrieval augmented generation for a technical research brief. Use only Pay.sh tools and only http://127.0.0.1:8787. Read GET /v1/terms, explain the research pack price and acceptance conditions briefly, then make exactly ONE paid POST /v1/rent/research with JSON body {"query":"retrieval augmented generation"}. Authorize no more than $1 test USDC. Do not retry a failed or timed-out paid request. Inspect the returned signed_reading.deliverable and checks. Report the actual titles and DOI links, checks passed or failed, hold ID, amount charged and amount returned. A structural citation check is not proof of relevance or paper quality. Do not claim to have read the papers, verified the signature yourself, or run a mainnet payment.`;
const config = JSON.stringify({ mcpServers: { pay: { command: 'npx', args: ['--yes', '--package', '@solana/pay', 'pay', '--sandbox', 'mcp'] } } });
console.log('\nDEMO MISSION: Buy three DOI-backed research sources. Authorize up to $1 test USDC.\nReal Claude buyer · Pay.sh sandbox tools only\n');
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
