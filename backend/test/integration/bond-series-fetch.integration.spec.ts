import { Reflector } from "@nestjs/core";
import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { acquireAdvisoryLock, LockScope } from "@/common/db/locks";
import { withScopedDb } from "@/common/db/scoped-db";
import { withUserContext } from "@/common/db/with-context";
import { ROLES_KEY, RolesGuard } from "@/auth/guards/roles.guard";
import { POLISH_BOND_ADAPTER } from "@/bonds/adapters/pl/index";
import {
  fakeFetch,
  fakePdfText,
  letterFixture,
  SLUGS,
  seriesRoutes,
} from "@/bonds/adapters/pl/series/fixture-helpers";
import { extractPdfText } from "@/common/pdf-text";
import {
  BondAdapter,
  BondFetch,
  ManualSeriesValues,
} from "@/bonds/bond-adapter";
import { FIXTURE_CATALOG } from "@/bonds/adapters/pl/pl-test-input";
import { BenchmarkRefreshService } from "@/bonds/benchmark-refresh.service";
import { BondCatalogService } from "@/bonds/bond-catalog.service";
import { bondInstrumentId } from "@/bonds/bond-instrument-id";
import { BondPriceService } from "../../src/bonds/bond-price.service";
import { BondSeriesService } from "@/bonds/bond-series.service";
import { BondsController } from "@/bonds/bonds.controller";
import { SeriesHttp } from "@/bonds/series-http";
import { CurrenciesService } from "@/currencies/currencies.service";
import { AuthAttemptCounterService } from "@/auth/auth-attempt-counter.service";
import { ProviderHealthService } from "@/provider-health/provider-health.service";
import { FetchSyncService } from "@/common/jobs/fetch-sync.service";
import {
  cleanTables,
  createIntegrationModule,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { FxProviderChain } from "@/currencies/providers/fx-provider-chain";

// The bond catalog only ensures a currency row; it never asks the FX chain.
const NO_FX_CHAIN = {} as unknown as FxProviderChain;

// The letter is read as text: the fake PDF is the magic plus the saved letter
// text, so the real adapter parses the real fixture without pdfjs.
jest.mock("@/common/pdf-text", () => ({
  extractPdfText: jest.fn(),
}));

const CODE = "EDO1036";
const INSTRUMENT_ID = bondInstrumentId("PL", "PL_MF", CODE);
const PAGE_URL = `https://www.obligacjeskarbowe.pl/oferta-obligacji/${SLUGS.EDO}/edo1036/`;
// The values of the October 2026 EDO letter, as an administrator would type them.
const VALUES: ManualSeriesValues = {
  firstPeriodRate: "0.0535",
  addend: "0.0200",
  fee: "3.00",
  saleWindow: { from: "2026-10-01", to: "2026-10-31" },
  letter: { number: "99/2026", date: "2026-09-21" },
};

/**
 * `docs/specs/bond-series-fetch.md` section 7, "Write" and "Manual" (INV-BOND-006)
 * against a real PostgreSQL, with a fake `BondFetch` over the saved issuer pages
 * and letters -- never the network. The transaction, the advisory lock, the
 * content-hash comparison and the rollback are properties of SQL a mocked
 * manager cannot show.
 */
describe("bond series fetch (integration, INV-BOND-006)", () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let catalog: BondCatalogService;
  let service: BondSeriesService;
  let door: jest.MockedFunction<BondFetch>;
  let adminId: string;
  let userId: string;
  let otherId: string;

  /** The adapter, fetching through `door` whatever `SeriesHttp` is asked. */
  const adapter: BondAdapter = POLISH_BOND_ADAPTER;

  /** The first-fetch refresh is the benchmark service's own test; here it is observed. */
  const benchmarks = {
    refreshNeverFetched: jest.fn(async () => undefined),
  } as unknown as BenchmarkRefreshService;

  const build = (): BondSeriesService =>
    new BondSeriesService(
      dataSource,
      catalog,
      { gated: () => door } as unknown as SeriesHttp,
      new ProviderHealthService(dataSource),
      new FetchSyncService(dataSource),
      {
        recomputeLinkedSecuritiesOfSeries: async () => undefined,
      } as unknown as BondPriceService,
      benchmarks,
      new AuthAttemptCounterService(dataSource),
    );

  /** A request as a signed-in user makes it. */
  const asUser = <T>(id: string, fn: () => Promise<T>) =>
    withUserContext(id, fn);
  const fetchAs = (id: string, code = CODE, adapters = [adapter]) =>
    asUser(id, () => service.fetchSeries(id, "PL", code, { adapters }));
  const enterAs = (
    id: string,
    values: ManualSeriesValues = VALUES,
    adapters = [adapter],
  ) =>
    asUser(id, () => service.enterManually("PL", CODE, values, { adapters }));

  const curatedEdo = () =>
    FIXTURE_CATALOG.find(
      (e) =>
        (e.terms as { instrument: { seriesCode: string } }).instrument
          .seriesCode === CODE,
    )!;
  const count = async (table: string): Promise<number> =>
    Number(
      (await dataSource.query(`SELECT COUNT(*)::int AS n FROM ${table}`))[0].n,
    );
  const versions = () =>
    dataSource.query(
      `SELECT version, content_hash, source_url,
              TO_CHAR(published_at, 'YYYY-MM-DD') AS published_at,
              terms -> 'source' ->> 'provider' AS provider,
              terms -> 'source' ->> 'document' AS document,
              retrieved_at::text AS retrieved_at
         FROM bond_terms_versions`,
    );
  const refusalOf = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      return error as { code: string; params: Record<string, string> };
    }
    throw new Error("expected a refusal");
  };

  beforeAll(async () => {
    module = await createIntegrationModule([]);
    dataSource = module.get(DataSource);
    catalog = new BondCatalogService(
      dataSource,
      new CurrenciesService(dataSource, NO_FX_CHAIN),
    );
    adminId = (await createTestUserDirect(dataSource, { role: "admin" })).id;
    userId = (await createTestUserDirect(dataSource)).id;
    otherId = (await createTestUserDirect(dataSource)).id;
  });

  afterAll(async () => {
    await dataSource.query(`DELETE FROM users WHERE id = ANY($1)`, [
      [adminId, userId, otherId],
    ]);
    await module.close();
  });

  beforeEach(async () => {
    (extractPdfText as jest.Mock).mockImplementation(async (b: Uint8Array) =>
      fakePdfText(b),
    );
    await cleanTables(dataSource, [
      "bond_programs",
      "bond_instruments",
      "benchmark_series",
    ]);
    await dataSource.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places, is_active)
       VALUES ('PLN', 'Zloty', 'z', 2, true)
       ON CONFLICT (code) DO NOTHING`,
    );
    await dataSource.query(
      `DELETE FROM auth_attempt_counters WHERE scope = 'bond-series-fetch'`,
    );
    door = fakeFetch(seriesRoutes(CODE, SLUGS.EDO));
    service = build();
  });

  afterEach(() => jest.restoreAllMocks());

  describe("the per-user limit on explicit fetches (L2)", () => {
    it("refuses the 11th fetch in a minute with a 429 and no request, counting a repeat that found the series stored; another user is not limited", async () => {
      await fetchAs(userId);
      door.mockClear();
      for (let i = 1; i < 10; i++) await fetchAs(userId);

      await expect(fetchAs(userId)).rejects.toMatchObject({
        status: 429,
        response: { errorCode: "SERIES_FETCH_RATE_LIMITED" },
      });
      expect(door).not.toHaveBeenCalled();
      await expect(fetchAs(otherId)).resolves.toMatchObject({
        created: false,
      });
    });
  });

  describe("Write", () => {
    it("a fetch inserts one instrument and terms version 1, naming the official source", async () => {
      await expect(fetchAs(userId)).resolves.toMatchObject({
        id: INSTRUMENT_ID,
        seriesCode: CODE,
        issuerCountryCode: "PL",
        currencyCode: "PLN",
        termsProvider: "obligacjeskarbowe.pl",
        created: true,
      });

      expect(await count("bond_instruments")).toBe(1);
      // The program is stored with its first series, in the same transaction.
      expect(await count("bond_programs")).toBe(1);
      const stored = await versions();
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({
        version: 1,
        source_url: PAGE_URL,
        published_at: "2026-09-21",
        provider: "obligacjeskarbowe.pl",
        document: "List emisyjny nr 99/2026",
      });
      expect(stored[0].content_hash).toHaveLength(64);
    });

    it("a fetch stores the benchmark row the series reads with it, and dispatches its first refresh after the commit", async () => {
      expect(await count("benchmark_series")).toBe(0);
      await fetchAs(userId);
      // Only the benchmark EDO reads, so a valuation names its publisher
      // before the first fetch lands; the fetch itself is the refresh's.
      expect(
        await dataSource.query(
          `SELECT code, publisher, covered_through FROM benchmark_series`,
        ),
      ).toEqual([
        { code: "PL_CPI_GUS_YOY", publisher: "GUS", covered_through: null },
      ]);
      expect(benchmarks.refreshNeverFetched).toHaveBeenCalledWith([
        INSTRUMENT_ID,
      ]);
    });

    it("a repeat fetches nothing and writes nothing", async () => {
      await fetchAs(userId);
      const before = await versions();
      door.mockClear();

      await expect(fetchAs(otherId)).resolves.toMatchObject({
        id: INSTRUMENT_ID,
        created: false,
      });

      expect(door).not.toHaveBeenCalled();
      expect(await count("bond_instruments")).toBe(1);
      expect(await versions()).toEqual(before);
    });

    it("a series stored already (a fixture version) is answered without a fetch", async () => {
      await withUserContext(userId, () =>
        withScopedDb(dataSource, (m) => catalog.storeEntry(m, curatedEdo())),
      );
      door.mockClear();
      await expect(
        asUser(userId, () =>
          service.fetchSeries(userId, "PL", "EDO1036", { adapters: [adapter] }),
        ),
      ).resolves.toMatchObject({ created: false, termsProvider: "PL_MF" });
      expect(door).not.toHaveBeenCalled();
    });

    it("a fetch whose content differs from the stored version 1 is SERIES_TERMS_CONFLICT and writes nothing", async () => {
      // A concurrent writer commits a different version 1 while this request is
      // reading the source, after its own check that the series is absent.
      const racing: BondAdapter = {
        ...adapter,
        fetchSeries: async (code, fetch) => {
          await enterAs(adminId);
          return adapter.fetchSeries!(code, fetch);
        },
      };
      const error = await refusalOf(fetchAs(userId, CODE, [racing]));

      expect(error.code).toBe("SERIES_TERMS_CONFLICT");
      expect(error.params).toEqual({ country: "PL", series: CODE });
      const stored = await versions();
      expect(stored).toHaveLength(1);
      expect(stored[0].provider).toBe("manual");
      expect(await count("bond_instruments")).toBe(1);
    });

    it("a manual entry over a fetched series is refused the same way, and the fetched version stays", async () => {
      await fetchAs(userId);
      const [fetched] = await versions();
      const error = await refusalOf(enterAs(adminId));
      expect(error.code).toBe("SERIES_TERMS_CONFLICT");
      expect(await versions()).toEqual([fetched]);
    });

    it("a refused fetch leaves no row: the letter disagrees with the page", async () => {
      door = fakeFetch(
        seriesRoutes(CODE, SLUGS.EDO, {
          letter: letterFixture(CODE).replace("5,35%", "5,40%"),
        }),
      );
      service = build();

      const error = await refusalOf(fetchAs(userId));

      expect(error.code).toBe("SOURCE_INCONSISTENT");
      expect(error.params).toMatchObject({ field: "firstPeriodRate" });
      expect(await count("bond_instruments")).toBe(0);
      expect(await count("bond_programs")).toBe(0);
      expect(await count("bond_terms_versions")).toBe(0);
    });

    it("a series the issuer does not publish is SERIES_NOT_PUBLISHED and leaves no row", async () => {
      door = fakeFetch({
        [PAGE_URL]: { status: 404, body: new Uint8Array() },
      });
      service = build();
      const error = await refusalOf(fetchAs(userId));
      expect(error.code).toBe("SERIES_NOT_PUBLISHED");
      expect(await count("bond_instruments")).toBe(0);
    });

    it("an unsupported country is refused before anything is fetched", async () => {
      const error = await refusalOf(
        asUser(userId, () =>
          service.fetchSeries(userId, "DE", CODE, { adapters: [adapter] }),
        ),
      );
      expect(error.code).toBe("SERIES_FETCH_UNSUPPORTED");
      expect(door).not.toHaveBeenCalled();
    });

    it("a failure after the insert rolls the whole store back", async () => {
      const store = catalog.storeEntry.bind(catalog);
      jest
        .spyOn(catalog, "storeEntry")
        .mockImplementationOnce(async (m, entry) => {
          await store(m, entry);
          throw new Error("later step failed");
        });
      await expect(fetchAs(userId)).rejects.toThrow("later step failed");
      expect(await count("bond_instruments")).toBe(0);
      expect(await count("bond_terms_versions")).toBe(0);
    });

    it("two concurrent fetches of one series insert once", async () => {
      const results = await Promise.all([
        fetchAs(userId),
        fetchAs(otherId),
        fetchAs(adminId),
      ]);

      expect(results.filter((r) => r.created)).toHaveLength(1);
      expect(results.filter((r) => !r.created)).toHaveLength(2);
      expect(new Set(results.map((r) => r.id))).toEqual(
        new Set([INSTRUMENT_ID]),
      );
      expect(await count("bond_instruments")).toBe(1);
      expect(await count("bond_terms_versions")).toBe(1);
    });

    it("the instrument's advisory lock holds a second writer until the first commits", async () => {
      const runner = dataSource.createQueryRunner();
      await runner.connect();
      await runner.startTransaction();
      try {
        await acquireAdvisoryLock(
          runner.manager,
          LockScope.BondSeriesFetch,
          INSTRUMENT_ID,
        );
        let settled = false;
        const pending = fetchAs(userId).finally(() => {
          settled = true;
        });
        // The network read is outside the lock; the store waits on it.
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(settled).toBe(false);
        expect(await count("bond_terms_versions")).toBe(0);

        await runner.commitTransaction();
        await expect(pending).resolves.toMatchObject({ created: true });
      } finally {
        if (runner.isTransactionActive) await runner.rollbackTransaction();
        await runner.release();
      }
      expect(await count("bond_terms_versions")).toBe(1);
    });
  });

  describe("Refresh of a program (fetchProgramOffer)", () => {
    beforeEach(async () => {
      await dataSource.query(
        `DELETE FROM fetch_sync WHERE job LIKE 'bond-program-refresh:%' OR job LIKE 'bond-series-attempt:%'`,
      );
    });

    it("refreshes a program at most once per interval, even after a pass that finished", async () => {
      const offerAdapter: BondAdapter = {
        ...adapter,
        currentSeries: jest.fn(async () => [CODE]),
        backfillCodes: () => [],
      };
      const first = await asUser(userId, () =>
        service.fetchProgramOffer("PL", "EDO", { adapters: [offerAdapter] }),
      );
      expect(first.history).not.toBeNull();
      expect(await count("bond_instruments")).toBe(1);

      // A second Refresh, by another reader, after the first pass is done: the
      // lease in fetch_sync still holds, so nothing is asked for.
      const second = await asUser(otherId, () =>
        service.fetchProgramOffer("PL", "EDO", { adapters: [offerAdapter] }),
      );
      expect(second).toMatchObject({ listed: 0, history: null });
      expect(offerAdapter.currentSeries).toHaveBeenCalledTimes(1);

      const [row] = await dataSource.query(
        `SELECT lease_until > CURRENT_TIMESTAMP AS held FROM fetch_sync WHERE job = $1`,
        ["bond-program-refresh:PL|EDO"],
      );
      expect(row.held).toBe(true);
    });

    it("leaves the program's progress done in fetch_sync, and the read answers it", async () => {
      const offerAdapter: BondAdapter = {
        ...adapter,
        currentSeries: jest.fn(async () => [CODE]),
        backfillCodes: () => [],
      };
      await asUser(userId, () =>
        service.fetchProgramOffer("PL", "EDO", { adapters: [offerAdapter] }),
      );
      const [row] = await dataSource.query(
        `SELECT progress FROM fetch_sync WHERE job = $1`,
        ["bond-program-refresh:PL|EDO"],
      );
      expect(row.progress).toMatchObject({
        phase: "done",
        done: 0,
        total: 0,
        seriesCode: null,
      });
      expect(typeof row.progress.startedAt).toBe("string");
      expect(typeof row.progress.finishedAt).toBe("string");

      const [program] = await dataSource.query(
        `SELECT id FROM bond_programs WHERE program_code = 'EDO'`,
      );
      const read = await asUser(otherId, () =>
        service.readRefreshProgress(program.id),
      );
      expect(read).toEqual(row.progress);
      await expect(
        asUser(otherId, () =>
          service.readRefreshProgress("00000000-0000-4000-8000-000000000000"),
        ),
      ).rejects.toMatchObject({ code: "PROGRAM_NOT_FOUND" });
    });

    it("asks for a refused series once a day, whichever pass comes next", async () => {
      door = fakeFetch({});
      service = build();
      const historyAdapter: BondAdapter = {
        ...adapter,
        backfillCodes: () => [CODE],
      };
      const options = {
        adapters: [historyAdapter],
        sleep: async () => undefined,
        today: "2026-10-11",
        limit: 8,
      };
      const first = await asUser(userId, () =>
        service.backfillHistory(options),
      );
      expect(first.notPublished + first.failed).toBe(1);
      const asked = door.mock.calls.length;

      const second = await asUser(otherId, () =>
        service.backfillHistory(options),
      );
      expect(second).toMatchObject({
        notPublished: 0,
        failed: 0,
        remaining: 1,
      });
      expect(door.mock.calls.length).toBe(asked);
    });
  });

  describe("Manual", () => {
    const guardAllows = async (id: string): Promise<boolean> => {
      // The role the JWT strategy would put on the request: the user's own row.
      const [{ role }] = await dataSource.query(
        `SELECT role FROM users WHERE id = $1`,
        [id],
      );
      const handler = BondsController.prototype.enterSeries;
      expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual(["admin"]);
      return new RolesGuard(new Reflector()).canActivate({
        getHandler: () => handler,
        getClass: () => BondsController,
        switchToHttp: () => ({ getRequest: () => ({ user: { id, role } }) }),
      } as never);
    };

    it("refuses a non-administrator (403 at the guard, and the tools' role check) and an administrator passes", async () => {
      expect(await guardAllows(userId)).toBe(false);
      expect(await guardAllows(adminId)).toBe(true);
      await expect(
        asUser(userId, () => service.isAdministrator(userId)),
      ).resolves.toBe(false);
      await expect(
        asUser(adminId, () => service.isAdministrator(adminId)),
      ).resolves.toBe(true);
      expect(await count("bond_instruments")).toBe(0);
    });

    it("an administrator's entry is stored with provider manual, on the template", async () => {
      await expect(enterAs(adminId)).resolves.toMatchObject({
        id: INSTRUMENT_ID,
        termsProvider: "manual",
        created: true,
      });
      const [stored] = await versions();
      expect(stored).toMatchObject({
        version: 1,
        provider: "manual",
        document: "List emisyjny nr 99/2026",
        source_url: PAGE_URL,
        published_at: "2026-09-21",
      });
      // The structure comes from the template: the terms are the fetched ones
      // but for their source.
      const [manual] = await dataSource.query(
        `SELECT terms - 'source' AS terms FROM bond_terms_versions`,
      );
      const { entry } = await adapter.fetchSeries!(CODE, door);
      const { source: _source, ...fetched } = entry.terms as Record<
        string,
        unknown
      >;
      expect(manual.terms).toEqual(fetched);
    });

    it("a repeat of the same entry writes nothing", async () => {
      await enterAs(adminId);
      const before = await versions();
      await expect(enterAs(adminId)).resolves.toMatchObject({ created: false });
      expect(await versions()).toEqual(before);
    });

    it.each([
      [
        "a fee above the bound",
        { ...VALUES, fee: "99.00" },
        "SOURCE_INCONSISTENT",
      ],
      [
        "a first-period rate above the bound",
        { ...VALUES, firstPeriodRate: "0.9000" },
        "SOURCE_INCONSISTENT",
      ],
      [
        "a sale window outside the code's sale month",
        { ...VALUES, saleWindow: { from: "2026-11-01", to: "2026-11-30" } },
        "SOURCE_INCONSISTENT",
      ],
      [
        "a letter dated after the sale starts",
        { ...VALUES, letter: { number: "99/2026", date: "2026-10-05" } },
        "SOURCE_INCONSISTENT",
      ],
      [
        "a rate that is not a decimal",
        { ...VALUES, firstPeriodRate: "5,35%" },
        "MANUAL_ENTRY_INVALID",
      ],
    ])("%s is refused and leaves no row", async (_label, values, code) => {
      const error = await refusalOf(enterAs(adminId, values));
      expect(error.code).toBe(code);
      expect(await count("bond_instruments")).toBe(0);
      expect(await count("bond_terms_versions")).toBe(0);
    });
  });
});
