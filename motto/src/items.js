// What the desk rents. Each item is one check plus its terms; the payment side is
// the same for all of them ($1.00 hold, $0.01 check fee). A new item is a new entry here.
import { verifyRequestError, checkCondition } from './judge.js';
import { chargerWaitMs, checkBatteryPack, checkCharger, checkDisplay, checkHotspot, checkStorage, numberIn } from './checks.js';

// Clamped like a request value: the wait must end inside the x402 offer's 300 second timeout.
const DEFAULT_WAIT_MS = chargerWaitMs(Number(process.env.CHARGER_WAIT_MS ?? 30_000) / 1000, 30_000);
const FAILED = 'The check itself failed: nothing charged, $1.00 returned.';

export const ITEMS = {
  charger: {
    hold_usd: '1.00',
    check_fee_usd: '0.01',
    check: 'Is the device already drawing AC power?',
    params: { wait_seconds: 'How long to wait for power after a hold on battery. Default 30, clamped to 0 to 240.' },
    summary: 'Start a charger rental with a refundable $1 hold',
    rules: {
      already_handled: 'Device already on power: charge the $0.01 check fee, $0.99 returned.',
      delivered: 'Device on battery, power delivered within the wait window: rental kept, $1.00 charged.',
      not_delivered: 'Power never arrived: charge the $0.01 check fee, $0.99 returned.',
      check_failed: FAILED,
    },
    run: ({ holdId, body, onUpdate }) => checkCharger({ holdId, waitMs: chargerWaitMs(body?.wait_seconds, DEFAULT_WAIT_MS), onUpdate }),
  },
  hotspot: {
    hold_usd: '1.00',
    check_fee_usd: '0.01',
    check: 'Is the device already on the venue network?',
    params: {},
    summary: 'Start a hotspot rental with a refundable $1 hold',
    rules: {
      already_handled: 'Device already on venue network: charge the $0.01 check fee, $0.99 returned.',
      delivered: 'Device off venue network: hotspot rental kept, $1.00 charged.',
      check_failed: FAILED,
    },
    run: ({ holdId }) => checkHotspot({ holdId }),
  },
  battery_pack: {
    hold_usd: '1.00',
    check_fee_usd: '0.01',
    check: 'Is the device on AC or charged to at least min_percent?',
    params: { min_percent: 'Charge the job needs to finish without a pack. Default 50, clamped to 1 to 100.' },
    summary: 'Start a battery pack rental with a refundable $1 hold',
    rules: {
      already_handled: 'Device on AC or charged to at least min_percent: charge the $0.01 check fee, $0.99 returned.',
      delivered: 'Device on battery below min_percent: battery pack rental kept, $1.00 charged.',
      check_failed: FAILED,
    },
    run: ({ holdId, body }) => checkBatteryPack({ holdId, minPercent: numberIn(body?.min_percent, 1, 100, 50) }),
  },
  storage: {
    hold_usd: '1.00',
    check_fee_usd: '0.01',
    check: 'Does the device already have needed_gb of free disk?',
    params: { needed_gb: 'Free space the job needs, in GB. Default 10, clamped to 0.1 to 100000.' },
    summary: 'Start a cloud storage rental with a refundable $1 hold',
    rules: {
      already_handled: 'Enough free disk already: charge the $0.01 check fee, $0.99 returned.',
      delivered: 'Not enough free disk for the job: cloud storage rental kept, $1.00 charged.',
      check_failed: FAILED,
    },
    run: ({ holdId, body }) => checkStorage({ holdId, neededGb: numberIn(body?.needed_gb, 0.1, 100_000, 10) }),
  },
  display: {
    hold_usd: '1.00',
    check_fee_usd: '0.01',
    check: 'Is an external display already connected?',
    params: { wait_seconds: 'How long to wait for a display to be connected. Default 30, clamped to 0 to 240.' },
    summary: 'Start a monitor rental with a refundable $1 hold',
    rules: {
      already_handled: 'External display already connected: charge the $0.01 check fee, $0.99 returned.',
      delivered: 'No display, then one connected within the wait window: rental kept, $1.00 charged.',
      not_delivered: 'No display connected before the timeout: charge the $0.01 check fee, $0.99 returned.',
      check_failed: FAILED,
    },
    run: ({ holdId, body, onUpdate }) => checkDisplay({ holdId, waitMs: chargerWaitMs(body?.wait_seconds, DEFAULT_WAIT_MS), onUpdate }),
  },
  verify: {
    hold_usd: '1.00',
    check_fee_usd: '0.01',
    check: 'Is your condition already true? You state it; the desk reads the evidence and a model decides.',
    params: {
      condition: 'Required. The fact that would make this purchase unnecessary, in plain English, up to 500 characters.',
      evidence_urls: 'Optional. Up to 3 public https URLs the desk fetches as evidence (order status, booking page, API).',
    },
    summary: 'Verify any condition before you buy, refundable $1 hold',
    rules: {
      already_handled: 'Condition true on the evidence: charge the $0.01 check fee, $0.99 returned.',
      delivered: 'Condition false on the evidence: the need is real, $1.00 charged.',
      inconclusive: 'The evidence does not settle it: nothing charged, $1.00 returned.',
      check_failed: FAILED,
    },
    validate: verifyRequestError,
    run: ({ holdId, body, onUpdate }) => checkCondition({ holdId, condition: body.condition, evidenceUrls: body.evidence_urls ?? [], onUpdate }),
  },
};

// Terms as the agent sees them: everything but the check function.
export function publicTerms() {
  return Object.fromEntries(Object.entries(ITEMS).map(([name, { run, validate, summary, ...terms }]) => [name, terms]));
}
