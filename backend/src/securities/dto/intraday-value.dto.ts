import { ApiProperty } from "@nestjs/swagger";
import { IsIn, IsOptional, IsString, MaxLength } from "class-validator";

/**
 * The chart ranges served intraday. `mtd` is served on its own: its window
 * opens on the 1st and is measured from the previous month's last session,
 * which a rolling month trimmed on the client does not always reach (on the
 * 31st a thirty-day window opens on the 1st itself).
 */
export const INTRADAY_RANGES = ["1d", "1w", "mtd", "1m"] as const;
export type IntradayRangeKey = (typeof INTRADAY_RANGES)[number];

export class IntradayValueQueryDto {
  @ApiProperty({ enum: INTRADAY_RANGES })
  @IsIn(INTRADAY_RANGES as unknown as string[])
  range: IntradayRangeKey;

  @ApiProperty({
    required: false,
    description: "Comma-separated account IDs to filter by",
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  accountIds?: string;

  @ApiProperty({
    required: false,
    description:
      "ISO currency code to convert all values to. Defaults to the user's preferred currency.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(8)
  displayCurrency?: string;
}

export interface IntradayValuePoint {
  timestamp: string;
  /** The scope's value at that bar: securities plus the cash beside them. */
  value: number;
  /**
   * The INVESTED part of the same bar -- the securities, no cash. The
   * investment charts plot this, because cash held in an investment account is
   * not an investment (INV-PORTRESULT-002,
   * `docs/specs/portfolio-period-result.md` section 10.7).
   */
  securitiesValue: number;
  /**
   * Three completeness bits, for three different repairs, as on
   * `DailyInvestmentValue`. `fxComplete` is false when a contribution at this
   * bar had no exchange rate (it was left out, not valued at 1:1);
   * `pricesComplete` is false when a held position had no price at this bar;
   * `cashComplete` is false when a cash account had no balance for the day (a
   * live bar always reports true). A session-close point carries the daily
   * row's own flags. Read each as `=== false`: absent is an older backend
   * saying nothing.
   */
  fxComplete: boolean;
  pricesComplete: boolean;
  cashComplete: boolean;
  /**
   * Set on a session's closing point: the daily series' own figure for the
   * day, stamped at the session's close (INV-INTRADAY-001), which includes the
   * point the series opens on. Absent on a live bar. A client shaping the
   * series reads it to keep the close a window is measured from, and never
   * infers a close from a timestamp.
   */
  sessionClose?: true;
}

/**
 * One stacked band on the intraday "by security" chart. Mirrors the
 * daily/monthly breakdown's series shape: an individual security, the
 * rolled-up "other" bucket of smaller holdings, or the aggregate cash band.
 */
export interface IntradayBreakdownSeries {
  /** securityId for a real holding, or the sentinel "cash" / "other". */
  key: string;
  type: "security" | "cash" | "other";
  symbol: string | null;
  name: string;
}

export interface IntradayBreakdownPoint {
  timestamp: string;
  /** Sum of every band at this bar (in the display currency). */
  total: number;
  /** Per-series value keyed by {@link IntradayBreakdownSeries.key}. */
  values: Record<string, number>;
  /** As on {@link IntradayValuePoint}: what this bar could not value. */
  fxComplete: boolean;
  pricesComplete: boolean;
  cashComplete: boolean;
  /** As on {@link IntradayValuePoint}: set on a session's closing point. */
  sessionClose?: true;
}

/**
 * Per-security intraday series for the Portfolio Value Over Time report's "by
 * security" view on the 1D / 1W / 1M ranges. Carries the same intraday
 * availability metadata as {@link IntradayValueResponse} so the frontend can
 * apply the identical fallback handling (1D unavailable notice, 1W/1M silent
 * fall back to the daily-snapshot breakdown).
 */
export interface IntradayBreakdownResponse {
  series: IntradayBreakdownSeries[];
  points: IntradayBreakdownPoint[];
  interval: "1m" | "2m" | "5m" | "15m" | "30m" | "60m" | "90m";
  currency: string;
  range: IntradayRangeKey;
  fetchedAt: string;
  skippedSymbols: string[];
  failedSymbols: string[];
  fallbackToDaily: boolean;
  /**
   * Completeness over every point, so `value` / `total` on each point is a
   * SUBTOTAL whenever one is false (as `DailyInvestmentValue.value` is): a
   * consumer that prints it under a total's caption must read the flags.
   * `valuationComplete` is all three per-point bits over every point. An empty
   * `points` array reports true and empty lists.
   */
  fxComplete: boolean;
  pricesComplete: boolean;
  valuationComplete: boolean;
  /** `"CCY->DISPLAY"` for each pair with no rate at any bar, sorted. */
  missingRatePairs: string[];
  /** The securities behind `pricesComplete: false`, sorted. */
  unpricedSecurityIds: string[];
}

export interface IntradayValueResponse {
  points: IntradayValuePoint[];
  interval: "1m" | "2m" | "5m" | "15m" | "30m" | "60m" | "90m";
  currency: string;
  /** Range that was actually returned (echoes the request). */
  range: IntradayRangeKey;
  /** ISO timestamp of when this series was computed (server clock). */
  fetchedAt: string;
  /**
   * Symbols of holdings whose quote provider does not expose intraday data
   * (e.g. MSN Money). They were skipped from the aggregated series.
   */
  skippedSymbols: string[];
  /**
   * Symbols whose intraday fetch failed at the provider level (network error,
   * empty/invalid response, etc.) even though the provider does support
   * intraday in principle. Distinguished from skippedSymbols so the frontend
   * can show a distinct error message.
   */
  failedSymbols: string[];
  /**
   * True when the frontend must not render this intraday series and should
   * instead use the daily-snapshot endpoint. Set when:
   *   - any holding's quote provider has no intraday support (skippedSymbols),
   *   - or any holding's intraday fetch failed (failedSymbols).
   * In either case the points array is empty.
   */
  fallbackToDaily: boolean;
  /**
   * Completeness over every point, so `value` / `total` on each point is a
   * SUBTOTAL whenever one is false (as `DailyInvestmentValue.value` is): a
   * consumer that prints it under a total's caption must read the flags.
   * `valuationComplete` is all three per-point bits over every point. An empty
   * `points` array reports true and empty lists.
   */
  fxComplete: boolean;
  pricesComplete: boolean;
  valuationComplete: boolean;
  /** `"CCY->DISPLAY"` for each pair with no rate at any bar, sorted. */
  missingRatePairs: string[];
  /** The securities behind `pricesComplete: false`, sorted. */
  unpricedSecurityIds: string[];
}
