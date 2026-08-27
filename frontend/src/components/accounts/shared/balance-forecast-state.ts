import type { BalanceForecast, BalanceForecastGap } from '@/types/banking-detail';

/**
 * What an account detail view holds after asking for a balance forecast.
 *
 * `withheld` is the WHOLE decision -- whether the forward line may be drawn,
 * whether the last point may be read as a projection, and whether the
 * unavailable panel renders. It is one field because the two views each derived
 * it twice from two different things: `complete === false` at the point of
 * loading, and `gaps.length > 0` at the point of rendering. Those agree only
 * while the server names a cause for every withheld forecast; a response that
 * withholds without naming one (an unrecognised gap reason, a narrowed payload,
 * a future server that reports incompleteness it cannot attribute) made
 * `gaps.length > 0` false, and then the panel did not render AND the projected
 * balance fell back to the account's CURRENT balance -- today's figure printed
 * under "Projected", with nothing on screen saying so. Exactly the trap issue
 * #1247 exists to close, reintroduced by asking the question twice.
 *
 * `gaps` explains the withholding; it never decides it.
 */
export interface BalanceForecastState {
  /** Points safe to draw as a forward line. Empty when the forecast is withheld. */
  points: Array<{ date: string; balance: number }>;
  /**
   * The server said it withheld the projection. Read `=== false` off the
   * response, so `true` and an ABSENT field (an older backend mid rolling
   * deploy) both mean "it did not" -- withholding on absence would invent a
   * problem the response never reported.
   */
  withheld: boolean;
  /** Why, when the server said. May be empty even when `withheld` is true. */
  gaps: BalanceForecastGap[];
  /**
   * The request never produced a forecast -- it failed, or has not run.
   *
   * A THIRD state, because "the server withheld the projection" and "we never
   * heard back" are both different from "this account has nothing scheduled",
   * and only the last of the three has a number to show. Folded into
   * `withheld: false`, a 500 on `GET /accounts/:id/balance-forecast` made
   * `projectedBalanceFrom` fall back to the account's CURRENT balance and print
   * it under "Projected" with no notice -- an outage rendered as a measured
   * answer. `frontend/CLAUDE.md`: five states stay distinguishable, and failed is
   * one of them.
   */
  unavailable: boolean;
}

export const EMPTY_BALANCE_FORECAST_STATE: BalanceForecastState = {
  points: [],
  withheld: false,
  gaps: [],
  unavailable: true,
};

/**
 * Read one forecast response into the state both detail views hold.
 *
 * A failed request is `undefined`/`null`, which is not a withheld forecast: it
 * is no information, so nothing is drawn and nothing is claimed about why.
 */
export function readBalanceForecast(
  forecast: BalanceForecast | null | undefined,
): BalanceForecastState {
  if (!forecast) return EMPTY_BALANCE_FORECAST_STATE;
  const withheld = forecast.complete === false;
  return {
    points: withheld
      ? []
      : forecast.points.map((p) => ({ date: p.date, balance: p.balance })),
    withheld,
    gaps: withheld ? (forecast.gaps ?? []) : [],
    unavailable: false,
  };
}

/**
 * The projected balance a detail view shows, or `null` when there is none to
 * show.
 *
 * `null` where the forecast was withheld OR never arrived, because the
 * alternative -- the account's current balance -- is today's figure under a
 * projection's label. `currentBalance` is the fallback only for the genuinely
 * empty case: an account with nothing scheduled projects to what it holds now,
 * which is a known answer, not an unknown one. That distinction is the whole
 * reason `unavailable` exists as its own field.
 */
export function projectedBalanceFrom(
  state: BalanceForecastState,
  currentBalance: number,
): number | null {
  if (state.withheld || state.unavailable) return null;
  const last = state.points[state.points.length - 1];
  return last && last.balance !== null ? last.balance : currentBalance;
}
