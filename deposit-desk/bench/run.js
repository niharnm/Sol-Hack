// Runs the benchmark: frontier model alone vs smaller model with Deposit Desk.
// Models are called through the Claude CLI with a minimal context. The desk's
// check is simulated here from each scenario's hidden truth (in the live product
// it reads the device). Results go to bench/results.json.
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const { scenarios } = JSON.parse(readFileSync(new URL('./scenarios.json', import.meta.url)));
const LIMIT = Number(process.env.BENCH_LIMIT ?? scenarios.length);
const CONCURRENCY = Number(process.env.BENCH_CONCURRENCY ?? 6);

const AGENTS = [
  { key: 'frontier_alone', label: 'Fable 5.1 alone', model: 'claude-fable-5-1', desk: false },
  { key: 'small_alone', label: 'Sonnet 5 alone', model: 'claude-sonnet-5', desk: false },
  { key: 'small_with_desk', label: 'Sonnet 5 + Deposit Desk', model: 'claude-sonnet-5', desk: true },
];

const SYSTEM = 'You are a personal purchasing agent acting for a user. You cannot see or query the user\'s device. Reply with a single JSON object only.';

function prompt(s, desk) {
  const item = s.item === 'charger' ? 'a charger rental' : 'a hotspot rental';
  const options = desk
    ? `Options:
- "buy": rent now for $1.00, charged in full.
- "hold": put $1.00 on hold at Deposit Desk. The desk checks the device itself. If the need is already handled you get $0.99 back ($0.01 check fee). If the need is real the rental starts and $1.00 is charged.
- "skip": do nothing.`
    : `Options:
- "buy": rent now for $1.00, charged in full.
- "skip": do nothing.`;
  return `User request: "${s.request}"
What you know (may be stale): ${s.context.map(c => `\n- ${c}`).join('')}

You are deciding about ${item}. Buying something the user did not need wastes their money. Skipping when the user really needed it means the device fails them.
${options}

Reply as {"decision": "...", "reason": "one short sentence"}.`;
}

function callModel(model, text) {
  return new Promise(resolve => {
    const started = Date.now();
    const child = execFile(
      'claude',
      ['-p', '--model', model, '--output-format', 'json', '--tools', '', '--system-prompt', SYSTEM,
        '--no-session-persistence', '--strict-mcp-config', '--setting-sources', '', '--disable-slash-commands'],
      { maxBuffer: 10 * 1024 * 1024, timeout: 180_000, cwd: '/tmp' },
      (error, stdout) => {
        const ms = Date.now() - started;
        try {
          const out = JSON.parse(stdout);
          const parsed = JSON.parse(out.result.match(/\{[\s\S]*\}/)[0]);
          resolve({ decision: String(parsed.decision).toLowerCase(), reason: parsed.reason, costUsd: out.total_cost_usd, ms });
        } catch {
          resolve({ decision: 'error', reason: String(error?.message ?? stdout).slice(0, 200), costUsd: 0, ms });
        }
      },
    );
    child.stdin.end(text);
  });
}

// Settlement rules, identical to the live desk.
function score(decision, truth) {
  const need = truth === 'real_need';
  if (decision === 'buy') return { spend: 1, wasted: need ? 0 : 1, missed: false };
  if (decision === 'hold') return { spend: need ? 1 : 0.01, wasted: need ? 0 : 0.01, missed: false };
  return { spend: 0, wasted: 0, missed: need }; // skip or error
}

async function pool(tasks, n) {
  const results = new Array(tasks.length);
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
      if ((i + 1) % 10 === 0) console.log(`  ${i + 1}/${tasks.length}`);
    }
  }));
  return results;
}

const subset = scenarios.slice(0, LIMIT);
const runs = [];
for (const agent of AGENTS) {
  console.log(`running ${agent.label} on ${subset.length} scenarios`);
  const results = await pool(subset.map(s => async () => {
    const r = await callModel(agent.model, prompt(s, agent.desk));
    return { id: s.id, truth: s.truth, ...r, ...score(r.decision, s.truth) };
  }), CONCURRENCY);
  const sum = key => results.reduce((t, r) => t + (typeof r[key] === 'boolean' ? Number(r[key]) : r[key]), 0);
  const needs = results.filter(r => r.truth === 'real_need').length;
  runs.push({
    ...agent,
    scenarios: results.length,
    wasted_usd: +sum('wasted').toFixed(2),
    missed_needs: sum('missed'),
    real_needs: needs,
    needs_met_pct: +(100 * (needs - sum('missed')) / needs).toFixed(1),
    total_spend_usd: +sum('spend').toFixed(2),
    model_cost_usd: +sum('costUsd').toFixed(4),
    avg_latency_ms: Math.round(sum('ms') / results.length),
    errors: results.filter(r => r.decision === 'error').length,
    decisions: results.reduce((m, r) => ({ ...m, [r.decision]: (m[r.decision] ?? 0) + 1 }), {}),
    results,
  });
}

const out = {
  ranAt: new Date().toISOString(),
  note: 'Scenarios are generated (bench/generate.js, seeded). Device states are simulated from each scenario\'s hidden truth; in the live product the desk reads the real device.',
  runs,
};
writeFileSync(new URL('./results.json', import.meta.url), JSON.stringify(out, null, 2));
console.table(runs.map(({ label, wasted_usd, missed_needs, needs_met_pct, total_spend_usd, model_cost_usd, avg_latency_ms, errors }) =>
  ({ label, wasted_usd, missed_needs, needs_met_pct, total_spend_usd, model_cost_usd, avg_latency_ms, errors })));
