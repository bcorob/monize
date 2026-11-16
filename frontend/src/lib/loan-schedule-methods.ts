/**
 * The projection of a LINEAR or INTEREST_ONLY mortgage
 * (docs/specs/mortgage-types.md, section 5.4).
 *
 * Each row's principal is table 4.3's, with the row's own projected balance in
 * place of the ledger debt (`methodPrincipal`), and its interest is
 * `roundMoney(balance * r)` at the rate in force on the row's date. There is no
 * constant payment: a stated rate-change payment is not read, and a rate step
 * moves only the interest. The annuity engine's re-levelling and stall rescue
 * do not apply -- the principal is set independently of the interest, so an
 * installment cannot fall below it.
 *
 * Every figure is computed at storage precision (`roundMoney`, spec decision
 * 7), which is what reproduces the spec's section 7 tables to the cent; rows
 * are emitted at cents, like the annuity engine's.
 *
 * The simulator's two overpayment modes are the account setting's two rules
 * (spec table 4.3), applied from the next row on: `LOWER_INSTALLMENT` prices
 * the principal as the balance over the payments left to the term end,
 * `SHORTEN_TERM` as the constant principal `c` = P / N (the whole balance once
 * it is smaller), so the loan ends earlier. A LINEAR loan follows its
 * account's rule until an extra repayment or a budget carrying the other one
 * takes effect; one that names no mode follows the account's rule, which is
 * what the lender will do with it. A SHORTEN_TERM what-if on a mortgage whose
 * `c` is unknown is withheld rather than priced with a principal of 0.
 * INTEREST_ONLY has no principal to re-derive: an extra repayment lowers the
 * interest and the bullet alike.
 */

import { roundMoney, roundToCents, roundToDecimals } from "@/lib/format";
import {
  isDebtOutstanding,
  advanceDate,
  getPeriodicRate,
  getPeriodsPerYear,
  isoDay,
  resolveMaxPayments,
} from "@/lib/loan-frequency";
import {
  recurringOccurrencesDue,
  type OverpaymentMode,
} from "@/lib/loan-overpayments";
import type {
  LoanScheduleInput,
  LoanScheduleResult,
  ScheduleRow,
} from "@/lib/loan-schedule-types";
import {
  methodPrincipal,
  type NonAnnuityMethod,
} from "@/lib/mortgage-installment";

/**
 * The result of a schedule the engine cannot price: no rows, not paid off. A
 * LINEAR or INTEREST_ONLY input without its method terms lands here rather
 * than being priced as an annuity; `buildLoanProjectionInput` refuses to build
 * one, naming the missing term.
 */
function withheldSchedule(): LoanScheduleResult {
  return {
    rows: [],
    payoffDate: null,
    totalInterest: 0,
    totalPaid: 0,
    totalExtraPrincipal: 0,
    numPayments: 0,
    paidOff: false,
    coveredInterest: true,
    finalPaymentAmount: 0,
    levelInstallment: false,
  };
}

/**
 * Generate the schedule of a LINEAR or INTEREST_ONLY mortgage. Called by
 * `generateLoanSchedule` for those methods, with or without an overpayment
 * plan; a fixed budget (`targetMonthlyPayment`) pays each row's installment
 * and overpays `budget - installment` of that row, as the annuity budget does.
 */
export function generateMethodSchedule(
  input: LoanScheduleInput,
  method: NonAnnuityMethod,
): LoanScheduleResult {
  const terms = input.methodTerms;
  if (!terms) return withheldSchedule();
  const {
    startingBalance,
    annualRate,
    frequency,
    mortgageType = "ANNUITY",
    firstPaymentDate,
    overpayments,
    initialCumulativePrincipal = 0,
    initialCumulativeInterest = 0,
  } = input;

  const maxPayments = resolveMaxPayments(frequency, input.maxPayments);
  const periodsPerYear = getPeriodsPerYear(frequency);
  const rateChanges = [...(input.rateChanges ?? [])].sort((a, b) =>
    a.effectiveDate.localeCompare(b.effectiveDate),
  );

  const budget =
    (overpayments?.targetMonthlyPayment ?? 0) > 0
      ? (overpayments?.targetMonthlyPayment ?? 0)
      : null;
  const budgetMode: OverpaymentMode =
    overpayments?.targetMonthlyPaymentMode ?? terms.prepaymentMode;
  const budgetStart = overpayments?.targetMonthlyPaymentStart;
  const budgetEnd = overpayments?.targetMonthlyPaymentEnd;

  // A budget replaces the recurring extra and the lump sums, as it does for
  // the annuity engine.
  const recurringExtra = budget === null ? overpayments?.recurringExtra : undefined;
  const recurringOccurrences =
    recurringExtra && recurringExtra.amount > 0
      ? recurringOccurrencesDue(recurringExtra, firstPaymentDate)
      : null;
  const lumpSums =
    budget === null
      ? [...(overpayments?.lumpSums ?? [])].sort((a, b) =>
          a.date.localeCompare(b.date),
        )
      : [];

  let currentAnnualRate = annualRate;
  let periodicRate = getPeriodicRate(
    currentAnnualRate,
    periodsPerYear,
    mortgageType,
  );
  let rateChangeIndex = 0;
  let lumpSumIndex = 0;

  // The LINEAR rule in force (see the module doc).
  let rule: OverpaymentMode = terms.prepaymentMode;

  const rows: ScheduleRow[] = [];
  let balance = roundMoney(startingBalance);
  let cumulativePrincipal = initialCumulativePrincipal;
  let cumulativeInterest = initialCumulativeInterest;
  let totalPaid = 0;
  let totalExtraPrincipal = 0;
  let lastInstallment = 0;
  let currentDate = new Date(firstPaymentDate);
  let paymentNumber = 0;

  while (isDebtOutstanding(balance) && paymentNumber < maxPayments) {
    const rowDate = isoDay(currentDate);
    while (
      rateChangeIndex < rateChanges.length &&
      rateChanges[rateChangeIndex].effectiveDate <= rowDate
    ) {
      currentAnnualRate = rateChanges[rateChangeIndex].annualRate;
      periodicRate = getPeriodicRate(
        currentAnnualRate,
        periodsPerYear,
        mortgageType,
      );
      rateChangeIndex++;
    }

    const budgetActive =
      budget !== null &&
      (!budgetStart || budgetStart <= rowDate) &&
      (!budgetEnd || rowDate <= budgetEnd);
    if (budgetActive && method === "LINEAR") rule = budgetMode;
    // SHORTEN_TERM needs `c`; without the amount borrowed there is none, and
    // a principal of 0 would project an interest-only loan nobody has.
    if (
      method === "LINEAR" &&
      rule === "SHORTEN_TERM" &&
      terms.constantPrincipal === null
    ) {
      return withheldSchedule();
    }

    const interest = roundMoney(balance * periodicRate);
    const principal = methodPrincipal({
      method,
      mode: rule,
      debt: balance,
      // Null only where the rule in force does not read it (checked above).
      constantPrincipal: terms.constantPrincipal ?? 0,
      remaining: terms.remainingAtFirstRow - paymentNumber,
      count: terms.scheduledPayments,
    });
    balance = roundMoney(balance - principal);

    let extraPrincipal = 0;
    // The modes of the extra repayments landing on this row.
    const landed: OverpaymentMode[] = [];
    if (budgetActive) {
      extraPrincipal = Math.max(0, roundMoney(budget - principal - interest));
    }
    if (recurringOccurrences && recurringExtra) {
      const occurrences = recurringOccurrences.dueBy(rowDate);
      if (occurrences > 0) {
        extraPrincipal += recurringExtra.amount * occurrences;
        landed.push(recurringExtra.mode ?? terms.prepaymentMode);
      }
    }
    while (
      lumpSumIndex < lumpSums.length &&
      lumpSums[lumpSumIndex].date <= rowDate
    ) {
      extraPrincipal += lumpSums[lumpSumIndex].amount;
      landed.push(lumpSums[lumpSumIndex].mode ?? terms.prepaymentMode);
      lumpSumIndex++;
    }
    extraPrincipal = roundMoney(Math.min(extraPrincipal, balance));
    balance = roundMoney(balance - extraPrincipal);
    // Two modes landing on one row: the lower installment is the one that
    // changes the principal, so it wins, as `effectiveOverpaymentMode` reads a
    // plan.
    if (method === "LINEAR" && landed.length > 0) {
      rule = landed.includes("LOWER_INSTALLMENT")
        ? "LOWER_INSTALLMENT"
        : "SHORTEN_TERM";
    }

    cumulativePrincipal += principal + extraPrincipal;
    cumulativeInterest += interest;
    totalPaid += principal + interest + extraPrincipal;
    totalExtraPrincipal += extraPrincipal;
    lastInstallment = principal + interest;
    paymentNumber++;

    rows.push({
      paymentNumber,
      date: rowDate,
      payment: roundToCents(principal + interest),
      principal: roundToCents(principal),
      interest: roundToCents(interest),
      extraPrincipal: roundToCents(extraPrincipal),
      balance: roundToCents(balance),
      annualRate: roundToDecimals(currentAnnualRate, 4),
      cumulativePrincipal: roundToCents(cumulativePrincipal),
      cumulativeInterest: roundToCents(cumulativeInterest),
    });

    currentDate = advanceDate(currentDate, frequency);
  }

  const paidOff = !isDebtOutstanding(balance);
  return {
    rows,
    payoffDate: paidOff && rows.length > 0 ? rows[rows.length - 1].date : null,
    totalInterest: roundToCents(cumulativeInterest - initialCumulativeInterest),
    totalPaid: roundToCents(totalPaid),
    totalExtraPrincipal: roundToCents(totalExtraPrincipal),
    numPayments: rows.length,
    paidOff,
    // The principal is set independently of the interest (table 4.3), so no
    // row can fall short of it.
    coveredInterest: true,
    // The installment of the last row projected: the method has no level
    // payment, so the end of the schedule is the only installment that is
    // "final". For INTEREST_ONLY a paid-off schedule ends on the bullet.
    finalPaymentAmount: roundToCents(lastInstallment),
    levelInstallment: false,
  };
}
