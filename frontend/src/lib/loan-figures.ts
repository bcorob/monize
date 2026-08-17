import type { LoanScheduleResult } from '@/lib/loan-schedule';

/**
 * A debt whose outstanding magnitude is at or below this is settled. It matches
 * the threshold `buildLoanProjectionInput` refuses to project below, so the two
 * never disagree about whether a loan is finished: below it there is no
 * projection, and every figure derived from one is a known end state rather
 * than an unknown.
 */
export const SETTLED_DEBT_EPSILON = 0.01;

/**
 * Whether a debt account's signed balance leaves nothing owing. Debt accounts
 * store the balance negative, so the amount outstanding is `-balance` -- the
 * same `debtMagnitude` the payment history walks. A balance in credit (an
 * overpaid loan) owes nothing and is settled; taking the magnitude instead
 * would read an overpayment as fresh debt of the same size and report the
 * payoff of a finished loan as unknown.
 */
export function isDebtSettled(signedBalance: number): boolean {
  return -(Number(signedBalance) || 0) <= SETTLED_DEBT_EPSILON;
}

export interface LoanFigureInput {
  /** The account's signed balance -- debt accounts store it negative. */
  currentBalance: number;
  /**
   * The borrower's real current installment (principal + interest) derived from
   * the payment history, or null when no usable history exists yet.
   */
  currentInstallment: number | null;
  /** The no-overpayment forward projection, or null when it cannot be built. */
  baseline: LoanScheduleResult | null;
}

export interface LoanFigures {
  /** The debt is repaid: payoff and remaining interest are settled, not unknown. */
  isSettled: boolean;
  /** The installment in effect, or null when it is not known. */
  currentPayment: number | null;
  /** ISO date of the projected final payment; null when unknown or settled. */
  payoffDate: string | null;
  /** Interest still to be paid: 0 once settled, null when unknown. */
  remainingInterest: number | null;
}

/**
 * The headline figures every surface shows for an amortizing loan or mortgage:
 * the current payment, the estimated payoff date and the estimated remaining
 * interest. The decision of when each is *known* lives here once, because it is
 * shown on both the loan detail page and the transactions Details sidebar and
 * the two must not drift.
 *
 * A projection that does not reach zero within the schedule horizon (`paidOff`
 * false -- an installment that never amortizes, or a term longer than the
 * horizon) has no payoff date, and its accumulated interest is the interest over
 * that horizon rather than the interest remaining. That is a subtotal, so both
 * figures are unknown rather than the horizon's numbers under a total's label.
 *
 * A settled debt is the opposite case: nothing is left to pay, so the remaining
 * interest is a known zero -- never `null`, which would report a finished loan
 * as one that could not be worked out.
 */
export function deriveLoanFigures({
  currentBalance,
  currentInstallment,
  baseline,
}: LoanFigureInput): LoanFigures {
  const isSettled = isDebtSettled(currentBalance);
  const projection = baseline?.paidOff ? baseline : null;
  return {
    isSettled,
    currentPayment:
      currentInstallment != null && currentInstallment > 0 ? currentInstallment : null,
    payoffDate: isSettled ? null : (projection?.payoffDate ?? null),
    remainingInterest: isSettled ? 0 : (projection?.totalInterest ?? null),
  };
}
