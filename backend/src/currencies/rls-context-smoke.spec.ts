import { CurrenciesService } from "./currencies.service";
import { ExchangeRateService } from "./exchange-rate.service";
import { Currency } from "./entities/currency.entity";
import { ExchangeRate } from "./entities/exchange-rate.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { createFetchSyncMock } from "../test-helpers/job-claim-testing";

/**
 * RLS smoke for the currencies module's cron and bootstrap entry points (R6).
 *
 * Unlike the per-service specs, this suite does NOT mock `withScopedDb`: the
 * real implementation runs (at the default RLS_MODE=off), so every DB access on
 * these paths must find the ambient context seeded by the module's own
 * `withSystemContext` / `withUserContext` wrappers, or withScopedDb throws its
 * missing-context error. This is the CI stand-in for the "dev smoke of the
 * module's cron/bootstrap paths shows no context throws" acceptance.
 *
 * Both bootstrap hooks matter here: `CurrenciesService.onApplicationBootstrap`
 * and `ExchangeRateService.onModuleInit` run before any request exists, which is
 * exactly the shape that would throw if the wrapper were missing.
 */
describe("currencies module RLS context smoke (real withScopedDb)", () => {
  const USER_ID = "8e0d5a1c-4b3e-4f5a-9c2d-1a2b3c4d5e6f";

  it("CurrenciesService.onApplicationBootstrap runs under the system context", async () => {
    const currencyRepo = { findOne: jest.fn().mockResolvedValue(null) };
    const { manager, dataSource } = createScopedDbMocks([
      [Currency, currencyRepo],
    ]);

    const service = new CurrenciesService(dataSource as never, {} as never);
    const warnSpy = jest
      .spyOn(service["logger"], "warn")
      .mockImplementation(() => undefined);

    await service.onApplicationBootstrap();

    // The hook swallows failures, so a missing ambient context would surface as
    // a logged "DB access outside request/user/system context" warning.
    expect(warnSpy).not.toHaveBeenCalled();
    expect(currencyRepo.findOne).toHaveBeenCalled();
    expect(manager.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO currencies"),
      expect.arrayContaining(["USD"]),
    );
  });

  it("ExchangeRateService.onModuleInit fans out startup backfills under their contexts", async () => {
    const exchangeRateRepo = {
      findOne: jest.fn().mockResolvedValue({ id: 1 }),
    };
    const prefRepo = jest.fn();
    const { manager, dataSource } = createScopedDbMocks([
      [ExchangeRate, exchangeRateRepo],
      [
        UserPreference,
        {
          findOne: jest.fn().mockImplementation((...args) => {
            prefRepo(...args);
            return Promise.resolve({ userId: USER_ID, defaultCurrency: "USD" });
          }),
        },
      ],
    ]);
    manager.query
      .mockResolvedValueOnce([{ user_id: USER_ID }]) // usersWithForeignAccounts
      .mockResolvedValue([]); // the per-user backfill's discovery queries

    const service = new ExchangeRateService(
      dataSource as never,
      {} as never,
      createFetchSyncMock() as never,
    );
    const errorSpy = jest
      .spyOn(service["logger"], "error")
      .mockImplementation(() => undefined);
    const warnSpy = jest
      .spyOn(service["logger"], "warn")
      .mockImplementation(() => undefined);

    await service.onModuleInit();
    // The per-user backfill is fire-and-forget; give it a tick to run.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(prefRepo).toHaveBeenCalledWith({ where: { userId: USER_ID } });
  });

  it("scheduledRateRefresh runs its cross-user read under the system context", async () => {
    const { manager, dataSource } = createScopedDbMocks([]);
    manager.query.mockResolvedValue([{ code: "USD" }]);

    const service = new ExchangeRateService(
      dataSource as never,
      {} as never,
      createFetchSyncMock() as never,
    );
    const errorSpy = jest
      .spyOn(service["logger"], "error")
      .mockImplementation(() => undefined);

    await service.scheduledRateRefresh();

    expect(errorSpy).not.toHaveBeenCalled();
    expect(manager.query).toHaveBeenCalled();
  });

  it("real withScopedDb still refuses these paths without their context wrappers", async () => {
    const { dataSource } = createScopedDbMocks([
      [Currency, { findOne: jest.fn().mockResolvedValue(null) }],
    ]);
    const service = new CurrenciesService(dataSource as never, {} as never);

    // Called with no ambient scope at all (no interceptor, no wrapper): the real
    // withScopedDb must throw, proving the smokes above pass because of the
    // wrappers and not because the check is inert.
    await expect(
      service.ensureCurrencyForUser("user-1", "USD"),
    ).rejects.toThrow("DB access outside request/user/system context");
  });
});
