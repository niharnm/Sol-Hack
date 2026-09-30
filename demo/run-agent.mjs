// A real Claude buyer with only Pay.sh tools; all payments use sandbox USDC.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
const mission = `You are a purchasing agent acting for a user whose laptop is running a long job at a venue. This is a demo task; do not claim you ran the job. Your assignment: arrange power if needed, with a maximum authorization of $1 test USDC. You cannot inspect the laptop. Use only the Pay.sh tools and only http://127.0.0.1:8787. First read GET /v1/terms and explain the charger price and refund rules in one sentence. Then make exactly ONE paid POST /v1/rent/charger, authorizing no more than $1. Do not retry a paid request if it fails or times out. Let the desk check the device and verify delivery. Report only what the returned receipt confirms: outcome, charged amount, returned amount, and hold ID. If settlement failed, state that it is unconfirmed. Never call this mainnet or real-money proof. Do not claim you cryptographically verified the signature yourself.`;
const config = JSON.stringify({ mcpServers: { pay: { command: 'npx', args: ['--yes', '--package', '@solana/pay', 'pay', '--sandbox', 'mcp'] } } });
console.log('\nDEMO MISSION: Keep my laptop powered. Authorize up to $1 test USDC.\nReal Claude buyer · Pay.sh sandbox tools only\n');
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
