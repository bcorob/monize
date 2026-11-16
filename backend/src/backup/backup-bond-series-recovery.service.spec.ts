import { HttpException, HttpStatus } from "@nestjs/common";
import { DataSource } from "typeorm";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { SeriesFetchError } from "../bonds/bond-adapter";
import { bondInstrumentId } from "../bonds/bond-instrument-id";
import { BondSeriesService } from "../bonds/bond-series.service";
import { ProviderUnavailableError } from "../provider-health/provider-unavailable.error";
import {
  BACKFILL_ATTEMPT_INTERVAL_MS,
  BACKFILL_GAP_MS,
} from "../bonds/bond-series.service";
import { FetchSyncService } from "../common/jobs/fetch-sync.service";
import {
  BackupBondSeriesRecoveryService,
  TRANSIENT_COOLDOWN_MS,
  classifyFetchFailure,
} from "./backup-bond-series-recovery.service";
import {
  BackupData,
  MAX_BOND_SERIES_FETCHES_PER_RESTORE,
} from "./backup-format";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

const USER = "user-1";
const id = (code: string) => bondInstrumentId("PL", "PL_MF", code);
const entry = (code: string) => ({
  bondInstrumentId: id(code),
  issuerCountryCode: "PL",
  issuerCode: "PL_MF",
  programCode: code.slice(0, 3),
  seriesCode: code,
});

/** A file whose rows name each series and whose `bondCatalog` describes them. */
const backup = (codes: string[]): BackupData =>
  ({
    version: 1,
    exportedAt: "x",
    investment_transactions: codes.map((code, i) => ({
      id: `t${i}`,
      bond_instrument_id: id(code),
    })),
    bondCatalog: { series: codes.map(entry) },
  }) as unknown as BackupData;

function setup(initiallyInCatalog: string[] = []) {
  const { manager, dataSource } = createScopedDbMocks();
  // The catalog the lookup reads, which a successful fetch adds to.
  const catalog = new Set(initiallyInCatalog);
  manager.query.mockImplementation(async (_sql: string, params: string[][]) =>
    params[2]
      .filter((code) => catalog.has(code))
      .map((code) => ({
        id: id(code),
        issuer_country_code: "PL",
        issuer_code: "PL_MF",
        series_code: code,
      })),
  );
  const fetchSeries = jest.fn(
    async (
      _user: string,
      _country: string,
      code: string,
      _options?: { limiter?: string },
    ) => {
      catalog.add(code);
      return { id: id(code), created: true };
    },
  );
  // The attempt lease: a series claimed in the last day is not claimed again.
  const leased = new Set<string>();
  const claim = jest.fn(async (job: string, _ms: number) => {
    if (leased.has(job)) return null;
    leased.add(job);
    return `token-${job}`;
  });
  const release = jest.fn(async (job: string, _token: string) => {
    leased.delete(job);
  });
  const service = new BackupBondSeriesRecoveryService(
    dataSource as unknown as DataSource,
    { fetchSeries } as unknown as BondSeriesService,
    { claim, release } as unknown as FetchSyncService,
  );
  const sleep = jest.fn(async (_ms: number) => undefined);
  const recover = (user: string, data: BackupData) =>
    service.recover(user, data, { sleep });
  return {
    service: { recover },
    fetchSeries,
    catalog,
    manager,
    sleep,
    claim,
    release,
  };
}

const idsOf = (data: BackupData) =>
  data.investment_transactions.map((r) => r.bond_instrument_id);

describe("BackupBondSeriesRecoveryService", () => {
  it("fetches each missing series once, for the restoring user, and keeps the rows' series", async () => {
    const { service, fetchSeries } = setup();
    const input = backup(["EDO1036", "EDO1036", "TOS1029"]);
    const result = await service.recover(USER, input);
    expect(fetchSeries.mock.calls).toEqual([
      [USER, "PL", "EDO1036", { limiter: "none" }],
      [USER, "PL", "TOS1029", { limiter: "none" }],
    ]);
    expect(result.unrecovered).toEqual([]);
    expect(idsOf(result.data)).toEqual(idsOf(input));
  });

  it("fetches 15 missing series, none reported rate-limited, with the backfill gap between fetches", async () => {
    const { service, fetchSeries, sleep } = setup();
    const codes = Array.from({ length: 15 }, (_, i) => `EDO${1000 + i}`);
    const result = await service.recover(USER, backup(codes));
    expect(fetchSeries).toHaveBeenCalledTimes(15);
    expect(result.unrecovered).toEqual([]);
    expect(sleep).toHaveBeenCalledTimes(14);
    expect(sleep.mock.calls.every(([ms]) => ms === BACKFILL_GAP_MS)).toBe(true);
    // Every fetch skips the interactive per-user limiter.
    expect(fetchSeries.mock.calls.every((c) => c[3]?.limiter === "none")).toBe(
      true,
    );
  });

  it("does not ask the issuer again for a series asked for in the last day", async () => {
    const { service, fetchSeries, claim } = setup();
    fetchSeries.mockRejectedValue(new Error("not published"));
    await service.recover(USER, backup(["EDO0199"]));
    const second = await service.recover(USER, backup(["EDO0199"]));
    expect(fetchSeries).toHaveBeenCalledTimes(1);
    expect(claim).toHaveBeenLastCalledWith(
      "bond-series-attempt:PL|EDO0199",
      BACKFILL_ATTEMPT_INTERVAL_MS,
    );
    expect(second.unrecovered.map((u) => u.reason)).toEqual(["not-attempted"]);
  });

  it("shortens the day's lease to a cooldown after a transient failure", async () => {
    const { service, fetchSeries, release, claim } = setup();
    fetchSeries.mockRejectedValueOnce(
      new ProviderUnavailableError("down", 1, null),
    );
    await service.recover(USER, backup(["EDO1036"]));
    expect(release).toHaveBeenCalledWith(
      "bond-series-attempt:PL|EDO1036",
      "token-bond-series-attempt:PL|EDO1036",
    );
    expect(claim).toHaveBeenLastCalledWith(
      "bond-series-attempt:PL|EDO1036",
      TRANSIENT_COOLDOWN_MS,
    );
    // Within the cooldown the series is not asked for again.
    const second = await service.recover(USER, backup(["EDO1036"]));
    expect(fetchSeries).toHaveBeenCalledTimes(1);
    expect(second.unrecovered.map((u) => u.reason)).toEqual(["not-attempted"]);
  });

  it("fetches nothing when every series is already in the catalog", async () => {
    const { service, fetchSeries } = setup(["EDO1036", "TOS1029"]);
    const result = await service.recover(USER, backup(["EDO1036", "TOS1029"]));
    expect(fetchSeries).not.toHaveBeenCalled();
    expect(result.unrecovered).toEqual([]);
  });

  it("fetches only the series that are missing", async () => {
    const { service, fetchSeries } = setup(["EDO1036"]);
    await service.recover(USER, backup(["EDO1036", "TOS1029"]));
    expect(fetchSeries.mock.calls.map((c) => c[2])).toEqual(["TOS1029"]);
  });

  it("leaves a legacy backup (no bondCatalog member) alone: no read, no fetch", async () => {
    const { service, fetchSeries, manager } = setup();
    const legacy = {
      version: 1,
      exportedAt: "x",
      investment_transactions: [{ id: "t", bond_instrument_id: id("EDO1036") }],
    } as unknown as BackupData;
    const result = await service.recover(USER, legacy);
    expect(result.data).toBe(legacy);
    expect(result.unrecovered).toEqual([]);
    expect(fetchSeries).not.toHaveBeenCalled();
    expect(manager.query).not.toHaveBeenCalled();
  });

  it("records a failed fetch, keeps going, and leaves that series for the restore to sever", async () => {
    const { service, fetchSeries } = setup();
    fetchSeries.mockImplementationOnce(async () => {
      throw new SeriesFetchError("SERIES_NOT_PUBLISHED");
    });
    const input = backup(["EDO1036", "TOS1029"]);
    const result = await service.recover(USER, input);
    expect(fetchSeries).toHaveBeenCalledTimes(2);
    expect(result.unrecovered).toEqual([
      {
        issuerCountryCode: "PL",
        seriesCode: "EDO1036",
        reason: "not-published",
      },
    ]);
    // The row of the unrecovered series still names an id the catalog lacks, so
    // `severUnavailableCatalogLinks` writes NULL for it, as it always did.
    expect(idsOf(result.data)).toEqual(idsOf(input));
  });

  it("reports a series fetched under another issuer than the file named as refused", async () => {
    const { service, fetchSeries } = setup();
    fetchSeries.mockImplementation(async () => ({ id: "x", created: true }));
    const result = await service.recover(USER, backup(["EDO1036"]));
    expect(result.unrecovered).toEqual([
      { issuerCountryCode: "PL", seriesCode: "EDO1036", reason: "refused" },
    ]);
  });

  it("stops asking once the explicit-fetch limit answers, reporting the rest", async () => {
    const { service, fetchSeries } = setup();
    fetchSeries.mockImplementationOnce(async () => {
      throw new HttpException("slow down", HttpStatus.TOO_MANY_REQUESTS);
    });
    const result = await service.recover(
      USER,
      backup(["EDO1036", "TOS1029", "COI0128"]),
    );
    expect(fetchSeries).toHaveBeenCalledTimes(1);
    expect(result.unrecovered.map((u) => [u.seriesCode, u.reason])).toEqual([
      ["EDO1036", "rate-limited"],
      ["TOS1029", "rate-limited"],
      ["COI0128", "rate-limited"],
    ]);
  });

  it("bounds the fetches of one restore and reports the series it did not attempt", async () => {
    const { service, fetchSeries } = setup();
    const codes = Array.from(
      { length: MAX_BOND_SERIES_FETCHES_PER_RESTORE + 3 },
      (_, i) => `EDO${String(i).padStart(4, "0")}`,
    );
    const result = await service.recover(USER, backup(codes));
    expect(fetchSeries).toHaveBeenCalledTimes(
      MAX_BOND_SERIES_FETCHES_PER_RESTORE,
    );
    expect(result.unrecovered.map((u) => u.reason)).toEqual([
      "not-attempted",
      "not-attempted",
      "not-attempted",
    ]);
  });

  it("points a row at the catalog's own id when the file's id differs from it", async () => {
    const { service } = setup(["EDO1036"]);
    const foreign = "12345678-1234-4234-8234-123456789012";
    const input = {
      version: 1,
      exportedAt: "x",
      investment_transactions: [{ id: "t", bond_instrument_id: foreign }],
      bondCatalog: {
        series: [{ ...entry("EDO1036"), bondInstrumentId: foreign }],
      },
    } as unknown as BackupData;
    const result = await service.recover(USER, input);
    expect(idsOf(result.data)).toEqual([id("EDO1036")]);
  });
});

describe("classifyFetchFailure", () => {
  it.each([
    [new SeriesFetchError("SERIES_NOT_PUBLISHED"), "not-published"],
    [new SeriesFetchError("SOURCE_UNAVAILABLE"), "source-unavailable"],
    [new SeriesFetchError("SERIES_FETCH_UNSUPPORTED"), "no-adapter"],
    [new SeriesFetchError("SOURCE_FORMAT_CHANGED"), "refused"],
    [new SeriesFetchError("SERIES_TERMS_CONFLICT"), "refused"],
    [new HttpException("x", HttpStatus.TOO_MANY_REQUESTS), "rate-limited"],
    [new ProviderUnavailableError("x", 1, null), "source-unavailable"],
    [
      Object.assign(new Error("x"), { code: "ECONNRESET" }),
      "source-unavailable",
    ],
    [new Error("boom"), "refused"],
  ])("%s -> %s", (error, reason) => {
    expect(classifyFetchFailure(error)).toBe(reason);
  });
});
