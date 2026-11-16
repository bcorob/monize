import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { BenchmarkRefreshService } from "@/bonds/benchmark-refresh.service";
import { BondCatalogService } from "@/bonds/bond-catalog.service";
import { BondSeriesService } from "@/bonds/bond-series.service";
import { SecuritiesModule } from "@/securities/securities.module";
import {
  cleanTables,
  createIntegrationModule,
} from "../helpers/integration-setup";

const RULE =
  "INV-BOND-008: no bond data without a person's action, see docs/backend/securities-and-providers.md";

/**
 * INV-BOND-008 against a real PostgreSQL: a deployment where nobody added a
 * bond stores no series and sends no request after its boot hooks and one run of
 * each bond cron body. Only the programs exist.
 */
describe("no automatic bonds (integration, INV-BOND-008)", () => {
  let module: TestingModule;
  let dataSource: DataSource;
  const realFetch = global.fetch;
  let fetchSpy: jest.Mock;

  beforeAll(async () => {
    module = await createIntegrationModule([SecuritiesModule]);
    dataSource = module.get(DataSource);
  });

  afterAll(async () => {
    global.fetch = realFetch;
    await module.close();
  });

  beforeEach(async () => {
    await cleanTables(dataSource, [
      "bond_programs",
      "bond_instruments",
      "benchmark_series",
      "fetch_sync",
    ]);
    await dataSource.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places, is_active)
       VALUES ('PLN', 'Zloty', 'zl', 2, true)
       ON CONFLICT (code) DO NOTHING`,
    );
    fetchSpy = jest.fn(async () => {
      throw new Error(RULE);
    });
    global.fetch = fetchSpy as unknown as typeof fetch;
  });

  const count = async (table: string): Promise<number> =>
    Number(
      (await dataSource.query(`SELECT COUNT(*)::int AS n FROM ${table}`))[0].n,
    );

  it(`stores no series and fetches nothing after the boot hooks and one run of each cron body. ${RULE}`, async () => {
    const catalog = module.get(BondCatalogService);
    const refresh = module.get(BenchmarkRefreshService, { strict: false });
    const series = module.get(BondSeriesService);

    await catalog.onApplicationBootstrap();
    refresh.onApplicationBootstrap();
    // The warm-up is fire and forget: let it settle before looking.
    await new Promise((resolve) => setTimeout(resolve, 500));
    await refresh.scheduledRefresh();
    await series.scheduledCurrentOffer();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await count("bond_instruments")).toBe(0);
    expect(await count("bond_terms_versions")).toBe(0);
    expect(await count("benchmark_values")).toBe(0);
    expect(await count("benchmark_series")).toBe(0);
    // The programs are what the boot seed leaves, so the security form can offer them.
    expect(await count("bond_programs")).toBeGreaterThan(0);
  });
});
