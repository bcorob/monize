/**
 * The installment of a LINEAR or INTEREST_ONLY mortgage on one due date
 * (docs/specs/mortgage-types.md, table 4.3).
 *
 * These methods have no constant payment: each installment is the interest on
 * the dated debt plus a principal the method decides, so every surface that
 * prices one -- the scheduled installment (`resolveInstallment`), the
 * rate-change paths, payment setup, the account row an assistant reads --
 * asks this module rather than `accounts.payment_amount`, which is null for
 * them (spec decision 11). The ANNUITY methods are not priced here; their
 * principal is the remainder of the constant payment.
 *
 * Every figure is at storage precision (`roundMoney`, spec decision 7).
 */

import { BadRequestException } from "@nestjs/common";
import { roundMoney } from "../common/round.util";
import { ensureYMD } from "../common/recurrence";
import { tr } from "../i18n/translate";
import {
  MortgageAmortizationMethod,
  MortgageType,
  PrepaymentMode,
  amortizationMethodFor,
  prepaymentModeOf,
} from "./mortgage-type.util";
import {
  SCHEDULED_FREQUENCY_BY_PAYMENT_FREQUENCY,
  advancePaymentDates,
  periodsPerYearForStoredFrequency,
} from "./payment-frequency.util";

/** The account columns the method installment reads. */
export interface MortgageMethodTerms {
  prepaymentMode?: PrepaymentMode | null;
  originalPrincipal?: number | string | null;
  openingBalance?: number | string | null;
  amortizationMonths?: number | null;
  paymentStartDate?: Date | string | null;
  paymentFrequency?: string | null;
}

/** A term a non-annuity method cannot be priced without (spec section 8). */
export type MissingMethodTerm =
  | "amortizationMonths"
  | "paymentStartDate"
  | "paymentFrequency"
  | "originalPrincipal";

/** One installment, before any standing extra-principal line. */
export interface MethodInstallment {
  principal: number;
  interest: number;
}

/**
 * Accelerated cadences pay a fraction of the annuity's monthly installment,
 * so they have no meaning for a method without one (spec section 5.1).
 */
export function isAcceleratedFrequency(
  frequency: string | null | undefined,
): boolean {
  return (
    frequency === "ACCELERATED_BIWEEKLY" || frequency === "ACCELERATED_WEEKLY"
  );
}

function recurrenceOf(terms: MortgageMethodTerms) {
  return terms.paymentFrequency
    ? (SCHEDULED_FREQUENCY_BY_PAYMENT_FREQUENCY[terms.paymentFrequency] ?? null)
    : null;
}

/**
 * `N`, the scheduled payment count: `round(amortizationMonths * ppy / 12)`.
 * Null when either input is missing or unknown -- never a default of 360 or
 * of 12 payments a year, which would price a confident wrong installment.
 */
export function scheduledPaymentCount(
  terms: MortgageMethodTerms,
): number | null {
  const months = Number(terms.amortizationMonths);
  const periodsPerYear = periodsPerYearForStoredFrequency(
    terms.paymentFrequency,
  );
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
 * stepped through `advancePaymentDates`, the recurrence engine the scheduler
 * posts on. Null when the calendar is unknown.
 */
export function scheduledPaymentDate(
  terms: MortgageMethodTerms,
  n: number,
): string | null {
  const recurrence = recurrenceOf(terms);
  if (recurrence === null || !terms.paymentStartDate || n < 1) return null;
  return ensureYMD(
    advancePaymentDates(
      new Date(ensureYMD(terms.paymentStartDate)),
      recurrence,
      n - 1,
    ),
  );
}

/**
 * `k(d)`: how many calendar due dates fall on or before `d`. The calendar
 * starts at `payment_start_date` (payment 1, INV-LOAN-005) and steps with the
 * scheduler's recurrence (`scheduledPaymentDate`). Defined for a date off the
 * calendar too: 2025-07-10 on a calendar of firsts from 2024-01-01 is 19, the
 * same as 2025-07-01. Never more than `N + 1`. The dates only move forward, so
 * the count is found by bisection rather than by walking the whole schedule.
 */
export function calendarPaymentNumber(
  terms: MortgageMethodTerms,
  asOfDate: string,
): number | null {
  const count = scheduledPaymentCount(terms);
  if (count === null || scheduledPaymentDate(terms, 1) === null) return null;
  let low = 0;
  let high = count + 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if ((scheduledPaymentDate(terms, mid) as string) <= asOfDate) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return low;
}

/**
 * `remaining(d)` = `N - k(d) + 1`: the scheduled payments from `d` to the term
 * end, `d` included (spec section 2). Taken from the calendar, never from a
 * count of postings, so a missed or an extra payment does not move the term
 * end (INV-LOAN-006). Never more than `N`, so a date before the first payment
 * spreads the debt over the whole schedule; zero or less past the term end.
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
 * The largest leftover a LINEAR SHORTEN_TERM final installment absorbs:
 * half a cent per scheduled payment, `roundMoney(N * 0.005)` (1.80 for 360
 * payments). Sized for the rounding of `c` to storage precision and of
 * installments recorded at statement cents (spec decision 8).
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
 * Past the term end (`remaining <= 0`, an overdue schedule) every method
 * prices the whole debt: nothing is left to spread it over.
 */
export function methodPrincipal(input: {
  method: Exclude<MortgageAmortizationMethod, "ANNUITY">;
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
 * `amortization_months`, `payment_start_date` and a known
 * `payment_frequency` for every non-annuity method (there is no `N`, no
 * calendar and no periodic rate without them), and a positive principal for a
 * LINEAR SHORTEN_TERM mortgage (`c` would be 0). Empty for an annuity type.
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
  if (
    periodsPerYearForStoredFrequency(terms.paymentFrequency) === null ||
    recurrenceOf(terms) === null
  ) {
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
 * Refuse a LINEAR or INTEREST_ONLY mortgage the method cannot price: an
 * accelerated cadence (spec section 5.1), or a missing term (section 8). The
 * create, update, preview and setup paths call this before writing, so the
 * refusal names the field and nothing is stored. A no-op for an annuity type.
 */
export function assertMortgageMethodTerms(
  type: MortgageType,
  terms: MortgageMethodTerms,
): void {
  if (amortizationMethodFor(type) === "ANNUITY") return;
  if (isAcceleratedFrequency(terms.paymentFrequency)) {
    throw new BadRequestException(
      tr(
        "errors.accounts.mortgageMethodAccelerated",
        `Accelerated payment frequencies apply only to annuity mortgages; a ${type} mortgage cannot be paid ${terms.paymentFrequency}`,
        { type, frequency: terms.paymentFrequency },
      ),
    );
  }
  const missing = missingMethodTerms(type, terms);
  if (missing.length > 0) {
    const fields = missing.join(", ");
    throw new BadRequestException(
      tr(
        "errors.accounts.mortgageMethodRequiresTerms",
        `A ${type} mortgage requires ${fields}`,
        { type, fields },
      ),
    );
  }
}

/**
 * The installment of a LINEAR or INTEREST_ONLY mortgage due on `asOfDate`:
 * interest `roundMoney(debt * periodicRate)` (INV-LOAN-006, unchanged) and
 * the method's principal (table 4.3). `debt` is the ledger debt through that
 * date (`datedLoanDebt`) and `periodicRate` the rate dated to it.
 *
 * Null for an annuity type, or when a term is missing: the caller declines
 * (spec section 8) rather than pricing a guess.
 */
export function nonAnnuityInstallment(
  type: MortgageType,
  terms: MortgageMethodTerms,
  asOfDate: string,
  debt: number,
  periodicRate: number,
): MethodInstallment | null {
  const method = amortizationMethodFor(type);
  if (method === "ANNUITY") return null;
  if (missingMethodTerms(type, terms).length > 0) return null;
  const count = scheduledPaymentCount(terms);
  const remaining = remainingScheduledPayments(terms, asOfDate);
  if (count === null || remaining === null) return null;
  const constantPrincipal =
    method === "LINEAR" ? (constantLinearPrincipal(terms) ?? 0) : 0;
  return {
    principal: methodPrincipal({
      method,
      mode: prepaymentModeOf(terms),
      debt,
      constantPrincipal,
      remaining,
      count,
    }),
    interest: roundMoney(Math.max(0, debt) * periodicRate),
  };
}
