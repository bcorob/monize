/**
 * Payment frequencies, and the one place each is turned into something else.
 *
 * There are two frequency domains -- loan (`PaymentFrequency`, the recurrence
 * spellings the setup DTO validates) and mortgage (`MortgagePaymentFrequency`,
 * which adds `SEMI_MONTHLY` and the accelerated cadences) -- and three
 * conversions between them and the scheduler. Every one of them used to be a
 * hand-rolled object or `switch` in whichever file needed it, and the copies
 * disagreed: one mapped `SEMI_MONTHLY` to itself (a value the recurrence engine
 * does not recognize, so the occurrence was due forever), another had no
 * `SEMIMONTHLY` case at all and fell through to monthly.
 *
 * This module exists so the two amortization utils can share them without
 * importing each other. They did, briefly, and the cycle was worse than the
 * duplication it removed: under a mortgage-first load order the merged table
 * initialised without any mortgage key, so an accelerated-biweekly mortgage's
 * scheduled transaction was created MONTHLY -- silently, and only in some import
 * orders.
 */

import {
  FrequencyType,
  addMonthsClamped,
  calculateNextDueDate,
  ensureYMD,
} from "../common/recurrence";
import { localDateForColumn } from "../common/date-utils";

/**
 * Payment frequencies a loan account can carry.
 *
 * These are the *scheduled transaction* recurrence spellings, because that is
 * what reaches the helpers: `SetupLoanPaymentsDto.paymentFrequency` is validated
 * as one of these and passed straight through. Note `SEMIMONTHLY` has no
 * underscore here and `SEMI_MONTHLY` does in `MortgagePaymentFrequency` -- two
 * enums, two spellings, and the mismatch is why this one was once missing: the
 * DTO accepted `SEMIMONTHLY`, `getPeriodsPerYear` fell through to its
 * `default: 12`, and a semi-monthly loan's interest split was computed at twice
 * the correct rate. `loan-payment-frequency.guard.spec.ts` reads the DTO's
 * `@IsIn` list and fails on any accepted value this module cannot handle.
 */
export const PAYMENT_FREQUENCIES = [
  "WEEKLY",
  "BIWEEKLY",
  "SEMIMONTHLY",
  "MONTHLY",
  "QUARTERLY",
  "YEARLY",
] as const;

export type PaymentFrequency = (typeof PAYMENT_FREQUENCIES)[number];

/**
 * Mortgage cadences. `SEMI_MONTHLY` is 24 a year (the 15th and the last day of
 * the month); `BIWEEKLY` and `ACCELERATED_BIWEEKLY` are both 26, `WEEKLY` and
 * `ACCELERATED_WEEKLY` both 52 -- an accelerated cadence pays a fraction of the
 * monthly installment on the same dates as its base, so it differs in the
 * AMOUNT, never in the count or the calendar.
 */
export const MORTGAGE_PAYMENT_FREQUENCIES = [
  "MONTHLY",
  "SEMI_MONTHLY",
  "BIWEEKLY",
  "ACCELERATED_BIWEEKLY",
  "WEEKLY",
  "ACCELERATED_WEEKLY",
] as const;

export type MortgagePaymentFrequency =
  (typeof MORTGAGE_PAYMENT_FREQUENCIES)[number];

/**
 * The recurrence frequency each loan payment frequency schedules at.
 *
 * A `Record` rather than a `switch`, so adding a member to `PaymentFrequency`
 * without deciding how it recurs is a compile error.
 */
export const LOAN_FREQUENCY_TO_RECURRENCE: Record<
  PaymentFrequency,
  FrequencyType
> = {
  WEEKLY: "WEEKLY",
  BIWEEKLY: "BIWEEKLY",
  SEMIMONTHLY: "SEMIMONTHLY",
  MONTHLY: "MONTHLY",
  QUARTERLY: "QUARTERLY",
  YEARLY: "YEARLY",
};

/**
 * The recurrence frequency each mortgage payment frequency schedules at.
 *
 * The accelerated frequencies pay a fraction of the monthly installment on the
 * base cadence, so they schedule as that base cadence.
 */
export const MORTGAGE_FREQUENCY_TO_RECURRENCE: Record<
  MortgagePaymentFrequency,
  FrequencyType
> = {
  MONTHLY: "MONTHLY",
  SEMI_MONTHLY: "SEMIMONTHLY",
  BIWEEKLY: "BIWEEKLY",
  ACCELERATED_BIWEEKLY: "BIWEEKLY",
  WEEKLY: "WEEKLY",
  ACCELERATED_WEEKLY: "WEEKLY",
};

/**
 * The recurrence frequency to schedule at, for any payment-frequency spelling
 * either domain uses.
 *
 * Merged from the two tables rather than written a third time:
 * `SetupLoanPaymentsDto` accepts loan spellings, but mortgage callers reach the
 * same service carrying mortgage ones. The shared keys map identically in both,
 * so the merge order does not matter.
 */
export const SCHEDULED_FREQUENCY_BY_PAYMENT_FREQUENCY: Record<
  string,
  FrequencyType
> = {
  ...LOAN_FREQUENCY_TO_RECURRENCE,
  ...MORTGAGE_FREQUENCY_TO_RECURRENCE,
};

/**
 * The mortgage-domain spelling of a payment frequency, or `null` when the
 * mortgage helpers cannot express it.
 *
 * `SetupLoanPaymentsDto` validates *recurrence* spellings, so its value reaches
 * the mortgage helpers through a conversion. Casting instead handed
 * `getMortgagePeriodsPerYear` values it has no case for -- `SEMIMONTHLY` (the
 * only semi-monthly spelling the DTO accepts), `QUARTERLY` and `YEARLY` -- and
 * its `default: 12` turned each into a monthly rate: twice the interest per
 * period for semi-monthly, three times for quarterly.
 *
 * Quarterly and yearly return `null` rather than a nearest match: a mortgage in
 * this model has no such cadence, and a caller must refuse rather than compute a
 * confident wrong split. Accelerated frequencies are already mortgage-domain
 * names and pass through.
 */
export function toMortgagePaymentFrequency(
  frequency: string,
): MortgagePaymentFrequency | null {
  switch (frequency) {
    case "MONTHLY":
    case "SEMI_MONTHLY":
    case "BIWEEKLY":
    case "WEEKLY":
    case "ACCELERATED_BIWEEKLY":
    case "ACCELERATED_WEEKLY":
      return frequency;
    case "SEMIMONTHLY":
      return "SEMI_MONTHLY";
    default:
      return null;
  }
}

/**
 * Payment periods a year for each cadence, in both domains.
 *
 * `Record`s over the two unions, so a new member of either is a compile error
 * here rather than a `default: 12`. They are the source both
 * `getPeriodsPerYear` and `getMortgagePeriodsPerYear` read.
 */
export const LOAN_PERIODS_PER_YEAR: Record<PaymentFrequency, number> = {
  WEEKLY: 52,
  BIWEEKLY: 26,
  SEMIMONTHLY: 24,
  MONTHLY: 12,
  QUARTERLY: 4,
  YEARLY: 1,
};

export const MORTGAGE_PERIODS_PER_YEAR: Record<
  MortgagePaymentFrequency,
  number
> = {
  MONTHLY: 12,
  SEMI_MONTHLY: 24,
  BIWEEKLY: 26,
  ACCELERATED_BIWEEKLY: 26,
  WEEKLY: 52,
  ACCELERATED_WEEKLY: 52,
};

/**
 * What a caller assumes when `accounts.payment_frequency` holds a string neither
 * domain names.
 *
 * A named constant rather than a `default: 12` inside a switch, because those
 * defaults were how three recognised cadences silently became monthly. This one
 * is only reachable for a value nothing writes -- both writers go through a
 * validated `@IsIn` list, and migration 165 healed the one spelling that
 * escaped -- so it covers a corrupt row, not a supported frequency.
 */
export const DEFAULT_PERIODS_PER_YEAR = 12;

/**
 * Payment periods a year for a frequency read out of `accounts.payment_frequency`,
 * or `null` when the column holds something neither domain names.
 *
 * That column is a bare `VARCHAR(20)` written by both paths -- the mortgage form
 * stores the mortgage enum's spelling, the loan-payment setup dialog stores the
 * recurrence's -- so a caller reading it back holds a string, not a member of
 * either union. Six of them cast it to `MortgagePaymentFrequency` and asked
 * `getMortgagePeriodsPerYear`, whose `default: 12` turned SEMIMONTHLY into a
 * monthly rate: a semi-monthly mortgage booked twice the correct interest on
 * every posted split, at every rate change, and in every recalculation, for the
 * life of the loan. A cast cannot be type-checked, which is why this takes a
 * `string` and answers `null` instead.
 *
 * `mortgage-frequency-cast.guard.spec.ts` scans `src/` for a revived cast.
 */
export function periodsPerYearForStoredFrequency(
  frequency: string | null | undefined,
): number | null {
  if (!frequency) return null;
  return (
    (LOAN_PERIODS_PER_YEAR as Record<string, number>)[frequency] ??
    (MORTGAGE_PERIODS_PER_YEAR as Record<string, number>)[frequency] ??
    null
  );
}

/**
 * Highest payment count the end-date helpers will date. Above it the loan is
 * treated as never paying off.
 *
 * Exported because `createLoanAccount` and `createMortgageAccount` gate on the
 * same ceiling -- they only write an `endDate` when the count is at or below it
 * -- and two literals disagreed at the boundary (the util dated exactly 10000
 * while the service refused it).
 */
export const MAX_DATEABLE_PAYMENTS = 10000;

/**
 * `date` advanced `steps` occurrences of `frequency`, through the recurrence
 * engine that will actually post those payments.
 *
 * The engine rather than a second calendar, because a payoff date's whole job is
 * to bound the linked scheduled transaction: it has to be a date the scheduler
 * reaches. A hand-rolled semi-monthly step (the 1st and the 15th) against the
 * engine's own (the 15th and the last day of the month) dated payment 24 of a
 * 24-payment schedule *before* the final installment, so the schedule it bounded
 * posted 23 of them. It follows that month-end drift here is whatever the
 * scheduler's drift is, by construction.
 *
 * The conversion is UTC in both directions, because that is what a `Date`
 * carrying a calendar date means here: every caller builds one from a date-only
 * string (`new Date("2026-01-15")` is UTC midnight) and every consumer reads it
 * back with `formatDateYMD`, which takes UTC components -- the same convention
 * `ensureYMD` follows. Reading LOCAL components instead put the payoff date one
 * day early in every non-UTC zone, and by two different routes: west of
 * Greenwich the *input* read landed on the previous day, east of it the
 * local-midnight *output* did. Both are invisible under CI's `TZ=UTC`;
 * `payment-frequency.timezone.spec.ts` runs the helpers across four offsets.
 *
 * The loop is deliberate, and cheap enough to keep: stepping through the engine
 * is what makes a payoff date a date the scheduler reaches, and the pathological
 * ceiling (`MAX_DATEABLE_PAYMENTS` weekly steps) measures 4.6ms -- an ordinary
 * 360-payment loan is under 0.2ms. Deriving the date arithmetically instead
 * would be a second calendar again.
 */
export function advancePaymentDates(
  date: Date,
  frequency: FrequencyType,
  steps: number,
): Date {
  let ymd = ensureYMD(date);
  for (let i = 0; i < steps; i++) {
    ymd = calculateNextDueDate(ymd, frequency);
  }
  const [year, month, day] = ymd.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

/**
 * The sentinel a loan that never pays off is dated to: a century past its first
 * payment.
 *
 * Shared by both end-date helpers, and UTC for the same reason
 * `advancePaymentDates` is -- `date.setFullYear(date.getFullYear() + 100)` on a
 * UTC-midnight `Date` reads local components, so west of Greenwich the sentinel
 * came back a day early too. A sentinel nobody reads as a real date still has to
 * be the same string in every deployment, or a snapshot test is a test of the
 * container's timezone.
 */
export function unpayableEndDate(startDate: Date): Date {
  return new Date(
    Date.UTC(
      startDate.getUTCFullYear() + 100,
      startDate.getUTCMonth(),
      startDate.getUTCDate(),
    ),
  );
}

/**
 * The date a mortgage's TERM ends: `termMonths` after the first payment.
 *
 * A single clamped month offset from the anchor, not an accumulation of monthly
 * steps -- a five-year term on a loan first paid on 31 January ends on 31
 * January, where stepping sixty times would have clamped to the 28th at the
 * first February and stayed there.
 *
 * Three call sites spelled this as `d.setMonth(d.getMonth() + termMonths)` on a
 * `Date` built from a date-only string, which is two defects at once: local
 * accessors on a UTC-midnight instant, and `setMonth`'s overflow (31 January
 * plus one month became 3 March, skipping February) where the scheduler's own
 * calendar clamps.
 *
 * The result is LOCAL midnight, not UTC, and that is not an inconsistency with
 * the rest of this module: it is the only `Date` here that goes into a TypeORM
 * `date` COLUMN, and TypeORM serializes those with local getters -- so a
 * UTC-midnight value is stored a day early west of Greenwich. `localDateForColumn`
 * carries the reasoning; which convention applies is decided by the destination.
 */
export function mortgageTermEndDate(
  paymentStartDate: Date | string,
  termMonths: number,
): Date {
  return localDateForColumn(
    addMonthsClamped(ensureYMD(paymentStartDate), termMonths),
  );
}
