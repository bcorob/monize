/**
 * The shapes a loan schedule is described by, and the two roundings applied to
 * them.
 *
 * At the bottom of this module graph on purpose: `loan-schedule.ts` and
 * `loan-comparison.ts` both need these, and a type module neither of them
 * imports back is what keeps the split acyclic. `loan-schedule.ts` re-exports
 * everything here, because every consumer has always imported from there.
 */

import type { ScheduleFrequency } from '@/lib/loan-frequency';
import type { OverpaymentPlan } from '@/lib/loan-overpayments';

/** A step on the loan's interest-rate timeline, applied during generation */
export interface RateChange {
  /** ISO date (yyyy-MM-dd) the new rate takes effect */
  effectiveDate: string;
  /** Annual rate as a percentage, e.g. 4.9 */
  annualRate: number;
  /** New regular payment from this date; omitted/null = payment unchanged */
  paymentAmount?: number | null;
}

/** A persisted rate-history row, as returned by the rate-changes API */
export interface RateTimelineRow {
  effectiveDate: string;
  annualRate: number;
  newPaymentAmount?: number | null;
  /**
   * How the row was created. Load-bearing for the payment, not the rate.
   *
   * `manual` (typed by the user) and `inferred` (the modal observed payment from
   * detection, and deliberately null when interest is booked separately) STATE
   * the payment: they are answers to "what is being paid".
   *
   * Optional only because callers build `RateTimelineRow`s by hand (fixtures,
   * and `loan-past-impact`'s contractual timeline); the API's `LoanRateChange`
   * declares it required, so a row that came from the server always has one.
   * Absent is read as "states the payment", which is what every caller meant
   * before this field existed -- the demotion applies to a row that says
   * `initial`, never to one that says nothing.
   *
   * `initial` is written by two things and means different things in each, with
   * no way to tell them apart from the row: `insertInitialRowIfFirst` copies
   * `account.paymentAmount` verbatim (a snapshot of a field the user may since
   * have corrected), while detection's first segment carries a real observed
   * payment. So it is neither authoritative nor worthless -- it comes back as
   * `snapshotPaymentAmount`, a candidate its caller tests before using
   * (`resolveEffectiveLoanTerms` in `loan-comparison.ts`).
   */
  source?: 'manual' | 'inferred' | 'initial';
}

export interface RateTimeline {
  /** Rate in effect at the schedule start */
  startingAnnualRate: number;
  /** Payment in effect at the schedule start, when the timeline knows it */
  startingPaymentAmount: number | null;
  /** Steps dated after the schedule start, ready for generateLoanSchedule */
  rateChanges: RateChange[];
}

export interface LoanScheduleInput {
  /** Positive remaining balance to amortize */
  startingBalance: number;
  /** Annual rate as a percentage, e.g. 5.5 */
  annualRate: number;
  /** Regular contractual payment per period */
  paymentAmount: number;
  frequency: ScheduleFrequency;
  /** Canadian fixed-rate mortgages compound semi-annually */
  isCanadian?: boolean;
  isVariableRate?: boolean;
  /** Date of the first projected payment (row 1) */
  firstPaymentDate: Date;
  overpayments?: OverpaymentPlan;
  /** Known rate steps; each applies from the first payment on/after its date */
  rateChanges?: RateChange[];
  /**
   * Maximum projected payments. Defaults to `DEFAULT_MAX_PROJECTION_YEARS`
   * worth of this frequency's payments (`maxPaymentsForHorizon`), clamped to
   * `HARD_MAX_PAYMENTS`.
   */
  maxPayments?: number;
  /**
   * Amortize to zero over exactly this many payments, re-levelling the payment
   * each period (so it also adjusts on every rate change). Models a
   * variable-rate loan that holds its term by adjusting the installment when
   * the rate moves, so a fixed payment can neither stall nor stretch the
   * schedule. Superseded by the LOWER_INSTALLMENT overpayment mode, which
   * derives its own fixed end from the baseline.
   */
  fixedEndPeriod?: number;
  /**
   * Term (in periods) to re-level the installment toward ONLY when a rate rise
   * would push the current payment below the period's interest (a stall).
   * Unlike `fixedEndPeriod` it does not re-level every period, so a schedule can
   * follow its real recorded payment amounts and still be rescued from a stall
   * instead of stopping. Superseded by `fixedEndPeriod` (which already rescues).
   */
  rescueEndPeriod?: number;
  /**
   * The no-overpayment payoff length, when the caller has already computed it.
   *
   * A LOWER_INSTALLMENT overpayment re-levels the installment toward the term
   * the loan would have run WITHOUT any overpayment, so the engine derives that
   * term by generating a whole second schedule with `overpayments: undefined`.
   * Inside a goal-seek that is the same schedule thirty times over -- the solver
   * already computes it once as its own baseline, and every candidate differs
   * only in the overpayment. Supplying it here skips the recursion; the value
   * MUST be `generateLoanSchedule({ ...input, overpayments: undefined })
   * .numPayments` for this exact input, or the installment is re-levelled toward
   * a term the loan does not have.
   *
   * Ignored when `fixedEndPeriod` is set, which supersedes it, and when the plan
   * carries no LOWER_INSTALLMENT overpayment, which needs no such term.
   */
  lowerEndPeriod?: number;
  /** Seed for cumulative principal (e.g. historical principal already paid) */
  initialCumulativePrincipal?: number;
  /** Seed for cumulative interest (e.g. historical interest already paid) */
  initialCumulativeInterest?: number;
}

export interface ScheduleRow {
  paymentNumber: number;
  /** ISO date (yyyy-MM-dd) */
  date: string;
  /** Regular payment applied this period (principal + interest) */
  payment: number;
  /** Principal portion of the regular payment */
  principal: number;
  interest: number;
  /** Recurring extra + lump sums applied this period */
  extraPrincipal: number;
  /** Balance after this payment */
  balance: number;
  /** Annual rate (percentage) in effect for this payment */
  annualRate: number;
  /** Running principal incl. extra, seeded by initialCumulativePrincipal */
  cumulativePrincipal: number;
  /** Running interest, seeded by initialCumulativeInterest */
  cumulativeInterest: number;
}

export interface LoanScheduleResult {
  rows: ScheduleRow[];
  /** Date of the final payment, or null when not paid off within maxPayments */
  payoffDate: string | null;
  /**
   * Interest over the rows actually projected. This is the loan's **lifetime**
   * interest only when `paidOff` is true; when the schedule stopped at the
   * projection horizon it is the interest over that horizon -- a subtotal, per
   * `docs/financial-calculation-contract.md` section 1. Every consumer that
   * presents a lifetime figure, or a saving derived from one, must gate on
   * `paidOff` first. Which consumers do is recorded, with an honest status, in
   * INV-LOAN-002 -- not counted here, where the number would rot.
   */
  totalInterest: number;
  /** Regular payments + extra principal contributed across the schedule */
  totalPaid: number;
  totalExtraPrincipal: number;
  numPayments: number;
  paidOff: boolean;
  /**
   * The regular installment in effect at the end of the schedule. Equal to the
   * contractual payment for SHORTEN_TERM; the recomputed lower payment for
   * LOWER_INSTALLMENT (PL *obniżenie raty*).
   *
   * "The end of the schedule" is the last row projected, which is the last
   * PAYMENT only when `paidOff` is true. On a schedule truncated by the horizon
   * this is a mid-schedule installment, so anything presenting it as final --
   * `compareSchedules().installmentReduction` is the one that does -- gates on
   * `paidOff` first.
   */
  finalPaymentAmount: number;
}

export interface ScenarioComparison {
  baseline: LoanScheduleResult;
  scenario: LoanScheduleResult;
  /**
   * Payments the scenario saves against the baseline, or `null` when either
   * schedule stopped at the projection horizon instead of paying off -- a
   * horizon's row count minus a lifetime's is not a number of payments saved.
   */
  paymentsSaved: number | null;
  /**
   * Months the scenario saves, or `null` on the same condition. A truncated
   * schedule has no payoff date, and "0 months" is a claim that the overpayment
   * bought no time rather than that the answer is unknown.
   */
  monthsSaved: number | null;
  /**
   * Interest the scenario saves against the baseline, or `null` when either
   * schedule stopped at the projection horizon instead of paying off. The
   * difference of two horizons is not a saving, and presenting one as though it
   * were is how a truncated baseline contaminated every scenario's headline.
   */
  interestSaved: number | null;
  /**
   * How much lower the scenario's ending installment is than the baseline's.
   * Zero for SHORTEN_TERM (the installment is unchanged); positive for
   * LOWER_INSTALLMENT (PL *obniżenie raty*); `null` when either schedule stopped
   * at the projection horizon.
   *
   * A truncated schedule has no ending installment: `finalPaymentAmount` is
   * whatever the re-levelled payment happened to be at the horizon's last row,
   * mid-schedule. Reporting a drop from it put "New Installment: X (-Y)" beside
   * "Unknown" for time and interest saved on the same card row.
   */
  installmentReduction: number | null;
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Storage precision (decimal(20,4)), matching backend roundMoney */
export function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}
