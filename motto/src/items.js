// What the desk rents. Each item is one check plus its terms. Prices are per item; the
// settlement rules are the same for all of them, and the rule sentences the agent reads are
// generated from the numbers so copy and settle() cannot drift. A new item is a new entry here.
import { verifyRequestError, checkCondition } from './judge.js';
import { checkResearch, researchRequestError } from './research.js';
import { chargerWaitMs, checkBatteryPack, checkCharger, checkDisplay, checkHotspot, checkStorage, numberIn } from './checks.js';
import { formatUsd, toBaseUnits } from './settlement.js';

// Clamped like a request value: the wait must end inside the x402 offer's 300 second timeout.
const DEFAULT_WAIT_MS = chargerWaitMs(Number(process.env.CHARGER_WAIT_MS ?? 30_000) / 1000, 30_000);

// Turn an item's prices and per-outcome leads into the terms the agent sees.
//   already_handled, not_delivered: the check fee is charged, the rest returned
//   delivered: the whole hold (or the fee, for a pure check like verify)
//   inconclusive, check_failed: nothing charged
function define(item) {
  const hold = toBaseUnits(item.hold_usd);
  const fee = toBaseUnits(item.check_fee_usd);
  if (fee > hold) throw new Error(`${item.label}: check fee $${item.check_fee_usd} is above the $${item.hold_usd} hold`);
  const feeText = `the $${formatUsd(fee)} check fee is charged, $${formatUsd(hold - fee)} returned`;
  const holdText = `$${formatUsd(hold)} charged (${item.covers}), nothing returned`;
  const noneText = `nothing charged, $${formatUsd(hold)} returned`;
  const money = outcome =>
    outcome === 'delivered' ? (item.charge_on_delivered === 'fee' ? feeText : holdText)
    : outcome === 'already_handled' || outcome === 'not_delivered' ? feeText
    : noneText;
  const rules = Object.fromEntries(Object.entries(item.leads).map(([outcome, lead]) => [outcome, `${lead}: ${money(outcome)}.`]));
  rules.check_failed = `The check itself failed: ${noneText}.`;
  const { leads, label, ...terms } = item;
  // Summaries show in the OS payment prompt and the pay-skills registry caps them at 63 characters.
  const summary = item.summary ?? `Start a ${label} rental with a refundable $${item.hold_usd.replace(/\.00$/, '')} hold`;
  return { ...terms, label, summary, rules };
}

export const ITEMS = {
  research: define({
    label: 'research',
    hold_usd: '1.00',
    // A delivery, not a device check: there is nothing to be "already handled", so no check fee.
    check_fee_usd: '0.00',
    covers: 'three DOI-backed citation records with titles',
    charge_on_delivered: 'hold',
    check: 'Deliver three distinct citation records with titles and DOI identifiers for the requested topic.',
    params: { query: 'Required topic, 3 to 200 characters. Returns 3 citation records from Crossref public metadata.' },
    summary: 'Buy a verified three-source research pack',
    leads: {
      delivered: 'Three citation records delivered and structural checks passed',
      inconclusive: 'Incomplete result or provider unavailable',
    },
    validate: researchRequestError,
    run: ({ holdId, body, onUpdate }) => checkResearch({ holdId, query: body.query, onUpdate }),
  }),
  charger: define({
    label: 'charger',
    hold_usd: '3.00',
    check_fee_usd: '0.05',
    covers: 'one charging session, up to 4 hours',
    charge_on_delivered: 'hold',
    check: 'Is the device already drawing AC power?',
    params: { wait_seconds: 'How long to wait for power after a hold on battery. Default 30, clamped to 0 to 240.' },
    leads: {
      already_handled: 'Device already on AC power',
      delivered: 'Device on battery and power arrived within the wait window',
      not_delivered: 'Power never arrived within the wait window',
    },
    run: ({ holdId, body, onUpdate }) => checkCharger({ holdId, waitMs: chargerWaitMs(body?.wait_seconds, DEFAULT_WAIT_MS), onUpdate }),
  }),
  hotspot: define({
    label: 'hotspot',
    hold_usd: '8.00',
    check_fee_usd: '0.10',
    covers: 'a day pass, up to 24 hours',
    charge_on_delivered: 'hold',
    check: 'Is the device already on the venue network?',
    params: {},
    leads: {
      already_handled: 'Device already on the venue network',
      delivered: 'Device off the venue network, hotspot needed',
    },
    run: ({ holdId }) => checkHotspot({ holdId }),
  }),
  battery_pack: define({
    label: 'battery pack',
    hold_usd: '6.00',
    check_fee_usd: '0.05',
    covers: 'one battery pack, up to 8 hours',
    charge_on_delivered: 'hold',
    check: 'Is the device on AC or charged to at least min_percent?',
    params: { min_percent: 'Charge the job needs to finish without a pack. Default 50, clamped to 1 to 100.' },
    leads: {
      already_handled: 'Device on AC or charged to at least min_percent',
      delivered: 'Device on battery below min_percent',
    },
    run: ({ holdId, body }) => checkBatteryPack({ holdId, minPercent: numberIn(body?.min_percent, 1, 100, 50) }),
  }),
  storage: define({
    label: 'storage',
    hold_usd: '2.00',
    check_fee_usd: '0.02',
    covers: 'up to 100 GB of storage for 24 hours',
    charge_on_delivered: 'hold',
    check: 'Does the device already have needed_gb of free disk?',
    params: { needed_gb: 'Free space the job needs, in GB. Default 10, clamped to 0.1 to 100000.' },
    leads: {
      already_handled: 'Enough free disk already',
      delivered: 'Not enough free disk for the job',
    },
    run: ({ holdId, body }) => checkStorage({ holdId, neededGb: numberIn(body?.needed_gb, 0.1, 100_000, 10) }),
  }),
  display: define({
    label: 'monitor',
    hold_usd: '10.00',
    check_fee_usd: '0.10',
    covers: 'one external monitor, up to 8 hours',
    charge_on_delivered: 'hold',
    check: 'Is an external display already connected?',
    params: { wait_seconds: 'How long to wait for a display to be connected. Default 30, clamped to 0 to 240.' },
    leads: {
      already_handled: 'External display already connected',
      delivered: 'No display, then one connected within the wait window',
      not_delivered: 'No display connected before the timeout',
    },
    run: ({ holdId, body, onUpdate }) => checkDisplay({ holdId, waitMs: chargerWaitMs(body?.wait_seconds, DEFAULT_WAIT_MS), onUpdate }),
  }),
  verify: define({
    label: 'verify',
    hold_usd: '0.10',
    check_fee_usd: '0.10',
    covers: 'one model-judged check of a stated condition',
    // A pure check: a definitive verdict either way costs the fee; there is no rental to keep.
    charge_on_delivered: 'fee',
    check: 'Is your condition already true? You state it; the desk reads the evidence and a model decides.',
    params: {
      condition: 'Required. The fact that would make this purchase unnecessary, in plain English, up to 500 characters.',
      evidence_urls: 'Optional. Up to 3 public https URLs the desk fetches as evidence (order status, booking page, API).',
    },
    summary: 'Verify any condition before you buy, refundable $0.10 hold',
    leads: {
      already_handled: 'Condition true on the evidence',
      delivered: 'Condition false on the evidence',
      inconclusive: 'The evidence does not settle it',
    },
    validate: verifyRequestError,
    run: ({ holdId, body, onUpdate }) => checkCondition({ holdId, condition: body.condition, evidenceUrls: body.evidence_urls ?? [], onUpdate }),
  }),
};

// The highest ceiling on the desk: the per-payment cap a buyer needs to rent anything here.
export const MAX_HOLD_USD = formatUsd(Object.values(ITEMS).reduce((max, item) => (toBaseUnits(item.hold_usd) > max ? toBaseUnits(item.hold_usd) : max), 0n));

// Terms as the agent sees them: everything but the check function.
export function publicTerms() {
  return Object.fromEntries(Object.entries(ITEMS).map(([name, { run, validate, summary, ...terms }]) => [name, terms]));
}
