import {
  INDEX_FETCH_COOLDOWN_MS,
  MarketIndexService,
} from "./market-index.service";
import { YahooFinanceService } from "./yahoo-finance.service";
import { HistoricalPrice } from "./providers/quote-provider.interface";
import { MARKET_INDEXES } from "./market-indexes";
import {
  createScopedDbMocks,
  DataSourceMock,
  ManagerMock,
} from "../test-helpers/scoped-db-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

const systemContext = jest.fn((fn: () => unknown) => fn());
jest.mock("../common/db/with-context", () => ({
  withSystemContext: (fn: () => unknown) => systemContext(fn),
}));

/** One coverage row, driver-shaped: dates as text, the float as a string. */
function coverageRow(
  code: string,
  earliest: string,
  latest: string,
  avgGapDays: number,
) {
  return {
    index_code: code,
    earliest,
    latest,
    avg_gap_days: String(avgGapDays),
  };
}

/**
 * Routes the three queries the service issues by their SQL: coverage,
 * last-attempt bookkeeping, and the deployment-wide earliest transaction.
 */
function routeQueries(
  manager: ManagerMock,
  data: {
    coverage?: unknown[];
    attempts?: unknown[];
    earliestTransaction?: string | null;
  },
): void {
  manager.query.mockImplementation((sql: string) => {
    if (sql.includes("investment_transactions")) {
      return Promise.resolve([{ earliest: data.earliestTransaction ?? null }]);
    }
    if (sql.includes("last_attempt_at") && sql.includes("SELECT")) {
      return Promise.resolve(data.attempts ?? []);
    }
    if (sql.includes("MIN(price_date)")) {
      return Promise.resolve(data.coverage ?? []);
    }
    return Promise.resolve([]);
  });
}

/** A provider bar, typed so the fixture cannot claim a shape Yahoo never sends. */
function bar(
  date: string,
  close: number,
  adjClose: number | null = null,
): HistoricalPrice {
  return {
    date: new Date(`${date}T00:00:00Z`),
    open: null,
    high: null,
    low: null,
    close,
    adjClose,
    volume: null,
  };
}

describe("MarketIndexService", () => {
  let service: MarketIndexService;
  let manager: ManagerMock;
  let dataSource: DataSourceMock;
  let yahoo: jest.Mocked<
    Pick<YahooFinanceService, "fetchHistorical" | "fetchHistoricalWindow">
  >;

  /** SQL statements the service issued, in order. */
  const statements = (): string[] =>
    manager.query.mock.calls.map((call) => String(call[0]));

  beforeEach(() => {
    jest.clearAllMocks();
    const mocks = createScopedDbMocks();
    manager = mocks.manager;
    dataSource = mocks.dataSource;
    manager.query.mockResolvedValue([]);
    yahoo = {
      fetchHistorical: jest.fn().mockResolvedValue(null),
      fetchHistoricalWindow: jest.fn().mockResolvedValue(null),
    };
    service = new MarketIndexService(dataSource as never, yahoo as never);
  });

  // --- catalog -------------------------------------------------------------

  describe("listCatalog", () => {
    it("reports no coverage for an index we hold nothing for", async () => {
      manager.query.mockResolvedValue([]);
      const catalog = await service.listCatalog();
      expect(catalog).toHaveLength(MARKET_INDEXES.length);
      // Null on both ends is "we hold nothing", which the picker has to be able
      // to tell apart from a coverage window that is merely short.
      expect(catalog[0].coverage).toEqual({
        earliestDate: null,
        latestDate: null,
        averageGapDays: null,
      });
    });

    it("attaches the stored window to the catalog entry", async () => {
      manager.query.mockResolvedValue([
        coverageRow("SP500", "2015-01-02", "2026-08-05", 1.4),
      ]);
      const catalog = await service.listCatalog();
      const sp500 = catalog.find((index) => index.code === "SP500");
      expect(sp500?.coverage).toEqual({
        earliestDate: "2015-01-02",
        latestDate: "2026-08-05",
        averageGapDays: 1.4,
      });
      expect(sp500?.yahooSymbol).toBe("^GSPC");
    });
  });

  // --- on-demand backfill --------------------------------------------------

  describe("ensureHistory", () => {
    it("does nothing for an empty selection", async () => {
      await service.ensureHistory([], "2025-01-01");
      expect(manager.query).not.toHaveBeenCalled();
    });

    it("ignores a code that is not in the catalog", async () => {
      await service.ensureHistory(["NOT_AN_INDEX"], "2025-01-01");
      expect(yahoo.fetchHistoricalWindow).not.toHaveBeenCalled();
    });

    /**
     * The user's own prescription, implemented literally: daily prices from the
     * first year the deployment recorded an investment transaction, fetched
     * year by year. One deep request is exactly the shape the provider answers
     * with monthly bars, so the chunking is what makes the daily series
     * actually arrive -- and the store is global, so one user's fetch serves
     * everyone comparing against the same index.
     */
    it("fetches daily history year by year from the earliest transaction", async () => {
      routeQueries(manager, { earliestTransaction: "2010-03-15" });
      yahoo.fetchHistoricalWindow.mockResolvedValue([
        bar("2025-01-02", 5900),
        bar("2025-01-03", 5910),
      ]);

      await service.ensureHistory(["SP500"], null);

      const calls = yahoo.fetchHistoricalWindow.mock.calls;
      // 2010-01-01 to today is over sixteen years: one request per year-sized
      // chunk, each within the span the provider serves daily.
      expect(calls.length).toBeGreaterThanOrEqual(16);
      expect(calls[0][0]).toBe("^GSPC");
      expect(calls[0][2].toISOString().slice(0, 10)).toBe("2010-01-01");
      for (const [, , from, to] of calls) {
        const days = (to.getTime() - from.getTime()) / 86_400_000;
        expect(days).toBeLessThanOrEqual(366);
      }
      // Contiguous: each chunk starts the day after the previous one ends.
      for (let i = 1; i < calls.length; i += 1) {
        const previousEnd = calls[i - 1][3].getTime();
        const nextStart = calls[i][2].getTime();
        expect(nextStart - previousEnd).toBeLessThanOrEqual(86_400_000);
      }
      expect(
        statements().some((sql) =>
          sql.includes("INSERT INTO market_index_prices"),
        ),
      ).toBe(true);
    });

    /**
     * The reported defect, as a test. An earlier version stored a provider
     * response that had silently gone monthly -- bars stamped on the 1st,
     * duplicated across the days that follow, a horizontal stub and then a gap.
     * The span test alone called that series covered forever; the density test
     * is what makes it due for repair, and the daily refetch overwrites the
     * wrong-dated closes in place.
     */
    it("repairs a stored series that is coarser than daily", async () => {
      routeQueries(manager, {
        // Monthly bars across two decades: ~30 days between observations. The
        // near end is CURRENT on purpose -- a stale fixture would make the
        // series due for its staleness and mask a deleted coarseness guard,
        // which is exactly how the first version of this test lied.
        coverage: [
          coverageRow(
            "SP500",
            "2001-01-01",
            new Date().toISOString().slice(0, 10),
            30.4,
          ),
        ],
        earliestTransaction: "2010-03-15",
      });
      yahoo.fetchHistoricalWindow.mockResolvedValue([
        bar("2025-01-02", 5900),
        bar("2025-01-03", 5910),
      ]);

      await service.ensureHistory(["SP500"], null);

      // Refetched from the deep start despite the apparently-complete span.
      const calls = yahoo.fetchHistoricalWindow.mock.calls;
      expect(calls.length).toBeGreaterThanOrEqual(16);
      expect(calls[0][2].toISOString().slice(0, 10)).toBe("2010-01-01");
      // Replaced, not upserted over: monthly bars sit on the 1st, which is a
      // weekend often enough that the daily refetch has no bar on that date to
      // overwrite -- the wrong-dated close would survive under the fresh
      // series. The delete runs only after the fetch passed the granularity
      // guard, so a failed repair leaves the old data rather than none.
      const deleteAt = statements().findIndex((sql) =>
        sql.includes("DELETE FROM market_index_prices"),
      );
      const insertAt = statements().findIndex((sql) =>
        sql.includes("INSERT INTO market_index_prices"),
      );
      expect(deleteAt).toBeGreaterThanOrEqual(0);
      expect(insertAt).toBeGreaterThan(deleteAt);
    });

    it("does not delete anything on an ordinary first fetch or top-up", async () => {
      routeQueries(manager, { earliestTransaction: "2015-06-01" });
      yahoo.fetchHistoricalWindow.mockResolvedValue([bar("2016-01-04", 1400)]);

      await service.ensureHistory(["SP500"], null);

      expect(
        statements().some((sql) =>
          sql.includes("DELETE FROM market_index_prices"),
        ),
      ).toBe(false);
    });

    it("does not treat a fine daily series as coarse", async () => {
      routeQueries(manager, {
        // Daily observations: weekends put the mean near 1.4, never above 4.
        coverage: [
          coverageRow(
            "SP500",
            "2010-01-04",
            new Date().toISOString().slice(0, 10),
            1.45,
          ),
        ],
        earliestTransaction: "2010-03-15",
      });

      await service.ensureHistory(["SP500"], null);
      expect(yahoo.fetchHistoricalWindow).not.toHaveBeenCalled();
    });

    it("falls back to a bounded horizon when no transactions exist", async () => {
      routeQueries(manager, { earliestTransaction: null });
      yahoo.fetchHistoricalWindow.mockResolvedValue([bar("2025-01-02", 5900)]);

      await service.ensureHistory(["SP500"], null);

      const [, , from] = yahoo.fetchHistoricalWindow.mock.calls[0];
      const yearsBack = (Date.now() - from.getTime()) / (365.25 * 86_400_000);
      expect(yearsBack).toBeGreaterThan(9);
      expect(yearsBack).toBeLessThan(11);
    });

    /**
     * `range=max` is the shorthand that drops granularity: asked for its whole
     * history an index answers with coarser bars, and those were then stored as
     * if they were the daily series. Nothing here may reach for it.
     */
    it("never asks for the provider's whole-history shorthand", async () => {
      manager.query.mockResolvedValue([]);
      yahoo.fetchHistoricalWindow.mockResolvedValue([bar("2025-01-02", 5900)]);

      await service.ensureHistory(["SP500"], null);
      await service.ensureHistory(["DAX"], "2025-01-01");
      await service.refreshAll();

      expect(yahoo.fetchHistorical).not.toHaveBeenCalled();
    });

    it("refuses a series coarser than daily rather than storing it", async () => {
      manager.query.mockResolvedValue([]);
      // Month-end closes: what the whole-history shorthand hands back, and what
      // drew the benchmark as a row of flat stubs once stored.
      yahoo.fetchHistoricalWindow.mockResolvedValue([
        bar("2025-01-31", 5900),
        bar("2025-02-28", 5950),
        bar("2025-03-31", 6000),
        bar("2025-04-30", 6100),
      ]);

      await service.ensureHistory(["SP500"], "2025-01-01");

      expect(
        statements().some((sql) =>
          sql.includes("INSERT INTO market_index_prices"),
        ),
      ).toBe(false);
      // Unpriced, which the comparison reports as an exclusion the user can act
      // on -- not a sparse series masquerading as a daily one.
      expect(statements().some((sql) => sql.includes("last_error = $2"))).toBe(
        true,
      );
    });

    it("accepts a daily series despite its weekend and holiday steps", async () => {
      manager.query.mockResolvedValue([]);
      yahoo.fetchHistoricalWindow.mockResolvedValue([
        bar("2025-01-02", 5900),
        bar("2025-01-03", 5910),
        // Weekend.
        bar("2025-01-06", 5920),
        bar("2025-01-07", 5930),
        bar("2025-01-08", 5940),
        // A closure of several days must not make a daily series look weekly.
        bar("2025-01-15", 5950),
      ]);

      await service.ensureHistory(["SP500"], "2025-01-01");

      expect(
        statements().some((sql) =>
          sql.includes("INSERT INTO market_index_prices"),
        ),
      ).toBe(true);
    });

    it("stores a single-bar top-up, which has no spacing to judge", async () => {
      manager.query.mockImplementation((sql: string) => {
        if (sql.includes("MIN(price_date)")) {
          return Promise.resolve([
            {
              index_code: "SP500",
              earliest: "2001-01-02",
              latest: "2020-06-01",
            },
          ]);
        }
        return Promise.resolve([]);
      });
      yahoo.fetchHistoricalWindow.mockResolvedValue([bar("2025-01-02", 5900)]);

      await service.ensureHistory(["SP500"], "2025-01-01");

      expect(
        statements().some((sql) =>
          sql.includes("INSERT INTO market_index_prices"),
        ),
      ).toBe(true);
    });

    it("extends a fine series backward when the window outreaches it", async () => {
      routeQueries(manager, {
        // Fine and current, but starting after the requested window.
        coverage: [
          coverageRow(
            "SP500",
            "2024-01-02",
            new Date().toISOString().slice(0, 10),
            1.4,
          ),
        ],
        earliestTransaction: "2010-03-15",
      });
      yahoo.fetchHistoricalWindow.mockResolvedValue([bar("2023-01-03", 5000)]);

      await service.ensureHistory(["SP500"], "2023-01-01");

      const [symbol, , from] = yahoo.fetchHistoricalWindow.mock.calls[0];
      expect(symbol).toBe("^GSPC");
      // The lookup that prices the window start searches backwards, so the
      // fetch has to reach behind the boundary.
      expect(from.toISOString().slice(0, 10) < "2023-01-01").toBe(true);
      expect(yahoo.fetchHistorical).not.toHaveBeenCalled();
    });

    it("tops a fine but stale series up with a bounded window, not the whole thing", async () => {
      routeQueries(manager, {
        // Fine, covers the request's back end, but weeks out of date.
        coverage: [coverageRow("SP500", "2009-01-02", "2026-06-01", 1.4)],
        earliestTransaction: "2010-03-15",
      });
      yahoo.fetchHistoricalWindow.mockResolvedValue([bar("2026-08-01", 5900)]);

      await service.ensureHistory(["SP500"], "2025-01-01");

      expect(yahoo.fetchHistoricalWindow).toHaveBeenCalledTimes(1);
      const [, , from, to] = yahoo.fetchHistoricalWindow.mock.calls[0];
      const days = (to.getTime() - from.getTime()) / 86_400_000;
      expect(days).toBeLessThan(30);
    });

    /**
     * "All time" has no boundary to reach behind, so no stored start can fail
     * to satisfy it. Treating it as unsatisfiable would refetch every selected
     * index on every open-ended request.
     */
    it("does not refetch on an open-ended request when the store is current", async () => {
      manager.query.mockImplementation((sql: string) => {
        if (sql.includes("MIN(price_date)")) {
          return Promise.resolve([
            {
              index_code: "SP500",
              earliest: "2000-01-03",
              latest: new Date().toISOString().slice(0, 10),
            },
          ]);
        }
        return Promise.resolve([]);
      });

      await service.ensureHistory(["SP500"], null);
      expect(yahoo.fetchHistoricalWindow).not.toHaveBeenCalled();
      expect(yahoo.fetchHistorical).not.toHaveBeenCalled();
    });

    it("does not refetch an index whose stored history already covers the window", async () => {
      manager.query.mockImplementation((sql: string) => {
        if (sql.includes("MIN(price_date)")) {
          return Promise.resolve([
            {
              index_code: "SP500",
              earliest: "2000-01-03",
              latest: new Date().toISOString().slice(0, 10),
            },
          ]);
        }
        return Promise.resolve([]);
      });

      await service.ensureHistory(["SP500"], "2025-01-01");
      expect(yahoo.fetchHistoricalWindow).not.toHaveBeenCalled();
    });

    /**
     * The whole reason `market_index_sync` exists. A provider that cannot serve
     * an index leaves no rows, so the coverage test stays false -- without the
     * cooldown the backfill fires again on the very next chart render.
     */
    it("does not retry within the cooldown, even with nothing stored", async () => {
      manager.query.mockImplementation((sql: string) => {
        if (sql.includes("last_attempt_at")) {
          return Promise.resolve([
            { index_code: "SP500", last_attempt_at: new Date() },
          ]);
        }
        return Promise.resolve([]);
      });

      await service.ensureHistory(["SP500"], "2025-01-01");
      expect(yahoo.fetchHistoricalWindow).not.toHaveBeenCalled();
    });

    it("retries once the cooldown has elapsed", async () => {
      const stale = new Date(Date.now() - INDEX_FETCH_COOLDOWN_MS - 1000);
      manager.query.mockImplementation((sql: string) => {
        if (sql.includes("last_attempt_at") && sql.includes("SELECT")) {
          return Promise.resolve([
            { index_code: "SP500", last_attempt_at: stale },
          ]);
        }
        return Promise.resolve([]);
      });
      yahoo.fetchHistoricalWindow.mockResolvedValue([bar("2025-01-02", 5900)]);

      await service.ensureHistory(["SP500"], "2025-01-01");
      expect(yahoo.fetchHistoricalWindow).toHaveBeenCalled();
    });

    /**
     * A provider outage must leave the index *unpriced*, which the comparison
     * then reports as an exclusion. Turning it into a thrown error would take
     * the securities' lines down with the benchmark.
     */
    it("records a failure and does not throw when the provider returns nothing", async () => {
      yahoo.fetchHistoricalWindow.mockResolvedValue(null);
      await expect(
        service.ensureHistory(["SP500"], "2025-01-01"),
      ).resolves.toBeUndefined();
      expect(statements().some((sql) => sql.includes("last_error = $2"))).toBe(
        true,
      );
      expect(
        statements().some((sql) =>
          sql.includes("INSERT INTO market_index_prices"),
        ),
      ).toBe(false);
    });

    it("records a failure and does not throw when the provider raises", async () => {
      yahoo.fetchHistoricalWindow.mockRejectedValue(new Error("429 throttled"));
      await expect(
        service.ensureHistory(["SP500"], "2025-01-01"),
      ).resolves.toBeUndefined();
      expect(statements().some((sql) => sql.includes("last_error = $2"))).toBe(
        true,
      );
    });

    it("stamps the attempt before the fetch, so a hang still cools down", async () => {
      yahoo.fetchHistoricalWindow.mockResolvedValue(null);
      await service.ensureHistory(["SP500"], "2025-01-01");
      const insertIndex = statements().findIndex((sql) =>
        sql.includes("INSERT INTO market_index_sync"),
      );
      expect(insertIndex).toBeGreaterThanOrEqual(0);
    });

    it("drops bars the provider could not price, rather than storing a zero", async () => {
      // Only the first chunk answers; the rest are years the provider has
      // nothing for.
      yahoo.fetchHistoricalWindow
        .mockResolvedValue(null)
        .mockResolvedValueOnce([
          bar("2025-01-02", 5900),
          bar("2025-01-03", 0),
          bar("2025-01-06", Number.NaN),
        ]);

      await service.ensureHistory(["SP500"], "2025-01-01");

      const insert = manager.query.mock.calls.find((call) =>
        String(call[0]).includes("INSERT INTO market_index_prices"),
      );
      // Five bound parameters per row; one usable bar.
      expect(insert?.[1]).toHaveLength(5);
      expect(insert?.[1]).toContain(5900);
    });

    it("refuses to erase a stored adjusted close with a null one", async () => {
      yahoo.fetchHistoricalWindow.mockResolvedValue([bar("2025-01-02", 5900)]);
      await service.ensureHistory(["SP500"], "2025-01-01");
      const insert = manager.query.mock.calls.find((call) =>
        String(call[0]).includes("INSERT INTO market_index_prices"),
      );
      // Without the COALESCE a provider with no adjusted close silently flips a
      // series' basis from adjusted to raw between two reads.
      expect(String(insert?.[0]).replace(/\s+/g, " ")).toContain(
        "adjusted_close = COALESCE(EXCLUDED.adjusted_close, market_index_prices.adjusted_close)",
      );
    });

    it("keeps an adjusted close the provider did supply", async () => {
      yahoo.fetchHistoricalWindow.mockResolvedValue([
        bar("2025-01-02", 5900, 5850),
      ]);
      await service.ensureHistory(["SP500"], "2025-01-01");
      const insert = manager.query.mock.calls.find((call) =>
        String(call[0]).includes("INSERT INTO market_index_prices"),
      );
      expect(insert?.[1]).toContain(5850);
    });
  });

  // --- start-up ------------------------------------------------------------

  describe("onApplicationBootstrap", () => {
    /**
     * Without this a fresh deployment holds no index prices until the first
     * weekday 17:10 ET, and every benchmark in the picker is one we cannot
     * draw.
     */
    it("warms the store under system context", async () => {
      manager.query.mockResolvedValue([]);
      yahoo.fetchHistoricalWindow.mockResolvedValue([bar("2001-01-03", 1400)]);

      service.onApplicationBootstrap();
      await new Promise((resolve) => setImmediate(resolve));

      expect(systemContext).toHaveBeenCalled();
      expect(yahoo.fetchHistoricalWindow).toHaveBeenCalled();
    });

    it("returns before the provider does, so start-up is not blocked", () => {
      manager.query.mockResolvedValue([]);
      yahoo.fetchHistoricalWindow.mockReturnValue(new Promise(() => {}));
      expect(service.onApplicationBootstrap()).toBeUndefined();
    });

    it("does not take the process down when the provider is unreachable", async () => {
      manager.query.mockRejectedValue(new Error("db asleep"));
      service.onApplicationBootstrap();
      await expect(
        new Promise((resolve) => setImmediate(resolve)),
      ).resolves.toBeUndefined();
    });
  });

  // --- scheduled refresh ---------------------------------------------------

  describe("scheduledRefresh", () => {
    it("seeds its own system context, since no request is behind it", async () => {
      await service.scheduledRefresh();
      expect(systemContext).toHaveBeenCalled();
    });

    it("asks for a short recent window where history exists", async () => {
      manager.query.mockImplementation((sql: string) => {
        if (sql.includes("MIN(price_date)")) {
          return Promise.resolve(
            MARKET_INDEXES.map((index) => ({
              index_code: index.code,
              earliest: "2000-01-03",
              latest: "2026-08-05",
            })),
          );
        }
        return Promise.resolve([]);
      });
      yahoo.fetchHistoricalWindow.mockResolvedValue([bar("2026-08-05", 100)]);

      await service.refreshAll();

      expect(yahoo.fetchHistoricalWindow).toHaveBeenCalledTimes(
        MARKET_INDEXES.length,
      );
      // A deep history is thousands of bars; the daily top-up must not ask for
      // one -- the window it passes is the giveaway.
      const [, , from, to] = yahoo.fetchHistoricalWindow.mock.calls[0];
      const days = (to.getTime() - from.getTime()) / 86_400_000;
      expect(days).toBeLessThan(30);
    });

    it("deep-fetches daily chunks for an index it holds nothing for", async () => {
      routeQueries(manager, { earliestTransaction: "2015-06-01" });
      yahoo.fetchHistoricalWindow.mockResolvedValue([bar("2016-01-04", 1400)]);

      await service.refreshAll();

      // Year-sized chunks from the earliest transaction's year, per index.
      const calls = yahoo.fetchHistoricalWindow.mock.calls;
      expect(calls.length).toBeGreaterThanOrEqual(MARKET_INDEXES.length * 11);
      for (const [, , from, to] of calls) {
        const days = (to.getTime() - from.getTime()) / 86_400_000;
        expect(days).toBeLessThanOrEqual(366);
      }
    });

    it("carries on past an index the provider cannot serve", async () => {
      manager.query.mockResolvedValue([]);
      yahoo.fetchHistoricalWindow
        .mockRejectedValueOnce(new Error("gone"))
        .mockResolvedValue([bar("2016-01-04", 1400)]);

      await expect(service.refreshAll()).resolves.toBeUndefined();
      // The failed index recorded its error; every other index still fetched
      // and stored.
      expect(statements().some((sql) => sql.includes("last_error = $2"))).toBe(
        true,
      );
      expect(
        statements().filter((sql) =>
          sql.includes("INSERT INTO market_index_prices"),
        ).length,
      ).toBeGreaterThanOrEqual(MARKET_INDEXES.length - 1);
    });
  });

  // --- reads ---------------------------------------------------------------

  describe("loadSeries", () => {
    it("does not query for an empty selection", async () => {
      await expect(service.loadSeries([], "2025-01-01")).resolves.toEqual(
        new Map(),
      );
      expect(manager.query).not.toHaveBeenCalled();
    });

    it("reads the index table through the shared basis loader", async () => {
      manager.query.mockResolvedValue([
        {
          series_id: "SP500",
          price_date: "2025-01-02",
          close_price: "5900",
          has_adjusted: false,
        },
      ]);
      const series = await service.loadSeries(["SP500"], "2025-01-01");
      expect(series.get("SP500")).toEqual({
        basis: "RAW",
        points: [{ date: "2025-01-02", close: 5900 }],
      });
      expect(statements()[0]).toContain("FROM market_index_prices");
    });
  });
});
