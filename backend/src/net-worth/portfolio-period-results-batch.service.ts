import {
  Inject,
  Injectable,
  Logger,
  Optional,
  forwardRef,
} from "@nestjs/common";
import { DataSource } from "typeorm";

import { withScopedDb } from "../common/db/scoped-db";
import { addDaysYMD, todayYMD } from "../common/date-utils";
import { loadExternalFlowSubtotals } from "../securities/external-flow.util";
import { ExchangeRateService } from "../currencies/exchange-rate.service";
import { NetWorthService, isValuationCashAccount } from "./net-worth.service";
import { SeriesFetchOptions, computeWithRateFill } from "./series-rate-fill";
import {
  FlowSubtotalRow,
  buildFlowRateIndex,
  foldFlowSubtotals,
} from "./period-flow-fold.util";
import {
  PORTFOLIO_PERIOD_PRESETS,
  PortfolioPeriodPreset,
  isHistoryGatedPreset,
  presetEarliestDate,
  presetWindowStart,
  usesPriorCloseBaseline,
} from "./portfolio-period-presets.util";
import {
  PortfolioPeriodResult,
  PortfolioPeriodResultService,
} from "./portfolio-period-result.service";
import { decidePeriodResult } from "./portfolio-period-result.util";
import {
  EMPTY_INCOMPLETE_RANGES,
  foldIncompleteData,
  withFlowUnpricedSecurities,
} from "./incomplete-data-ranges.util";
import {
  loadUnmeasuredFlowRows,
  unmeasuredFlowsAfter,
} from "./unmeasured-flows.util";
import {
  foldInvestedFlows,
  loadInvestedCapitalFlowRows,
  shareLegCloseFrom,
  shareLegSecurityIds,
} from "./invested-capital-flow.util";
import {
  NO_INVESTED_PERIOD,
  investedPeriodResult,
} from "./invested-period-result.util";

/** What `GET /net-worth/investments-period-results` answers. */
export interface PortfolioPeriodResults {
  /** The currency every figure in every period is in. */
  currency: string;
  /** The day every period is measured TO. */
  asOf: string;
  /** One entry per preset asked for, keyed by the preset. */
  periods: Partial<Record<PortfolioPeriodPreset, PortfolioPeriodResult>>;
}

export interface PortfolioPeriodResultsOptions extends SeriesFetchOptions {
  /** Which windows to answer; every preset when empty or omitted. */
  periods?: readonly PortfolioPeriodPreset[];
  accountIds?: string[];
  displayCurrency?: string;
  /** The day the windows end on; the server's own today when omitted. */
  endDate?: string;
}

/**
 * Every trailing window of the same portfolio, measured once.
 *
 * Every figure is the one `PortfolioPeriodResultService` would have answered
 * for that window: the same value series, the same flow classifier, the same
 * per-day conversion and the same `decidePeriodResult`. What differs is how
 * often the expensive parts run. `getDailyInvestments` rebuilds a portfolio's
 * whole valuation, and the widest window's series already contains every
 * shorter window's points, so this service builds it ONCE for the widest
 * window it reports, loads the per-day flow subtotals and the
 * unmeasurable-movement counts once beside it, and derives each preset by
 * slicing:
 *
 *  - the end boundary is the series' last point, shared by every preset;
 *  - the start boundary is the last point on or before the preset's baseline
 *    (1d, 1w and all report against the previous close) or the first point on
 *    or after the window's start (every other preset);
 *  - the flows and the unmeasurable counts are the days strictly after the
 *    preset's own lower bound, which is exactly what a single-range call with
 *    that bound would have loaded.
 *
 * Slicing rather than recomputing is safe because neither the series nor the
 * rate index depends on how wide a window was asked for: a day is valued from
 * the latest accepted close on or before it, and `buildRateIndex` loads enough
 * rows that a date resolves the same in any window (issue #1390 is the defect
 * that established that). `portfolio-period-results-batch.service.spec.ts`
 * holds the two routes to the same answers on the same fixture, preset by
 * preset -- the "a preview computes what the commit will do" rule, applied to
 * two readers of one measure.
 *
 * A preset whose baseline predates the first point of the series is `null` with
 * `noValueSeries`: a portfolio three days old has no one-year return, and
 * measuring from its first day instead would report a number that looks like
 * one.
 *
 * The LONG windows are not reported that way, because a permanent "n/a" is not
 * an answer anybody can act on. `2y`, `5y` and `10y` are left out of the
 * response entirely unless the scope's history reaches back to them
 * (`isHistoryGatedPreset`), and `all` opens on that history's first day rather
 * than on any arithmetic -- the same day, drawn the same way, as
 * `getInvestedResultSinceInception`. Absence therefore says "this portfolio
 * has no such window"; a window that IS present with null figures was withheld
 * for a cause it names.
 */
@Injectable()
export class PortfolioPeriodResultsBatchService {
  private readonly logger = new Logger(PortfolioPeriodResultsBatchService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly netWorth: NetWorthService,
    private readonly periodResult: PortfolioPeriodResultService,
    // The read-path FX fill for the flow fold, optional and forward-referenced
    // for the reasons `PortfolioPeriodResultService` gives; the value series
    // fills through `NetWorthService`.
    @Optional()
    @Inject(forwardRef(() => ExchangeRateService))
    private readonly exchangeRates?: ExchangeRateService,
  ) {}

  async getPeriodResults(
    userId: string,
    opts: PortfolioPeriodResultsOptions = {},
  ): Promise<PortfolioPeriodResults> {
    const presets =
      opts.periods && opts.periods.length > 0
        ? [...new Set(opts.periods)]
        : [...PORTFOLIO_PERIOD_PRESETS];
    const currency = await this.periodResult.reportingCurrency(
      userId,
      opts.displayCurrency,
    );
    const end = opts.endDate || todayYMD();

    // The empty answer is the decision itself over no boundaries, so the shape
    // and the reason are the same ones every other caller of the policy gets.
    const empty = (startDate: string): PortfolioPeriodResult => ({
      currency,
      startDate,
      // No valued day is no session to name; the single-range route's own
      // empty answer says the same.
      startPriceDate: null,
      endDate: end,
      ...decidePeriodResult({
        start: null,
        end: null,
        flow: { complete: true, value: 0, missingPairs: [] },
      }),
      incompleteRanges: EMPTY_INCOMPLETE_RANGES,
      ...NO_INVESTED_PERIOD,
    });

    const scope = await this.periodResult.resolveScope(userId, opts.accountIds);

    // Where this scope's history begins, asked once and only when a preset
    // needs it: `all` opens there, and a gated window is shown only when the
    // scope reaches back to it. `null` is a scope that has never held
    // anything, which has no all-time window and no long ones either.
    const needsInception = presets.some(
      (preset) => preset === "all" || isHistoryGatedPreset(preset),
    );
    const inception =
      scope.length > 0 && needsInception
        ? await this.periodResult.firstInvestmentDate(
            userId,
            scope.map((row) => row.id),
          )
        : null;

    // The windows this answer actually reports, each with the day it opens on.
    // A gated window the scope has no history for is left out of the response
    // rather than returned as a permanent "n/a": the client shows the windows
    // it is sent, and absence here means "this portfolio has no such window",
    // while a window that IS sent with null figures was withheld for a cause
    // it names.
    const windows = new Map<PortfolioPeriodPreset, string>();
    for (const preset of presets) {
      if (preset === "all") {
        if (inception !== null) windows.set(preset, inception);
        continue;
      }
      const start = presetWindowStart(preset, end);
      if (start === null) continue;
      if (
        isHistoryGatedPreset(preset) &&
        (inception === null || inception > start)
      ) {
        continue;
      }
      windows.set(preset, start);
    }

    const allEmpty = (): PortfolioPeriodResults => ({
      currency,
      asOf: end,
      periods: Object.fromEntries(
        [...windows].map(([preset, start]) => [preset, empty(start)]),
      ),
    });

    // The widest window any reported preset can need a value for. A prior-close
    // preset reaches one day further back than its window opens, because that
    // close is what it is measured from.
    const earliestDates = [...windows].flatMap(([preset, start]) => {
      const date = presetEarliestDate(preset, end, start);
      return date === null ? [] : [date];
    });
    if (earliestDates.length === 0) return allEmpty();
    const earliest = earliestDates.reduce((a, b) => (a < b ? a : b));

    if (earliest > end) return allEmpty();
    if (scope.length === 0) return allEmpty();
    // ONE boundary, the same one the single-range route draws: the accounts
    // whose ledger cash the valuation actually walks, on both sides of a
    // transfer.
    const cashScope = scope
      .filter((row) => isValuationCashAccount(row))
      .map((row) => row.id);
    const query = (sql: string, params: unknown[]) =>
      withScopedDb(this.dataSource, (m) => m.query(sql, params));

    const [series, flowRows, investedRows, unmeasuredRows] = await Promise.all([
      this.netWorth.getDailyInvestments(
        userId,
        earliest,
        end,
        opts.accountIds,
        currency,
        // One opt-out for the whole answer, as in the single-range route.
        { fetchMissing: opts.fetchMissing },
      ),
      loadExternalFlowSubtotals(query, {
        userId,
        // Exclusive, as in the single-range route: a flow dated on a preset's
        // baseline is already inside that preset's MV(b), and the per-preset
        // slice below keeps that exclusivity for every later baseline too.
        afterDate: earliest,
        throughDate: end,
        accountIds: cashScope,
        // A trade on the scope whose cash leg transfers into a sleeve settled
        // inside, not across the boundary (the QIF/CSV import's shape).
        investmentScope: scope.map((row) => row.id),
        perDay: true,
      }) as Promise<FlowSubtotalRow[]>,
      // The invested part's capital and income over the same widest window,
      // loaded ONCE beside the flows and sliced per preset exactly as they are.
      loadInvestedCapitalFlowRows(query, {
        userId,
        afterDate: earliest,
        throughDate: end,
        accountIds: scope.map((row) => row.id),
      }),
      loadUnmeasuredFlowRows(query, {
        userId,
        afterDate: earliest,
        throughDate: end,
        scope: scope.map((row) => row.id),
        cashScope,
        perDay: true,
      }),
    ]);

    if (series.length === 0) return allEmpty();

    // The closes a share-moving leg is valued at, over the widest window and
    // therefore shared by every preset's slice: the same series the value
    // chart was built from, so `IV` and `K` move by one number for one day's
    // shares (`docs/specs/portfolio-period-result.md` section 10.6).
    const shareLegClose = shareLegCloseFrom(
      await this.netWorth.loadValuationSeries(
        shareLegSecurityIds(investedRows),
        earliest,
        end,
      ),
    );

    // ONE index for the widest window, filled once: the fold over every row
    // names the months and pairs it is short of, the provider is asked once per
    // unit, and on a successful fill the index is re-read from the database.
    // Each preset's slice below folds against that same index, so a preset
    // cannot see a rate the whole window did not.
    const { rateIndex, investedByDay } = await computeWithRateFill(
      this.exchangeRates,
      async () => {
        const index = await buildFlowRateIndex(
          query,
          [...flowRows, ...investedRows],
          currency,
          earliest,
          end,
        );
        // Folded per DAY once, for the whole window: a day is the same day
        // whatever preset reads it, which is what makes a preset's slice
        // identical to what the single-range route would have folded for it.
        const invested = foldInvestedFlows(
          investedRows,
          currency,
          index,
          this.logger,
          shareLegClose,
        );
        return {
          rateIndex: index,
          investedByDay: invested.byDay,
          gaps: [
            ...foldFlowSubtotals(flowRows, currency, index, this.logger).gaps,
            ...invested.gaps,
          ],
        };
      },
      (built) => built.gaps,
      { fetchMissing: opts.fetchMissing },
      this.logger,
    );

    const last = series[series.length - 1];
    // Where each reported preset is measured from, resolved before anything is
    // built: the trading session behind each of those boundaries is one query
    // for all of them rather than one per preset.
    const boundaries = new Map(
      [...windows].map(([preset, windowStart]) => [
        preset,
        this.startBoundary(series, preset, windowStart),
      ]),
    );
    const pricedDays = await this.netWorth.getLastPricedDays(
      userId,
      [...boundaries.values()].flatMap((point) => (point ? [point.date] : [])),
      scope.map((row) => row.id),
    );
    const periods: Partial<
      Record<PortfolioPeriodPreset, PortfolioPeriodResult>
    > = {};
    for (const [preset, windowStart] of windows) {
      const start = boundaries.get(preset) ?? null;
      if (!start) {
        periods[preset] = empty(windowStart);
        continue;
      }
      // The lower bound the single-range route would have been given for this
      // preset: its baseline where it has one, its window start otherwise.
      const from = usesPriorCloseBaseline(preset) ? start.date : windowStart;
      // A row with no date is kept: the fold reports it as unknown, which
      // withholds the flow rather than quietly dropping money out of it.
      const flow = foldFlowSubtotals(
        flowRows.filter((row) => row.date === null || row.date > from),
        currency,
        rateIndex,
        this.logger,
      );
      const unmeasuredFlows = unmeasuredFlowsAfter(unmeasuredRows, from);
      const startIndex = series.indexOf(start);
      periods[preset] = {
        currency,
        startDate: start.date,
        startPriceDate: pricedDays.get(start.date) ?? null,
        endDate: last.date,
        ...decidePeriodResult({ start, end: last, flow, unmeasuredFlows }),
        // This preset's OWN slice of the one series, so a preset reports the
        // gaps inside its window and not the wider window's: the single-range
        // route folds exactly the points it valued, and these two must answer
        // the same thing for the same window.
        incompleteRanges: foldIncompleteData(
          withFlowUnpricedSecurities(series.slice(startIndex), investedByDay),
        ),
        // The same one series, sliced at this preset's own boundary: the TWR
        // for a preset is a product over that preset's days, O(days), over the
        // per-day flows folded once above.
        ...investedPeriodResult({
          points: series,
          startIndex,
          endIndex: series.length - 1,
          flowsByDay: investedByDay,
        }),
      };
    }

    return { currency, asOf: end, periods };
  }

  /**
   * Where the preset is measured FROM, as a point of the series.
   *
   * A prior-close preset takes the last point on or before the day before its
   * window's first point: the close the session opened against. Every other
   * preset takes the first point inside its window, which already IS the close
   * of the day the window opens on. `null` when the series does not reach back
   * that far, which is a period this scope cannot report rather than one that
   * did nothing.
   *
   * `all` is a prior-close preset whose window opens on the scope's first
   * holding: its baseline is the close the day before that purchase, which the
   * series carries because `presetEarliestDate` loads from it.
   */
  private startBoundary<T extends { date: string }>(
    series: readonly T[],
    preset: PortfolioPeriodPreset,
    windowStart: string,
  ): T | null {
    const firstInWindow = series.find((point) => point.date >= windowStart);
    if (!firstInWindow) return null;
    if (!usesPriorCloseBaseline(preset)) {
      // A window the series does not reach back to is a period this scope
      // cannot report. Measuring from the first day it held anything instead
      // would put a figure under a caption promising a whole year of it -- the
      // "n/a rather than 0%" rule the security card already keeps.
      return series[0].date <= windowStart ? firstInWindow : null;
    }

    const baseline = addDaysYMD(firstInWindow.date, -1);
    let prior: T | null = null;
    for (const point of series) {
      if (point.date > baseline) break;
      prior = point;
    }
    return prior;
  }
}
