/**
 * The trailing windows the Investments page reports a portfolio result over,
 * and where each one starts.
 *
 * This file is the one arithmetic for those windows. The batch route and the
 * single-range route resolve every preset from it, the intraday series
 * (`PortfolioService.loadIntradayData`) trims its bars to `presetWindowStart`
 * and opens on the close of `presetEarliestDate`, and the client's chart
 * window (`frontend/src/components/investments/portfolio-range-window.ts`)
 * mirrors it day for day so the series a chart draws opens where the figures
 * under it are measured from; `portfolio-period-presets.util.spec.ts` and
 * `portfolio-range-window.test.ts` pin both to the same dates. `1w` is seven
 * days back, `1m` thirty, `3m` ninety, `1y` the same day a year earlier, `2y`
 * seven hundred and thirty days back, `5y` and `10y` the same day five and ten
 * years earlier. A day's move IS the prior close against the newest one, so
 * `1d`'s window is the end day alone.
 *
 * `ytd` is not 1 January: it opens on 31 December of the previous year, so the
 * year is measured from the close of its last trading session, as every quote
 * source reports it. A day is valued from the latest close on or before it, so
 * a 31 December that fell on a weekend or holiday still carries the last
 * session's close, and `startPriceDate` names that session.
 *
 * `all` is the one window whose start no arithmetic answers: it opens on the
 * day the scope's own history begins, which only a query knows, so
 * `presetWindowStart` returns `null` for it and the caller that HAS that date
 * supplies it (`PortfolioPeriodResultService.firstInvestmentDate`).
 *
 * Every function here is pure and takes "today" as a string, because the server
 * decides what today is (`todayYMD`) and a window must not depend on the clock
 * of whoever asked.
 */
import { addDaysYMD } from "../common/date-utils";

export const PORTFOLIO_PERIOD_PRESETS = [
  "1d",
  "1w",
  "1m",
  "3m",
  "ytd",
  "1y",
  "2y",
  "5y",
  "10y",
  "all",
] as const;

export type PortfolioPeriodPreset = (typeof PORTFOLIO_PERIOD_PRESETS)[number];

/**
 * The windows a scope is shown only when its history reaches back to them.
 *
 * A portfolio two years old has no five-year return, and the row would be a
 * permanent "n/a" telling the reader nothing they can act on -- unlike a
 * window withheld for a missing price, which names a repair. The shorter
 * windows are NOT gated: every portfolio is shown its month and its year, and
 * a young one reports them from the day it started holding anything, which is
 * the behaviour the card has always had. `all` is not gated either: a scope
 * with any history at all has an all-time result, and one with none has no
 * windows to report in the first place.
 */
const HISTORY_GATED_PRESETS: ReadonlySet<string> = new Set(["2y", "5y", "10y"]);

export function isHistoryGatedPreset(preset: PortfolioPeriodPreset): boolean {
  return HISTORY_GATED_PRESETS.has(preset);
}

/**
 * The presets measured from the previous trading day's close rather than from
 * the first point inside the window.
 *
 * A one-day and a one-week window open mid-session, so a change measured from
 * the first point inside them drops whatever the portfolio did between the
 * previous close and that point. Every quote source reports these against the
 * prior close, so this does too -- the same rule, and the same set, as
 * `usesPriorCloseBaseline` on the client, which also holds `mtd`, a range
 * with no preset here.
 *
 * `all` is here for a different reason with the same arithmetic: its window
 * opens on the day the scope's first holding was bought, and that day's close
 * already holds the purchase, so measuring from it would drop the day that
 * bought the portfolio out of the chain. `getInvestedResultSinceInception`
 * draws the same boundary (`baselineDate: first - 1 day`), and the two must
 * answer the same figure.
 */
const PRIOR_CLOSE_PRESETS: ReadonlySet<string> = new Set(["1d", "1w", "all"]);

export function usesPriorCloseBaseline(preset: PortfolioPeriodPreset): boolean {
  return PRIOR_CLOSE_PRESETS.has(preset);
}

export function isPortfolioPeriodPreset(
  value: string,
): value is PortfolioPeriodPreset {
  return (PORTFOLIO_PERIOD_PRESETS as readonly string[]).includes(value);
}

/**
 * The same calendar day `years` earlier, clamped to the month's last day so
 * February 29 steps back to February 28 rather than rolling into March -- the
 * behaviour of `subYears`, which is what the client's `1y` and `5y` ranges use.
 */
function yearsEarlier(ymd: string, years: number): string {
  const [year, month, day] = ymd.split("-").map(Number);
  const lastDayOfMonth = new Date(
    Date.UTC(year - years, month, 0),
  ).getUTCDate();
  const clamped = Math.min(day, lastDayOfMonth);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${year - years}-${pad(month)}-${pad(clamped)}`;
}

/**
 * The first day the preset's window covers, given the day it ends on, or
 * `null` for `all`, whose window opens where the scope's history does.
 */
export function presetWindowStart(
  preset: PortfolioPeriodPreset,
  today: string,
): string | null {
  switch (preset) {
    case "1d":
      return today;
    case "1w":
      return addDaysYMD(today, -7);
    case "1m":
      return addDaysYMD(today, -30);
    case "3m":
      return addDaysYMD(today, -90);
    case "ytd":
      return `${Number(today.slice(0, 4)) - 1}-12-31`;
    case "1y":
      return yearsEarlier(today, 1);
    // A rolling two years is 730 days on the client, not two calendar years;
    // the chart's own `2y` button draws that window, and two surfaces on one
    // page must not disagree about where the same caption opens.
    case "2y":
      return addDaysYMD(today, -730);
    case "5y":
      return yearsEarlier(today, 5);
    case "10y":
      return yearsEarlier(today, 10);
    case "all":
      return null;
  }
}

/**
 * The day the preset is measured from, and so the earliest day it needs a
 * value for: the day before its window opens for a prior-close preset, the
 * window's own first day otherwise. The period result's series and flows are
 * loaded from it, its `startDate` reports it, and the intraday series and the
 * client's chart window open on its close.
 */
export function presetEarliestDate(
  preset: PortfolioPeriodPreset,
  today: string,
  /** Where `all` opens; ignored by every other preset. */
  inception?: string,
): string | null {
  const start =
    preset === "all" ? (inception ?? null) : presetWindowStart(preset, today);
  if (start === null) return null;
  return usesPriorCloseBaseline(preset) ? addDaysYMD(start, -1) : start;
}
