import { roundMoney, roundToDecimals } from "../common/round.util";
import { PORTFOLIO_MOVE_PERCENT_DECIMALS } from "../notification-center/portfolio-movement.util";

/**
 * Why a day's market movement could not be reported, as a closed set so the
 * client renders actionable copy instead of parsing prose.
 *
 * The distinctions are the point. A non-trading day is BLANK -- nothing
 * happened, and there is nothing to fix. An unknown day shows the marker and
 * names what is missing, and the repairs differ: a price is entered against the
 * security, a rate in Currencies. The two never share a rendering.
 */
export type DailyMovementReason =
  /** No security the scope held that day has a close dated that day. */
  | "notTradingDay"
  /** A held position on that day or the day before had no accepted close. */
  | "unpricedHolding"
  /** A value or a flow on either day could not be converted. */
  | "missingRate"
  /** An external cash flow on the day could not be converted. */
  | "flowIncomplete"
  /** A cash account in the scope reported no balance for the day. */
  | "cashIncomplete"
  /** The day before precedes the scope's first valued day. */
  | "noPriorValue"
  /** The previous day's value is zero: a percentage of nothing. */
  | "zeroBaseline";

/** One day's value, as `getDailyInvestments` reports it, reduced to what decide needs. */
export interface DailyMovementValue {
  value: number;
  /**
   * Every component priced, converted and balanced:
   * `fxComplete && pricesComplete && cashComplete`.
   */
  complete: boolean;
  /** Why not, when `complete` is false. */
  reasons: DailyMovementReason[];
}

export interface DailyMovementInput {
  /** At least one held security has a close dated this day. */
  isTradingDay: boolean;
  /** MV(d); `null` when the scope has no value series for the day at all. */
  today: DailyMovementValue | null;
  /** MV(d-1); `null` when the day before precedes the series. */
  previous: DailyMovementValue | null;
  /** The day's external cash flow in the reporting currency. */
  flow: { complete: boolean; value: number };
}

export interface DailyMovementDecision {
  /**
   * The day's market movement in the reporting currency: `MV(d) - MV(d-1) -
   * externalFlow(d)`.
   *
   * Non-null on every complete day, and additionally on a `zeroBaseline` day,
   * where the money moved is known and only the PERCENTAGE is undefined. A cell
   * renders from `complete`, so a zero-baseline day is still blank; the day
   * panel may show this absolute figure.
   */
  movement: number | null;
  /** The movement as a percentage of MV(d-1); non-null exactly when complete. */
  movementPercent: number | null;
  /** True only when the percentage is known. */
  complete: boolean;
  reasons: DailyMovementReason[];
}

/**
 * Whether a day's portfolio movement can be reported, and what it is.
 *
 * A change needs **two complete values of two different observations**, plus the
 * contributions the reader made themselves. Each guard below removes one way
 * that can fail to hold, in the order of truth table B in
 * `docs/specs/calendar-view.md`:
 *
 * 1. Not a trading day -> blank. No security the scope held struck a close, so
 *    there is no market observation to compare; a weekend deposit is not a gain.
 * 2. MV(d) incomplete -> unknown, carrying its own causes. A subtotal minus a
 *    total is not a movement.
 * 3. MV(d-1) missing or incomplete -> unknown. A first day has no baseline, and
 *    the day before being a subtotal makes the difference meaningless.
 * 4. Flow incomplete -> unknown. An unconvertible contribution is
 *    indistinguishable from a market move; counting it as zero would report the
 *    reader's own deposit as a gain (INV-PORTMOVE-002).
 * 5. MV(d-1) is zero -> no percentage. The movement itself is known and is
 *    returned; the ratio is not.
 *
 * Pure, so the whole policy is table-tested without a database. The client reads
 * `complete` and `reasons` and never re-derives a row of this table.
 */
export function decideDailyMovement(
  input: DailyMovementInput,
): DailyMovementDecision {
  if (!input.isTradingDay) {
    return {
      movement: null,
      movementPercent: null,
      complete: false,
      reasons: ["notTradingDay"],
    };
  }

  if (input.today === null || !input.today.complete) {
    return {
      movement: null,
      movementPercent: null,
      complete: false,
      reasons: dedupeReasons(input.today?.reasons ?? ["unpricedHolding"]),
    };
  }

  if (input.previous === null) {
    return {
      movement: null,
      movementPercent: null,
      complete: false,
      reasons: ["noPriorValue"],
    };
  }

  if (!input.previous.complete) {
    return {
      movement: null,
      movementPercent: null,
      complete: false,
      reasons: dedupeReasons(
        input.previous.reasons.length > 0
          ? input.previous.reasons
          : ["unpricedHolding"],
      ),
    };
  }

  if (!input.flow.complete) {
    return {
      movement: null,
      movementPercent: null,
      complete: false,
      reasons: ["flowIncomplete"],
    };
  }

  // The difference of three decimal(20,4) values is not itself a 4dp decimal,
  // so the delta is rounded once here rather than accumulating drift.
  const movement = roundMoney(
    input.today.value - input.previous.value - input.flow.value,
  );

  if (input.previous.value === 0) {
    return {
      movement,
      movementPercent: null,
      complete: false,
      reasons: ["zeroBaseline"],
    };
  }

  return {
    movement,
    // A percentage is a ratio, not money: PORTFOLIO_MOVE_PERCENT_DECIMALS, never
    // roundMoney.
    movementPercent: roundToDecimals(
      (movement / input.previous.value) * 100,
      PORTFOLIO_MOVE_PERCENT_DECIMALS,
    ),
    complete: true,
    reasons: [],
  };
}

/**
 * The reasons a day's value carries, from the completeness flags the value
 * series reports. Three flags, three causes, three repairs -- a day short of
 * more than one names each of them.
 */
export function valueReasons(point: {
  fxComplete?: boolean;
  pricesComplete?: boolean;
  cashComplete?: boolean;
}): DailyMovementReason[] {
  const reasons: DailyMovementReason[] = [];
  // `=== false`, never `!flag`: absent is no information, not incomplete.
  if (point.pricesComplete === false) reasons.push("unpricedHolding");
  if (point.fxComplete === false) reasons.push("missingRate");
  if (point.cashComplete === false) reasons.push("cashIncomplete");
  return reasons;
}

function dedupeReasons(reasons: DailyMovementReason[]): DailyMovementReason[] {
  return [...new Set(reasons)];
}
