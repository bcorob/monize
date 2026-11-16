import type { LoanScheduleInput, LoanScheduleResult } from '@/lib/loan-schedule-types';
import { firstPeriodInterest, isDebtOutstanding } from '@/lib/loan-frequency';
import { amortizationMethodFor } from '@/lib/mortgage-type';

/**
 * A debt whose outstanding magnitude is below this (less than one minor unit) is settled; one whole unit is owed. It matches
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
  return !isDebtOutstanding(-(Number(signedBalance) || 0));
}

export interface LoanFigureInput {
  /** The account's signed balance -- debt accounts store it negative. */
  currentBalance: number;
  /**
   * The borrower's real current installment (principal + interest) derived from
   * the payment history, or null when no usable history exists yet.
   */
  currentInstallment: number | null;
  /**
   * The due date `currentInstallment` is for, when the method has no constant
   * payment (`CurrentLoanTerms.paymentDate`); null or absent for an annuity.
   */
  currentInstallmentDate?: string | null;
  /** An INTEREST_ONLY mortgage's bullet (`CurrentLoanTerms.finalPayment`). */
  finalPayment?: { amount: number; date: string } | null;
  /** The no-overpayment forward projection, or null when it cannot be built. */
  baseline: LoanScheduleResult | null;
}

export interface LoanFigures {
  /** The debt is repaid: payoff and remaining interest are settled, not unknown. */
  isSettled: boolean;
  /** The installment in effect, or null when it is not known. */
  currentPayment: number | null;
  /**
   * The due date `currentPayment` is the installment of, for a LINEAR or
   * INTEREST_ONLY mortgage, whose installment changes from one due date to the
   * next: a surface showing it says which date it is for. Null for an annuity.
   */
  currentPaymentDate: string | null;
  /**
   * An INTEREST_ONLY mortgage's final payment and its date, shown beside the
   * installment; null otherwise, and once the debt is settled.
   */
  finalPayment: { amount: number; date: string } | null;
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
/**
 * Why a loan's projection does not reach payoff, or `null` when it does (or when
 * there is no projection to explain). The payoff date and remaining interest are
 * `null` in both non-payoff cases, and the two have opposite fixes, so a surface
 * that only prints "unknown" leaves the user with no way forward:
 *
 * - `payment-below-interest` -- the installment is below the interest at the
 *   current rate, so the balance never falls. `payment` and `periodInterest`
 *   are the two figures to compare; usually the payment is stale or unset, which
 *   the user can fix (record the real installment, or set the payment amount).
 * - `beyond-horizon` -- the payment covers interest but the term runs past the
 *   projection horizon. A property of the loan, not a data problem.
 */
export type LoanNotAmortizingReason =
  | {
      kind: 'payment-below-interest';
      /** The installment the projection is seeded with. */
      payment: number;
      /** One period's interest at the current rate on the current balance. */
      periodInterest: number;
      /** The annual rate the interest is computed at (percent). */
      annualRate: number;
    }
  | { kind: 'beyond-horizon' };

export function loanNotAmortizingReason(
  input: LoanScheduleInput | null,
  baseline: LoanScheduleResult | null,
): LoanNotAmortizingReason | null {
  if (!input || !baseline || baseline.paidOff) return null;
  // A LINEAR or INTEREST_ONLY installment sets its principal independently of
  // the interest, so it cannot stall, and its schedule ends on the term end
  // (docs/specs/mortgage-types.md, section 5.4): neither explanation applies.
  if (amortizationMethodFor(input.mortgageType ?? 'ANNUITY') !== 'ANNUITY') return null;
  if (baseline.coveredInterest) return { kind: 'beyond-horizon' };
  const periodInterest = firstPeriodInterest(
    input.startingBalance,
    input.annualRate,
    input.frequency,
    input.mortgageType ?? 'ANNUITY',
  );
  return {
    kind: 'payment-below-interest',
    payment: input.paymentAmount,
    periodInterest: Math.round(periodInterest * 100) / 100,
    annualRate: input.annualRate,
  };
}

export function deriveLoanFigures({
  currentBalance,
  currentInstallment,
  currentInstallmentDate = null,
  finalPayment = null,
  baseline,
}: LoanFigureInput): LoanFigures {
  const isSettled = isDebtSettled(currentBalance);
  const projection = baseline?.paidOff ? baseline : null;
  const currentPayment =
    currentInstallment != null && currentInstallment > 0 ? currentInstallment : null;
  return {
    isSettled,
    currentPayment,
    currentPaymentDate: currentPayment != null ? currentInstallmentDate : null,
    finalPayment: isSettled ? null : finalPayment,
    payoffDate: isSettled ? null : (projection?.payoffDate ?? null),
    remainingInterest: isSettled ? 0 : (projection?.totalInterest ?? null),
  };
}
