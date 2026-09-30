// Generates the benchmark scenarios: personal-agent purchase decisions where the
// agent only has text context and the real device state is hidden.
// Deterministic (seeded) so anyone can regenerate the exact same file.
import { writeFileSync } from 'node:fs';

const N = Number(process.env.BENCH_N ?? 50);
let seed = 20260930;
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = list => list[Math.floor(rand() * list.length)];

// Cues point one way or the other, but they are stale or indirect, the way an
// agent's context really is. Each scenario mixes cues; the truth is drawn so the
// cues are informative but not decisive.
const charger = {
  request: [
    'My laptop has a long export running. Make sure it does not die.',
    'I need my phone alive for the next few hours. Handle power if needed.',
    'Keep my laptop going through the afternoon session.',
    'My phone is my ticket for tonight. Do not let it run out.',
  ],
  needCues: [
    'Last battery sync 45 minutes ago showed 14%.',
    'User texted "almost dead" an hour ago.',
    'User is in a lecture hall with few outlets.',
    'Calendar shows back-to-back meetings away from the desk.',
    'Device reported "low power mode on" at the last sync.',
  ],
  handledCues: [
    'User usually works at a desk with a charger.',
    'Last battery sync 50 minutes ago showed 71%.',
    'User mentioned bringing a power bank this morning.',
    'Venue lists outlets at every seat.',
    'User said "plugging in now" 30 minutes ago, no confirmation since.',
  ],
};
const hotspot = {
  request: [
    'My laptop has to stay online for a deploy. Sort out connectivity if needed.',
    'I am about to join a video call from my laptop. Make sure I have internet.',
    'Keep my laptop connected for the upload this afternoon.',
    'I need to be online for the demo in an hour.',
  ],
  needCues: [
    'User complained the venue wifi was dropping an hour ago.',
    'Last network sync showed the laptop on a phone tether.',
    'Venue wifi requires a login page the user may not have completed.',
    'User said "wifi here is terrible" this morning.',
  ],
  handledCues: [
    'User joined the venue wifi at check-in two hours ago.',
    'Venue advertises fast wifi for all attendees.',
    'Last network sync 40 minutes ago showed the venue network.',
    'User finished a large upload without complaint earlier.',
  ],
};

const scenarios = [];
for (let i = 0; i < N; i++) {
  const item = i % 2 === 0 ? 'charger' : 'hotspot';
  const pool = item === 'charger' ? charger : hotspot;
  const truth = rand() < 0.5 ? 'real_need' : 'already_handled';
  // Cues agree with the truth about 60% of the time: informative, not decisive.
  const cues = [];
  for (let c = 0; c < 3; c++) {
    const agrees = rand() < 0.6;
    const pointsToNeed = truth === 'real_need' ? agrees : !agrees;
    const cue = pick(pointsToNeed ? pool.needCues : pool.handledCues);
    if (!cues.includes(cue)) cues.push(cue);
  }
  scenarios.push({ id: `s${String(i + 1).padStart(2, '0')}`, item, request: pick(pool.request), context: cues, truth });
}

writeFileSync(new URL('./scenarios.json', import.meta.url), JSON.stringify({ seed: 20260930, n: N, scenarios }, null, 2));
const needs = scenarios.filter(s => s.truth === 'real_need').length;
console.log(`wrote ${N} scenarios (${needs} real needs, ${N - needs} already handled)`);
