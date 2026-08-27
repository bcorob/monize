/**
 * The rate timeline a projection follows, and the comparison of two schedules.
 *
 * Split out of `loan-schedule.ts` for its size. Two related jobs: turning a
 * loan's recorded rate history into the `rateChanges` the generator consumes,
 * and subtracting one generated schedule from another. `loan-schedule.ts`
 * re-exports both, because every consumer has always imported from there.
 */

import type {
  LoanScheduleResult,
  RateTimeline,
  RateTimelineRow,
  ScenarioComparison,
} from '@/lib/loan-schedule-types';
import { round2 } from '@/lib/loan-schedule-types';

/**
 * The annual rate (percentage) in effect on a given date: the latest row with
 * `effectiveDate <= date`, else the earliest row's rate (a date before the
 * first recorded change still amortizes at the origination rate), else the
 * fallback. Shared by the schedule table (per-row historical rate) and
 * `buildRateTimeline`'s starting rate.
 */
export function effectiveAnnualRateOn(
  rows: RateTimelineRow[],
  dateIso: string,
  fallbackAnnualRate: number,
): number {
  const sorted = [...rows].sort((a, b) =>
    a.effectiveDate.localeCompare(b.effectiveDate),
  );
  const atOrBefore = sorted.filter((row) => row.effectiveDate <= dateIso);
  if (atOrBefore.length > 0) {
    return atOrBefore[atOrBefore.length - 1].annualRate;
  }
  return sorted[0]?.annualRate ?? fallbackAnnualRate;
}

/**
 * Resolve a persisted rate history into engine inputs for a schedule that
 * starts at `scheduleStartIso`: the rate in effect at the start is the
 * latest row on or before that date (before the earliest row, the earliest
 * row's rate applies; with no rows, the fallback), the payment in effect is
 * the latest non-null payment on or before the start (before the earliest
 * row, that row's payment applies -- the origination installment), and the
 * remaining rows become steps for generateLoanSchedule.
 */
export function buildRateTimeline(
  rows: RateTimelineRow[],
  scheduleStartIso: string,
  fallbackAnnualRate: number,
): RateTimeline {
  const sorted = [...rows].sort((a, b) =>
    a.effectiveDate.localeCompare(b.effectiveDate),
  );

  const atOrBefore = sorted.filter(
    (row) => row.effectiveDate <= scheduleStartIso,
  );
  const startingAnnualRate = effectiveAnnualRateOn(
    rows,
    scheduleStartIso,
    fallbackAnnualRate,
  );
  // Mirror the rate's "before the earliest row, the earliest row applies"
  // fallback for the payment: a schedule starting shortly before the first
  // recorded row (payment_start_date precedes the first installment, which is
  // where detection dates the initial row) still starts at the origination
  // installment that row records. Only the earliest row is consulted -- later
  // rows describe later rate levels and become steps anyway.
  const startingPaymentAmount =
    [...atOrBefore].reverse().find((row) => row.newPaymentAmount != null)
      ?.newPaymentAmount ??
    (atOrBefore.length === 0 ? (sorted[0]?.newPaymentAmount ?? null) : null);

  const rateChanges = sorted
    .filter((row) => row.effectiveDate > scheduleStartIso)
    .map((row) => ({
      effectiveDate: row.effectiveDate,
      annualRate: row.annualRate,
      paymentAmount: row.newPaymentAmount ?? null,
    }));

  return { startingAnnualRate, startingPaymentAmount, rateChanges };
}

export function compareSchedules(
  baseline: LoanScheduleResult,
  scenario: LoanScheduleResult,
): ScenarioComparison {
  // Every saving is a difference of two lifetime figures, so both sides must
  // have paid off within the horizon. A truncated schedule's `numPayments` is
  // the horizon's row count and its `totalInterest` the interest over it, so
  // subtracting either from a real lifetime figure says nothing about the loan
  // (a truncated baseline made every scenario look better than it is, and could
  // even report a negative saving). `monthsSaved` needs the same gate for a
  // different reason: `monthsBetween` returns 0 for a missing payoff date, which
  // reads as "the overpayment bought no time" rather than "not known".
  const comparable = baseline.paidOff && scenario.paidOff;
  return {
    baseline,
    scenario,
    paymentsSaved: comparable
      ? baseline.numPayments - scenario.numPayments
      : null,
    monthsSaved: comparable
      ? monthsBetween(scenario.payoffDate, baseline.payoffDate)
      : null,
    interestSaved: comparable
      ? round2(baseline.totalInterest - scenario.totalInterest)
      : null,
    // A truncated schedule's `finalPaymentAmount` is the installment at its last
    // PROJECTED row, not its last payment -- there is no last payment -- so a
    // drop measured from it is as unknown as the rest.
    installmentReduction: comparable
      ? round2(baseline.finalPaymentAmount - scenario.finalPaymentAmount)
      : null,
  };
}

/** Whole months from `fromDate` to `toDate` (0 when either is missing) */
export function monthsBetween(
  fromDate: string | null,
  toDate: string | null,
): number {
  if (!fromDate || !toDate) return 0;
  const from = parseIsoDateParts(fromDate);
  const to = parseIsoDateParts(toDate);
  return (to.year - from.year) * 12 + (to.month - from.month);
}

function parseIsoDateParts(isoDate: string): { year: number; month: number } {
  const [year, month] = isoDate.split("-").map(Number);
  return { year, month };
}

/** Round to 2 decimals (cents), avoiding floating-point drift. */
