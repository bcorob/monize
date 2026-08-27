import {
  LoanScheduleInput,
  LoanScheduleResult,
  OverpaymentMode,
  RecurringOverpaymentFrequency,
  generateLoanSchedule,
} from '@/lib/loan-schedule';

/**
 * Goal-seek helpers for the overpayment simulator: given a target (a total
 * interest cost, or a payoff month), find the smallest recurring extra payment
 * that reaches it. Both targets are monotonic in the recurring amount -- more
 * extra per period means less total interest and an earlier payoff -- so a
 * binary search converges reliably.
 *
 * A target is only "met" by a schedule that actually paid off inside the
 * projection horizon: a truncated schedule has accumulated less interest than
 * the loan really costs, so it satisfies any interest target by being
 * incomplete. `meetsInterestTarget` is that predicate, and a baseline that did
 * not pay off yields `baseline-incomplete` rather than a saving measured against
 * a subtotal.
 *
 * The recurring amount is the knob because it is the natural "how much should I
 * overpay every month" answer. The mode is SHORTEN_TERM: paying off sooner (and
 * paying less interest) is only meaningful when the extra shortens the term;
 * LOWER_INSTALLMENT keeps the end date, so it cannot hit a payoff-date target.
 */

/**
 * `baseline-incomplete` is distinct from `unreachable`: it means the
 * no-overpayment schedule itself did not pay off inside the projection horizon,
 * so its lifetime interest is unknown and no interest target derived from it can
 * be honoured -- not that a large enough overpayment could not reach a target.
 */
export type SolveStatus =
  | 'ok'
  | 'already-met'
  | 'unreachable'
  | 'baseline-incomplete';

export interface SolveResult {
  status: SolveStatus;
  /** Required recurring extra per period (rounded up to `step`); null unless ok */
  amount: number | null;
  /** Schedule produced by `amount`; for already-met it is the no-overpayment
   *  baseline, and it is null for unreachable and baseline-incomplete */
  result: LoanScheduleResult | null;
  /** Interest saved vs the no-overpayment baseline by `result`; null whenever
   *  either side's lifetime interest is unknown -- unreachable,
   *  baseline-incomplete, or a payoff-month solve whose baseline never paid off */
  interestSaved: number | null;
}

const MIN_ITERATIONS = 24;

/**
 * Bisection steps: enough to bracket the answer inside one `step`.
 *
 * The search halves `[0, hi0]`, so after N steps the bracket is `hi0 / 2^N`;
 * for a 300k balance and a step of 1 that is under a step by 19. The count
 * matters because the projection horizon is now derived from the frequency, so
 * a weekly loan's schedule is 2600 rows rather than 600, and
 * `OverpaymentSimulator.apply` runs a whole solve synchronously on every
 * keystroke in the goal fields.
 *
 * Bracketing inside a step is NOT enough on its own to make the answer minimal:
 * `roundUpTo(hi, step)` equals `roundUpTo(a*, step)` only when no multiple of
 * `step` sits in `(a*, hi]`, and a non-zero bracket leaves that possible (a
 * 317k balance returned 585 where 584 also reached the target). `minimizeToStep`
 * closes the gap exactly instead of paying for a 1e-13 bracket.
 */
function iterationsFor(upper: number, step: number): number {
  const resolution = step > 0 ? step : 1;
  if (!(upper > resolution)) return MIN_ITERATIONS;
  return Math.max(
    MIN_ITERATIONS,
    Math.min(60, Math.ceil(Math.log2(upper / resolution)) + 4),
  );
}

/**
 * The smallest multiple of `step` at or below `amount` that still meets the
 * goal.
 *
 * Bisection leaves a bracket narrower than one step, but a multiple of `step`
 * can fall inside it, so the rounded-up answer can be one step above the true
 * minimum. Monotonicity bounds this: `lo` (which does not meet the goal) is
 * within the bracket of `hi`, so at most two steps down are possible. The cap is
 * a backstop against a non-monotonic predicate rather than an expected path.
 */
function minimizeToStep(
  amount: number,
  step: number,
  meets: (candidate: number) => boolean,
): number {
  const resolution = step > 0 ? step : 1;
  // Counted in STEPS and multiplied back once, rather than subtracted four
  // times: repeated `-= 0.01` walks off the step's grid, and the answer is
  // persisted as the scenario's overpayment amount.
  let steps = 0;
  let best = amount;
  for (let i = 0; i < 4; i++) {
    const candidate = snapToStep(amount / resolution - (steps + 1), resolution);
    if (candidate <= 0 || !meets(candidate)) break;
    steps++;
    best = candidate;
  }
  return best;
}

/** Optional constraints on the recurring extra being solved. A date range
 *  limits when it applies (so a short window makes tighter targets
 *  unreachable); a frequency sets its cadence, so the solved amount is the
 *  per-cadence amount (e.g. per quarter) rather than per payment. */
export interface SolveWindow {
  startDate?: string;
  endDate?: string;
  frequency?: RecurringOverpaymentFrequency;
}

/**
 * Whether a schedule provably costs no more than `targetInterest` over its life.
 *
 * `paidOff` is half the predicate: a schedule that stopped at the projection
 * horizon has accumulated only the horizon's interest, which is smaller than the
 * lifetime figure and would satisfy any target by being incomplete. An unknown
 * total does not meet a target.
 */
function meetsInterestTarget(
  result: LoanScheduleResult,
  targetInterest: number,
): boolean {
  return result.paidOff && result.totalInterest <= targetInterest;
}

/**
 * One candidate schedule. `lowerEndPeriod` is the no-overpayment payoff length,
 * which a LOWER_INSTALLMENT candidate otherwise derives by generating a whole
 * second schedule of its own -- the same schedule for every candidate, so a
 * bisection paid for it thirty times. Every solver here already has it as its
 * baseline (`scheduleWith(base, 0, mode)` IS that schedule), so it is threaded
 * through rather than recomputed. Omitted for the `amount <= 0` call, which is
 * that baseline.
 */
function scheduleWith(
  base: LoanScheduleInput,
  amount: number,
  mode: OverpaymentMode,
  window: SolveWindow = {},
  lowerEndPeriod?: number,
): LoanScheduleResult {
  if (amount <= 0) {
    return generateLoanSchedule({ ...base, overpayments: undefined });
  }
  return generateLoanSchedule({
    ...base,
    lowerEndPeriod: lowerEndPeriod ?? base.lowerEndPeriod,
    overpayments: { recurringExtra: { amount, mode, ...window } },
  });
}

/** A generous upper bound: a recurring extra this large clears the balance in
 *  roughly one period, so the true answer always lies below it. */
function upperBound(base: LoanScheduleInput): number {
  return Math.max(base.startingBalance, base.paymentAmount * 2, 1);
}

/** Round up to the nearest `step` so the rounded amount still meets the goal
 *  (more overpayment can only help). */
function roundUpTo(amount: number, step: number): number {
  if (step <= 0) return Math.ceil(amount);
  return snapToStep(Math.ceil(amount / step), step);
}

/**
 * `multiple * step`, rounded back onto the step's own decimal grid.
 *
 * `Math.ceil(585 / 0.01) * 0.01` is 585.0000000000001, and `minimizeToStep`
 * subtracts the step a few more times from there -- so a fractional step
 * produced an amount that was not a multiple of it, written onto
 * `RecurringExtra.amount` and persisted. Every caller passes 1 today, which is
 * exactly why this was invisible: the parameter is public and its documented
 * meaning ("rounded up to `step`") has to hold for the fractional values the
 * signature invites.
 *
 * Nine significant decimals is past any money or rate precision this app stores
 * and well inside a double's exact range for these magnitudes.
 */
function snapToStep(multiple: number, step: number): number {
  return Number((multiple * step).toFixed(9));
}

/**
 * Smallest recurring extra whose schedule leaves total interest at or below
 * `targetInterest`.
 * - `already-met`: the loan already costs that little (or less) with no extra.
 * - `unreachable`: even the maximum extra cannot get interest that low (the
 *   target is below the interest of a near-immediate payoff).
 * - `baseline-incomplete`: the loan does not pay off inside the projection
 *   horizon, so what it costs over its life is unknown.
 */
export function solveRecurringForTargetInterest(
  base: LoanScheduleInput,
  targetInterest: number,
  mode: OverpaymentMode = 'SHORTEN_TERM',
  step = 1,
  window: SolveWindow = {},
): SolveResult {
  return solveTargetInterestWithBaseline(
    base,
    scheduleWith(base, 0, mode),
    targetInterest,
    mode,
    step,
    window,
  );
}

/** Core of the target-interest solve, reusing an already-computed baseline so
 *  callers that derive the target from the baseline don't run it twice. */
function solveTargetInterestWithBaseline(
  base: LoanScheduleInput,
  baseline: LoanScheduleResult,
  targetInterest: number,
  mode: OverpaymentMode,
  step: number,
  window: SolveWindow = {},
): SolveResult {
  if (!baseline.paidOff) {
    // The baseline hit the projection horizon, so its lifetime interest is
    // unknown; "already met" and any saving measured against it would both be
    // claims about a subtotal.
    return {
      status: 'baseline-incomplete',
      amount: null,
      result: null,
      interestSaved: null,
    };
  }
  if (baseline.totalInterest <= targetInterest) {
    return { status: 'already-met', amount: 0, result: baseline, interestSaved: 0 };
  }
  const hi0 = upperBound(base);
  if (
    !meetsInterestTarget(
      scheduleWith(base, hi0, mode, window, baseline.numPayments),
      targetInterest,
    )
  ) {
    return { status: 'unreachable', amount: null, result: null, interestSaved: null };
  }
  let lo = 0;
  let hi = hi0;
  const iterations = iterationsFor(hi0, step);
  for (let i = 0; i < iterations; i++) {
    const mid = (lo + hi) / 2;
    if (
      meetsInterestTarget(
        scheduleWith(base, mid, mode, window, baseline.numPayments),
        targetInterest,
      )
    )
      hi = mid;
    else lo = mid;
  }
  const amount = minimizeToStep(roundUpTo(hi, step), step, (candidate) =>
    meetsInterestTarget(
      scheduleWith(base, candidate, mode, window, baseline.numPayments),
      targetInterest,
    ),
  );
  const result = scheduleWith(base, amount, mode, window, baseline.numPayments);
  return {
    status: 'ok',
    amount,
    result,
    interestSaved: round2(baseline.totalInterest - result.totalInterest),
  };
}

/**
 * Smallest recurring extra that saves at least `targetSavings` of interest vs
 * the no-overpayment baseline. This is the user-facing framing (the comparison
 * cards and the scenario chart both speak in "interest saved"), implemented as
 * a target-interest solve at `baseline - targetSavings`.
 * - `already-met`: the target is zero or negative, so no extra is needed.
 * - `unreachable`: even the maximum extra cannot save that much (the savings
 *   asked for exceed what a near-immediate payoff would save).
 * - `baseline-incomplete`: the baseline never pays off, so there is no lifetime
 *   interest to save against.
 */
export function solveRecurringForInterestSavings(
  base: LoanScheduleInput,
  targetSavings: number,
  mode: OverpaymentMode = 'SHORTEN_TERM',
  step = 1,
  window: SolveWindow = {},
): SolveResult {
  const baseline = scheduleWith(base, 0, mode);
  return solveTargetInterestWithBaseline(
    base,
    baseline,
    baseline.totalInterest - targetSavings,
    mode,
    step,
    window,
  );
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Smallest recurring extra whose schedule pays the loan off no later than
 * `targetMonth` (comparison is at month granularity, so a payoff anywhere
 * within the target month counts).
 * - `already-met`: the loan already pays off by then with no extra.
 * - `unreachable`: the target month is earlier than the soonest possible payoff.
 */
export function solveRecurringForPayoffMonth(
  base: LoanScheduleInput,
  targetDate: string,
  mode: OverpaymentMode = 'SHORTEN_TERM',
  step = 1,
  window: SolveWindow = {},
): SolveResult {
  const targetMonth = targetDate.slice(0, 7);
  const paysOffBy = (r: LoanScheduleResult): boolean =>
    r.payoffDate != null && r.payoffDate.slice(0, 7) <= targetMonth;

  const baseline = scheduleWith(base, 0, mode);
  if (paysOffBy(baseline)) {
    return { status: 'already-met', amount: 0, result: baseline, interestSaved: 0 };
  }
  const hi0 = upperBound(base);
  if (!paysOffBy(scheduleWith(base, hi0, mode, window, baseline.numPayments))) {
    return { status: 'unreachable', amount: null, result: null, interestSaved: null };
  }
  let lo = 0;
  let hi = hi0;
  const iterations = iterationsFor(hi0, step);
  for (let i = 0; i < iterations; i++) {
    const mid = (lo + hi) / 2;
    if (paysOffBy(scheduleWith(base, mid, mode, window, baseline.numPayments))) hi = mid;
    else lo = mid;
  }
  const amount = minimizeToStep(roundUpTo(hi, step), step, (candidate) =>
    paysOffBy(scheduleWith(base, candidate, mode, window, baseline.numPayments)),
  );
  const result = scheduleWith(base, amount, mode, window, baseline.numPayments);
  return {
    status: 'ok',
    amount,
    result,
    // The date target is met either way, but the saving is only a number when
    // the baseline paid off too -- otherwise it is a horizon minus a lifetime.
    interestSaved: baseline.paidOff
      ? round2(baseline.totalInterest - result.totalInterest)
      : null,
  };
}
