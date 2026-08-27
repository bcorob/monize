/**
 * Overpayments: what a borrower adds on top of the contractual installment, and
 * when.
 *
 * Split out of `loan-schedule.ts` for its size. This module owns the plan shapes
 * (a recurring extra, lump sums, a fixed budget), what a plan's MODE is, and the
 * calendar that turns a cadence into occurrences a schedule row can carry. It
 * knows nothing about generating a schedule; `loan-schedule.ts` re-exports it
 * all, because every consumer has always imported from there.
 */

import { parseLocalDate } from "@/lib/utils";
import { advanceByFrequency } from "@/lib/frequency";
import type { FrequencyType } from "@/types/scheduled-transaction";
import {
  ScheduleFrequency,
  getPeriodsPerYear,
  isoDay,
} from "@/lib/loan-frequency";

export interface LumpSum {
  /** ISO date (yyyy-MM-dd) the lump sum is paid */
  date: string;
  amount: number;
  /**
   * Whether this overpayment shortens the term (keep the installment) or lowers
   * the installment (keep the end date). Defaults to SHORTEN_TERM when omitted.
   */
  mode?: OverpaymentMode;
}

/**
 * How often a recurring overpayment is made. ONE_OFF is a single dated payment
 * (modelled as a lump sum, not a RecurringExtra); the rest recur.
 *
 * A cadence is a *calendar*, independent of the loan's own payment frequency:
 * occurrences fall on the anchor date and every cadence step after it, and each
 * is applied at the first loan payment on or after its due date
 * (`recurringOccurrencesDue`). So MONTHLY contributes exactly 12 occurrences per
 * calendar year on a weekly, biweekly or monthly loan, and the borrower's
 * nominal annual cash is what they typed. Deriving a payment interval instead
 * (`round(periodsPerYear / overpaymentsPerYear)`) paid a monthly extra 13 times
 * a year on a biweekly loan.
 */
export type OverpaymentFrequency =
  | "ONE_OFF"
  | "WEEKLY"
  | "BIWEEKLY"
  | "MONTHLY"
  | "QUARTERLY"
  | "ANNUALLY";

/**
 * The frequencies that genuinely recur. `ONE_OFF` is a single dated payment,
 * modelled as a `LumpSum`, so it is not a cadence a `RecurringExtra` can carry.
 */
export type RecurringOverpaymentFrequency = Exclude<
  OverpaymentFrequency,
  "ONE_OFF"
>;

/**
 * Overpayments per year for each frequency. `ONE_OFF` is 0 -- a single dated
 * payment has no annual rate, and a caller spreading an amount over a year must
 * treat it separately rather than divide by zero occurrences.
 *
 * A `Record` rather than a `switch`, so a new member of `OverpaymentFrequency`
 * is a compile error here instead of a silent `default: 0`.
 */
const OVERPAYMENTS_PER_YEAR: Record<OverpaymentFrequency, number> = {
  ONE_OFF: 0,
  WEEKLY: 52,
  BIWEEKLY: 26,
  MONTHLY: 12,
  QUARTERLY: 4,
  ANNUALLY: 1,
};

/** Overpayments per year for each recurring frequency (ONE_OFF is not recurring). */
export function overpaymentsPerYear(frequency: OverpaymentFrequency): number {
  return OVERPAYMENTS_PER_YEAR[frequency] ?? 0;
}

/**
 * The *average* extra per loan payment for a recurring overpayment of `amount`
 * per `frequency`: the nominal annual cash spread over the loan's periods.
 *
 * Display only -- it is what the "resulting monthly payment" card adds to the
 * installment when the cadence is at least as frequent as the loan's payments.
 * The schedule engine does NOT apply this figure; it dates each occurrence and
 * applies the full amount (see `recurringOccurrencesDue`), so a balance must
 * never be computed from this average.
 */
export function perPaymentExtraAmount(
  amount: number,
  frequency: OverpaymentFrequency,
  loanFrequency: ScheduleFrequency,
): number {
  const per = overpaymentsPerYear(frequency);
  if (per <= 0) return 0;
  return (amount * per) / getPeriodsPerYear(loanFrequency);
}

export interface RecurringExtra {
  /** Amount paid per occurrence of `frequency` (not per loan payment). */
  amount: number;
  /** ISO date (yyyy-MM-dd); applies from the first payment when omitted */
  startDate?: string;
  /** ISO date (yyyy-MM-dd); applies until payoff when omitted */
  endDate?: string;
  /**
   * Cadence of the overpayment. Omitted means the amount is applied on every
   * loan payment as-is (legacy "extra per payment"); a set frequency dates the
   * occurrences on the calendar and applies the full amount at the first loan
   * payment on or after each due date.
   *
   * `ONE_OFF` is excluded by the type rather than by convention: it is a single
   * dated payment, so it belongs in `lumpSums`. Accepted here it collapsed into
   * the legacy no-cadence branch and paid the full amount on EVERY payment --
   * a lump sum of 5000 becoming 60,000 a year. The backend enum does not admit
   * it, but nothing in the types said so.
   */
  frequency?: RecurringOverpaymentFrequency;
  /**
   * Whether this overpayment shortens the term or lowers the installment.
   * Defaults to SHORTEN_TERM when omitted.
   */
  mode?: OverpaymentMode;
}

export interface OverpaymentPlan {
  recurringExtra?: RecurringExtra;
  lumpSums?: LumpSum[];
  /**
   * A fixed total to spend on the loan each period (installment + overpayment).
   * Modelled in the lower-installment style: every period the installment is
   * recomputed over the remaining contractual term, and the rest of the budget
   * is overpaid -- so as the installment falls the overpayment grows to keep the
   * total constant. When set, recurringExtra and lumpSums are ignored.
   */
  targetMonthlyPayment?: number;
  /**
   * How the budget's installment/overpayment split is shown. LOWER_INSTALLMENT
   * (default, matching how banks apply overpayments) re-amortizes the
   * installment each period (it shrinks, the overpayment grows); SHORTEN_TERM
   * keeps the contractual installment fixed and the overpayment constant. The
   * balance and payoff are identical either way -- only the split differs.
   */
  targetMonthlyPaymentMode?: OverpaymentMode;
  /** ISO date (yyyy-MM-dd); the budget applies from the first payment when
   *  omitted. Before it, only the regular installment is paid. */
  targetMonthlyPaymentStart?: string;
  /** ISO date (yyyy-MM-dd); the budget applies until payoff when omitted. After
   *  it, the loan reverts to the regular installment. */
  targetMonthlyPaymentEnd?: string;
}

/**
 * The mode a plan actually behaves as, from whichever of its three carriers is
 * in force.
 *
 * A plan can name its mode in three places -- `targetMonthlyPaymentMode`,
 * `recurringExtra.mode`, and each lump sum's -- and reading only the second was
 * how the heuristic it replaced kept coming back: a saved BUDGET scenario has
 * `recurringExtraMode = null` and its mode on `targetMonthlyPaymentMode`, so the
 * caller fell through to `installmentReduction > 0.005`, which is null exactly
 * when a schedule truncated -- the case the explicit mode was added for.
 *
 * The precedence follows the engine, not a preference. A budget IGNORES
 * `recurringExtra` and `lumpSums` (see `OverpaymentPlan.targetMonthlyPayment`),
 * so when one is set its mode is the only one that describes anything, and its
 * default matches the engine's `?? 'LOWER_INSTALLMENT'`. Otherwise the engine
 * re-levels the installment when ANY overpayment asks it to
 * (`anyLowerOverpayment`), so any LOWER_INSTALLMENT carrier makes the plan one:
 * a consumer that adds the overpayment on top of an installment a lump sum has
 * already re-levelled down counts the same money twice.
 *
 * `null` means the plan carries no overpayment at all -- distinct from
 * SHORTEN_TERM, which is a plan that overpays and keeps its installment.
 */
export function effectiveOverpaymentMode(
  plan: OverpaymentPlan | undefined | null,
): OverpaymentMode | null {
  if (!plan) return null;
  if ((plan.targetMonthlyPayment ?? 0) > 0) {
    return plan.targetMonthlyPaymentMode ?? "LOWER_INSTALLMENT";
  }
  const carriers = [
    ...(plan.recurringExtra ? [plan.recurringExtra.mode] : []),
    ...(plan.lumpSums ?? []).map((lump) => lump.mode),
  ];
  if (carriers.length === 0) return null;
  return carriers.some(
    (mode) => (mode ?? "SHORTEN_TERM") === "LOWER_INSTALLMENT",
  )
    ? "LOWER_INSTALLMENT"
    : "SHORTEN_TERM";
}

/**
 * What a bank holds fixed after an overpayment:
 * - SHORTEN_TERM (PL *skrócenie okresu*): keep the installment, pay off sooner.
 * - LOWER_INSTALLMENT (PL *obniżenie raty*): keep the end date, recompute a
 *   smaller installment that amortizes the reduced balance over the remaining
 *   periods.
 */
export type OverpaymentMode = "SHORTEN_TERM" | "LOWER_INSTALLMENT";

/**
 * The recurrence frequency each overpayment cadence steps on.
 *
 * The same engine the loan's own payment dates use, and for the same reason: an
 * occurrence is applied at the first loan payment on or after its due date, so
 * two calendars that clamp differently make an occurrence miss the payment it
 * belongs to. They did. Occurrences were derived from the anchor by index and
 * clamped per month (31 Jan, 28 Feb, 31 Mar, 30 Apr ...) while the loan's rows
 * accumulate the engine's clamp (31 Jan, 28 Feb, 28 Mar, 28 Apr ...), so on a
 * monthly loan first paid on the 31st the occurrence due 31 March arrived after
 * the row dated 28 March, waited for 28 April, and the borrower paid ELEVEN
 * monthly extras in the first calendar year and two on one row the next
 * February -- the count INV-LOAN-001 exists to protect, broken by the calendars
 * disagreeing rather than by the arithmetic.
 *
 * The price is the one the anchor-derived version was written to avoid: an
 * accumulating clamp is lossy, so a cadence anchored on the 31st settles onto
 * the 28th after its first February instead of returning to month-end the way a
 * standing order would. On a loan paid on the 31st that is not a cost -- the
 * loan's own payments have settled onto the 28th too, and the overpayment
 * follows them -- and for any anchor on the 28th or earlier the two are
 * identical. The count per year, which is the invariant, is preserved either
 * way; the alignment is not.
 */
const CADENCE_RECURRENCE: Record<RecurringOverpaymentFrequency, FrequencyType> =
  {
    WEEKLY: "WEEKLY",
    BIWEEKLY: "BIWEEKLY",
    MONTHLY: "MONTHLY",
    QUARTERLY: "QUARTERLY",
    ANNUALLY: "YEARLY",
  };

/** Counts the overpayment occurrences a given loan payment has to carry. */
export interface RecurringOccurrenceCounter {
  /**
   * Occurrences due on or before `rowDate` that no earlier payment has taken.
   * Stateful: call once per schedule row, in date order.
   */
  dueBy(rowDate: string): number;
}

/**
 * The one place a recurring overpayment's cadence becomes schedule rows.
 *
 * A declared frequency is a **calendar**: occurrences fall on the anchor date
 * and every cadence step after it, and each is applied at the first loan payment
 * on or after its due date. That makes the annual count exact in both
 * directions -- 12 monthly occurrences a year on a weekly, biweekly or monthly
 * loan; 52 weekly occurrences a year on a monthly loan, arriving four or five at
 * a time -- so the borrower's nominal annual cash is what they typed.
 *
 * The interval this replaced was `round(periodsPerYear / overpaymentsPerYear)`,
 * which is only exact when the ratio divides: `26 / 12` rounded to 2, so a
 * "monthly" 100 landed every second biweekly payment, 13 times a year.
 *
 * Two window rules, both deliberate:
 * - The anchor never precedes the first projected payment. A start date already
 *   in the past means "from now", not a backlog of missed occurrences dumped
 *   onto row 1.
 * - The end date is tested against an occurrence's **due** date, not against
 *   the payment that carries it: cash committed inside the window is still
 *   paid, even when the next payment date falls past the end.
 *
 * An omitted frequency keeps the legacy meaning -- the amount on every payment
 * inside the window, so every payment is exactly one occurrence.
 */
export function recurringOccurrencesDue(
  extra: RecurringExtra,
  firstPaymentDate: Date,
): RecurringOccurrenceCounter {
  // Three cases, not two. No frequency declared is the legacy "amount on every
  // payment"; a recognized cadence is dated below; a frequency declared but
  // unrecognized is neither.
  //
  // The third is reachable even though `RecurringExtra.frequency` excludes
  // ONE_OFF by type: `loan_scenarios.recurring_extra_frequency` is an
  // unconstrained VARCHAR whose only enforcement is `@IsIn` at write time, so a
  // legacy row or a restored backup can carry anything. An undefined lookup
  // landing in the legacy branch applied the FULL amount on every payment --
  // the densest possible reading of an unknown value, turning a declared 5000
  // annual overpayment into 5000 a month with a payoff and a saving to match.
  // Contributing nothing is the direction that cannot invent a saving.
  const declaredCadence = extra.frequency
    ? (CADENCE_RECURRENCE[extra.frequency] as FrequencyType | undefined)
    : null;

  if (declaredCadence === undefined) {
    return { dueBy: () => 0 };
  }

  const cadence = declaredCadence;
  if (!cadence) {
    return {
      dueBy: (rowDate) =>
        (!extra.startDate || extra.startDate <= rowDate) &&
        (!extra.endDate || rowDate <= extra.endDate)
          ? 1
          : 0,
    };
  }

  const firstPaymentIso = isoDay(firstPaymentDate);
  const anchor =
    extra.startDate && extra.startDate > firstPaymentIso
      ? parseLocalDate(extra.startDate)
      : new Date(firstPaymentDate);

  // Occurrence 0 is the anchor itself; each consumed occurrence steps the cursor
  // once, so the walk is one engine step per occurrence rather than a fresh
  // derivation per row -- and consuming in order is already this counter's
  // contract (the out-of-order guard below).
  let cursor = new Date(anchor);
  let lastRowDate: string | null = null;
  // The pending occurrence's ISO date, cached because most rows consume nothing:
  // re-deriving and re-formatting it per row cost one date-fns `format` on every
  // one of a weekly loan's 2600 projected payments, and the goal-seek solver
  // builds ~24 schedules per keystroke.
  let pendingDueIso: string | null = null;

  return {
    dueBy: (rowDate) => {
      // The counter consumes occurrences as it goes, so a caller that asks out
      // of order would silently swallow every occurrence between the two dates.
      // Refuse rather than answer wrongly -- prose could not make this checkable.
      if (lastRowDate !== null && rowDate < lastRowDate) {
        throw new Error(
          `recurringOccurrencesDue: rowDate ${rowDate} precedes ${lastRowDate}; ` +
            "occurrences are consumed in date order, one call per schedule row",
        );
      }
      lastRowDate = rowDate;
      let count = 0;
      for (;;) {
        if (pendingDueIso === null) {
          pendingDueIso = isoDay(cursor);
        }
        // Not yet due: it stays pending for a later payment.
        if (pendingDueIso > rowDate) break;
        // Past the window: nothing further is ever due, and the pending date
        // stays parked so subsequent rows count nothing.
        if (extra.endDate && pendingDueIso > extra.endDate) break;
        count++;
        cursor = advanceByFrequency(cursor, cadence);
        pendingDueIso = null;
      }
      return count;
    },
  };
}
