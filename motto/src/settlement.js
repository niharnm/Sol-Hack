// What a hold settles to, from the item's terms, the check outcome and whether settle() succeeded.
// Kept in one place so the agent response, the hold log, the rule sentences and the tests agree.

// USDC has 6 decimals. Prices are decimal strings ("3.00"); money math is bigint base units.
const DECIMALS = 6n;
const ONE = 10n ** DECIMALS;

// "3.00" -> 3000000n. Same format pay-kit's usd() accepts: digits, at most 6 decimals, no sign.
export function toBaseUnits(usd) {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(String(usd));
  if (!m) throw new Error(`bad usd amount "${usd}"`);
  return BigInt(m[1]) * ONE + BigInt((m[2] ?? '').padEnd(6, '0'));
}

// 3000000n -> "3.00". Two decimals unless the amount needs more (sub-cent settlements stay exact).
export function formatUsd(baseUnits) {
  const whole = baseUnits / ONE;
  const frac = baseUnits % ONE;
  const cents = frac / 10_000n;
  const rest = frac % 10_000n;
  let text = `${whole}.${String(cents).padStart(2, '0')}`;
  if (rest) text += String(rest).padStart(4, '0').replace(/0+$/, '');
  return text;
}

// What an outcome charges: the whole hold, the check fee, or nothing. `verify` is a pure check,
// so a definitive verdict either way charges the fee (charge_on_delivered: 'fee').
export function chargeKind(item, outcome) {
  if (outcome === 'delivered') return item.charge_on_delivered === 'fee' ? 'fee' : 'hold';
  if (outcome === 'already_handled' || outcome === 'not_delivered') return 'fee';
  // The desk's own check threw, or could not tell: the agent got no answer, so it owes nothing.
  return 'none';
}

export function settlementFor(item, outcome, settleError) {
  const hold = toBaseUnits(item.hold_usd);
  const kind = chargeKind(item, outcome);
  const chargeBaseUnits = kind === 'hold' ? hold : kind === 'fee' ? toBaseUnits(item.check_fee_usd) : 0n;
  // "kept" means the desk kept the whole hold; anything less is a (partial or full) refund.
  const keep = hold > 0n && chargeBaseUnits === hold;
  if (settleError) {
    // Settlement did not go through, so no money moved yet; do not report the intended split as done.
    return { keep, chargeBaseUnits, decision: 'settle_failed', charged_usd: null, returned_usd: null };
  }
  return {
    keep,
    chargeBaseUnits,
    decision: keep ? 'kept' : 'refunded',
    charged_usd: formatUsd(chargeBaseUnits),
    returned_usd: formatUsd(hold - chargeBaseUnits),
  };
}
