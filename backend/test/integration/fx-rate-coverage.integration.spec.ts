import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import {
  ExchangeRateHistoryService,
  STORED_RATE_ROW_CAP,
} from "@/currencies/exchange-rate-history.service";
import { ExchangeRateService } from "@/currencies/exchange-rate.service";
import { FxProviderChain } from "@/currencies/providers/fx-provider-chain";
import { UserPreference } from "@/users/entities/user-preference.entity";
import { withUserContext } from "@/common/db/with-context";
import {
  createIntegrationModule,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";

/**
 * The pair's two reads against a real PostgreSQL database.
 *
 * The unit suite drives `manager.query` through a mock, so only this test
 * exercises the SQL itself: that the two stored directions of a pair are read
 * as one pair, that `observations` counts calendar days rather than the rows,
 * that a date a pre-collapse writer left in both orientations is listed once,
 * and that dates come back as `YYYY-MM-DD` strings in every process time zone
 * rather than as whatever the DATE parser would have made of them.
 */
describe("ExchangeRateHistoryService reads (integration)", () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let service: ExchangeRateHistoryService;
  let userId: string;

  /** Never called here: this spec is about the read, not the provider. */
  const exchangeRateService = {
    fillRateWindow: jest.fn(),
  } as unknown as ExchangeRateService;

  /** A chain that is only ever asked to describe itself. */
  const chainOf = (...sources: string[]): FxProviderChain =>
    ({
      describe: () => sources.map((source) => ({ name: source, source })),
    }) as unknown as FxProviderChain;

  const insertRate = (
    from: string,
    to: string,
    date: string,
    rate: string,
  ): Promise<unknown> =>
    dataSource.query(
      `INSERT INTO exchange_rates (from_currency, to_currency, rate_date, rate, source)
       VALUES ($1, $2, $3::DATE, $4, 'test')`,
      [from, to, date, rate],
    );

  beforeAll(async () => {
    module = await createIntegrationModule([]);
    dataSource = module.get(DataSource);
    service = new ExchangeRateHistoryService(
      dataSource,
      exchangeRateService,
      chainOf("frankfurter", "yahoo_finance"),
    );
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanTables(dataSource, [
      "exchange_rate_coverage",
      "exchange_rates",
      "user_preferences",
      "users",
    ]);
    const user = await createTestUserDirect(dataSource);
    userId = user.id;
    await dataSource.manager.save(
      dataSource.manager.create(UserPreference, {
        userId,
        defaultCurrency: "PLN",
      }),
    );
    await dataSource.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places, is_active)
       VALUES ('EUR', 'Euro', 'E', 2, true), ('PLN', 'Zloty', 'z', 2, true),
              ('USD', 'Dollar', '$', 2, true)
       ON CONFLICT (code) DO NOTHING`,
    );
  });

  it("reads both stored directions as one pair and counts days, not rows", async () => {
    // What a fetch actually writes: each day forwards and inverted.
    await insertRate("EUR", "PLN", "2026-01-02", "4.3000000000");
    await insertRate("PLN", "EUR", "2026-01-02", "0.2325581395");
    await insertRate("EUR", "PLN", "2026-06-19", "4.2500000000");
    await insertRate("PLN", "EUR", "2026-06-19", "0.2352941176");
    // A row about a different pair must not reach this answer.
    await insertRate("EUR", "EUR", "2026-07-01", "1.0000000000");

    const coverage = await withUserContext(userId, () =>
      service.getCoverage(userId, "EUR"),
    );

    expect(coverage).toEqual({
      from: "EUR",
      to: "PLN",
      earliestDate: "2026-01-02",
      latestDate: "2026-06-19",
      observations: 2,
    });
  });

  it("reports null bounds for a pair with no rows at all", async () => {
    const coverage = await withUserContext(userId, () =>
      service.getCoverage(userId, "EUR"),
    );

    expect(coverage).toEqual({
      from: "EUR",
      to: "PLN",
      earliestDate: null,
      latestDate: null,
      observations: 0,
    });
  });

  it("finds a pair stored only in the reverse direction", async () => {
    await insertRate("PLN", "EUR", "2025-12-31", "0.2325581395");

    const coverage = await withUserContext(userId, () =>
      service.getCoverage(userId, "EUR"),
    );

    expect(coverage.earliestDate).toBe("2025-12-31");
    expect(coverage.observations).toBe(1);
  });

  describe("getStoredRates", () => {
    it("lists a date held in both orientations once, keeping the canonical row", async () => {
      // What a pre-collapse writer left behind: two rows for one date that are
      // not reciprocal. The canonical orientation is the one every writer
      // maintains now, and the one the contract migration keeps.
      await insertRate("EUR", "PLN", "2026-01-02", "4.3000000000");
      await insertRate("PLN", "EUR", "2026-01-02", "0.9900000000");

      const list = await withUserContext(userId, () =>
        service.getStoredRates(userId, "EUR"),
      );

      expect(list.rates).toEqual([
        {
          rateDate: "2026-01-02",
          rate: 4.3,
          source: "test",
          inverted: false,
        },
      ]);
    });

    it("lists a pair stored the other way round as its reciprocal", async () => {
      // USD against PLN is stored canonically as PLN->USD, which is the reverse
      // of what a reader asking about USD wants.
      await insertRate("PLN", "USD", "2026-01-02", "0.2500000000");

      const list = await withUserContext(userId, () =>
        service.getStoredRates(userId, "USD"),
      );

      expect(list.rates).toEqual([
        {
          rateDate: "2026-01-02",
          rate: 4,
          source: "test",
          inverted: true,
        },
      ]);
    });

    it("returns whole dates, newest first, and nothing about another pair", async () => {
      await insertRate("EUR", "PLN", "2026-01-02", "4.3000000000");
      await insertRate("EUR", "PLN", "2026-06-19", "4.2500000000");
      await insertRate("EUR", "PLN", "2026-03-11", "4.2800000000");
      await insertRate("USD", "PLN", "2026-04-01", "3.9000000000");

      const list = await withUserContext(userId, () =>
        service.getStoredRates(userId, "EUR"),
      );

      expect(list.rates.map((rate) => rate.rateDate)).toEqual([
        "2026-06-19",
        "2026-03-11",
        "2026-01-02",
      ]);
      expect(list.truncated).toBe(false);
    });

    it("lists nothing for a pair with no rows at all", async () => {
      const list = await withUserContext(userId, () =>
        service.getStoredRates(userId, "EUR"),
      );

      expect(list).toEqual({
        from: "EUR",
        to: "PLN",
        rates: [],
        truncated: false,
        limit: STORED_RATE_ROW_CAP,
      });
    });
  });

  /**
   * The coverage upsert's merge is SQL, so only a real database can show that
   * it ratchets within one provider chain and resets across two.
   */
  describe("pair coverage across provider chains", () => {
    interface Coverage {
      earliestAvailableDate: string | null;
      firstGapDate: string | null;
      probedFrom: string | null;
    }
    interface CoverageDoor {
      readPairCoverage(from: string, to: string): Promise<Coverage>;
      recordPairCoverage(
        from: string,
        to: string,
        coverage: Coverage,
      ): Promise<void>;
    }

    const under = (...sources: string[]): CoverageDoor =>
      new ExchangeRateHistoryService(
        dataSource,
        exchangeRateService,
        chainOf(...sources),
      ) as unknown as CoverageDoor;

    const storedRow = async () =>
      (
        await dataSource.query(
          `SELECT TO_CHAR(earliest_available_date, 'YYYY-MM-DD') AS earliest,
                  TO_CHAR(first_gap_date, 'YYYY-MM-DD') AS first_gap,
                  TO_CHAR(probed_from, 'YYYY-MM-DD') AS probed_from,
                  providers
             FROM exchange_rate_coverage
            WHERE from_currency = 'EUR' AND to_currency = 'PLN'`,
        )
      )[0];

    const yahooEra: Coverage = {
      earliestAvailableDate: "2003-09-01",
      firstGapDate: "2026-10-12",
      probedFrom: "1996-09-16",
    };

    it("keeps the forward-only merge within one chain", async () => {
      const door = under("yahoo_finance");
      await withUserContext(userId, () =>
        door.recordPairCoverage("EUR", "PLN", yahooEra),
      );
      await withUserContext(userId, () =>
        door.recordPairCoverage("EUR", "PLN", {
          earliestAvailableDate: "1999-01-04",
          firstGapDate: "2010-01-01",
          probedFrom: "2001-01-01",
        }),
      );

      expect(await storedRow()).toEqual({
        earliest: "2003-09-01",
        first_gap: "2026-10-12",
        probed_from: "1996-09-16",
        providers: "yahoo_finance",
      });
      expect(
        await withUserContext(userId, () =>
          door.readPairCoverage("PLN", "EUR"),
        ),
      ).toEqual(yahooEra);
    });

    it("reads a row recorded under another chain as unestablished", async () => {
      await withUserContext(userId, () =>
        under("yahoo_finance").recordPairCoverage("EUR", "PLN", yahooEra),
      );

      expect(
        await withUserContext(userId, () =>
          under("frankfurter", "yahoo_finance").readPairCoverage("EUR", "PLN"),
        ),
      ).toEqual({
        earliestAvailableDate: null,
        firstGapDate: null,
        probedFrom: null,
      });
    });

    it("reads a row with no recorded chain as unestablished", async () => {
      await dataSource.query(
        `INSERT INTO exchange_rate_coverage
                (from_currency, to_currency, earliest_available_date,
                 first_gap_date, probed_from)
         VALUES ('EUR', 'PLN', '2003-09-01', '2026-10-12', '1996-09-16')`,
      );

      expect(
        await withUserContext(userId, () =>
          under("frankfurter", "yahoo_finance").readPairCoverage("EUR", "PLN"),
        ),
      ).toEqual({
        earliestAvailableDate: null,
        firstGapDate: null,
        probedFrom: null,
      });
    });

    it("replaces all three dates when the chain changes, rather than merging", async () => {
      await withUserContext(userId, () =>
        under("yahoo_finance").recordPairCoverage("EUR", "PLN", yahooEra),
      );
      const current = under("frankfurter", "yahoo_finance");
      await withUserContext(userId, () =>
        current.recordPairCoverage("EUR", "PLN", {
          earliestAvailableDate: null,
          firstGapDate: "2001-01-01",
          probedFrom: "1998-01-02",
        }),
      );

      // GREATEST/LEAST would have kept 2003-09-01, 2026-10-12 and 1996-09-16.
      expect(await storedRow()).toEqual({
        earliest: null,
        first_gap: "2001-01-01",
        probed_from: "1998-01-02",
        providers: "frankfurter,yahoo_finance",
      });
      expect(
        await withUserContext(userId, () =>
          current.readPairCoverage("EUR", "PLN"),
        ),
      ).toEqual({
        earliestAvailableDate: null,
        firstGapDate: "2001-01-01",
        probedFrom: "1998-01-02",
      });
    });

    it("replaces the dates of a row with no recorded chain", async () => {
      await dataSource.query(
        `INSERT INTO exchange_rate_coverage
                (from_currency, to_currency, earliest_available_date,
                 first_gap_date, probed_from)
         VALUES ('EUR', 'PLN', '2003-09-01', '2026-10-12', '1996-09-16')`,
      );
      await withUserContext(userId, () =>
        under("frankfurter", "yahoo_finance").recordPairCoverage("EUR", "PLN", {
          earliestAvailableDate: "1999-01-04",
          firstGapDate: "2001-01-01",
          probedFrom: "1998-01-02",
        }),
      );

      expect(await storedRow()).toEqual({
        earliest: "1999-01-04",
        first_gap: "2001-01-01",
        probed_from: "1998-01-02",
        providers: "frankfurter,yahoo_finance",
      });
    });
  });
});
