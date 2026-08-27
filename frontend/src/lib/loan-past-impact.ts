import { Account } from '@/types/account';
import { parseLocalDate } from '@/lib/utils';
import { LoanHistoryResult } from '@/lib/loan-history';
import {
  LoanScheduleInput,
  LoanScheduleResult,
  RateTimelineRow,
  ScheduleFrequency,
  HARD_MAX_PAYMENTS,
  buildRateTimeline,
  calculateMortgagePaymentAmount,
  firstPeriodInterest,
  generateLoanSchedule,
  getPeriodsPerYear,
  monthsBetween,
  round2,
} from '@/lib/loan-schedule';

/**
 * "How much have my overpayments already helped?" — compares the original
 * contractual schedule (from origination) against what actually happened
 * plus the current projection from today's balance.
 *
 * Extra principal is measured against the contractual schedule, not from
 * memos or split structure, so it captures overpayments however they were
 * recorded -- including plain transfers to the loan or an extra transfer
 * alongside the regular split payment.
 */
export interface PastImpactResult {
  /** Contractual schedule from the original principal at paymentStartDate */
  originalSchedule: LoanScheduleResult;
  /** Projection from the current balance; null when the loan is paid off */
  currentProjection: LoanScheduleResult | null;
  originalPayoffDate: string | null;
  /** Projected payoff, or the final actual payment when already paid off */
  currentPayoffDate: string | null;
  /**
   * Months the overpayments have already saved, or `null` when either payoff
   * date is unknown -- `monthsBetween` returns 0 for a missing date, which reads
   * as "the overpayments bought no time" rather than "not known".
   */
  monthsAlreadySaved: number | null;
  /**
   * Interest the overpayments have already saved against the original
   * contractual schedule, or `null` when either schedule stopped at its
   * projection horizon instead of paying off. Both sides are lifetime figures,
   * so a horizon subtotal on either side makes the difference unknown rather
   * than small.
   */
  interestAlreadySaved: number | null;
  /**
   * Total extra principal already paid: the principal from payments recognized
   * as overpayments (by the loan's overpayment category or memo). Matches the
   * Extra Principal column of the installment schedule, which surfaces the same
   * classified payments.
   */
  extraPrincipalPaid: number;
}

/** An original schedule runs from origination rather than from today's balance,
 * so it needs room beyond even the engine's default horizon (a 30-year weekly
 * mortgage already carries 1560 payments before any historical rate step
 * stretches it). Referencing the engine's own ceiling rather than repeating the
 * number, so the two cannot disagree. */
const ORIGINAL_SCHEDULE_MAX_PAYMENTS = HARD_MAX_PAYMENTS;

/**
 * Compute the past impact of overpayments, or null when the account lacks the
 * data to reconstruct its original schedule (a positive original principal,
 * a start date, rate, frequency, and a determinable contractual payment).
 *
 * `rateChanges` is the account's persisted rate history. The contractual
 * baseline starts at the origination rate (the timeline's initial row, not
 * the account's current scalar) and applies the recorded steps as they
 * happened -- without overpayments -- so the comparison isolates the pure
 * effect of extra payments even across rate changes.
 *
 * `currentProjection` is the loan detail page's forward projection from today's
 * balance (the no-overpayment baseline). It is passed in rather than recomputed
 * here so both views share one projection.
 */
export function computePastImpact(
  account: Account,
  history: LoanHistoryResult,
  currentProjection: LoanScheduleResult | null = null,
  rateChanges: RateTimelineRow[] = [],
): PastImpactResult | null {
  // The original principal is the configured value, or the loan's opening
  // balance (mortgages store the original amount as the negative opening
  // balance). When neither is available -- common for loans imported from
  // Quicken/MS Money without an opening balance, where any draw or adjustment
  // also pushes derivation onto the ledger path and leaves startingBalance at
  // zero -- reconstruct the starting debt from the payment history itself:
  // today's balance plus every principal dollar already repaid. That equals
  // the opening balance whenever one is known and stays positive when it is
  // blank, so the contractual baseline can still be built from transactions.
  const reconstructedPrincipal = round2(
    history.currentBalance + history.cumulativePrincipal,
  );
  const originalPrincipal =
    account.originalPrincipal && account.originalPrincipal > 0
      ? account.originalPrincipal
      : history.startingBalance > 0
        ? history.startingBalance
        : reconstructedPrincipal;

  // The schedule starts at the earliest actual payment; the configured
  // first-payment date is only a fallback for when there are no payments yet.
  // Preferring the real transaction keeps the baseline aligned with the data
  // the user actually has, rather than a stale configured value.
  const startDate = history.events[0]?.date || account.paymentStartDate || null;

  // The configured repayment period. Prefer the amortization period; fall back
  // to the term. It is required (the loan/mortgage form collects it), so
  // without it there is no contractual baseline to compare against.
  const configuredTermMonths =
    account.amortizationMonths && account.amortizationMonths > 0
      ? account.amortizationMonths
      : account.termMonths && account.termMonths > 0
        ? account.termMonths
        : null;

  if (
    originalPrincipal <= 0 ||
    !startDate ||
    account.interestRate == null ||
    !account.paymentFrequency ||
    !configuredTermMonths
  ) {
    return null;
  }

  const frequency = account.paymentFrequency as ScheduleFrequency;
  const isCanadian = account.isCanadianMortgage || false;
  const isVariableRate = account.isVariableRate || false;

  // The origination rate comes from the rate history when one exists; the
  // account's scalar rate is only the *current* rate and would corrupt the
  // baseline after any recorded change.
  const timeline = buildRateTimeline(rateChanges, startDate, account.interestRate);

  const periodsPerYear = getPeriodsPerYear(frequency);

  // --- The contractual "if I never overpaid" schedule ---
  // Prefer the loan's real origination installment -- the payment recorded on
  // the initial rate row, sized for the full original principal -- and follow
  // its recorded steps. This plots the loan's true payoff, so a loan paid down
  // faster than its nominal amortization (a large regular payment on a
  // long-amortization mortgage) is not stretched onto the theoretical
  // minimum-payment curve that a fresh PMT over the configured term would draw.
  //
  // Fall back to that PMT only when no usable installment is recorded: interest
  // booked separately leaves the rate rows' payment null (recording it would
  // capture a principal-only figure), and a recorded payment that cannot even
  // cover the first period's interest is unusable. The fallback path is
  // unchanged from before, so loans that already relied on it are unaffected.
  const configuredTermPeriods = Math.round((configuredTermMonths * periodsPerYear) / 12);
  const recordedInstallment = timeline.startingPaymentAmount;
  const useRecordedInstallment =
    recordedInstallment != null &&
    recordedInstallment >
      firstPeriodInterest(
        originalPrincipal,
        timeline.startingAnnualRate,
        frequency,
        isCanadian,
        isVariableRate,
      );

  const contractualPayment = useRecordedInstallment
    ? recordedInstallment
    : calculateMortgagePaymentAmount(
        originalPrincipal,
        timeline.startingAnnualRate,
        configuredTermMonths,
        frequency,
        isCanadian,
        isVariableRate,
      );
  if (contractualPayment <= 0) return null;

  const base: LoanScheduleInput = {
    startingBalance: originalPrincipal,
    annualRate: timeline.startingAnnualRate,
    paymentAmount: contractualPayment,
    frequency,
    isCanadian,
    isVariableRate,
    firstPaymentDate: parseLocalDate(startDate),
  };
  // Accelerated payments (monthly / 2 or / 4) are larger than the amortizing
  // installment, so the contractual loan pays off before its nominal term.
  // fixedEndPeriod would re-level them down to fill the full term and erase the
  // acceleration, so those keep the fixed payment and run to their natural,
  // earlier payoff (only rescuing a rate-rise stall) -- matching how the current
  // projection is computed.
  const isAccelerated =
    frequency === 'ACCELERATED_WEEKLY' || frequency === 'ACCELERATED_BIWEEKLY';
  const originalSchedule = generateLoanSchedule(
    useRecordedInstallment
      ? {
          ...base,
          // Keep the timeline's payment steps so the contractual installment
          // tracks the lender period to period (e.g. a variable rate that
          // re-levelled the payment upward), then run to the loan's own payoff.
          rateChanges: timeline.rateChanges,
          // Re-level toward the configured term ONLY if a rate rise would
          // otherwise stall the payment; unlike fixedEndPeriod this never forces
          // payoff at the term, so a faster real schedule keeps its earlier one.
          rescueEndPeriod: configuredTermPeriods,
          maxPayments: ORIGINAL_SCHEDULE_MAX_PAYMENTS,
        }
      : {
          ...base,
          // Keep the recorded rate steps but drop their payment overrides (often
          // principal-only figures that would stall a fixed payment);
          // re-levelling sets the installment instead.
          rateChanges: timeline.rateChanges.map((change) => ({ ...change, paymentAmount: null })),
          ...(isAccelerated
            ? {
                rescueEndPeriod: configuredTermPeriods,
                maxPayments: ORIGINAL_SCHEDULE_MAX_PAYMENTS,
              }
            : {
                fixedEndPeriod: configuredTermPeriods,
                // One-period buffer so a rounding remainder on the final
                // payment is kept.
                maxPayments: Math.min(
                  configuredTermPeriods + Math.ceil(periodsPerYear / 12),
                  ORIGINAL_SCHEDULE_MAX_PAYMENTS,
                ),
              }),
        },
  );

  // --- Current payoff, from the caller's forward projection ---
  const isPaidOff = history.currentBalance <= 0.01;
  const lastActualPaymentDate =
    history.events.length > 0 ? history.events[history.events.length - 1].date : null;
  const currentPayoffDate = isPaidOff
    ? lastActualPaymentDate
    : (currentProjection?.payoffDate ?? null);

  // Both sides of the comparison are lifetime interest, so both have to be
  // known: `totalInterest` on a schedule that stopped at its projection horizon
  // is the interest over that horizon, and subtracting it would report a saving
  // the loan has not made. A loan already paid off contributes a known zero of
  // remaining interest rather than an unknown (there is nothing left to
  // project), which is why the settled case is not gated on a projection.
  //
  // The remaining interest is resolved to `null` rather than to a `?? 0`
  // fallback, so the subtraction below cannot compile without the gate. An
  // unreachable "unknown means zero" branch is still the defect waiting for the
  // next edit of the condition.
  const projectedRemainingInterest: number | null = isPaidOff
    ? 0
    : currentProjection?.paidOff
      ? currentProjection.totalInterest
      : null;
  const interestAlreadySaved =
    originalSchedule.paidOff && projectedRemainingInterest !== null
      ? Math.max(
          0,
          round2(
            originalSchedule.totalInterest -
              (history.cumulativeInterest + projectedRemainingInterest),
          ),
        )
      : null;

  // Extra principal already paid = the principal from payments recognized as
  // overpayments (by the loan's overpayment category or memo). This is the sum
  // the installment schedule shows in its Extra Principal column, so the two
  // views agree. Integer-cents arithmetic avoids floating-point drift.
  const extraPrincipalCents = history.events
    .filter((event) => event.type === 'OVERPAYMENT')
    .reduce((sum, event) => sum + Math.round(event.principal * 100), 0);
  const extraPrincipalPaid = extraPrincipalCents / 100;

  return {
    originalSchedule,
    currentProjection,
    originalPayoffDate: originalSchedule.payoffDate,
    currentPayoffDate,
    // The sibling of interestAlreadySaved: both compare the original schedule
    // against where the loan now ends, so both need both ends known. A schedule
    // that stopped at its projection horizon has no payoff date at all.
    monthsAlreadySaved:
      currentPayoffDate != null && originalSchedule.payoffDate != null
        ? Math.max(
            0,
            monthsBetween(currentPayoffDate, originalSchedule.payoffDate),
          )
        : null,
    interestAlreadySaved,
    extraPrincipalPaid,
  };
}

