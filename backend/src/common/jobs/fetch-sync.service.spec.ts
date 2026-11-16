import { Test, TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";

import { FetchSyncJob, FetchSyncService } from "./fetch-sync.service";
import { createScopedDbMocks } from "../../test-helpers/scoped-db-testing";

jest.mock("../db/scoped-db", () =>
  jest
    .requireActual("../../test-helpers/scoped-db-testing")
    .scopedDbMockModule(),
);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("FetchSyncService", () => {
  let service: FetchSyncService;
  let manager: Record<string, jest.Mock>;

  beforeEach(async () => {
    const scoped = createScopedDbMocks([]);
    manager = scoped.manager as Record<string, jest.Mock>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FetchSyncService,
        { provide: DataSource, useValue: scoped.dataSource },
      ],
    }).compile();

    service = module.get(FetchSyncService);
  });

  afterEach(() => jest.clearAllMocks());

  describe("claim", () => {
    it("returns the token the database handed back", async () => {
      manager.query.mockResolvedValue([{ lease_token: "tok-1" }]);

      await expect(
        service.claim(FetchSyncJob.ExchangeRates, 60_000),
      ).resolves.toBe("tok-1");
    });

    it("returns null when a live lease refused the retake", async () => {
      manager.query.mockResolvedValue([]);

      await expect(
        service.claim(FetchSyncJob.SecurityPrices, 60_000),
      ).resolves.toBeNull();
    });

    it("retakes only an expired lease, in one statement", async () => {
      manager.query.mockResolvedValue([{ lease_token: "tok" }]);

      await service.claim(FetchSyncJob.MarketIndexes, 60_000);

      expect(manager.query).toHaveBeenCalledTimes(1);
      const [sql, params] = manager.query.mock.calls[0];
      expect(sql).toContain("INSERT INTO fetch_sync");
      expect(sql).toContain("ON CONFLICT (job) DO UPDATE");
      // The lease: a live one returns no row, so its loser stands down. Without
      // this predicate the second replica would simply take the job away.
      expect(sql).toContain("fetch_sync.lease_until < CURRENT_TIMESTAMP");
      expect(sql).toContain("RETURNING lease_token");
      expect(params[0]).toBe(FetchSyncJob.MarketIndexes);
      expect(params[1]).toBe(60_000);
      expect(String(params[2])).toMatch(UUID);
    });

    it("expires against the database clock, not this process's", async () => {
      manager.query.mockResolvedValue([{ lease_token: "tok" }]);

      await service.claim(FetchSyncJob.ExchangeRates, 60_000);

      const [sql] = manager.query.mock.calls[0];
      expect(sql).toContain("CURRENT_TIMESTAMP");
      expect(sql).not.toMatch(/\$\d::timestamptz/);
    });
  });

  // A worker delayed past its own expiry must not hand back the lease a
  // replica now fetching holds.
  describe("token ownership", () => {
    it.each([
      ["release", () => service.release(FetchSyncJob.ExchangeRates, "tok")],
      [
        "markSuccess",
        () => service.markSuccess(FetchSyncJob.ExchangeRates, "tok"),
      ],
      [
        "markFailure",
        () => service.markFailure(FetchSyncJob.ExchangeRates, "tok", "boom"),
      ],
    ])("%s addresses the row by token", async (_name, call) => {
      manager.query.mockResolvedValue([[], 1]);

      await call();

      const [sql, params] = manager.query.mock.calls[0];
      expect(sql).toContain("WHERE job = $1 AND lease_token = $2::uuid");
      expect(params[1]).toBe("tok");
    });
  });

  describe("progress", () => {
    const progress = {
      startedAt: "2026-10-11T10:00:00.000Z",
      phase: "series" as const,
      done: 2,
      total: 8,
      seriesCode: "EDO0124",
      finishedAt: null,
    };

    it("reportProgress writes only under the holder's token and leaves the lease alone", async () => {
      manager.query.mockResolvedValue([[], 0]);

      await service.reportProgress(
        "bond-program-refresh:PL|EDO",
        "tok",
        progress,
      );

      const [sql, params] = manager.query.mock.calls[0];
      expect(sql).toContain("SET progress = $3::jsonb");
      expect(sql).toContain("WHERE job = $1 AND lease_token = $2::uuid");
      expect(sql).not.toContain("lease_until");
      expect(params).toEqual([
        "bond-program-refresh:PL|EDO",
        "tok",
        JSON.stringify(progress),
      ]);
    });

    it("readProgress returns the stored progress, or null without a row or a report", async () => {
      manager.query.mockResolvedValueOnce([{ progress }]);
      await expect(
        service.readProgress("bond-program-refresh:PL|EDO"),
      ).resolves.toEqual(progress);
      manager.query.mockResolvedValueOnce([]);
      await expect(
        service.readProgress("bond-program-refresh:PL|EDO"),
      ).resolves.toBeNull();
      manager.query.mockResolvedValueOnce([{ progress: null }]);
      await expect(
        service.readProgress("bond-program-refresh:PL|EDO"),
      ).resolves.toBeNull();
    });
  });

  describe("withLease", () => {
    it("runs the body and records the success", async () => {
      manager.query.mockResolvedValue([{ lease_token: "tok" }]);
      const body = jest.fn().mockResolvedValue(undefined);

      await expect(
        service.withLease(FetchSyncJob.ExchangeRates, 60_000, body),
      ).resolves.toBe(true);

      expect(body).toHaveBeenCalled();
      const statements = manager.query.mock.calls.map(([sql]) => sql as string);
      expect(statements.some((s) => s.includes("last_success_at"))).toBe(true);
    });

    // Losing is the normal outcome for every replica but one, so it is not an
    // error and it must not stop the body's caller reporting a clean tick.
    it("skips the body when the lease is held elsewhere", async () => {
      manager.query.mockResolvedValue([]);
      const body = jest.fn();

      await expect(
        service.withLease(FetchSyncJob.SecurityPrices, 60_000, body),
      ).resolves.toBe(false);

      expect(body).not.toHaveBeenCalled();
    });

    // The lease must come back on the failure path too, or one crashed fetch
    // would hold the job for the rest of its window.
    it("records the failure, releases, and rethrows", async () => {
      manager.query.mockResolvedValue([{ lease_token: "tok" }]);

      await expect(
        service.withLease(FetchSyncJob.MarketIndexes, 60_000, () =>
          Promise.reject(new Error("provider down")),
        ),
      ).rejects.toThrow("provider down");

      const statements = manager.query.mock.calls.map(([sql]) => sql as string);
      const failure = statements.find((s) => s.includes("last_error = $3"));
      expect(failure).toBeDefined();
      expect(failure).toContain("lease_until = NULL");
    });

    it("bounds the stored error text", async () => {
      manager.query.mockResolvedValue([{ lease_token: "tok" }]);

      await expect(
        service.withLease(FetchSyncJob.MarketIndexes, 60_000, () =>
          Promise.reject(new Error("x".repeat(5000))),
        ),
      ).rejects.toThrow();

      const failure = manager.query.mock.calls.find(([sql]) =>
        (sql as string).includes("last_error = $3"),
      );
      expect((failure![1] as string[])[2].length).toBe(2000);
    });
  });
});
