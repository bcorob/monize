import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { DataSource, EntityManager } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { withSystemContext } from "../common/db/with-context";
import { todayYMD } from "../common/date-utils";
import {
  PRICE_WINDOW_LEAD_DAYS,
  addDays,
  withLeadDays,
} from "../common/time-series/price-boundary.util";
import {
  LoadedPriceSeries,
  PriceSampling,
  loadPriceSeries,
} from "../common/time-series/price-series.util";
import { YahooFinanceService } from "./yahoo-finance.service";
import { HistoricalPrice } from "./providers/quote-provider.interface";
import {
  MAX_DAILY_GAP_DAYS,
  medianGapDays,
} from "./providers/daily-spacing.util";
import {
  MARKET_INDEXES,
  MarketIndexDefinition,
  marketIndexByCode,
} from "./market-indexes";
import {
  describeFetchFailure,
  isTransportFailure,
} from "../common/http/fetch-failure.util";
import { ProviderHealthService } from "../provider-health/provider-health.service";
import { isProviderUnavailable } from "../provider-health/provider-unavailable.error";
import { TrackedProviderId } from "../provider-health/providers";

/** The provider the index closes come from, for availability reporting. */
const HEALTH_PROVIDER_ID: TrackedProviderId = "yahoo_finance";

/** True when the failure is the provider's, rather than this service's own. */
function isProviderFailure(error: unknown): boolean {
  return isProviderUnavailable(error) || isTransportFailure(error);
}

/** Where an index's stored history begins and ends, and how dense it is. */
export interface MarketIndexCoverage {
  earliestDate: string | null;
  latestDate: string | null;
  /**
   * Mean days between stored observations across the whole span. A daily
   * series sits near 1.4 (weekends); monthly bars sit near 30. What this
   * exists to catch: rows stored by an earlier version from a provider
   * response that had silently gone coarse. Those rows are not merely sparse
   * -- a month bar stamped on the 1st carries the month's close under the
   * wrong date -- and the coverage span alone calls them "covered" forever.
   */
  averageGapDays: number | null;
}

/** A catalog entry with what we actually hold for it. */
export interface MarketIndexView extends MarketIndexDefinition {
  coverage: MarketIndexCoverage;
}

/**
 * How long after an attempt the same index may be fetched again.
 *
 * An index the provider cannot serve leaves no rows, so "do we have history back
 * to the window start" stays false and the on-demand backfill would fire on
 * every chart render. Six hours matches the per-security backfill cooldown in
 * `GemBackfillService`.
 */
export const INDEX_FETCH_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/**
 * How stale the newest stored close may be before the on-demand path tops the
 * series up rather than waiting for the next scheduled refresh. Generous enough
 * to span a long weekend, so an ordinary Monday morning does not fetch.
 */
const TOP_UP_AFTER_DAYS = 5;

/**
 * How far after a requested window start an index's stored history may begin and
 * still count as covering it. One trading week: shorter and a bank holiday at
 * the window edge triggers a pointless refetch.
 */
const COVERAGE_TOLERANCE_DAYS = 7;

/** Days of recent history the scheduled refresh re-requests. */
const REFRESH_WINDOW_DAYS = 10;

const SOURCE = "yahoo_finance";

/**
 * How far back a deep fetch reaches when the deployment holds no investment
 * transactions to measure from. A deployment with no transactions has no
 * holding to benchmark, so a modest decade serves the standalone index view
 * without fetching a century nobody asked about.
 */
const FALLBACK_HISTORY_YEARS = 10;

/**
 * The widest span one provider request may cover.
 *
 * The deep fetch is chunked into windows of at most this many days -- year by
 * year, in effect -- because a single request spanning decades is exactly the
 * shape the provider answers with coarser bars. A one-year window always comes
 * back daily, so chunking is what makes "daily from the first transaction
 * onward" actually deliverable rather than merely requested.
 */
const FETCH_CHUNK_DAYS = 365;

/** ISO date `years` from `date`. */
function withYears(date: string, years: number): string {
  const shifted = new Date(`${date}T00:00:00Z`);
  shifted.setUTCFullYear(shifted.getUTCFullYear() + years);
  return shifted.toISOString().slice(0, 10);
}

interface UpsertRow {
  indexCode: string;
  priceDate: string;
  closePrice: number;
  adjustedClose: number | null;
}

/**
 * Daily closes for the curated market indexes.
 *
 * Indexes are global reference data, so everything here is deployment-wide: one
 * fetch per index serves every user, and the rows carry no owner. That is the
 * whole reason the catalog is not modelled as user-owned `securities` rows --
 * see `market-indexes.ts` and the exemption note in `database/schema.sql`.
 */
@Injectable()
export class MarketIndexService implements OnApplicationBootstrap {
  private readonly logger = new Logger(MarketIndexService.name);

  constructor(
    private dataSource: DataSource,
    private yahooFinanceService: YahooFinanceService,
    private readonly health: ProviderHealthService,
  ) {}

  /**
   * The catalog with the stored coverage per index, so the picker can grey out
   * an index we cannot yet draw instead of offering it and rendering nothing.
   *
   * An index with no rows gets `{ earliestDate: null, latestDate: null }`, which
   * is "we hold nothing" -- distinct from a coverage window that happens to be
   * short.
   */
  async listCatalog(): Promise<MarketIndexView[]> {
    const rows: Array<{
      index_code: string;
      earliest: string | null;
      latest: string | null;
      avg_gap_days: string | number | null;
    }> = await withScopedDb(this.dataSource, (m) =>
      m.query(
        `SELECT index_code,
                MIN(price_date)::text AS earliest,
                MAX(price_date)::text AS latest,
                (MAX(price_date) - MIN(price_date))::float
                  / GREATEST(COUNT(*) - 1, 1) AS avg_gap_days
           FROM market_index_prices
          GROUP BY index_code`,
      ),
    );
    const byCode = new Map(rows.map((row) => [row.index_code, row]));
    return MARKET_INDEXES.map((index) => {
      const row = byCode.get(index.code);
      const gap = row?.avg_gap_days == null ? null : Number(row.avg_gap_days);
      return {
        ...index,
        coverage: {
          earliestDate: row?.earliest ?? null,
          latestDate: row?.latest ?? null,
          averageGapDays: gap !== null && Number.isFinite(gap) ? gap : null,
        },
      };
    });
  }

  /**
   * Close prices per index code, through the same door and with the same
   * per-series basis rule as a security's prices.
   */
  async loadSeries(
    codes: readonly string[],
    fromDate: string,
    toDate?: string,
    sampling: PriceSampling = "day",
    manager?: EntityManager,
  ): Promise<Map<string, LoadedPriceSeries>> {
    if (codes.length === 0) return new Map();
    const load = (m: EntityManager) =>
      loadPriceSeries(m, {
        table: "market_index_prices",
        ids: codes,
        fromDate,
        toDate,
        sampling,
      });
    return manager
      ? load(manager)
      : withScopedDb(this.dataSource, (m) => load(m));
  }

  /**
   * Make sure each index's stored history reaches back to `fromDate` and
   * forward to roughly now, fetching what is missing.
   *
   * Awaited rather than fired and forgotten: a chart that renders before its
   * data arrives shows an index as unavailable and gives the reader no reason to
   * try again. The cooldown is what keeps that affordable -- an index the
   * provider will not serve is asked at most once every
   * `INDEX_FETCH_COOLDOWN_MS`, not once per render.
   *
   * Failures are recorded and swallowed. A provider outage must leave the index
   * *unpriced*, which the comparison then reports as an exclusion; turning it
   * into a request failure would take the securities' lines down with it.
   */
  async ensureHistory(
    codes: readonly string[],
    fromDate: string | null,
  ): Promise<void> {
    if (codes.length === 0) return;
    const definitions = codes
      .map((code) => marketIndexByCode(code))
      .filter((index): index is MarketIndexDefinition => index !== undefined);
    if (definitions.length === 0) return;

    const [coverage, attempts] = await Promise.all([
      this.coverageFor(definitions.map((index) => index.code)),
      this.lastAttempts(definitions.map((index) => index.code)),
    ]);

    const now = Date.now();
    const today = todayYMD();
    // The lookup that prices the window's start searches backwards, so the
    // fetch has to reach behind the boundary by the same span the rule accepts.
    // A null `fromDate` is "all time", which has no boundary to reach behind:
    // the deep window is what is wanted.
    const wantedFrom = fromDate
      ? withLeadDays(fromDate, PRICE_WINDOW_LEAD_DAYS)
      : null;
    const staleBefore = withLeadDays(today, TOP_UP_AFTER_DAYS);
    const acceptableStart = wantedFrom
      ? withLeadDays(wantedFrom, -COVERAGE_TOLERANCE_DAYS)
      : null;

    const due = definitions.filter((index) => {
      const attempted = attempts.get(index.code);
      if (attempted && now - attempted.getTime() < INDEX_FETCH_COOLDOWN_MS) {
        return false;
      }
      const held = coverage.get(index.code);
      if (!held?.earliestDate || !held.latestDate) return true;
      // A stored series coarser than daily is corrupt, not covered: an earlier
      // version stored a provider response that had silently gone monthly, and
      // the span test alone would call it complete forever. It is refetched
      // daily and overwritten in place.
      if (this.isCoarse(held)) return true;
      if (held.latestDate < staleBefore) return true;
      // With no requested start, whatever is stored is the history: only
      // staleness at the near end or coarseness can make it due. Treating "all
      // time" as unsatisfiable would refetch on every open-ended request.
      return acceptableStart !== null && held.earliestDate > acceptableStart;
    });
    if (due.length === 0) return;

    // Daily history is pulled from the first year the deployment recorded an
    // investment transaction, and onward -- the store is global, so one user's
    // fetch serves everyone comparing against the same index.
    const deepFrom = await this.deepHistoryStart(today);

    for (const index of due) {
      const held = coverage.get(index.code);
      const fineEarliest =
        held?.earliestDate && held.latestDate && !this.isCoarse(held)
          ? held.earliestDate
          : null;
      let from: string;
      if (fineEarliest === null) {
        // Nothing stored, or a coarse series to overwrite: the full daily
        // history. A first fetch bounded to the request would store exactly
        // that span and then sit behind the cooldown for six hours, so a user
        // who widened the window straight afterwards would be told the
        // benchmark could not be priced at the new boundary.
        from = this.earlierOf(wantedFrom, deepFrom);
      } else if (acceptableStart !== null && fineEarliest > acceptableStart) {
        // A fine series the window outreaches: extend it backward, through
        // today, so a stale near end is caught by the same fetch.
        from = wantedFrom as string;
      } else {
        // A fine series that is merely stale at the near end.
        from = withLeadDays(today, REFRESH_WINDOW_DAYS);
      }
      await this.fetchInto(index, from, today, {
        replaceExisting: held !== undefined && this.isCoarse(held),
      });
    }
  }

  /** True when the stored observations are too far apart to be a daily series. */
  private isCoarse(coverage: MarketIndexCoverage): boolean {
    return (
      coverage.averageGapDays !== null &&
      coverage.averageGapDays > MAX_DAILY_GAP_DAYS
    );
  }

  /** The earlier of two dates, where null means "no bound from this side". */
  private earlierOf(a: string | null, b: string): string {
    return a !== null && a < b ? a : b;
  }

  /**
   * The first day of the earliest year any investment transaction was recorded,
   * or a fallback horizon when the deployment holds none.
   *
   * A genuinely cross-user read, deliberately: `market_index_prices` is global
   * reference data and one fetch serves every user, so the depth question is
   * "how far back does anyone's history go", not "how far back does the
   * caller's". Under enforcement a request-scoped MIN would see one user's rows
   * and store an index too shallow for everyone else. Nothing user-identifiable
   * leaves this method -- the answer only sizes a public index's fetch.
   */
  private async deepHistoryStart(today: string): Promise<string> {
    const rows: Array<{ earliest: string | null }> = await withSystemContext(
      () =>
        withScopedDb(this.dataSource, (m) =>
          m.query(
            `SELECT MIN(transaction_date)::text AS earliest
               FROM investment_transactions
              WHERE status != 'VOID'`,
          ),
        ),
    );
    const earliest = rows[0]?.earliest ?? null;
    if (earliest) return `${earliest.slice(0, 4)}-01-01`;
    return withYears(today, -FALLBACK_HISTORY_YEARS);
  }

  /**
   * Warm the store once at start-up.
   *
   * Without this a fresh deployment holds no index prices until the first
   * weekday 17:10 ET, and the picker has nothing useful to say about any of
   * them until then. Deliberately not awaited: an outbound provider call must
   * not sit between the process starting and it serving requests.
   *
   * It respects the per-index attempt cooldown, and the *scheduled* refresh
   * does not. That asymmetry is the point (issue #1265): a restart is not a new
   * day's worth of information, and an unreachable provider turned every
   * restart into 24 indexes x up to 11 yearly chunks of doomed requests -- while
   * the flood of failures was itself what made an operator restart the
   * container. The daily cron is a schedule the operator asked for; a restart
   * loop is not.
   */
  onApplicationBootstrap(): void {
    void withSystemContext(() =>
      this.refreshAll({ respectCooldown: true }),
    ).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Initial market index refresh failed: ${message}`);
    });
  }

  /**
   * Weekday refresh, five minutes after the FX refresh and ten after the
   * security prices, so the three do not contend for the same provider at the
   * same instant.
   *
   * Cross-user work with no request behind it, so it seeds its own system
   * context (`backend/CLAUDE.md`, cron section).
   */
  @Cron("10 17 * * 1-5", { timeZone: "America/New_York" })
  async scheduledRefresh(): Promise<void> {
    await withSystemContext(() => this.refreshAll());
  }

  /**
   * Top every catalog index up with recent closes; deep-fetch from scratch any
   * that hold nothing, and repair any whose stored series is coarser than
   * daily.
   *
   * @param options.respectCooldown skip indexes attempted within
   *   `INDEX_FETCH_COOLDOWN_MS`. The start-up warm-up passes it; the scheduled
   *   refresh does not, because a daily schedule is the request.
   */
  async refreshAll(options: { respectCooldown?: boolean } = {}): Promise<void> {
    const today = todayYMD();
    const coverage = await this.coverageFor(
      MARKET_INDEXES.map((index) => index.code),
    );
    const attempts = options.respectCooldown
      ? await this.lastAttempts(MARKET_INDEXES.map((index) => index.code))
      : new Map<string, Date>();
    const now = Date.now();
    const deepFrom = await this.deepHistoryStart(today);
    for (const index of MARKET_INDEXES) {
      const attempted = attempts.get(index.code);
      if (attempted && now - attempted.getTime() < INDEX_FETCH_COOLDOWN_MS) {
        continue;
      }
      const held = coverage.get(index.code);
      const fine = held?.latestDate && !this.isCoarse(held);
      const from = fine ? withLeadDays(today, REFRESH_WINDOW_DAYS) : deepFrom;
      await this.fetchInto(index, from, today, {
        replaceExisting: held !== undefined && this.isCoarse(held),
      });
    }
  }

  /**
   * The daily series for one index over `[from, to]`, written into the store.
   *
   * Fetched in windows of at most `FETCH_CHUNK_DAYS` -- year by year -- never
   * as one deep request and never as `range=max`. Asked for decades in one
   * breath the provider silently answers with monthly bars stamped on the 1st,
   * each carrying the month's close under the wrong date; stored, those drew
   * the benchmark as a horizontal stub repeated for days and then a gap. A
   * one-year window always comes back daily, so the chunking is what makes the
   * daily series actually arrive.
   *
   * The windows are requested **one after another**. They used to go out
   * together, which the circuit breaker turned into a defect: only one of them
   * can hold the half-open probe, so the rest were refused and read as empty
   * years -- one year stored as the whole history, with a success recorded over
   * it. Sequentially the first window is the probe and the ten behind it follow
   * a decision that has already been made, in either direction.
   */
  private async fetchInto(
    index: MarketIndexDefinition,
    from: string,
    to: string,
    options: { replaceExisting?: boolean } = {},
  ): Promise<void> {
    try {
      const chunks: Array<{ start: string; end: string }> = [];
      for (let start = from; start <= to; ) {
        const end = addDays(start, FETCH_CHUNK_DAYS - 1);
        chunks.push({ start, end: end < to ? end : to });
        start = addDays(end, 1);
      }

      // The first window goes alone; the rest go together behind it.
      //
      // All eleven at once was wrong once the breaker existed: exactly one of
      // them can hold the half-open probe, so even a *successful* probe left
      // ten refusals behind it and the whole fetch failed. All eleven in series
      // was wrong too -- `ensureHistory` is awaited inside a chart request, and
      // a cold index went from the slowest of eleven round trips to their sum.
      // One probe, then the batch: the breaker's answer is known before the ten
      // are attempted, and they still overlap.
      const prices: HistoricalPrice[] = [];
      const fetchWindow = (window: { start: string; end: string }) =>
        this.yahooFinanceService.fetchHistoricalWindow(
          index.yahooSymbol,
          null,
          new Date(`${window.start}T00:00:00Z`),
          new Date(`${window.end}T23:59:59Z`),
        );

      // `last_attempt_at` drives a six-hour cooldown, so it is stamped for a
      // request that actually left the process and not before: a call the
      // breaker refused is not an attempt, and recording one meant a provider
      // that recovered two minutes later still left the benchmark undrawable
      // until the evening. The check is "would it be refused *now*" rather than
      // "is the breaker open", because once the window has elapsed the request
      // below becomes the probe -- which is how a deployment holding no
      // securities at all (issue #1265's own) ever discovers Yahoo is back.
      if (this.health.wouldRefuse(HEALTH_PROVIDER_ID)) return;

      const first = await fetchWindow(chunks[0]);
      // The client swallows a refusal into the same `null` a failure gives, and
      // the breaker can open between the check above and the call: if it is
      // refusing now and nothing came back, this is the request that never left
      // rather than an attempt to stamp.
      if (first === null && this.health.wouldRefuse(HEALTH_PROVIDER_ID)) return;
      await this.recordAttempt(index.code);

      const rest =
        first === null
          ? []
          : await Promise.all(chunks.slice(1).map(fetchWindow));
      const fetched = [first, ...rest];

      for (let i = 0; i < fetched.length; i++) {
        const chunk = fetched[i];
        const { start, end } = chunks[i];

        // `null` is "no usable answer" -- a refusal, a transport failure, a
        // throttled response that outlasted its retries. `[]` is the provider
        // saying the window is empty, which is an ordinary year before the
        // index existed.
        //
        // A missing window refuses the *whole* fetch rather than storing the
        // years around it, for the reason the granularity guard below gives:
        // an index whose stored history has a hole draws a benchmark that is
        // silently wrong, while an unpriced index is reported as an exclusion
        // the user can act on. A first window with no answer also means the ten
        // behind it are never asked, so a provider that has stopped answering
        // costs one request per index rather than eleven.
        if (chunk === null) {
          await this.recordFailure(
            index.code,
            this.noAnswerReason(index, start, end),
          );
          return;
        }
        if (chunk.length === 0) continue;

        // A chunk coarser than daily is not a sparse daily series, it is a
        // different series -- and storing it beside daily closes produces a
        // benchmark with no price for most of every month.
        const spacing = medianGapDays(chunk.map((price) => price.date));
        if (spacing !== null && spacing > MAX_DAILY_GAP_DAYS) {
          await this.recordFailure(
            index.code,
            `${index.yahooSymbol} returned bars about ${spacing} day(s) apart; a daily series was requested`,
          );
          return;
        }
        prices.push(...chunk);
      }

      if (prices.length === 0) {
        // Every window answered, and every one of them was empty -- a window
        // with no answer stopped the loop above, so this really is the provider
        // saying it has no history for the symbol.
        await this.recordFailure(
          index.code,
          `no history returned for ${index.yahooSymbol}`,
        );
        return;
      }

      const rows: UpsertRow[] = prices
        .filter((price) => Number.isFinite(price.close) && price.close > 0)
        .map((price) => ({
          indexCode: index.code,
          priceDate: price.date.toISOString().slice(0, 10),
          closePrice: price.close,
          adjustedClose:
            price.adjClose !== null && Number.isFinite(price.adjClose)
              ? price.adjClose
              : null,
        }));

      if (rows.length === 0) {
        await this.recordFailure(
          index.code,
          `every bar for ${index.yahooSymbol} was unusable`,
        );
        return;
      }

      // A coarse series is *replaced*, not merely upserted over. Monthly bars
      // are stamped on the 1st, and the 1st is a weekend or a holiday often
      // enough that the daily refetch has no bar on that date to overwrite --
      // the wrong-dated close would survive under the fresh series and, for an
      // index whose provider sends no adjusted closes, splice into every read.
      // Running against a real database is what surfaced this: 2025-06-01 is a
      // Sunday, and the upsert-only repair left the bad row sitting on it. The
      // delete happens only after the fetch passed the granularity guard, so a
      // failed repair leaves the old data untouched rather than none.
      if (options.replaceExisting) {
        await withScopedDb(this.dataSource, (m) =>
          m.query(`DELETE FROM market_index_prices WHERE index_code = $1`, [
            index.code,
          ]),
        );
      }
      await this.bulkUpsert(rows);
      await this.recordSuccess(index.code);
      this.logger.log(
        `Stored ${rows.length} close(s) for ${index.code} (${index.yahooSymbol})`,
      );
    } catch (error) {
      // The stored reason names the cause, not just `fetch failed`: it is what
      // an operator reads when an index has no history, and what the outage
      // email quotes.
      const message = describeFetchFailure(error);
      await this.recordFailure(index.code, message);
      if (isProviderFailure(error)) {
        // Belt, not the main path: the provider client catches its own
        // transport failures and returns null (which lands in the empty-series
        // branch above), so what usually reaches here is *this* service's
        // problem. If a provider error ever does escape, it goes through the
        // rate-limited door -- 24 indexes failing the same way is one fact, not
        // 24 log lines.
        this.health.logFailure(
          this.logger,
          HEALTH_PROVIDER_ID,
          `market index refresh for ${index.code}`,
          error,
        );
        return;
      }
      // A failed upsert, a database that went away: not the provider's fault,
      // so it gets its own line rather than being rate-limited behind an
      // unrelated network failure -- or demoted to debug by one.
      this.logger.error(
        `Market index refresh for ${index.code} failed: ${message}`,
      );
    }
  }

  /**
   * Why one window came back with no usable answer, in the words an operator
   * needs.
   *
   * The provider client turns both a transport failure and a refusal into
   * `null`, and only the breaker knows which -- so it is asked rather than the
   * response. Saying "the index returned nothing" when nothing was *asked*
   * sends whoever reads `market_index_sync.last_error` looking for a symbol
   * problem that does not exist.
   */
  private noAnswerReason(
    index: MarketIndexDefinition,
    start: string,
    end: string,
  ): string {
    const health = this.health.snapshot(HEALTH_PROVIDER_ID);
    const because =
      health.state === "closed"
        ? "the provider gave no usable response"
        : `the provider is currently unavailable${
            health.lastFailureReason
              ? ` (last failure: ${health.lastFailureReason})`
              : ""
          }`;
    return `no answer for ${index.yahooSymbol} over ${start}..${end}: ${because}`;
  }

  /** Where each index's stored history begins and ends. */
  private async coverageFor(
    codes: readonly string[],
  ): Promise<Map<string, MarketIndexCoverage>> {
    const result = new Map<string, MarketIndexCoverage>();
    if (codes.length === 0) return result;
    const rows: Array<{
      index_code: string;
      earliest: string | null;
      latest: string | null;
      avg_gap_days: string | number | null;
    }> = await withScopedDb(this.dataSource, (m) =>
      m.query(
        `SELECT index_code,
                MIN(price_date)::text AS earliest,
                MAX(price_date)::text AS latest,
                (MAX(price_date) - MIN(price_date))::float
                  / GREATEST(COUNT(*) - 1, 1) AS avg_gap_days
           FROM market_index_prices
          WHERE index_code = ANY($1::text[])
          GROUP BY index_code`,
        [codes],
      ),
    );
    for (const row of rows) {
      const gap = row.avg_gap_days === null ? null : Number(row.avg_gap_days);
      result.set(row.index_code, {
        earliestDate: row.earliest,
        latestDate: row.latest,
        averageGapDays: gap !== null && Number.isFinite(gap) ? gap : null,
      });
    }
    return result;
  }

  /** When each index was last asked for, successfully or not. */
  private async lastAttempts(
    codes: readonly string[],
  ): Promise<Map<string, Date>> {
    const result = new Map<string, Date>();
    if (codes.length === 0) return result;
    const rows: Array<{ index_code: string; last_attempt_at: Date | null }> =
      await withScopedDb(this.dataSource, (m) =>
        m.query(
          `SELECT index_code, last_attempt_at
             FROM market_index_sync
            WHERE index_code = ANY($1::text[])`,
          [codes],
        ),
      );
    for (const row of rows) {
      if (row.last_attempt_at) {
        result.set(row.index_code, new Date(row.last_attempt_at));
      }
    }
    return result;
  }

  private async recordAttempt(code: string): Promise<void> {
    await withScopedDb(this.dataSource, (m) =>
      m.query(
        `INSERT INTO market_index_sync (index_code, last_attempt_at)
         VALUES ($1, NOW())
         ON CONFLICT (index_code)
         DO UPDATE SET last_attempt_at = NOW()`,
        [code],
      ),
    );
  }

  private async recordSuccess(code: string): Promise<void> {
    await withScopedDb(this.dataSource, (m) =>
      m.query(
        `UPDATE market_index_sync
            SET last_success_at = NOW(), last_error = NULL
          WHERE index_code = $1`,
        [code],
      ),
    );
  }

  private async recordFailure(code: string, message: string): Promise<void> {
    await withScopedDb(this.dataSource, (m) =>
      m.query(
        `UPDATE market_index_sync SET last_error = $2 WHERE index_code = $1`,
        [code, message.slice(0, 1000)],
      ),
    );
  }

  /**
   * Write the fetched bars.
   *
   * `adjusted_close` is COALESCEd against the stored value for the same reason
   * `SecurityPriceService.bulkUpsertPrices` does it: a later provider that
   * supplies no adjusted close must not erase one an earlier fetch stored, or
   * the series' basis silently flips from adjusted to raw between two reads.
   */
  private async bulkUpsert(rows: readonly UpsertRow[]): Promise<void> {
    const BATCH = 500;
    for (let offset = 0; offset < rows.length; offset += BATCH) {
      const batch = rows.slice(offset, offset + BATCH);
      const values: unknown[] = [];
      const tuples = batch.map((row, i) => {
        const base = i * 5;
        values.push(
          row.indexCode,
          row.priceDate,
          row.closePrice,
          row.adjustedClose,
          SOURCE,
        );
        return `($${base + 1}, $${base + 2}::date, $${base + 3}, $${base + 4}, $${base + 5})`;
      });
      await withScopedDb(this.dataSource, (m) =>
        m.query(
          `INSERT INTO market_index_prices
             (index_code, price_date, close_price, adjusted_close, source)
           VALUES ${tuples.join(", ")}
           ON CONFLICT (index_code, price_date) DO UPDATE
             SET close_price = EXCLUDED.close_price,
                 adjusted_close = COALESCE(EXCLUDED.adjusted_close,
                                           market_index_prices.adjusted_close),
                 source = EXCLUDED.source`,
          values,
        ),
      );
    }
  }
}
