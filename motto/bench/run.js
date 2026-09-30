// Runs the benchmark: frontier model alone vs smaller model with Motto.
// Models are called through the Claude CLI with a minimal context. The desk's
// check is simulated here from each scenario's hidden truth (in the live product
// it reads the device). Results go to bench/results.json.
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { publicTerms } from '../src/items.js';

// Each scenario's item is priced from the desk's own table, so the prompt and the score never drift.
const TERMS = publicTerms();
const { scenarios } = JSON.parse(readFileSync(new URL('./scenarios.json', import.meta.url)));
const LIMIT = Number(process.env.BENCH_LIMIT ?? scenarios.length);
const CONCURRENCY = Number(process.env.BENCH_CONCURRENCY ?? 6);

const AGENTS = [
  { key: 'frontier_alone', label: 'Fable 5.1 alone', model: 'claude-fable-5-1', desk: false },
  { key: 'small_alone', label: 'Sonnet 5 alone', model: 'claude-sonnet-5', desk: false },
  { key: 'small_with_desk', label: 'Sonnet 5 + Motto', model: 'claude-sonnet-5', desk: true },
];

const SYSTEM = 'You are a personal purchasing agent acting for a user. You cannot see or query the user\'s device. Reply with a single JSON object only.';

// '3.00' minus '0.05' -> '2.95', done in USDC base units (6 decimals) so sub-cent fees stay exact.
function usdMinus(a, b) {
  const units = s => { const [i, f = ''] = String(s).split('.'); return BigInt(i) * 1_000_000n + BigInt(f.padEnd(6, '0')); };
  const diff = units(a) - units(b);
  const frac = (diff % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '').padEnd(2, '0');
  return `${diff / 1_000_000n}.${frac}`;
}

function prompt(s, desk) {
  const { hold_usd, check_fee_usd } = TERMS[s.item];
  const item = `a ${s.item.replaceAll('_', ' ')} rental`;
  const options = desk
    ? `Options:
- "buy": rent now for $${hold_usd}, charged in full.
- "hold": put $${hold_usd} on hold at Motto. The desk checks the device itself. If the need is already handled you get $${usdMinus(hold_usd, check_fee_usd)} back ($${check_fee_usd} check fee). If the need is real the rental starts and $${hold_usd} is charged.
- "skip": do nothing.`
    : `Options:
- "buy": rent now for $${hold_usd}, charged in full.
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

// Settlement rules, identical to the live desk, at the item's own prices: buy pays the hold outright;
// a hold pays the hold when the need is real (the fee for a pure check) and only the check fee when
// the need was already handled.
function score(decision, truth, item) {
  const need = truth === 'real_need';
  const terms = TERMS[item];
  const hold = Number(terms.hold_usd);
  const fee = Number(terms.check_fee_usd);
  const kept = terms.charge_on_delivered === 'fee' ? fee : hold;
  if (decision === 'buy') return { spend: hold, wasted: need ? 0 : hold, missed: false };
  if (decision === 'hold') return { spend: need ? kept : fee, wasted: need ? 0 : fee, missed: false };
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
    return { id: s.id, truth: s.truth, ...r, ...score(r.decision, s.truth, s.item) };
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
  note: 'Scenarios are generated (bench/generate.js, seeded). Device states are simulated from each scenario\'s hidden truth; in the live product the desk reads the real device. Spend and waste are priced per item from the desk\'s own hold and check fee (src/items.js).',
  runs,
};
writeFileSync(new URL('./results.json', import.meta.url), JSON.stringify(out, null, 2));
console.table(runs.map(({ label, wasted_usd, missed_needs, needs_met_pct, total_spend_usd, model_cost_usd, avg_latency_ms, errors }) =>
  ({ label, wasted_usd, missed_needs, needs_met_pct, total_spend_usd, model_cost_usd, avg_latency_ms, errors })));
