// What the desk can buy as an intermediary. Each item is one virtual deliverable plus its terms. Prices are per item; the
// settlement rules are the same for all of them, and the rule sentences the agent reads are
// generated from the numbers so copy and settle() cannot drift. A new item is a new entry here.
import { checkResearch, researchRequestError } from './research.js';
import { formatUsd, toBaseUnits } from './settlement.js';

// Turn an item's prices and per-outcome leads into the terms the agent sees.
//   already_handled, not_delivered: the check fee is charged, the rest returned
//   delivered: the whole hold (or the fee, for a pure check like verify)
//   inconclusive, check_failed: nothing charged
function define(item) {
  if (item.fulfillment?.type !== 'virtual') throw new Error(`${item.label}: active offers must use virtual fulfillment`);
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
  const summary = item.summary ?? `Buy ${label} with a refundable $${item.hold_usd.replace(/\.00$/, '')} hold`;
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
    fulfillment: {
      type: 'virtual',
      delivery: 'signed_json_response',
      contents: 'three DOI-backed citation records with titles',
    },
    summary: 'Buy a verified three-source research pack',
    leads: {
      delivered: 'Three citation records delivered and structural checks passed',
      inconclusive: 'Incomplete result or provider unavailable',
    },
    validate: researchRequestError,
    run: ({ holdId, body, onUpdate }) => checkResearch({ holdId, query: body.query, onUpdate }),
  }),
};

// The highest ceiling on the desk: the per-payment cap a buyer needs to buy anything here.
export const MAX_HOLD_USD = formatUsd(Object.values(ITEMS).reduce((max, item) => (toBaseUnits(item.hold_usd) > max ? toBaseUnits(item.hold_usd) : max), 0n));

// Terms as the agent sees them: everything but the check function.
export function publicTerms() {
  return Object.fromEntries(Object.entries(ITEMS).map(([name, { run, validate, summary, ...terms }]) => [name, terms]));
}
