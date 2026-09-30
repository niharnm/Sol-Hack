// What a hold settles to, from the check outcome and whether settle() succeeded.
// Kept in one place so the agent response, the hold log and the tests agree.

// USDC has 6 decimals: $1.00 hold, $0.01 check fee.
export const HOLD_BASE_UNITS = 1_000_000n;
export const CHECK_FEE_BASE_UNITS = 10_000n;

export function settlementFor(outcome, settleError) {
  const keep = outcome === 'delivered';
  // The desk's own check threw, or could not tell: the agent got no answer, so it owes nothing.
  const free = outcome === 'check_failed' || outcome === 'inconclusive';
  const chargeBaseUnits = keep ? HOLD_BASE_UNITS : free ? 0n : CHECK_FEE_BASE_UNITS;
  const charged = chargeBaseUnits === HOLD_BASE_UNITS ? '1.00' : chargeBaseUnits === 0n ? '0.00' : '0.01';
  const returned = chargeBaseUnits === HOLD_BASE_UNITS ? '0.00' : chargeBaseUnits === 0n ? '1.00' : '0.99';
  if (settleError) {
    // Settlement did not go through, so no money moved yet; do not report the intended split as done.
    return { keep, chargeBaseUnits, decision: 'settle_failed', charged_usd: null, returned_usd: null };
  }
  return { keep, chargeBaseUnits, decision: keep ? 'kept' : 'refunded', charged_usd: charged, returned_usd: returned };
}
