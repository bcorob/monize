import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { withScopedDb } from "@/common/db/scoped-db";
import { todayInTimezone } from "@/common/date-utils";
import { withSystemContext, withUserContext } from "@/common/db/with-context";
import { FetchSyncService } from "@/common/jobs/fetch-sync.service";
import { CurrenciesService } from "@/currencies/currencies.service";
import { AuthAttemptCounterService } from "@/auth/auth-attempt-counter.service";
import { ProviderHealthService } from "@/provider-health/provider-health.service";
import { POLISH_BOND_ADAPTER } from "@/bonds/adapters/pl/index";
import {
  fakeFetch,
  fakePdfText,
  SITE,
  SLUGS,
  seriesRoutes,
} from "@/bonds/adapters/pl/series/fixture-helpers";
import { extractPdfText } from "@/common/pdf-text";
import { FIXTURE_CATALOG } from "@/bonds/adapters/pl/pl-test-input";
import { BenchmarkRefreshService } from "@/bonds/benchmark-refresh.service";
import { BondAdapter, BondFetch } from "@/bonds/bond-adapter";
import { BondCatalogService } from "@/bonds/bond-catalog.service";
import { BondOfferService } from "@/bonds/bond-offer.service";
import { BondPriceService } from "../../src/bonds/bond-price.service";
import { BondSeriesService } from "@/bonds/bond-series.service";
import { BondValuationService } from "@/bonds/bond-valuation.service";
import { ExactDecimal } from "@/bonds/domain/exact-decimal";
import { SeriesHttp } from "@/bonds/series-http";
import {
  cleanTables,
  createIntegrationModule,
  createTestUserDirect,
  storeFixtureSeries,
} from "../helpers/integration-setup";
import { FxProviderChain } from "@/currencies/providers/fx-provider-chain";

// The bond catalog only ensures a currency row; it never asks the FX chain.
const NO_FX_CHAIN = {} as unknown as FxProviderChain;

// The letter is read as text: the fake PDF is the magic plus the saved letter
// text, so the real adapter parses the real fixture without pdfjs.
jest.mock("@/common/pdf-text", () => ({
  extractPdfText: jest.fn(),
}));

// The seeded series are the October 2026 ones; a fixed Warsaw date keeps them
// "on sale" whenever the suite runs. The database's own NOW() is untouched.
jest.mock("@/common/date-utils", () => ({
  ...jest.requireActual("@/common/date-utils"),
  todayInTimezone: jest.fn(() => "2026-10-10"),
}));

const CPI = "PL_CPI_GUS_YOY";
const ORIGINAL_SERIES = [
  "COI1030",
  "DOR1028",
  "EDO1036",
  "OTS0127",
  "ROD1038",
  "ROR1027",
  "ROS1032",
  "TOS1029",
];
const page = (code: string, slug: string) =>
  `${SITE}/oferta-obligacji/${slug}/${code.toLowerCase()}/`;

/**
 * `docs/specs/bond-offer-and-history.md` section 6, "On sale", "History" and
 * "Backfill" against a real PostgreSQL: the sale-window predicate over the
 * newest terms version, the owner-agnostic read of reference data and a rerun
 * of the backfill that fetches nothing. Never the network: the series fetch is
 * a fake over the saved issuer pages.
 */
describe("bond offer, history and backfill (integration)", () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let catalog: BondCatalogService;
  let offers: BondOfferService;
  let userId: string;
  let otherId: string;

  const asUser = <T>(id: string, fn: () => Promise<T>) =>
    withUserContext(id, fn);
  const offerOf = (id: string, assume?: ReadonlyMap<string, string>) =>
    asUser(id, () => offers.offer(id, "PL", assume));
  const historyOf = (programCode?: string) =>
    asUser(userId, () => offers.history("PL", programCode));
  const bySeries = <T extends { seriesCode: string }>(rows: readonly T[]) =>
    Object.fromEntries(rows.map((row) => [row.seriesCode, row]));
  const exact = (text: string | null) => ExactDecimal.parse(text as string);

  beforeAll(async () => {
    module = await createIntegrationModule([]);
    dataSource = module.get(DataSource);
    catalog = new BondCatalogService(
      dataSource,
      new CurrenciesService(dataSource, NO_FX_CHAIN),
    );
    offers = new BondOfferService(
      dataSource,
      new BondValuationService(dataSource),
    );
    userId = (await createTestUserDirect(dataSource)).id;
    otherId = (await createTestUserDirect(dataSource)).id;
  });

  afterAll(async () => {
    await dataSource.query(`DELETE FROM users WHERE id = ANY($1)`, [
      [userId, otherId],
    ]);
    await module.close();
  });

  beforeEach(async () => {
    (todayInTimezone as jest.Mock).mockImplementation(() => "2026-10-10");
    (extractPdfText as jest.Mock).mockImplementation(async (b: Uint8Array) =>
      fakePdfText(b),
    );
    await cleanTables(dataSource, [
      "bond_programs",
      "bond_instruments",
      "benchmark_series",
      "fetch_sync",
    ]);
    // The adapter ships no series: the October 2026 ones are stored as a fetch would.
    await storeFixtureSeries(dataSource, catalog);
    await dataSource.query(
      `INSERT INTO benchmark_values (benchmark_code, observation_date, value, source_url, retrieved_at)
       VALUES ('${CPI}', '2026-08-01', 0.0290000000, 'https://example.test/cpi', NOW())`,
    );
  });

  describe("On sale", () => {
    it("lists every series whose window holds today, in issuer and series order, for any user alike", async () => {
      const mine = await offerOf(userId);
      const theirs = await offerOf(otherId);

      expect(mine.countryCode).toBe("PL");
      expect(mine.today).toBe("2026-10-10");
      expect(mine.series.map((s) => s.seriesCode)).toEqual(ORIGINAL_SERIES);
      // Reference data has no owner: the same answer for another user.
      expect(theirs).toEqual(mine);
    });

    it("lists nothing the day after the window closes, and nothing before it opens", async () => {
      (todayInTimezone as jest.Mock).mockImplementation(() => "2026-11-01");
      expect((await offerOf(userId)).series).toEqual([]);
      (todayInTimezone as jest.Mock).mockImplementation(() => "2026-09-30");
      expect((await offerOf(userId)).series).toEqual([]);
      (todayInTimezone as jest.Mock).mockImplementation(() => "2026-10-31");
      expect((await offerOf(userId)).series).toHaveLength(8);
    });

    it("answers an empty offer for a country with no series", async () => {
      const offer = await asUser(userId, () => offers.offer(userId, "DE"));
      expect(offer).toEqual({
        countryCode: "DE",
        today: "2026-10-10",
        series: [],
      });
    });

    it("projects a fixed-rate compounding bond exactly, and labels the latest observation for an indexed one", async () => {
      const { series } = await offerOf(userId);
      const rows = bySeries(series);

      expect(rows.TOS1029).toMatchObject({
        programCode: "TOS",
        periodMonths: 12,
        periodCount: 3,
        capitalization: "COMPOUND_AT_PERIOD_END",
        saleWindow: { from: "2026-10-01", to: "2026-10-31" },
        projection: {
          maturityValue: "113.79",
          totalReturn: "0.1379",
          annualizedReturn: "0.0440",
          projected: false,
          assumptions: [],
          projectionMissing: [],
        },
      });
      expect(rows.EDO1036.projection.projected).toBe(true);
      expect(rows.EDO1036.projection.assumptions).toEqual([
        expect.objectContaining({
          benchmarkId: CPI,
          value: "0.0290",
          basis: "LATEST_OBSERVATION",
        }),
      ]);
      expect(rows.EDO1036.projection.maturityValue).not.toBeNull();
      expect(rows.COI1030.projection.maturityValue).not.toBeNull();
      expect(rows.COI1030.capitalization).toBe("NONE");
    });

    it("an assumption (the scenario pipe's map) moves the series that read the benchmark and no other", async () => {
      const base = bySeries((await offerOf(userId)).series);
      const high = bySeries(
        (await offerOf(userId, new Map([[CPI, "0.0600"]]))).series,
      );

      expect(high.TOS1029.projection).toEqual(base.TOS1029.projection);
      expect(high.OTS0127.projection).toEqual(base.OTS0127.projection);
      for (const code of ["EDO1036", "COI1030", "ROS1032", "ROD1038"]) {
        expect(high[code].projection.assumptions).toEqual([
          expect.objectContaining({ value: "0.0600", basis: "SUPPLIED" }),
        ]);
        expect(
          exact(high[code].projection.maturityValue).cmp(
            exact(base[code].projection.maturityValue),
          ),
        ).toBe(1);
      }
    });

    it("has null figures and names what is missing when the benchmark has no observation and none is assumed", async () => {
      await dataSource.query(`DELETE FROM benchmark_values`);
      const { series } = await offerOf(userId);
      const edo = bySeries(series).EDO1036;
      expect(edo.projection).toMatchObject({
        maturityValue: null,
        totalReturn: null,
        annualizedReturn: null,
      });
      expect(edo.projection.projectionMissing).toEqual([
        expect.objectContaining({ benchmarkId: CPI }),
      ]);
      // A fixed-rate series needs no observation.
      expect(bySeries(series).TOS1029.projection.maturityValue).toBe("113.79");
    });
  });

  describe("History", () => {
    const earlierEdo = async () => {
      const october = FIXTURE_CATALOG.find(
        (e) =>
          (e.terms as { instrument: { seriesCode: string } }).instrument
            .seriesCode === "EDO1036",
      )!;
      const doc = JSON.parse(JSON.stringify(october.terms));
      doc.instrument.seriesCode = "EDO0934";
      doc.saleWindow = { from: "2024-09-01", to: "2024-09-30" };
      doc.rateRule.firstPeriodRate = "0.0560";
      doc.rateRule.margin = "0.0200";
      doc.redemption.penalties[0].amount = "2.00";
      await withUserContext(userId, () =>
        withScopedDb(dataSource, (m) =>
          catalog.storeEntry(m, {
            termsVersion: 1,
            publishedAt: "2024-08-20",
            terms: doc,
          }),
        ),
      );
    };

    it("orders a program by the start of the sale window with each series' terms", async () => {
      await earlierEdo();
      const { programs } = await historyOf("EDO");

      expect(programs).toHaveLength(1);
      const [edo] = programs;
      expect(edo.programCode).toBe("EDO");
      expect(edo.series.map((s) => s.seriesCode)).toEqual([
        "EDO0934",
        "EDO1036",
      ]);
      expect(edo.series[0]).toMatchObject({
        saleWindow: { from: "2024-09-01", to: "2024-09-30" },
        firstPeriodRate: "0.0560",
        addend: "0.0200",
        fee: "2.00",
        proceedsFloor: "ALL_PERIODS",
        annualRate: null,
        termsVersion: 1,
      });
      expect(edo.series[1]).toMatchObject({
        firstPeriodRate: "0.0535",
        addend: "0.0200",
        fee: "3.00",
      });
    });

    it("names the absent months between the first validated month and the last stored one", async () => {
      await earlierEdo();
      const [edo] = (await historyOf("EDO")).programs;

      expect(edo.coverage.from).toBe("2024-01");
      expect(edo.coverage.to).toBe("2026-10");
      // 34 months from 2024-01 to 2026-10, two of them stored.
      expect(edo.coverage.missingMonths).toHaveLength(32);
      expect(edo.coverage.missingMonths).toContain("2024-10");
      expect(edo.coverage.missingMonths).not.toContain("2024-09");
      expect(edo.coverage.missingMonths).not.toContain("2026-10");
    });

    it("covers every program when none is named, each with its own coverage, and none for an unknown one", async () => {
      const { programs } = await historyOf();
      expect(programs.map((p) => p.programCode)).toEqual([
        "COI",
        "DOR",
        "EDO",
        "OTS",
        "ROD",
        "ROR",
        "ROS",
        "TOS",
      ]);
      expect(
        programs.find((p) => p.programCode === "TOS")!.series[0],
      ).toMatchObject({
        annualRate: "0.0440",
        fee: "1.00",
        firstPeriodRate: null,
      });
      expect((await historyOf("XYZ")).programs).toEqual([]);
    });
  });

  describe("Backfill", () => {
    const EDO_PAGE = page("EDO1036", SLUGS.EDO);
    const ROR_PAGE = page("ROR1027", SLUGS.ROR);

    const build = (door: BondFetch): BondSeriesService =>
      new BondSeriesService(
        dataSource,
        catalog,
        { gated: () => door } as unknown as SeriesHttp,
        new ProviderHealthService(dataSource),
        new FetchSyncService(dataSource),
        {
          recomputeLinkedSecuritiesOfSeries: async () => undefined,
        } as unknown as BondPriceService,
        {
          refreshNeverFetched: async () => undefined,
        } as unknown as BenchmarkRefreshService,
        new AuthAttemptCounterService(dataSource),
      );
    const adapterFor = (...codes: string[]): BondAdapter => ({
      ...POLISH_BOND_ADAPTER,
      backfillCodes: () => codes,
    });
    const run = (service: BondSeriesService, adapter: BondAdapter) =>
      withSystemContext(() =>
        service.backfillHistory({
          adapters: [adapter],
          sleep: async () => undefined,
          today: "2026-10-10",
        }),
      );

    beforeEach(async () => {
      // The backfill must store what it fetches, so start from an empty catalog.
      await cleanTables(dataSource, ["bond_programs", "bond_instruments"]);
    });

    it("a rerun after a complete run fetches nothing", async () => {
      const door = fakeFetch(seriesRoutes("EDO1036", SLUGS.EDO));
      const service = build(door);
      const adapter = adapterFor("EDO1036");

      await expect(run(service, adapter)).resolves.toMatchObject({
        candidates: 1,
        stored: 1,
        stoppedEarly: false,
      });
      expect(door).toHaveBeenCalled();

      door.mockClear();
      await expect(run(service, adapter)).resolves.toMatchObject({
        candidates: 1,
        alreadyStored: 1,
        stored: 0,
      });
      expect(door).not.toHaveBeenCalled();
    });

    it("a rerun asks only for the series that are not stored: a month the source does not publish is asked again", async () => {
      const routes = {
        ...seriesRoutes("EDO1036", SLUGS.EDO),
        [ROR_PAGE]: { status: 404, body: new Uint8Array() },
      };
      const door = fakeFetch(routes);
      const service = build(door);
      const adapter = adapterFor("EDO1036", "ROR1027");

      await expect(run(service, adapter)).resolves.toMatchObject({
        stored: 1,
        notPublished: 1,
        failed: 0,
      });
      const urls = () => door.mock.calls.map(([url]) => url);
      expect(urls()).toContain(EDO_PAGE);
      expect(urls()).toContain(ROR_PAGE);

      door.mockClear();
      await run(service, adapter);
      expect(urls()).toEqual([ROR_PAGE]);
    });

    it("stops the pass on the first unavailable source", async () => {
      const door = jest.fn(async () => {
        throw new Error("connection refused");
      }) as unknown as jest.MockedFunction<BondFetch>;
      const outcome = await run(build(door), adapterFor("EDO1036", "ROR1027"));
      expect(outcome).toMatchObject({ stored: 0, stoppedEarly: true });
      expect(door).toHaveBeenCalledTimes(1);
    });
  });
});
