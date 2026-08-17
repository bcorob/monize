import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { DataSource, EntityManager, In } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { todayYMD } from "../common/date-utils";
import { roundToDecimals } from "../common/round.util";
import { tr } from "../i18n/translate";
import {
  PRICE_WINDOW_LEAD_DAYS,
  PricePoint,
  addDays,
  daysBetween,
  observationAt,
  withLeadDays,
} from "../common/time-series/price-boundary.util";
import {
  LoadedPriceSeries,
  PriceSampling,
  loadPriceSeries,
} from "../common/time-series/price-series.util";
import { Security } from "./entities/security.entity";
import { MarketIndexService } from "./market-index.service";
import { SecurityPriceService } from "./security-price.service";
import { marketIndexByCode } from "./market-indexes";
import {
  PerformanceComparisonView,
  PerformanceExclusion,
  PerformanceExclusionReason,
  PerformanceGap,
  PerformancePoint,
  PerformanceSeriesKind,
  PerformanceSeriesRef,
} from "./performance-comparison.types";

/** Percentage points, rounded the way every return figure in this app is. */
const PP_DECIMALS = 4;

/**
 * Sampling by window length. Daily closes are what the shorter windows are for;
 * over a decade they ship tens of thousands of points the chart cannot draw
 * distinctly.
 */
function samplingFor(start: string, end: string): PriceSampling {
  const days = daysBetween(start, end);
  if (days <= 400) return "day";
  if (days <= 1300) return "week";
  return "month";
}

/**
 * How stale an observation may be and still stand for a plotted date.
 *
 * Carrying a series forward between observations is deliberate: a market holiday
 * in one country must not punch a hole in the others' lines. Unbounded, the same
 * mechanism draws a delisted instrument as a perfectly flat line across every
 * month since its feed stopped, and reports the level it stopped at as the
 * window's return -- a stale quote wearing today's date.
 *
 * One sampling bucket plus a closed market. The same table answers the boundary
 * lookup at the window start, because a monthly series genuinely has no
 * observation within a fortnight of an arbitrary date and refusing on the daily
 * bound would exclude every series on a long window.
 */
const LAG_DAYS: Record<PriceSampling, number> = {
  day: 10,
  week: 21,
  month: 45,
};

/**
 * How long after a deep-backfill attempt the same security may be asked again.
 * The same six hours GEM's history backfill uses, for the same reason: a
 * provider that cannot serve the symbol must not be re-asked on every render.
 */
const SECURITY_BACKFILL_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/**
 * How far after the wanted start a security's usable history may begin and
 * still count as covering it. A trading week, matching the index side.
 */
const SECURITY_COVERAGE_TOLERANCE_DAYS = 7;

/**
 * The provider range that covers `days` of history.
 *
 * Each tier keeps about two months of headroom under its nominal span, so the
 * fetched history still reaches a lead-days-widened boundary; more headroom
 * than that just promotes ordinary requests a whole tier up.
 */
function backfillRangeFor(days: number): string {
  const months = days / 30.44;
  if (months <= 10) return "1y";
  if (months <= 58) return "5y";
  if (months <= 118) return "10y";
  return "max";
}

export interface PerformanceComparisonRequest {
  securityIds: string[];
  indexCodes: string[];
  /** Omitted means "all history", resolved from the data (contract section 2.5). */
  startDate?: string;
  endDate?: string;
}

/** A candidate line, before we know whether it can be drawn. */
interface Candidate {
  key: string;
  kind: PerformanceSeriesKind;
  id: string;
  label: string;
  name: string;
  currencyCode: string;
}

/** A candidate that resolved a base, and can therefore be plotted. */
interface Resolved extends Candidate {
  points: PricePoint[];
  base: number;
  baseDate: string;
  basis: LoadedPriceSeries["basis"];
}

/**
 * The Security Performance report's comparison chart.
 *
 * Every line is a cumulative percent return rebased at the window's **start**,
 * so instruments with different price levels and currencies compare on one axis
 * and a benchmark can be read against a holding. A series that cannot be priced
 * at that boundary is refused with a reason rather than rebased on its own later
 * first observation, which would report the window's return measured from a date
 * the label does not mention.
 *
 * `docs/security-benchmark-comparison.md` is the specification; it carries the
 * exclusion truth table, the worked examples and the test matrix.
 */
@Injectable()
export class PerformanceComparisonService {
  private readonly logger = new Logger(PerformanceComparisonService.name);

  constructor(
    private dataSource: DataSource,
    private marketIndexService: MarketIndexService,
    private securityPriceService: SecurityPriceService,
  ) {}

  async getComparison(
    userId: string,
    request: PerformanceComparisonRequest,
  ): Promise<PerformanceComparisonView> {
    const securityIds = [...new Set(request.securityIds)];
    const indexCodes = [...new Set(request.indexCodes)].filter(
      (code) => marketIndexByCode(code) !== undefined,
    );

    // Ownership first, and under the caller's own scope: an id that is not
    // theirs must not reach a price query, let alone appear in the payload.
    const securities = await this.loadOwnedSecurities(userId, securityIds);

    const end = request.endDate ?? todayYMD();

    // The securities' priced history has to reach the window before the window
    // can be honest about them. Creation backfills one year, and every earlier
    // close may be transaction-derived -- raw rows the basis rule rightly
    // refuses to splice into an adjusted series -- so a holding bought in 2010
    // can be unpriceable in 2010 until the provider history is actually
    // fetched. Mirrors the index side, cooldown included; failures leave the
    // security unpriced, which the exclusion list reports.
    await this.ensureSecuritiesHistory(securities, request.startDate ?? null);

    // An open-ended window is measured off the securities, and that question is
    // answered from their own rows -- so it is asked first and the benchmarks
    // are then fetched to fit it, rather than fetched blind and allowed to set
    // a boundary from decades the user has no part in.
    //
    // With no securities selected there is nothing to measure off, so the index
    // is the subject: its full history has to be in hand before its own earliest
    // observation can be read, and `null` is what asks for it. Resolving first
    // there would open the window on today and draw a single day.
    const securityStart =
      request.startDate ??
      (securities.length > 0
        ? await this.resolveSecuritiesStart(securities.map((s) => s.id))
        : null);

    // Failures here leave the index unpriced, which the exclusion list then
    // reports; they are not allowed to take the securities' lines down.
    await this.marketIndexService.ensureHistory(indexCodes, securityStart);

    const start =
      securityStart ?? (await this.resolveIndexesStart(indexCodes)) ?? end;

    const sampling = samplingFor(start, end);
    const lag = LAG_DAYS[sampling];
    // The lookup that prices the window's start searches backwards, so the read
    // must reach behind the boundary by at least what the rule will accept.
    const loadFrom = withLeadDays(start, Math.max(lag, PRICE_WINDOW_LEAD_DAYS));

    const [securitySeries, indexSeries] = await withScopedDb(
      this.dataSource,
      async (m: EntityManager) => [
        await loadPriceSeries(m, {
          table: "security_prices",
          ids: securities.map((s) => s.id),
          fromDate: loadFrom,
          toDate: end,
          sampling,
        }),
        await this.marketIndexService.loadSeries(
          indexCodes,
          loadFrom,
          end,
          sampling,
          m,
        ),
      ],
    );

    const candidates: Array<{
      candidate: Candidate;
      loaded: LoadedPriceSeries | undefined;
    }> = [
      ...securities
        .slice()
        .sort((a, b) => a.symbol.localeCompare(b.symbol))
        .map((security) => ({
          candidate: {
            key: `sec:${security.id}`,
            kind: "SECURITY" as const,
            id: security.id,
            label: security.symbol,
            name: security.name,
            currencyCode: security.currencyCode,
          },
          loaded: securitySeries.get(security.id),
        })),
      // Benchmarks last, so the categorical palette assigns the same colour to
      // the same security whether or not an index is overlaid.
      ...indexCodes
        .map((code) => marketIndexByCode(code))
        .filter((index) => index !== undefined)
        .sort((a, b) => a.defaultName.localeCompare(b.defaultName))
        .map((index) => ({
          candidate: {
            key: `idx:${index.code}`,
            kind: "INDEX" as const,
            id: index.code,
            label: index.code,
            name: index.defaultName,
            currencyCode: index.currencyCode,
          },
          loaded: indexSeries.get(index.code),
        })),
    ];

    const resolved: Resolved[] = [];
    const excluded: PerformanceExclusion[] = [];

    for (const { candidate, loaded } of candidates) {
      const outcome = this.resolveBase(loaded, start, end, lag);
      if ("reason" in outcome) {
        excluded.push({
          key: candidate.key,
          kind: candidate.kind,
          id: candidate.id,
          label: candidate.label,
          reason: outcome.reason,
        });
        continue;
      }
      resolved.push({ ...candidate, ...outcome });
    }

    return this.build({ start, end, sampling, lag, resolved, excluded });
  }

  /**
   * The base close a series is rebased on, or the reason it has none.
   *
   * Four refusals, not one. They are answered differently by the reader -- "we
   * hold nothing for this" is a data gap to fill, "its history starts later" is
   * a window to widen, and collapsing them into an absent line tells them
   * neither.
   */
  private resolveBase(
    loaded: LoadedPriceSeries | undefined,
    start: string,
    end: string,
    lag: number,
  ):
    | {
        points: PricePoint[];
        base: number;
        baseDate: string;
        basis: LoadedPriceSeries["basis"];
      }
    | { reason: PerformanceExclusionReason } {
    const points = loaded?.points ?? [];
    if (points.length === 0) return { reason: "NO_PRICE_HISTORY" };

    const base = observationAt(points, start, lag);
    if (!base) return { reason: "NO_PRICE_AT_WINDOW_START" };
    if (!(base.close > 0)) return { reason: "NON_POSITIVE_BASE" };

    // Both ends of a short window can resolve to the same row, and the
    // arithmetic then returns exactly zero -- a hard 0% that counts itself as a
    // fully covered period (docs/time-series-contract.md section 2.3).
    const hasLater = points.some(
      (point) => point.date > base.date && point.date <= end,
    );
    if (!hasLater) return { reason: "SINGLE_OBSERVATION" };

    return {
      points,
      base: base.close,
      baseDate: base.date,
      basis: loaded?.basis ?? "RAW",
    };
  }

  /** Assemble the plotted points, totals, gaps and completeness. */
  private build(params: {
    start: string;
    end: string;
    sampling: PriceSampling;
    lag: number;
    resolved: Resolved[];
    excluded: PerformanceExclusion[];
  }): PerformanceComparisonView {
    const { start, end, sampling, lag, resolved, excluded } = params;

    const series: PerformanceSeriesRef[] = resolved.map((entry) => ({
      key: entry.key,
      kind: entry.kind,
      id: entry.id,
      label: entry.label,
      name: entry.name,
      currencyCode: entry.currencyCode,
      basis: entry.basis,
    }));

    // The window's own start and end are always plotted. The start because
    // every included series is rebased there, so they leave the axis together
    // at 0% and the reader can see the comparison is like for like; the end
    // because a series whose feed stopped has to be shown running out, and
    // without a sample there it simply ends at its last observation and reads
    // as a complete line.
    const dates = new Set<string>([start, end]);
    for (const entry of resolved) {
      for (const point of entry.points) {
        if (point.date > start && point.date <= end) dates.add(point.date);
      }
      // A stride longer than the carry bound is a stretch nobody observed, and
      // the plotted dates alone will not reveal it: where every series shares
      // the hole there is no sample inside it, so the line is drawn straight
      // across months of nothing. Section 2.4 of the time-series contract is
      // explicit that two boundaries say nothing about the interior -- so the
      // stride is measured and a sample planted just past the bound, where the
      // series evaluates to null and the line breaks.
      const walk = [{ date: start, close: entry.base }, ...entry.points];
      for (let i = 1; i < walk.length; i += 1) {
        const previous = walk[i - 1].date;
        const next = walk[i].date;
        if (next <= previous || daysBetween(previous, next) <= lag) continue;
        const breakDate = addDays(previous, lag + 1);
        if (breakDate > start && breakDate < next && breakDate <= end) {
          dates.add(breakDate);
        }
      }
    }
    const orderedDates = [...dates].sort();

    const points: PerformancePoint[] = orderedDates.map((date) => {
      const values: Record<string, number | null> = {};
      for (const entry of resolved) {
        const close = observationAt(entry.points, date, lag)?.close ?? null;
        values[entry.key] =
          close === null
            ? null
            : roundToDecimals((close / entry.base - 1) * 100, PP_DECIMALS);
      }
      return { date, values };
    });

    const gaps: PerformanceGap[] = [];
    for (const entry of resolved) {
      let openFrom: string | null = null;
      let openTo: string | null = null;
      for (const point of points) {
        if (point.values[entry.key] === null) {
          openFrom = openFrom ?? point.date;
          openTo = point.date;
        } else if (openFrom && openTo) {
          gaps.push({ key: entry.key, from: openFrom, to: openTo });
          openFrom = null;
          openTo = null;
        }
      }
      if (openFrom && openTo) {
        gaps.push({ key: entry.key, from: openFrom, to: openTo });
      }
    }

    const last = points[points.length - 1];
    const totals: Record<string, number | null> = {};
    for (const entry of resolved) {
      // The window's return, or nothing. A series whose feed stopped in March is
      // not up 20% over the year: it is up 20% to March and unknown since.
      totals[entry.key] = last?.values[entry.key] ?? null;
    }

    const status =
      excluded.length === 0 &&
      gaps.length === 0 &&
      resolved.length > 0 &&
      resolved.every((entry) => totals[entry.key] !== null)
        ? "complete"
        : "incomplete";

    return {
      window: { start, end },
      sampling,
      series,
      points: resolved.length === 0 ? [] : points,
      totals,
      gaps,
      excluded,
      status,
    };
  }

  /**
   * The securities the caller actually owns.
   *
   * A missing id is a `404` for the whole request rather than a quietly dropped
   * line: a chart that silently omits one of the instruments you asked for is a
   * chart you will read as complete.
   */
  private async loadOwnedSecurities(
    userId: string,
    securityIds: string[],
  ): Promise<Security[]> {
    if (securityIds.length === 0) return [];
    const securities = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Security).find({
        where: { userId, id: In(securityIds) },
      }),
    );
    if (securities.length !== securityIds.length) {
      throw new NotFoundException(
        tr(
          "errors.securities.selectionNotFound",
          "One or more of the selected securities could not be found",
        ),
      );
    }
    return securities;
  }

  /**
   * Per-security activity: where its **usable** priced history begins, and when
   * the user first transacted in it.
   *
   * "Usable" is the operative word, and it is the basis rule restated as a
   * window question. The loader keeps only the adjusted rows for an instrument
   * that has any (`docs/time-series-contract.md` rule 1), so a raw
   * transaction-derived close from 2010 sitting beside adjusted provider rows
   * from 2025 is a row the read will never return. Counting it -- a plain
   * `MIN(price_date)` -- opened the window on a date the series cannot answer,
   * and the instrument was excluded from its own chart with
   * `NO_PRICE_AT_WINDOW_START` while a price row for that very day sat in the
   * table. The first price here is therefore computed on the same basis the
   * loader will choose: the first adjusted row where any exist, the first raw
   * row where none do.
   */
  private async securityActivity(
    securityIds: string[],
  ): Promise<
    Map<
      string,
      { firstUsablePrice: string | null; firstTransaction: string | null }
    >
  > {
    const activity = new Map<
      string,
      { firstUsablePrice: string | null; firstTransaction: string | null }
    >();
    if (securityIds.length === 0) return activity;
    const rows: Array<{
      security_id: string;
      first_usable_price: string | null;
      first_transaction: string | null;
    }> = await withScopedDb(this.dataSource, (m) =>
      m.query(
        `SELECT ids.security_id,
                p.first_usable_price::text AS first_usable_price,
                t.first_transaction::text AS first_transaction
           FROM unnest($1::uuid[]) AS ids(security_id)
           LEFT JOIN (
             SELECT security_id,
                    CASE WHEN bool_or(adjusted_close IS NOT NULL)
                         THEN MIN(price_date) FILTER (WHERE adjusted_close IS NOT NULL)
                         ELSE MIN(price_date)
                    END AS first_usable_price
               FROM security_prices
              WHERE security_id = ANY($1::uuid[])
                AND close_price IS NOT NULL
              GROUP BY security_id
           ) p ON p.security_id = ids.security_id
           LEFT JOIN (
             SELECT security_id, MIN(transaction_date) AS first_transaction
               FROM investment_transactions
              WHERE security_id = ANY($1::uuid[])
                AND status != 'VOID'
              GROUP BY security_id
           ) t ON t.security_id = ids.security_id`,
        [securityIds],
      ),
    );
    for (const row of rows) {
      activity.set(row.security_id, {
        firstUsablePrice: row.first_usable_price,
        firstTransaction: row.first_transaction,
      });
    }
    return activity;
  }

  /**
   * Fetch the provider history a selected security is missing, before the
   * window is resolved against what is stored.
   *
   * The index side has had this from the start (`ensureHistory`); the
   * securities did not, and the gap showed: creation backfills one year, so an
   * all-time request on a holding bought in 2010 had nothing usable to open on.
   * The wanted start is the requested date for a named window, and the first
   * transaction for an open-ended one -- a watch-list security with no
   * transactions wants nothing deeper than it has.
   *
   * The cooldown is `securities.historical_backfill_attempted_at`, stamped for
   * every attempt whether or not it improved the data, exactly as GEM's
   * backfill stamps it: the cooldown exists to spare the provider. Failures are
   * logged and swallowed -- an unpriced security becomes an exclusion, not a
   * failed request.
   */
  private async ensureSecuritiesHistory(
    securities: Security[],
    requestedStart: string | null,
  ): Promise<void> {
    if (securities.length === 0) return;
    const activity = await this.securityActivity(securities.map((s) => s.id));
    const today = todayYMD();
    const now = Date.now();

    const due: Array<{ security: Security; wantedFrom: string }> = [];
    for (const security of securities) {
      const known = activity.get(security.id);
      const wanted = requestedStart ?? known?.firstTransaction ?? null;
      if (!wanted) continue;
      const covered =
        known?.firstUsablePrice !== null &&
        known?.firstUsablePrice !== undefined &&
        known.firstUsablePrice <=
          addDays(wanted, SECURITY_COVERAGE_TOLERANCE_DAYS);
      if (covered) continue;
      const last = security.historicalBackfillAttemptedAt;
      const lastMs =
        last instanceof Date ? last.getTime() : Date.parse(String(last ?? ""));
      if (
        Number.isFinite(lastMs) &&
        now - lastMs < SECURITY_BACKFILL_COOLDOWN_MS
      ) {
        continue;
      }
      due.push({ security, wantedFrom: wanted });
    }
    if (due.length === 0) return;

    await Promise.all(
      due.map(({ security, wantedFrom }) =>
        this.securityPriceService
          .backfillSecurityRange(
            security,
            backfillRangeFor(daysBetween(wantedFrom, today)),
          )
          .catch((error: unknown) => {
            this.logger.warn(
              `Comparison history backfill failed for ${security.symbol}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
            return 0;
          }),
      ),
    );

    // Stamp every attempt, successful or not: the cooldown exists to spare the
    // provider, not to record whether the data improved.
    await withScopedDb(this.dataSource, (m) =>
      m
        .getRepository(Security)
        .update(
          { id: In(due.map(({ security }) => security.id)) },
          { historicalBackfillAttemptedAt: new Date() },
        ),
    );
  }

  /**
   * Where an open-ended window opens when securities are selected.
   *
   * **The securities set it; the benchmarks follow.** A market index carries
   * decades the user has no part in -- the S&P 500 reaches back to 1927 -- so
   * taking the earliest observation across the whole selection opened "all
   * time" in 1927, and every security was then excluded for having no price at
   * that boundary. The chart drew the benchmark alone, which is the opposite of
   * what it is for.
   *
   * Per security the start is the later of two dates, and both bounds matter:
   *
   * - the first **usable** stored close -- on the basis the loader will choose,
   *   see `securityActivity` -- because a window opening before the instrument
   *   can be priced excludes the very thing it was derived from;
   * - the first transaction, because prices are backfilled further than a
   *   holding goes and years before the user owned anything are not their
   *   performance. A security with no transactions -- a watch-list entry -- has
   *   only the first bound.
   *
   * Across several securities it is the **latest** of those starts, so every
   * one of them can be priced at the boundary and the comparison is like for
   * like. Opening earlier would draw one line and exclude the rest.
   *
   * `docs/time-series-contract.md` section 2.5: the answer to "when does the
   * data start" is a query against the scope the request names, never a
   * constant.
   */
  private async resolveSecuritiesStart(
    securityIds: string[],
  ): Promise<string | null> {
    const activity = await this.securityActivity(securityIds);
    let latest: string | null = null;
    for (const { firstUsablePrice, firstTransaction } of activity.values()) {
      if (!firstUsablePrice) continue;
      const start =
        firstTransaction && firstTransaction > firstUsablePrice
          ? firstTransaction
          : firstUsablePrice;
      if (latest === null || start > latest) latest = start;
    }
    return latest;
  }

  /**
   * Where an open-ended window opens with no securities to measure off: the
   * index is the subject rather than the yardstick, and its own earliest
   * observation is the answer.
   */
  private async resolveIndexesStart(
    indexCodes: string[],
  ): Promise<string | null> {
    if (indexCodes.length === 0) return null;
    const rows: Array<{ start: string | null }> = await withScopedDb(
      this.dataSource,
      (m) =>
        m.query(
          `SELECT MIN(price_date)::text AS start
             FROM market_index_prices
            WHERE index_code = ANY($1::text[])`,
          [indexCodes],
        ),
    );
    return rows[0]?.start ?? null;
  }
}
