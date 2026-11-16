import { roundToDecimals } from "../common/round.util";
import {
  GemAssetRole,
  GEM_EQUITY_ROLES,
} from "./entities/gem-strategy-asset.entity";
import {
  GemMomentumSnapshot,
  GemSignalState,
} from "./entities/gem-strategy-signal.entity";
import { GemCadence } from "./entities/gem-strategy.entity";
import {
  BOUNDARY_HOLIDAY_DAYS,
  BOUNDARY_LAG_DAYS,
  PricePoint,
  daysBetween,
  pointAsOf,
} from "../common/time-series/price-boundary.util";

// The boundary lookup and its staleness bound are shared with the Security
// Performance comparison, so they live under `common/time-series/`. Re-exported
// here so the call sites that already import them from this module keep
// working: one implementation, two names, which is what
// `docs/time-series-contract.md` section 2.1 asks for.
export {
  BOUNDARY_LAG_DAYS,
  closeAt,
  daysBetween,
  pointAsOf,
  priceAsOf,
} from "../common/time-series/price-boundary.util";
export type { PricePoint } from "../common/time-series/price-boundary.util";

/**
 * Pure GEM (Global Equities Momentum) arithmetic: evaluation calendar, trailing
 * momentum, and the two decision steps. No database, no clock beyond the date
 * handed in -- so the rules are testable in isolation and the services stay
 * about data access.
 *
 * The rules implemented here are the standard dual-momentum ones:
 *   1. Absolute momentum -- compare the US equity leg's trailing return with
 *      the risk-free leg's (`RISK_FREE`, T-bills in the original rules).
 *      Equities win => RISK_ON, otherwise RISK_OFF and the portfolio moves into
 *      the `SAFE` instrument, which is a different asset: the yardstick and the
 *      thing you hold need not be the same fund.
 *   2. Relative momentum -- while RISK_ON, hold the equity market with the
 *      strongest trailing return. While RISK_OFF the ranking is not consulted.
 * The portfolio is always 100% in a single asset.
 */

/** One evaluation period on the strategy's calendar. */
export interface GemPeriod {
  /** Price date the decision is taken on (the day before the period starts). */
  evaluatedOn: string;
  /** First day the resulting allocation applies. */
  effectiveFrom: string;
}

/** Percentage points, rounded the way every momentum figure is. */
export const GEM_PP_DECIMALS = 4;

function ymd(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Parse an ISO date (date-only) as UTC midnight, avoiding local-timezone drift. */
export function parseYmd(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

/** First day of the month `value` falls in. */
function startOfMonthUtc(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1));
}

/** Shift a date by whole months, clamping to the target month's last day. */
export function addMonthsUtc(value: Date, months: number): Date {
  const target = new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + months, 1),
  );
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(value.getUTCDate(), lastDay));
  return target;
}

/** Months between one period start and the next, for the given cadence. */
export function cadenceMonths(cadence: GemCadence): number {
  return cadence === "QUARTERLY" ? 3 : 1;
}

/**
 * The period `asOf` falls in. A monthly strategy re-allocates on the 1st of
 * every month; a quarterly one on the 1st of January, April, July and October.
 * The decision uses prices from the last day before the period starts, which is
 * how a month-end signal becomes a first-of-month allocation.
 */
export function periodFor(asOf: string, cadence: GemCadence): GemPeriod {
  const step = cadenceMonths(cadence);
  const date = parseYmd(asOf);
  const monthStart = startOfMonthUtc(date);
  // Align the period start to the cadence grid (quarterly => Jan/Apr/Jul/Oct).
  const alignedMonth = Math.floor(monthStart.getUTCMonth() / step) * step;
  const effectiveFrom = new Date(
    Date.UTC(monthStart.getUTCFullYear(), alignedMonth, 1),
  );
  const evaluatedOn = new Date(effectiveFrom);
  evaluatedOn.setUTCDate(0); // last day of the previous month
  return { evaluatedOn: ymd(evaluatedOn), effectiveFrom: ymd(effectiveFrom) };
}

/**
 * The `count` most recent periods up to and including the one `asOf` falls in,
 * oldest first. Used to backfill history the first time a strategy is read.
 */
export function recentPeriods(
  asOf: string,
  cadence: GemCadence,
  count: number,
): GemPeriod[] {
  if (count <= 0) return [];
  const step = cadenceMonths(cadence);
  const current = periodFor(asOf, cadence);
  const periods: GemPeriod[] = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const effectiveFrom = addMonthsUtc(
      parseYmd(current.effectiveFrom),
      -i * step,
    );
    const evaluatedOn = new Date(effectiveFrom);
    evaluatedOn.setUTCDate(0);
    periods.push({
      evaluatedOn: ymd(evaluatedOn),
      effectiveFrom: ymd(effectiveFrom),
    });
  }
  return periods;
}

/**
 * How a span between two boundary dates could be priced.
 *
 * Three outcomes, not two. "No new close yet" is not the same as "the prices
 * are missing": a period still in its opening days has not produced a second
 * observation, and calling that a gap would throw away the history behind it,
 * while calling it a flat 0% would invent a return. Only a span longer than
 * `BOUNDARY_LAG_DAYS` can reach `UNPRICED` by this route, because a shorter one
 * fails the freshness test at its far end first.
 *
 * `UNELAPSED` also covers "the far boundary has passed on the calendar but the
 * series has not caught up to it yet" -- an answer that is not wrong, merely
 * not available. Both readings mean the same thing to every caller: come back
 * once there is more data. Nothing may be persisted from an unelapsed span.
 */
export type SpanCloses =
  | { state: "PRICED"; base: number; latest: number }
  | { state: "UNELAPSED" }
  | { state: "UNPRICED" };

/**
 * What the far end of a span means, which decides whether it has to be settled.
 *
 * - `BOUNDARY` -- a date the calendar fixed: a period's last day, a momentum
 *   window's end. The answer is a *fact about that day*, and on the signal path
 *   it is persisted, so it may only be computed once the series proves the day
 *   is behind it.
 * - `AS_OF` -- "value it with what is known now". There is no later observation
 *   to wait for, by construction: today's close does not exist until the market
 *   shuts. Nothing persists such a span, and the newest close is the right
 *   answer to the question actually asked.
 *
 * `BOUNDARY` is the default so a new call site is strict unless it argues
 * otherwise.
 */
export type SpanEnd = "BOUNDARY" | "AS_OF";

/**
 * The two closes that price a span, each within `BOUNDARY_LAG_DAYS` of the
 * boundary it stands for, and struck on **different days**.
 *
 * The same-observation rule is the point. `closeAt` bounds each end
 * independently, so a period shorter than the lag window resolves both of its
 * ends to one close and the arithmetic returns exactly 1.0 -- a hard 0% return
 * that is indistinguishable from a market that went nowhere, and that counts
 * itself as a fully covered period. `pointAsOf` documents the trap; this is
 * where it is closed.
 */
export function spanCloses(
  prices: PricePoint[] | undefined,
  from: string,
  to: string,
  end: SpanEnd = "BOUNDARY",
): SpanCloses {
  if (!prices?.length) return { state: "UNPRICED" };
  const entry = pointAsOf(prices, from);
  const exit = pointAsOf(prices, to);
  if (!entry || !exit) return { state: "UNPRICED" };
  if (daysBetween(entry.date, from) > BOUNDARY_LAG_DAYS) {
    return { state: "UNPRICED" };
  }
  if (daysBetween(exit.date, to) > BOUNDARY_LAG_DAYS) {
    return { state: "UNPRICED" };
  }
  // The far boundary is settled only once the series holds an observation dated
  // at or after it.
  //
  // The lag window above tolerates a market that was shut on the boundary, but
  // it cannot tell that from a close nobody has fetched yet: both look like
  // "the newest observation is a few days old". Pricing the span off the
  // earlier close answers the period from the wrong day -- and on the signal
  // path that answer is materialized under the current fingerprint and version,
  // then skipped forever, so a report opened at 09:00 on the 1st can pin a
  // month-end decision to the 30th's close and never correct it even when the
  // real month-end close flips the decision.
  //
  // Defer instead, exactly the way a period that has not elapsed defers, and
  // let the next load decide once the close is in. An instrument that stops
  // reporting altogether still fails the lag test above within two weeks, so
  // this cannot hold a period open indefinitely.
  //
  // An `AS_OF` end is exempt, and has to be: "now" never has a close dated at
  // or after it until the market shuts, so demanding one would drop the
  // backtest's trailing mark-to-market period on every trading day -- the
  // period a strategy configured last month consists of.
  if (end === "BOUNDARY" && prices[prices.length - 1].date < to) {
    return { state: "UNELAPSED" };
  }
  if (entry.date === exit.date) return { state: "UNELAPSED" };
  // Both ends, not just the base. A zero exit close (the DTO admits `@Min(0)`,
  // so a typo can store one) would otherwise read as a *known* -100% period
  // and a zeroed equity curve rather than as a price nobody supplied.
  if (!(entry.close > 0) || !(exit.close > 0)) return { state: "UNPRICED" };
  return { state: "PRICED", base: entry.close, latest: exit.close };
}

/**
 * Trailing total return between two dates, in percent. Null when either
 * boundary has no close near enough in time to stand for it, when one close
 * would have to answer for both, or when the base is not positive (a zero base
 * would produce Infinity).
 *
 * The freshness rule is the same one the backtest applies, and for a stronger
 * reason: this figure is what picks the instrument the report tells the user to
 * hold. A momentum computed from a months-old quote is not a cautious estimate,
 * it is a made-up number with an instruction attached.
 */
export function trailingReturnPercent(
  prices: PricePoint[],
  from: string,
  to: string,
): number | null {
  const span = spanCloses(prices, from, to);
  if (span.state !== "PRICED") return null;
  return roundToDecimals((span.latest / span.base - 1) * 100, GEM_PP_DECIMALS);
}

/**
 * Momentum per role over the lookback window ending at `evaluatedOn`. A role
 * with no instrument, or with prices that do not cover the window, comes back
 * null so every caller renders it as unknown.
 *
 * The roles are one decision, so they are priced at one session: the newest
 * exit close any role holds on or before `evaluatedOn` is the boundary's
 * session, and a role whose own exit trails it by more than
 * `BOUNDARY_HOLIDAY_DAYS` is not priced. Its series has a gap at the boundary
 * (a feed outage), not a holiday, and its 18th compared with another role's
 * 30th is not a ranking (A26-M27). Unknown, the period defers through
 * `evaluate` exactly as an unpriced role does.
 */
export function momentumSnapshot(
  pricesByRole: Partial<Record<GemAssetRole, PricePoint[]>>,
  evaluatedOn: string,
  lookbackMonths: number,
): GemMomentumSnapshot {
  const from = ymd(addMonthsUtc(parseYmd(evaluatedOn), -lookbackMonths));
  const snapshot: GemMomentumSnapshot = {};
  const exits = new Map<GemAssetRole, string>();
  for (const [role, prices] of Object.entries(pricesByRole) as Array<
    [GemAssetRole, PricePoint[]]
  >) {
    const momentum = prices?.length
      ? trailingReturnPercent(prices, from, evaluatedOn)
      : null;
    snapshot[role] = momentum;
    const exit = momentum === null ? null : pointAsOf(prices, evaluatedOn);
    if (exit) exits.set(role, exit.date);
  }
  const session = [...exits.values()].reduce<string | null>(
    (newest, date) => (newest === null || date > newest ? date : newest),
    null,
  );
  if (session !== null) {
    for (const [role, exitDate] of exits) {
      if (daysBetween(exitDate, session) > BOUNDARY_HOLIDAY_DAYS) {
        snapshot[role] = null;
      }
    }
  }
  return snapshot;
}

/** A role and its momentum, ordered best-first by `rankEquities`. */
export interface RankedRole {
  role: GemAssetRole;
  momentum: number;
}

/**
 * Equity roles with a known momentum, strongest first. Roles without momentum
 * are dropped rather than sorted to the bottom: an unknown figure cannot be
 * said to be worse than a known one.
 *
 * Ties break on the canonical role order, so a tie produces the same winner on
 * every evaluation instead of depending on object key order.
 */
export function rankEquities(
  momentum: GemMomentumSnapshot,
  eligibleRoles: readonly GemAssetRole[] = GEM_EQUITY_ROLES,
): RankedRole[] {
  return GEM_EQUITY_ROLES.filter(
    (role) =>
      eligibleRoles.includes(role) &&
      typeof momentum[role] === "number" &&
      Number.isFinite(momentum[role]),
  )
    .map((role) => ({ role, momentum: momentum[role] as number }))
    .sort((a, b) => b.momentum - a.momentum);
}

/**
 * Which instrument the absolute test measures equities against: the dedicated
 * risk-free leg when one is assigned, otherwise the safe asset. The fallback is
 * what keeps a strategy configured before the two roles were split evaluating
 * exactly as it did.
 */
export function benchmarkRoleFor(
  mappedRoles: readonly GemAssetRole[],
): GemAssetRole {
  return mappedRoles.includes("RISK_FREE") ? "RISK_FREE" : "SAFE";
}

/**
 * Which instrument a RISK-OFF period moves into: the safe asset, unless the
 * risk-free leg is the only defensive instrument assigned. Holding the yardstick
 * is a reasonable last resort; holding nothing is not. With neither assigned the
 * answer is still `SAFE` -- the role the report then reports as unmapped.
 */
export function riskOffRoleFor(
  mappedRoles: readonly GemAssetRole[],
): GemAssetRole {
  return mappedRoles.includes("RISK_FREE") && !mappedRoles.includes("SAFE")
    ? "RISK_FREE"
    : "SAFE";
}

/** The outcome of one evaluation, before it is persisted. */
export interface GemEvaluation {
  state: GemSignalState;
  /** Role to hold: the equity winner while RISK_ON, the safe asset otherwise. */
  targetRole: GemAssetRole | null;
  /** The role the absolute test compared equities against. */
  benchmarkRole: GemAssetRole;
  /** US equity momentum minus benchmark momentum, in pp. */
  spreadPp: number | null;
  /** Winner minus runner-up, in pp. Null while RISK_OFF or with one candidate. */
  leadPp: number | null;
  ranking: RankedRole[];
}

/**
 * Run both decision steps. Returns null when the absolute test cannot be run at
 * all -- momentum missing for the US equity leg or for the benchmark -- because
 * guessing a state from half the inputs would produce a signal the user could
 * act on with no basis.
 *
 * `mappedRoles` are the roles with an instrument assigned; they decide both
 * which equity markets the ranking considers and which instrument stands in as
 * the risk-free benchmark.
 */
export function evaluate(
  momentum: GemMomentumSnapshot,
  mappedRoles: readonly GemAssetRole[] = GEM_EQUITY_ROLES,
): GemEvaluation | null {
  const benchmarkRole = benchmarkRoleFor(mappedRoles);
  const equity = momentum.US_EQUITY;
  const benchmark = momentum[benchmarkRole];
  if (
    typeof equity !== "number" ||
    typeof benchmark !== "number" ||
    !Number.isFinite(equity) ||
    !Number.isFinite(benchmark)
  ) {
    return null;
  }

  const spreadPp = roundToDecimals(equity - benchmark, GEM_PP_DECIMALS);
  const ranking = rankEquities(momentum, mappedRoles);
  const riskOn = equity > benchmark;

  if (!riskOn) {
    // Equities lost the absolute test, which only involves the US leg and the
    // benchmark. The allocation goes to the safe asset whatever the other
    // markets did, so a gap in their history cannot change this answer.
    return {
      state: "RISK_OFF",
      targetRole: riskOffRoleFor(mappedRoles),
      benchmarkRole,
      spreadPp,
      leadPp: null,
      ranking,
    };
  }

  // RISK-ON is decided by comparing the equity markets against each other, so
  // every market the user put in the race has to have finished it. `rankEquities`
  // drops a role whose momentum is unknown, which quietly turns "we could not
  // measure emerging markets" into "emerging markets did not win" -- and the
  // report then names a concrete switch into the strongest of whatever was
  // left. The period stays unevaluated instead, and is picked up on a later
  // read once the prices arrive.
  //
  // A role with no instrument is not in `mappedRoles` and is no obstacle: a
  // deliberate two-asset variant evaluates exactly as before.
  const unmeasured = GEM_EQUITY_ROLES.filter(
    (role) =>
      mappedRoles.includes(role) &&
      !ranking.some((entry) => entry.role === role),
  );
  if (unmeasured.length > 0) return null;

  const winner = ranking[0] ?? null;
  const runnerUp = ranking[1] ?? null;
  return {
    state: "RISK_ON",
    benchmarkRole,
    // With no eligible equity instrument there is nothing to hold; the report
    // reports the unmapped roles rather than falling back to the safe asset,
    // which would be a different signal than the rules produce.
    targetRole: winner ? winner.role : null,
    spreadPp,
    leadPp:
      winner && runnerUp
        ? roundToDecimals(winner.momentum - runnerUp.momentum, GEM_PP_DECIMALS)
        : null,
    ranking,
  };
}

/** What a stored evaluation asked the investor to do. */
export type GemHistoryAction = "BUY" | "HOLD" | "SWITCH";

/**
 * The action a period implies: the first allocation is a BUY, a change of
 * instrument a SWITCH, and an unchanged allocation a HOLD.
 */
export function historyAction(
  targetRole: GemAssetRole | null,
  previousRole: GemAssetRole | null,
): GemHistoryAction {
  if (!previousRole) return "BUY";
  if (targetRole && targetRole !== previousRole) return "SWITCH";
  return "HOLD";
}
