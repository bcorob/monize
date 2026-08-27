/**
 * Loan cadences: what a projection's dates and rates are derived from.
 *
 * Split out of `loan-schedule.ts`, which had grown past the repository's
 * 800-line ceiling. Everything here answers a question about a FREQUENCY -- how
 * many periods a year it has, what one period's interest costs, when the next
 * payment falls, and how far a projection may run -- and nothing here knows
 * about overpayments or about generating a schedule. `loan-schedule.ts`
 * re-exports the lot, because every consumer has always imported from there.
 */

import { advanceByFrequency } from "@/lib/frequency";
import type { FrequencyType } from "@/types/scheduled-transaction";

/**
 * Payment frequencies a schedule can be projected at.
 *
 * Semi-monthly appears twice on purpose: `accounts.payment_frequency` holds
 * whichever spelling wrote it. The mortgage path stores the mortgage enum's
 * `SEMI_MONTHLY`; the loan-payment setup dialog stores the scheduled-transaction
 * recurrence's `SEMIMONTHLY`. Accepting only the first made
 * `buildLoanProjectionInput`'s cast fall through `getPeriodsPerYear` to its
 * monthly default, so a semi-monthly loan was projected at 12 periods a year
 * instead of 24 -- roughly double the remaining interest and a payoff date twice
 * as far out, on every surface that reads a projection.
 * `frontend/src/lib/loan-frequency.guard.test.ts` holds both spellings.
 */
export type ScheduleFrequency =
  | "WEEKLY"
  | "BIWEEKLY"
  | "SEMI_MONTHLY"
  | "SEMIMONTHLY"
  | "MONTHLY"
  | "QUARTERLY"
  | "YEARLY"
  | "ACCELERATED_WEEKLY"
  | "ACCELERATED_BIWEEKLY";

/**
 * A local calendar day as `yyyy-MM-dd`.
 *
 * date-fns `format` with this pattern, without the pattern parser: the schedule
 * loop calls it once per row, and a goal-seek runs thirty schedules of up to
 * `HARD_MAX_PAYMENTS` rows per keystroke, so it is the hottest line in the
 * engine. Local components, matching `format`'s reading of a local `Date` and
 * `parseLocalDate`'s construction of one.
 *
 * The invalid-date throw is kept deliberately: `format` raises `RangeError` on
 * one, and a hand-rolled builder that emits "NaN-NaN-NaN" instead would put that
 * string in a row date, a payoff date and a saved scenario rather than failing.
 */
export function isoDay(date: Date): string {
  if (Number.isNaN(date.getTime())) {
    throw new RangeError("Invalid time value");
  }
  const month = date.getMonth() + 1;
  const day = date.getDate();
  return `${date.getFullYear()}-${month < 10 ? "0" : ""}${month}-${day < 10 ? "0" : ""}${day}`;
}

/**
 * Default projection horizon, in years. The bound on a schedule is a span of
 * time, not a row count: a flat 600-payment default was 50 years of a monthly
 * loan but only 11 years of a weekly one, so ordinary 25- and 30-year weekly and
 * biweekly mortgages (1300 and 780 payments) stopped mid-term and reported no
 * payoff date and a fraction of their lifetime interest.
 *
 * 50 years is past the longest amortization any supported term expresses, so a
 * schedule that still has not cleared is genuinely not amortizing rather than
 * merely long.
 */
export const DEFAULT_MAX_PROJECTION_YEARS = 50;

/**
 * Absolute ceiling on projected rows, whatever a caller asks for. Exported
 * because `loan-past-impact.ts` deliberately projects to it, and a literal copy
 * there would silently disagree the moment this moves.
 */
export const HARD_MAX_PAYMENTS = 10000;
/** Balances at or below this are considered paid off (matches the reports) */
export const PAYOFF_EPSILON = 0.01;

/**
 * Payments in `years` of `frequency`, clamped to `HARD_MAX_PAYMENTS` -- the
 * default projection bound, and the one place the horizon becomes a row count.
 */
export function maxPaymentsForHorizon(
  frequency: ScheduleFrequency,
  years: number = DEFAULT_MAX_PROJECTION_YEARS,
): number {
  return Math.min(
    Math.max(1, Math.round(getPeriodsPerYear(frequency) * years)),
    HARD_MAX_PAYMENTS,
  );
}

/**
 * The row cap a schedule runs to: a supplied `maxPayments` or the frequency's
 * horizon, floored at one row and clamped to the hard maximum.
 *
 * Written once because both entry points need it and had drifted: the budget
 * path omitted the `Math.max(1, ...)` floor, so `maxPayments: 0` gave
 * `generateLoanSchedule` one row and `generateBudgetSchedule` zero -- an empty,
 * not-paid-off result for an input the other path amortized.
 */
export function resolveMaxPayments(
  frequency: ScheduleFrequency,
  maxPayments: number | undefined,
): number {
  return Math.min(
    Math.max(1, maxPayments ?? maxPaymentsForHorizon(frequency)),
    HARD_MAX_PAYMENTS,
  );
}

/**
 * Payment periods a year for each cadence a loan account can store.
 *
 * A `Record` rather than a `switch` with a `default: 12`: the default is how
 * semi-monthly was silently projected at twelve periods a year -- roughly double
 * the remaining interest and a payoff date twice as far out -- and a table makes
 * a new member of `ScheduleFrequency` a compile error instead. The runtime
 * fallback below survives only for the cast at `buildLoanProjectionInput`, where
 * a value out of the database has not been through the compiler at all.
 */
const PERIODS_PER_YEAR: Record<ScheduleFrequency, number> = {
  WEEKLY: 52,
  ACCELERATED_WEEKLY: 52,
  BIWEEKLY: 26,
  ACCELERATED_BIWEEKLY: 26,
  SEMI_MONTHLY: 24,
  SEMIMONTHLY: 24,
  MONTHLY: 12,
  QUARTERLY: 4,
  YEARLY: 1,
};

export function getPeriodsPerYear(frequency: ScheduleFrequency): number {
  return PERIODS_PER_YEAR[frequency] ?? 12;
}

/**
 * Periodic rate, on the convention named in docs/financial-semantics.md
 * section 9: the quoted rate is a nominal annual rate compounded at the payment
 * frequency, so the periodic rate is `annualRate / periodsPerYear` -- NOT
 * monthly compounding converted to the period. Canadian fixed-rate mortgages
 * are the one exception (semi-annual compounding, required by law).
 *
 * Mirrors `getPeriodicRate` in
 * backend/src/accounts/mortgage-amortization.util.ts, which carries the full
 * reasoning. The mirroring detects drift; it is not evidence for the convention.
 */
export function getPeriodicRate(
  annualRate: number,
  periodsPerYear: number,
  isCanadian: boolean,
  isVariableRate: boolean,
): number {
  if (annualRate === 0) return 0;
  if (isCanadian && !isVariableRate) {
    // Canadian fixed-rate: semi-annual compounding
    const semiAnnualRate = annualRate / 100 / 2;
    return Math.pow(1 + semiAnnualRate, 2 / periodsPerYear) - 1;
  }
  return annualRate / 100 / periodsPerYear;
}

/**
 * Effective annual rate as a percentage, unrounded -- the rate the loan actually
 * costs over a year, compounded the way its own periodic rate is derived.
 *
 * The one frontend implementation of the "Displayed EAR" row of
 * docs/financial-semantics.md section 9, mirroring the backend's
 * `calculateEffectiveAnnualRate` (which rounds to 2dp for its API contract; this
 * returns the raw percentage so each surface chooses its own precision). The
 * loan detail summary card previously computed the Canadian formula inline,
 * which made it a third copy of the compounding convention that the
 * frequency-aware fix never reached.
 *
 * @param periodsPerYear - Payments per year, from getPeriodsPerYear
 */
export function effectiveAnnualRate(
  annualRate: number,
  periodsPerYear: number,
  isCanadian: boolean,
  isVariableRate: boolean,
): number {
  if (isCanadian && !isVariableRate) {
    // Semi-annual compounding, required by law and independent of how often the
    // mortgage is paid.
    return (Math.pow(1 + annualRate / 100 / 2, 2) - 1) * 100;
  }
  // Nominal rate compounded at the payment frequency.
  return (
    (Math.pow(1 + annualRate / 100 / periodsPerYear, periodsPerYear) - 1) * 100
  );
}

/**
 * Interest accrued on `balance` over one payment period at `annualRate`. A
 * candidate installment amortizes only when it exceeds this, so it is the
 * shared guard for seeding a projection or the contractual schedule -- rejecting
 * a principal-only figure that would never reduce the balance.
 */
export function firstPeriodInterest(
  balance: number,
  annualRate: number,
  frequency: ScheduleFrequency,
  isCanadian = false,
  isVariableRate = false,
): number {
  return (
    balance *
    getPeriodicRate(
      annualRate,
      getPeriodsPerYear(frequency),
      isCanadian,
      isVariableRate,
    )
  );
}

/**
 * The recurrence frequency each loan cadence is posted at.
 *
 * The projection's row dates and the scheduler's posting dates are the same
 * calendar to a borrower, so they are the same calendar in code: this table maps
 * a loan cadence onto the recurrence engine's own frequency, and `advanceDate`
 * steps through `advanceByFrequency`. The accelerated cadences pay a fraction of
 * the monthly installment on their base cadence, so they step as that base.
 *
 * A `Record`, so a new member of `ScheduleFrequency` is a compile error rather
 * than a silent monthly `default`. It is the browser-side twin of the backend's
 * `LOAN_FREQUENCY_TO_RECURRENCE` / `MORTGAGE_FREQUENCY_TO_RECURRENCE`
 * (`backend/src/accounts/payment-frequency.util.ts`).
 */
const SCHEDULE_FREQUENCY_TO_RECURRENCE: Record<
  ScheduleFrequency,
  FrequencyType
> = {
  WEEKLY: "WEEKLY",
  ACCELERATED_WEEKLY: "WEEKLY",
  BIWEEKLY: "BIWEEKLY",
  ACCELERATED_BIWEEKLY: "BIWEEKLY",
  SEMI_MONTHLY: "SEMIMONTHLY",
  SEMIMONTHLY: "SEMIMONTHLY",
  MONTHLY: "MONTHLY",
  QUARTERLY: "QUARTERLY",
  YEARLY: "YEARLY",
};

/**
 * The next payment date after `date` on the loan's cadence.
 *
 * Delegated to `advanceByFrequency`, the engine that posts these payments, and
 * not a second calendar beside it. The hand-rolled version got two things wrong
 * at once. Semi-monthly stepped the 1st and the 15th where the engine steps the
 * 15th and the last day of the month, showing a borrower dates their register
 * never has. And the month cadences used `Date.setMonth(+1)`, which OVERFLOWS
 * rather than clamps: a loan paid on the 31st had its second row dated 3 March
 * -- February skipped entirely -- and every later row three days off the
 * schedule the backend's `calculateEndDate` bounds. `advanceByFrequency` clamps
 * (`addMonthsClamped`), so 31 January steps to 28 February, and INV-LOAN-005's
 * requirement -- that a projected payoff is a date the scheduler reaches --
 * holds by construction on this side too.
 *
 * `loan-frequency.guard.test.ts` walks every cadence against the engine,
 * including the month-end anchors, so the two cannot drift apart again.
 */
export function advanceDate(date: Date, frequency: ScheduleFrequency): Date {
  return advanceByFrequency(
    date,
    SCHEDULE_FREQUENCY_TO_RECURRENCE[frequency] ?? "MONTHLY",
  );
}
