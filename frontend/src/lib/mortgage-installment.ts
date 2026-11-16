/**
 * The installment rules of a LINEAR or INTEREST_ONLY mortgage
 * (docs/specs/mortgage-types.md, table 4.3): the browser-side twin of
 * `backend/src/accounts/mortgage-installment.util.ts`.
 *
 * These methods have no constant payment: each installment is the interest on
 * the debt plus a principal the method decides. The backend prices the dated
 * installment of a scheduled payment from here; this layer prices each row of
 * a projection (`generateLoanSchedule`), with the row's own projected balance
 * in place of the ledger debt (spec section 5.4). The ANNUITY methods are not
 * priced here; their principal is the remainder of the constant payment.
 *
 * Every figure is at storage precision (`roundMoney`, spec decision 7).
 */

import { roundMoney } from "@/lib/format";
import {
  advanceDate,
  isoDay,
  periodsPerYearOf,
  type ScheduleFrequency,
} from "@/lib/loan-frequency";
import {
  amortizationMethodFor,
  prepaymentModeOf,
  type MortgageAmortizationMethod,
  type PrepaymentMode,
} from "@/lib/mortgage-type";
import { parseLocalDate } from "@/lib/utils";
import type { MortgageType } from "@/types/account";

/** The account columns the method installment reads. */
export interface MortgageMethodTerms {
  prepaymentMode?: PrepaymentMode | null;
  originalPrincipal?: number | string | null;
  openingBalance?: number | string | null;
  amortizationMonths?: number | null;
  paymentStartDate?: string | null;
  paymentFrequency?: string | null;
}

/** A term a non-annuity method cannot be priced without (spec section 8). */
export type MissingMethodTerm =
  | "amortizationMonths"
  | "paymentStartDate"
  | "paymentFrequency"
  | "originalPrincipal";

/** A method other than ANNUITY: the ones priced here. */
export type NonAnnuityMethod = Exclude<MortgageAmortizationMethod, "ANNUITY">;

/**
 * What a projection needs to price every row of a LINEAR or INTEREST_ONLY
 * mortgage, resolved once from the account (`methodScheduleTerms`).
 */
export interface MethodScheduleTerms {
  /** The account's mode; `SHORTEN_TERM` for INTEREST_ONLY, which ignores it. */
  prepaymentMode: PrepaymentMode;
  /**
   * `c` = `roundMoney(P / N)`; 0 for INTEREST_ONLY, which has none. Null for a
   * LOWER_INSTALLMENT LINEAR mortgage whose amount borrowed is unknown: its own
   * rule never reads `c`, and a SHORTEN_TERM what-if on it cannot be priced.
   */
  constantPrincipal: number | null;
  /** `N`, the scheduled payment count. */
  scheduledPayments: number;
  /**
   * `remaining(d)` for the date of the projection's first row: the scheduled
   * payments from that row to the term end, that row included. Each later row
   * falls one calendar step after the one before, so it is one fewer there.
   */
  remainingAtFirstRow: number;
  /** The date of payment `N` (YYYY-MM-DD): the term end, and the bullet's date. */
  termEndDate: string;
}

/**
 * Payments a year for a stored cadence, or null when the cadence is unknown --
 * never a default of 12 (spec section 8).
 */
function knownPeriodsPerYear(
  frequency: string | null | undefined,
): number | null {
  return frequency ? periodsPerYearOf(frequency) : null;
}

/**
 * `N`, the scheduled payment count: `round(amortizationMonths * ppy / 12)`.
 * Null when either input is missing or unknown -- never a default of 360 or of
 * 12 payments a year, which would price a confident wrong installment.
 */
export function scheduledPaymentCount(
  terms: MortgageMethodTerms,
): number | null {
  const months = Number(terms.amortizationMonths);
  const periodsPerYear = knownPeriodsPerYear(terms.paymentFrequency);
  if (!Number.isFinite(months) || months <= 0 || periodsPerYear === null) {
    return null;
  }
  const count = Math.round((months * periodsPerYear) / 12);
  return count >= 1 ? count : null;
}

/**
 * `P`: `original_principal`, else the amount advanced when the account was
 * opened (`abs(opening_balance)`, spec section 8). Null when neither is a
 * positive amount: a principal of 0 would not amortize.
 */
function amountBorrowed(terms: MortgageMethodTerms): number | null {
  const original = Number(terms.originalPrincipal);
  if (terms.originalPrincipal != null && Number.isFinite(original)) {
    return original > 0 ? original : null;
  }
  const opening = Math.abs(Number(terms.openingBalance));
  return Number.isFinite(opening) && opening > 0 ? opening : null;
}

/**
 * `c`, the constant principal of a LINEAR mortgage: `roundMoney(P / N)`
 * (833.3333 for 300,000 over 360 payments). Null when `P` or `N` is unknown.
 */
export function constantLinearPrincipal(
  terms: MortgageMethodTerms,
): number | null {
  const principal = amountBorrowed(terms);
  const count = scheduledPaymentCount(terms);
  if (principal === null || count === null) return null;
  return roundMoney(principal / count);
}

/**
 * The YYYY-MM-DD date of scheduled payment `n` (1 is `payment_start_date`),
 * stepped through `advanceDate`, the calendar the scheduler posts on. Null
 * when the calendar is unknown.
 */
export function scheduledPaymentDate(
  terms: MortgageMethodTerms,
  n: number,
): string | null {
  if (
    !terms.paymentStartDate ||
    knownPeriodsPerYear(terms.paymentFrequency) === null ||
    n < 1
  ) {
    return null;
  }
  let date = parseLocalDate(terms.paymentStartDate);
  for (let i = 1; i < n; i++) {
    date = advanceDate(date, terms.paymentFrequency as ScheduleFrequency);
  }
  return isoDay(date);
}

/**
 * `k(d)`: how many calendar due dates fall on or before `d`. The calendar
 * starts at `payment_start_date` (payment 1, INV-LOAN-005) and steps with
 * `advanceDate`. Defined for a date off the calendar too: 2025-07-10 on a
 * calendar of firsts from 2024-01-01 is 19, the same as 2025-07-01. Never
 * more than `N + 1`. Mirrors the backend's `calendarPaymentNumber`.
 */
export function calendarPaymentNumber(
  terms: MortgageMethodTerms,
  asOfDate: string,
): number | null {
  const count = scheduledPaymentCount(terms);
  if (count === null || !terms.paymentStartDate) return null;
  const frequency = terms.paymentFrequency as ScheduleFrequency;
  let date = parseLocalDate(terms.paymentStartDate);
  let k = 0;
  while (k <= count && isoDay(date) <= asOfDate) {
    k++;
    date = advanceDate(date, frequency);
  }
  return k;
}

/**
 * `remaining(d)` = `N - k(d) + 1`: the scheduled payments from `d` to the term
 * end, `d` included (spec section 2). Taken from the calendar, never from a
 * count of postings, so a missed or an extra payment does not move the term
 * end. Never more than `N`; zero or less past the term end.
 */
export function remainingScheduledPayments(
  terms: MortgageMethodTerms,
  asOfDate: string,
): number | null {
  const count = scheduledPaymentCount(terms);
  const k = calendarPaymentNumber(terms, asOfDate);
  if (count === null || k === null) return null;
  return Math.min(count, count - k + 1);
}

/**
 * The first calendar due date after `afterDate` (YYYY-MM-DD), or null when
 * the calendar is unknown or the term has already ended. A projection with no
 * scheduled payment to anchor on starts here, so its rows -- and the bullet --
 * fall on the dates the mortgage is paid on.
 */
export function nextScheduledPaymentDate(
  terms: MortgageMethodTerms,
  afterDate: string,
): string | null {
  const count = scheduledPaymentCount(terms);
  const k = calendarPaymentNumber(terms, afterDate);
  if (count === null || k === null) return null;
  return k < count ? scheduledPaymentDate(terms, k + 1) : null;
}

/**
 * The largest leftover a LINEAR SHORTEN_TERM final installment absorbs: half
 * a cent per scheduled payment, `roundMoney(N * 0.005)` (1.80 for 360
 * payments; spec decision 8).
 */
export function linearResidueBound(count: number): number {
  return roundMoney(count * 0.005);
}

/**
 * Table 4.3's principal at a due date, for a method other than ANNUITY.
 *
 * - LINEAR, SHORTEN_TERM: `min(c, debt)`, and the whole debt when what is left
 *   after `c` is within `linearResidueBound` (decision 8), so no payment of a
 *   few cents follows the last one;
 * - LINEAR, LOWER_INSTALLMENT: `roundMoney(debt / remaining)`, the whole debt
 *   on the last scheduled payment;
 * - INTEREST_ONLY: 0, and the whole debt on the last scheduled payment (the
 *   bullet).
 *
 * Past the term end (`remaining <= 0`) every method prices the whole debt:
 * nothing is left to spread it over.
 */
export function methodPrincipal(input: {
  method: NonAnnuityMethod;
  mode: PrepaymentMode;
  debt: number;
  constantPrincipal: number;
  remaining: number;
  count: number;
}): number {
  const debt = roundMoney(input.debt);
  if (debt <= 0) return 0;
  if (input.remaining <= 0) return debt;
  if (input.method === "INTEREST_ONLY") {
    return input.remaining <= 1 ? debt : 0;
  }
  if (input.mode === "LOWER_INSTALLMENT") {
    return input.remaining <= 1 ? debt : roundMoney(debt / input.remaining);
  }
  return roundMoney(debt - input.constantPrincipal) <=
    linearResidueBound(input.count)
    ? debt
    : Math.min(input.constantPrincipal, debt);
}

/**
 * What a non-annuity method cannot be priced without (spec section 8):
 * `amortization_months`, `payment_start_date` and a known `payment_frequency`
 * for every non-annuity method, and a positive principal for a LINEAR
 * SHORTEN_TERM mortgage (`c` would be 0). Empty for an annuity type.
 */
export function missingMethodTerms(
  type: MortgageType,
  terms: MortgageMethodTerms,
): MissingMethodTerm[] {
  const method = amortizationMethodFor(type);
  if (method === "ANNUITY") return [];
  const missing: MissingMethodTerm[] = [];
  const months = Number(terms.amortizationMonths);
  if (!Number.isFinite(months) || months <= 0) {
    missing.push("amortizationMonths");
  }
  if (!terms.paymentStartDate) missing.push("paymentStartDate");
  if (knownPeriodsPerYear(terms.paymentFrequency) === null) {
    missing.push("paymentFrequency");
  }
  if (
    method === "LINEAR" &&
    prepaymentModeOf(terms) === "SHORTEN_TERM" &&
    amountBorrowed(terms) === null
  ) {
    missing.push("originalPrincipal");
  }
  return missing;
}

/**
 * The terms a projection whose first row falls on `firstRowDate` prices a
 * LINEAR or INTEREST_ONLY mortgage by, or the terms that are missing. Null for
 * an annuity type, which the engine prices from its constant payment.
 */
export function methodScheduleTerms(
  type: MortgageType,
  terms: MortgageMethodTerms,
  firstRowDate: string,
):
  | { terms: MethodScheduleTerms; missing: null }
  | { terms: null; missing: MissingMethodTerm[] }
  | null {
  const method = amortizationMethodFor(type);
  if (method === "ANNUITY") return null;
  const missing = missingMethodTerms(type, terms);
  const count = scheduledPaymentCount(terms);
  const remaining = remainingScheduledPayments(terms, firstRowDate);
  const termEndDate = count !== null ? scheduledPaymentDate(terms, count) : null;
  if (
    missing.length > 0 ||
    count === null ||
    remaining === null ||
    termEndDate === null
  ) {
    return { terms: null, missing };
  }
  return {
    terms: {
      prepaymentMode:
        method === "LINEAR" ? prepaymentModeOf(terms) : "SHORTEN_TERM",
      constantPrincipal: method === "LINEAR" ? constantLinearPrincipal(terms) : 0,
      scheduledPayments: count,
      remainingAtFirstRow: remaining,
      termEndDate,
    },
    missing: null,
  };
}
