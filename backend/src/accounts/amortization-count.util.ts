/**
 * How many payments an installment needs to clear a balance.
 *
 * One implementation of `n = -ln(1 - P*r / A) / ln(1 + r)`, because it had three:
 * `calculateAcceleratedPayments` and `calculateResidualPayoff` in
 * mortgage-amortization.util.ts, and `calculateTotalPayments` in
 * loan-amortization.util.ts. Three copies of one financial formula is exactly
 * the drift the "written once, in the place that can check it" rule targets.
 *
 * One implementation is not one CALL: an accelerated mortgage still evaluates it
 * twice on the same inputs in a single `calculateMortgageAmortization` -- once
 * for the term and once inside `calculateResidualPayoff`, which derives its own
 * clearing count rather than trusting a number a caller passed it. Two
 * logarithms is the price of that independence, and it is the right trade; the
 * point of this module is that both calls compute the same thing.
 */

/**
 * Whole number of payments of `paymentAmount` needed to clear `principal` at
 * `periodicRate` per period.
 *
 * `Infinity` when the loan never amortizes: a non-positive payment, or one that
 * does not exceed the first period's interest. Callers must distinguish that
 * from a number -- reporting a finite total for a schedule that never ends is
 * the "unknown rendered as a measured value" defect in its worst form.
 *
 * @param principal - Balance to clear (positive)
 * @param periodicRate - Interest rate per payment period, as a decimal
 * @param paymentAmount - The regular installment
 * @returns Payments needed, rounded up; `Infinity` when it never amortizes
 */
export function paymentsToClear(
  principal: number,
  periodicRate: number,
  paymentAmount: number,
): number {
  // Settled first, and deliberately before the payment test: a cleared balance
  // needs no payments whatever the installment is, and answering `Infinity`
  // ("never amortizes") for a zero balance with a zero installment put a
  // year-2126 payoff date and `totalPayments: -1` on the same response as
  // `residualPayoffAmount: 0` -- the schedule reported unknowable and
  // known-zero at once. Zero needs no rate, and it needs no payment either.
  if (principal <= 0) return 0;
  if (paymentAmount <= 0) return Infinity;
  if (periodicRate === 0) {
    return Math.ceil(principal / paymentAmount);
  }
  // The payment must beat the first period's interest, or the balance grows.
  if (paymentAmount <= principal * periodicRate) return Infinity;
  return Math.ceil(
    -Math.log(1 - (principal * periodicRate) / paymentAmount) /
      Math.log(1 + periodicRate),
  );
}
