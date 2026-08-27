/**
 * Shared loan/mortgage schedule engine.
 *
 * Single source of the period-projection math that was previously duplicated
 * inline in LoanAmortizationReport and DebtPayoffTimelineReport, extended with
 * overpayment support (recurring extra amounts and one-off lump sums) for the
 * loan detail view's simulator.
 *
 * The rate math mirrors backend/src/accounts/mortgage-amortization.util.ts
 * (including Canadian fixed-rate semi-annual compounding); parity is pinned by
 * fixtures in loan-schedule.test.ts. Backend/frontend agreement is drift
 * detection, not evidence for the convention itself -- that is named in
 * docs/financial-semantics.md section 9 and held by independently derived
 * fixtures on both sides. When no overpayments are supplied the loop reproduces
 * the reports' historical projection behaviour exactly: unrounded internal
 * accumulation, per-row values rounded to 2 decimals.
 */

/**
 * The schedule engine. Cadences live in `loan-frequency.ts` and overpayment
 * plans in `loan-overpayments.ts`; both are re-exported here because every
 * consumer has always imported from this module, and splitting a file is not a
 * reason to touch fifty call sites.
 */
export * from "@/lib/loan-frequency";
export * from "@/lib/loan-overpayments";
export * from "@/lib/loan-schedule-types";
export * from "@/lib/loan-comparison";

import {
  ScheduleFrequency,
  advanceDate,
  getPeriodicRate,
  getPeriodsPerYear,
  isoDay,
  PAYOFF_EPSILON,
  resolveMaxPayments,
} from "@/lib/loan-frequency";
import {
  OverpaymentMode,
  recurringOccurrencesDue,
} from "@/lib/loan-overpayments";
import {
  LoanScheduleInput,
  LoanScheduleResult,
  ScheduleRow,
  round2,
  round4,
} from "@/lib/loan-schedule-types";

/**
 * Contractual payment for a mortgage amortized over a given period.
 * Port of backend calculateMortgagePayment: accelerated frequencies pay
 * half (bi-weekly) or a quarter (weekly) of the monthly payment; other
 * frequencies solve the standard PMT formula at their own period count.
 */
export function calculateMortgagePaymentAmount(
  principal: number,
  annualRate: number,
  amortizationMonths: number,
  frequency: ScheduleFrequency,
  isCanadian: boolean,
  isVariableRate: boolean,
): number {
  if (principal <= 0 || amortizationMonths <= 0) return 0;

  if (
    frequency === "ACCELERATED_BIWEEKLY" ||
    frequency === "ACCELERATED_WEEKLY"
  ) {
    const monthlyRate = getPeriodicRate(
      annualRate,
      12,
      isCanadian,
      isVariableRate,
    );
    // Accelerated payments derive from the monthly payment, rounded to
    // storage precision first as the backend does
    const monthlyPayment = round4(
      solvePayment(principal, monthlyRate, amortizationMonths),
    );
    const divisor = frequency === "ACCELERATED_BIWEEKLY" ? 2 : 4;
    return round4(monthlyPayment / divisor);
  }

  const periodsPerYear = getPeriodsPerYear(frequency);
  const totalPayments = Math.round((amortizationMonths * periodsPerYear) / 12);
  const periodicRate = getPeriodicRate(
    annualRate,
    periodsPerYear,
    isCanadian,
    isVariableRate,
  );
  return round4(solvePayment(principal, periodicRate, totalPayments));
}

/**
 * Installment that amortizes `balance` over exactly `periods` payments at the
 * given rate -- the annuity `A = B*r / (1 - (1 + r)^(-n))`. This is the payment
 * a bank recomputes for the *obniżenie raty* (lower-installment) overpayment
 * mode, keeping the end date fixed. A 0% rate splits the balance evenly.
 */
export function calculatePaymentForTerm(
  balance: number,
  annualRate: number,
  periods: number,
  frequency: ScheduleFrequency,
  isCanadian = false,
  isVariableRate = false,
): number {
  if (balance <= 0 || periods <= 0) return 0;
  const periodicRate = getPeriodicRate(
    annualRate,
    getPeriodsPerYear(frequency),
    isCanadian,
    isVariableRate,
  );
  if (periodicRate === 0) return round4(balance / periods);
  return round4(
    (balance * periodicRate) / (1 - Math.pow(1 + periodicRate, -periods)),
  );
}

/** Standard amortization payment: PMT = P * [r(1+r)^n] / [(1+r)^n - 1] */
function solvePayment(
  principal: number,
  periodicRate: number,
  totalPayments: number,
): number {
  if (totalPayments <= 0) return 0;
  if (periodicRate === 0) {
    return principal / totalPayments;
  }
  const growth = Math.pow(1 + periodicRate, totalPayments);
  return (principal * (periodicRate * growth)) / (growth - 1);
}

/**
 * Fixed-total-payment ("monthly budget") schedule. Every period the whole
 * `budget` goes to the loan: the installment is recomputed over the remaining
 * contractual term (the lower-installment behaviour), and the rest of the budget
 * is overpaid. As the balance falls the installment shrinks, so the overpayment
 * grows and the total stays constant -- exactly the borrower's "I spend X per
 * month on the loan" plan. The row's `payment` is the recomputed installment and
 * `extraPrincipal` is that period's overpayment, so installment + overpayment =
 * budget. Rate steps are honoured; the loan pays off when the balance clears.
 */
export function generateBudgetSchedule(
  input: LoanScheduleInput,
  budget: number,
  mode: OverpaymentMode = "LOWER_INSTALLMENT",
  window: { startDate?: string; endDate?: string } = {},
): LoanScheduleResult {
  const {
    startingBalance,
    annualRate,
    paymentAmount,
    frequency,
    isCanadian = false,
    isVariableRate = false,
    firstPaymentDate,
    maxPayments,
    initialCumulativePrincipal = 0,
    initialCumulativeInterest = 0,
  } = input;

  const periodsPerYear = getPeriodsPerYear(frequency);
  const cap = resolveMaxPayments(frequency, maxPayments);

  // LOWER_INSTALLMENT re-amortizes the installment over the remaining
  // contractual term (it steps down as the balance falls); SHORTEN_TERM keeps
  // the contractual installment fixed and the overpayment constant. Either way
  // the total paid is the budget, so the balance/payoff are identical.
  const lowerInstallment = mode === "LOWER_INSTALLMENT";
  // The same quantity `lowerEnd` is in the ordinary generator, and obtained the
  // same way: a caller that already has the no-overpayment term supplies it
  // (`lowerEndPeriod`) rather than paying for a second full schedule per
  // candidate. Deriving it by two routes is how the two entry points drifted
  // before -- one of them would keep the recursion after a change to the other.
  const contractualPeriods = lowerInstallment
    ? Math.max(
        1,
        input.lowerEndPeriod ??
          generateLoanSchedule({ ...input, overpayments: undefined })
            .numPayments,
      )
    : 0;

  const rateChanges = [...(input.rateChanges ?? [])].sort((a, b) =>
    a.effectiveDate.localeCompare(b.effectiveDate),
  );

  let balance = startingBalance;
  let cumulativePrincipal = initialCumulativePrincipal;
  let cumulativeInterest = initialCumulativeInterest;
  let totalPaid = 0;
  let totalExtraPrincipal = 0;
  let coveredInterest = true;
  let currentAnnualRate = annualRate;
  let currentPeriodicRate = getPeriodicRate(
    currentAnnualRate,
    periodsPerYear,
    isCanadian,
    isVariableRate,
  );
  let rateChangeIndex = 0;
  let lastInstallment = 0;

  const rows: ScheduleRow[] = [];
  let currentDate = new Date(firstPaymentDate);
  let paymentNumber = 0;

  while (balance > PAYOFF_EPSILON && paymentNumber < cap) {
    const rowDate = isoDay(currentDate);
    while (
      rateChangeIndex < rateChanges.length &&
      rateChanges[rateChangeIndex].effectiveDate <= rowDate
    ) {
      currentAnnualRate = rateChanges[rateChangeIndex].annualRate;
      currentPeriodicRate = getPeriodicRate(
        currentAnnualRate,
        periodsPerYear,
        isCanadian,
        isVariableRate,
      );
      rateChangeIndex++;
    }

    const interest = balance * currentPeriodicRate;

    // The installment for the split: re-amortized over the remaining
    // contractual term (LOWER_INSTALLMENT) or the fixed contractual installment
    // (SHORTEN_TERM). The overpayment is whatever is left of the budget.
    const installment = lowerInstallment
      ? calculatePaymentForTerm(
          balance,
          currentAnnualRate,
          Math.max(1, contractualPeriods - paymentNumber),
          frequency,
          isCanadian,
          isVariableRate,
        )
      : paymentAmount;

    // The budget only tops up within its window; outside it (before the start
    // or after the end) the loan pays just the regular installment.
    const budgetActive =
      (!window.startDate || window.startDate <= rowDate) &&
      (!window.endDate || rowDate <= window.endDate);
    // Total cash this period: the budget while active, else the installment --
    // capped at the payoff amount on the final period.
    const totalDue = balance + interest;
    const payment = Math.min(budgetActive ? budget : installment, totalDue);
    // A payment that can't cover the interest never amortizes.
    if (payment <= interest) {
      coveredInterest = false;
      break;
    }
    // The installment can't exceed the total actually paid this period. When
    // the installment is below the period's interest (e.g. a sharp rate rise on
    // a fixed installment), it covers no principal -- interest is settled first
    // from the total, and only what's left over is principal overpayment, so
    // unpaid interest is never miscounted as principal.
    const regularInstallment = Math.min(installment, payment);
    const regularPrincipal = Math.max(0, regularInstallment - interest);
    const overpayment = Math.max(0, payment - interest - regularPrincipal);

    balance = Math.max(0, balance - (regularPrincipal + overpayment));
    cumulativePrincipal += regularPrincipal + overpayment;
    cumulativeInterest += interest;
    totalPaid += payment;
    totalExtraPrincipal += overpayment;
    // Track the level installment (contractual for SHORTEN_TERM, re-amortized
    // for LOWER_INSTALLMENT) rather than the payoff-capped split, so
    // finalPaymentAmount matches the normal loop's semantics and the
    // comparison table never reports the residual catch-up as "the payment".
    lastInstallment = installment;
    paymentNumber++;

    rows.push({
      paymentNumber,
      date: rowDate,
      payment: round2(regularPrincipal + interest),
      principal: round2(regularPrincipal),
      interest: round2(interest),
      extraPrincipal: round2(overpayment),
      balance: round2(balance),
      annualRate: round4(currentAnnualRate),
      cumulativePrincipal: round2(cumulativePrincipal),
      cumulativeInterest: round2(cumulativeInterest),
    });

    currentDate = advanceDate(currentDate, frequency);
  }

  const paidOff = coveredInterest && balance <= PAYOFF_EPSILON;
  return {
    rows,
    payoffDate: paidOff && rows.length > 0 ? rows[rows.length - 1].date : null,
    totalInterest: round2(cumulativeInterest - initialCumulativeInterest),
    totalPaid: round2(totalPaid),
    totalExtraPrincipal: round2(totalExtraPrincipal),
    numPayments: rows.length,
    paidOff,
    finalPaymentAmount: round2(lastInstallment),
  };
}

/**
 * Generate a period-by-period schedule. With no overpayments this reproduces
 * the reports' projection loop exactly; with a plan, extra principal is
 * applied after the regular payment each period (capped at the remaining
 * balance), shortening the schedule.
 */
export function generateLoanSchedule(
  input: LoanScheduleInput,
): LoanScheduleResult {
  const budget = input.overpayments?.targetMonthlyPayment;
  if (budget && budget > 0) {
    return generateBudgetSchedule(
      input,
      budget,
      input.overpayments?.targetMonthlyPaymentMode ?? "LOWER_INSTALLMENT",
      {
        startDate: input.overpayments?.targetMonthlyPaymentStart,
        endDate: input.overpayments?.targetMonthlyPaymentEnd,
      },
    );
  }
  const {
    startingBalance,
    annualRate,
    paymentAmount,
    frequency,
    isCanadian = false,
    isVariableRate = false,
    firstPaymentDate,
    overpayments,
    initialCumulativePrincipal = 0,
    initialCumulativeInterest = 0,
  } = input;

  const maxPayments = resolveMaxPayments(frequency, input.maxPayments);

  // Each overpayment carries its own mode; SHORTEN_TERM is the default for
  // those that omit one.
  const modeOf = (m?: OverpaymentMode): OverpaymentMode => m ?? "SHORTEN_TERM";
  const hasOverpayments = Boolean(
    overpayments?.recurringExtra || (overpayments?.lumpSums?.length ?? 0) > 0,
  );
  const anyLowerOverpayment =
    hasOverpayments &&
    ((overpayments?.recurringExtra != null &&
      modeOf(overpayments.recurringExtra.mode) === "LOWER_INSTALLMENT") ||
      (overpayments?.lumpSums ?? []).some(
        (l) => modeOf(l.mode) === "LOWER_INSTALLMENT",
      ));

  // Two re-levelling ends. `reLevelEveryPeriod` (a passed fixedEndPeriod) holds
  // a variable-rate contractual schedule on its term every period. `lowerEnd`
  // is the no-overpayment payoff length that a LOWER_INSTALLMENT overpayment
  // re-levels the installment toward -- applied only in the period such an
  // overpayment lands, so SHORTEN_TERM overpayments keep the installment (and
  // shorten the term) alongside it.
  const reLevelEveryPeriod = input.fixedEndPeriod ?? null;
  const lowerEnd =
    reLevelEveryPeriod === null && anyLowerOverpayment
      ? (input.lowerEndPeriod ??
        generateLoanSchedule({ ...input, overpayments: undefined }).numPayments)
      : null;
  // Term to re-level toward if a rate rise would otherwise stall the payment.
  // An explicit `rescueEndPeriod` supplies this rescue without the every-period
  // re-levelling of `fixedEndPeriod`, so a contractual schedule keeps following
  // its real recorded payments and only re-levels to avoid a stall.
  const rescueEnd = reLevelEveryPeriod ?? input.rescueEndPeriod ?? lowerEnd;

  const periodsPerYear = getPeriodsPerYear(frequency);

  const rateChanges = [...(input.rateChanges ?? [])].sort((a, b) =>
    a.effectiveDate.localeCompare(b.effectiveDate),
  );
  let currentAnnualRate = annualRate;
  let currentPayment = paymentAmount;
  let currentPeriodicRate = getPeriodicRate(
    currentAnnualRate,
    periodsPerYear,
    isCanadian,
    isVariableRate,
  );
  let rateChangeIndex = 0;

  const recurringExtra = overpayments?.recurringExtra;
  // The recurring extra lands on dated calendar occurrences, each applied at the
  // first loan payment on or after its due date -- so the nominal annual cash is
  // exact for every combination of cadence and loan frequency. See
  // recurringOccurrencesDue.
  const recurringOccurrences =
    recurringExtra && recurringExtra.amount > 0
      ? recurringOccurrencesDue(recurringExtra, firstPaymentDate)
      : null;
  const lumpSums = [...(overpayments?.lumpSums ?? [])].sort((a, b) =>
    a.date.localeCompare(b.date),
  );

  const rows: ScheduleRow[] = [];
  // Unrounded internal accumulation, matching the reports' float behaviour so
  // the refactor is numerically identical; rows are rounded on emission only.
  let balance = startingBalance;
  let cumulativePrincipal = initialCumulativePrincipal;
  let cumulativeInterest = initialCumulativeInterest;
  let totalPaid = 0;
  let totalExtraPrincipal = 0;
  let coveredInterest = true;

  let currentDate = new Date(firstPaymentDate);
  let lumpSumIndex = 0;
  let paymentNumber = 0;

  while (balance > PAYOFF_EPSILON && paymentNumber < maxPayments) {
    const rowDate = isoDay(currentDate);

    // Rate steps land on the first payment on or after their effective date
    // (steps dated before the first payment apply to row 1)
    while (
      rateChangeIndex < rateChanges.length &&
      rateChanges[rateChangeIndex].effectiveDate <= rowDate
    ) {
      const change = rateChanges[rateChangeIndex];
      currentAnnualRate = change.annualRate;
      currentPeriodicRate = getPeriodicRate(
        currentAnnualRate,
        periodsPerYear,
        isCanadian,
        isVariableRate,
      );
      if (change.paymentAmount != null && change.paymentAmount > 0) {
        currentPayment = change.paymentAmount;
      }
      rateChangeIndex++;
    }

    const interest = balance * currentPeriodicRate;
    let principal = currentPayment - interest;

    if (principal <= 0 && rescueEnd !== null) {
      // Holding a fixed term: a rate rise can push the current installment
      // below the interest for a period. Re-level it now, at the new rate, to
      // amortize the remaining balance over the periods left -- so the schedule
      // adjusts on the rate change instead of stalling.
      const remaining = rescueEnd - paymentNumber;
      if (remaining > 0) {
        currentPayment = calculatePaymentForTerm(
          balance,
          currentAnnualRate,
          remaining,
          frequency,
          isCanadian,
          isVariableRate,
        );
        principal = currentPayment - interest;
      }
    }

    if (principal <= 0) {
      // Payment doesn't cover interest: the loan never amortizes
      coveredInterest = false;
      break;
    }
    if (principal > balance) {
      principal = balance;
    }
    balance = Math.max(0, balance - principal);

    let extraPrincipal = 0;
    // Whether a LOWER_INSTALLMENT-mode overpayment landed this period, so the
    // installment is re-levelled below (SHORTEN_TERM ones leave it unchanged).
    let lowerApplied = false;
    if (recurringOccurrences && recurringExtra) {
      // Every occurrence whose due date has arrived is paid in full, so a
      // cadence denser than the loan's payments contributes several at once and
      // a sparser one contributes none on most payments.
      const occurrences = recurringOccurrences.dueBy(rowDate);
      if (occurrences > 0) {
        extraPrincipal += recurringExtra.amount * occurrences;
        if (modeOf(recurringExtra.mode) === "LOWER_INSTALLMENT")
          lowerApplied = true;
      }
    }
    // Lump sums land on the first payment on or after their date (sums dated
    // before the first payment attach to row 1)
    while (
      lumpSumIndex < lumpSums.length &&
      lumpSums[lumpSumIndex].date <= rowDate
    ) {
      extraPrincipal += lumpSums[lumpSumIndex].amount;
      if (modeOf(lumpSums[lumpSumIndex].mode) === "LOWER_INSTALLMENT")
        lowerApplied = true;
      lumpSumIndex++;
    }
    if (extraPrincipal > balance) {
      extraPrincipal = balance;
    }
    balance = Math.max(0, balance - extraPrincipal);

    cumulativePrincipal += principal + extraPrincipal;
    cumulativeInterest += interest;
    totalPaid += principal + interest + extraPrincipal;
    totalExtraPrincipal += extraPrincipal;
    paymentNumber++;

    // Re-level the installment to amortize the remaining balance over the
    // periods left to the target end. `reLevelEveryPeriod` (contractual
    // variable-rate schedule) re-levels every period, so it also tracks rate
    // changes; a LOWER_INSTALLMENT overpayment re-levels toward `lowerEnd`
    // only in the period it lands, stepping the payment down while
    // SHORTEN_TERM overpayments leave it unchanged (shortening the term).
    const reLevelEnd =
      reLevelEveryPeriod !== null
        ? reLevelEveryPeriod
        : lowerApplied
          ? lowerEnd
          : null;
    if (reLevelEnd !== null) {
      const remaining = reLevelEnd - paymentNumber;
      if (remaining > 0 && balance > PAYOFF_EPSILON) {
        currentPayment = calculatePaymentForTerm(
          balance,
          currentAnnualRate,
          remaining,
          frequency,
          isCanadian,
          isVariableRate,
        );
      }
    }

    rows.push({
      paymentNumber,
      date: rowDate,
      payment: round2(principal + interest),
      principal: round2(principal),
      interest: round2(interest),
      extraPrincipal: round2(extraPrincipal),
      balance: round2(balance),
      annualRate: round4(currentAnnualRate),
      cumulativePrincipal: round2(cumulativePrincipal),
      cumulativeInterest: round2(cumulativeInterest),
    });

    currentDate = advanceDate(currentDate, frequency);
  }

  const paidOff = coveredInterest && balance <= PAYOFF_EPSILON;

  return {
    rows,
    payoffDate: paidOff && rows.length > 0 ? rows[rows.length - 1].date : null,
    totalInterest: round2(cumulativeInterest - initialCumulativeInterest),
    totalPaid: round2(totalPaid),
    totalExtraPrincipal: round2(totalExtraPrincipal),
    numPayments: rows.length,
    paidOff,
    finalPaymentAmount: round2(currentPayment),
  };
}

