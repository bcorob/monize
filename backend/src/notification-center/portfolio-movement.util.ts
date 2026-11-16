/**
 * The pure decision behind the daily portfolio-movement notification
 * (`docs/specs/portfolio-movement-notifications.md`): given today's portfolio
 * value, the stored baseline, the day's external cash flow and the user's
 * threshold, decide whether to fire and what the new baseline is.
 *
 * Kept free of the database and the cron so the arithmetic and the
 * completeness/withhold policy (INV-PORTMOVE-001..006) are unit-testable in
 * isolation. The producer supplies the inputs and applies the result.
 */
import { roundMoney } from "../common/round.util";

/** A percentage is a ratio, not money -- never round it with `roundMoney` (4dp). */
export const PORTFOLIO_MOVE_PERCENT_DECIMALS = 2;

export interface MovementInputs {
  /** `getPortfolioSummary(...).valuationComplete` for today's run. */
  mvComplete: boolean;
  /** Today's portfolio value (holdings + cash) in the reporting currency. */
  mvToday: number;
  /**
   * The late closes since the baseline (INV-PORTMOVE-008): a position valued at
   * the baseline on a close older than the tolerance, whose new close has since
   * arrived. `value` is what they add to the baseline -- the baseline restated at
   * the closes that arrived -- so the catch-up is not booked as this period's
   * market move. `complete: false` means a late close could not be valued in the
   * reporting currency. The producer passes `{ complete: true, value: 0 }` when
   * there is no baseline to restate.
   */
  latePrice: { complete: boolean; value: number };
  /** The reporting currency today's value is in. */
  currency: string;
  /** The stored baseline, or null when none has been captured. */
  baseline: { value: number; currency: string } | null;
  /**
   * Whether the stored baseline carries the date it was captured on.
   *
   * A baseline without one names no period: there is nothing to measure the
   * day's external flow over (INV-PORTMOVE-007), nothing for a held position's
   * close to be stale against (INV-PORTMOVE-008) and no opening date to put in
   * front of the reader. Such a baseline is replaced, not compared.
   */
  baselineDateKnown: boolean;
  /**
   * Whether the stored baseline carries the per-security closes it was valued
   * at. Without them a late close cannot be told from a market move, so such a
   * baseline (one written before the snapshot existed) is replaced, not
   * compared.
   */
  baselinePositionsKnown: boolean;
  /** The day's external cash flow into the investment accounts. */
  flow: { complete: boolean; value: number };
  /** The user's threshold in percent; <= 0 or null means the alert is off. */
  movePercent: number | null;
}

export interface FiredMovement {
  /** The movement as a percentage of the baseline, rounded for display. */
  changePercent: number;
  /** `"up"` for a gain, `"down"` for a loss. */
  direction: "up" | "down";
  /** The movement in the reporting currency (mvToday - baseline - flow). */
  movementValue: number;
  /**
   * The three components the movement is the difference of, carried so a reader
   * can reproduce the figure rather than take it on trust: the value the period
   * opened at, the value it closed at, and the external cash removed from the
   * difference. All in the reporting currency, at money precision.
   */
  baselineValue: number;
  currentValue: number;
  externalFlow: number;
  /**
   * What late closes added to the baseline (INV-PORTMOVE-008), removed from the
   * movement: `movementValue = currentValue - baselineValue - latePriceAdjustment
   * - externalFlow`, and the percentage is over `baselineValue +
   * latePriceAdjustment`, the baseline restated at the closes that arrived.
   */
  latePriceAdjustment: number;
}

export interface MovementDecision {
  /** The alert to raise, or null (silent, withheld, or nothing to compare). */
  fire: FiredMovement | null;
  /**
   * The value to store as the new baseline, or null to leave the baseline
   * untouched. Null means the run was a no-op (incomplete value or flow): a
   * subtotal must never become a baseline (INV-PORTMOVE-001).
   */
  rebaselineTo: number | null;
}

const roundPercent = (value: number): number => {
  const factor = 10 ** PORTFOLIO_MOVE_PERCENT_DECIMALS;
  return Math.round(value * factor) / factor;
};

/**
 * Decide the movement outcome. The order of the guards is the spec's:
 *
 * 1. Value incomplete -> no-op (no alert, no rebaseline): a subtotal is unknown.
 * 2. Off (no threshold) -> no-op: nothing to maintain a baseline for.
 * 3. No baseline, a reporting-currency change, a baseline with no capture date,
 *    or one with no per-security closes -> rebaseline, no alert: an undated
 *    baseline names no period, and one without its closes cannot tell a late
 *    price from a market move.
 * 4. Flow incomplete -> no-op: an unconvertible contribution makes the movement
 *    unknown; do not rebaseline on an unknown run either.
 * 5. A late close that cannot be valued -> rebaseline, no alert
 *    (INV-PORTMOVE-008). The movement is unknown, so nothing fires; but the
 *    stored closes are what make it unknown, and keeping them would make every
 *    later run unknown too, so the baseline moves to today's complete value.
 * 6. Restated baseline value 0 -> undefined percentage -> rebaseline, no alert.
 * 7. Otherwise restate the baseline at the late closes, compute movement =
 *    mvToday - restatedBaseline - flow, compare |movement / restatedBaseline|
 *    against the threshold (at full precision), and rebaseline to today whether
 *    or not it fired.
 */
export function decideMovement(input: MovementInputs): MovementDecision {
  if (!input.mvComplete) return { fire: null, rebaselineTo: null };
  if (input.movePercent == null || input.movePercent <= 0) {
    return { fire: null, rebaselineTo: null };
  }
  if (
    input.baseline == null ||
    input.baseline.currency !== input.currency ||
    !input.baselineDateKnown ||
    !input.baselinePositionsKnown
  ) {
    return { fire: null, rebaselineTo: input.mvToday };
  }
  if (!input.flow.complete) return { fire: null, rebaselineTo: null };
  if (!input.latePrice.complete) {
    return { fire: null, rebaselineTo: input.mvToday };
  }
  const restated = input.baseline.value + input.latePrice.value;
  if (restated === 0) {
    return { fire: null, rebaselineTo: input.mvToday };
  }

  // The threshold compares at full precision, but the STORED movement is the
  // difference of four decimal(20,4) values, and the difference of two 4dp
  // decimals is not a 4dp decimal -- round the delta before it is persisted.
  const movement = input.mvToday - restated - input.flow.value;
  const rawPercent = (movement / restated) * 100;
  const fires = Math.abs(rawPercent) >= input.movePercent;
  return {
    fire: fires
      ? {
          changePercent: roundPercent(rawPercent),
          direction: rawPercent >= 0 ? "up" : "down",
          movementValue: roundMoney(movement),
          baselineValue: roundMoney(input.baseline.value),
          currentValue: roundMoney(input.mvToday),
          externalFlow: roundMoney(input.flow.value),
          latePriceAdjustment: roundMoney(input.latePrice.value),
        }
      : null,
    rebaselineTo: input.mvToday,
  };
}
