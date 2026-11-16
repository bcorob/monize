import { Test, TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";

import { AuthAttemptCounterService } from "./auth-attempt-counter.service";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { runOutsideActiveScopedManager } from "../common/db/scoped-db";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

describe("AuthAttemptCounterService", () => {
  let service: AuthAttemptCounterService;
  let manager: Record<string, jest.Mock>;
  let dataSource: { transaction: jest.Mock; query: jest.Mock };

  beforeEach(async () => {
    const scoped = createScopedDbMocks([]);
    manager = scoped.manager as Record<string, jest.Mock>;
    dataSource = scoped.dataSource;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthAttemptCounterService,
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    service = module.get(AuthAttemptCounterService);
  });

  afterEach(() => jest.clearAllMocks());

  describe("increment", () => {
    it("counts in one statement and returns what the database wrote", async () => {
      const windowExpiresAt = new Date("2026-01-01T12:05:00.000Z");
      manager.query.mockResolvedValue([
        { count: 3, window_expires_at: windowExpiresAt },
      ]);

      const result = await service.increment(
        "2fa-user",
        "user-1",
        300_000,
        "sliding",
      );

      expect(result).toEqual({ count: 3, windowExpiresAt });
      expect(manager.query).toHaveBeenCalledTimes(1);
      const [sql, params] = manager.query.mock.calls[0];
      // One INSERT ... ON CONFLICT DO UPDATE, so the count a caller compares
      // against its threshold is the count the database serialized.
      expect(sql).toContain("INSERT INTO auth_attempt_counters");
      expect(sql).toContain("ON CONFLICT (scope, key) DO UPDATE");
      expect(sql).toContain("RETURNING");
      expect(params).toEqual(["2fa-user", "user-1", 300_000, true]);
    });

    // The two shapes are different security controls, and nothing about the
    // statement says which one a call site meant -- so the parameter is pinned
    // here and the mode is asserted at each call site below.
    it("asks the statement to push a sliding window's end out", async () => {
      manager.query.mockResolvedValue([
        { count: 2, window_expires_at: new Date() },
      ]);

      await service.increment("step-up", "user-1:export", 1000, "sliding");

      const [sql, params] = manager.query.mock.calls[0];
      expect(sql).toContain("WHEN $4::boolean");
      expect(params[3]).toBe(true);
    });

    it("leaves a fixed window's end where the first attempt put it", async () => {
      manager.query.mockResolvedValue([
        { count: 2, window_expires_at: new Date() },
      ]);

      await service.increment("forgot-password", "hash", 1000, "fixed");

      expect(manager.query.mock.calls[0][1][3]).toBe(false);
    });

    it("compares the window against the database clock, never this process's", async () => {
      manager.query.mockResolvedValue([
        { count: 1, window_expires_at: new Date() },
      ]);

      await service.increment("2fa-user", "user-1", 300_000, "sliding");

      const [sql] = manager.query.mock.calls[0];
      expect(sql).toContain("CURRENT_TIMESTAMP");
      expect(sql).not.toMatch(/\$\d::timestamptz/);
    });

    it("coerces the driver's string count and timestamp", async () => {
      manager.query.mockResolvedValue([
        { count: "7", window_expires_at: "2026-01-01T12:05:00.000Z" },
      ]);

      const result = await service.increment(
        "2fa-token",
        "hash",
        1000,
        "fixed",
      );

      expect(result.count).toBe(7);
      expect(result.windowExpiresAt).toBeInstanceOf(Date);
      expect(result.windowExpiresAt.toISOString()).toBe(
        "2026-01-01T12:05:00.000Z",
      );
    });

    // A failure counter written inside the transaction that refuses the request
    // rolls back with the refusal, and the limiter counts nothing.
    it("runs outside the caller's transaction so the count survives the refusal", async () => {
      manager.query.mockResolvedValue([
        { count: 1, window_expires_at: new Date() },
      ]);

      await service.increment("2fa-user", "user-1", 1000, "sliding");

      expect(runOutsideActiveScopedManager).toHaveBeenCalledTimes(1);
    });
  });

  describe("incrementUntilUtcMidnight", () => {
    it("adds the whole amount in one statement and returns what the database wrote", async () => {
      const windowExpiresAt = new Date("2026-03-16T00:00:00.000Z");
      manager.query.mockResolvedValue([
        { count: "7", window_expires_at: windowExpiresAt.toISOString() },
      ]);

      const result = await service.incrementUntilUtcMidnight(
        "mcp-write",
        "user-1",
        4,
      );

      expect(result).toEqual({ count: 7, windowExpiresAt });
      expect(manager.query).toHaveBeenCalledTimes(1);
      const [sql, params] = manager.query.mock.calls[0];
      expect(sql).toContain("INSERT INTO auth_attempt_counters");
      expect(sql).toContain("ON CONFLICT (scope, key) DO UPDATE");
      // The amount is added, not one per call, and a lapsed window restarts
      // at the amount rather than at 1.
      expect(sql).toContain("auth_attempt_counters.count + EXCLUDED.count");
      expect(sql).toMatch(/THEN EXCLUDED\.count/);
      expect(params).toEqual(["mcp-write", "user-1", 4]);
    });

    it("computes the day boundary in SQL, never from this process's clock", async () => {
      manager.query.mockResolvedValue([
        { count: 1, window_expires_at: new Date() },
      ]);

      await service.incrementUntilUtcMidnight("ai-write", "user-1", 1);

      const [sql, params] = manager.query.mock.calls[0];
      expect(sql).toContain(
        "(date_trunc('day', now() AT TIME ZONE 'UTC') + interval '1 day') AT TIME ZONE 'UTC'",
      );
      // No duration from this process in the parameters: only scope, key, amount.
      expect(params).toHaveLength(3);
    });

    it("runs outside the caller's transaction, like increment", async () => {
      manager.query.mockResolvedValue([
        { count: 1, window_expires_at: new Date() },
      ]);

      await service.incrementUntilUtcMidnight("ai-write", "user-1", 1);

      expect(runOutsideActiveScopedManager).toHaveBeenCalledTimes(1);
    });
  });

  describe("peek", () => {
    it("ignores a row whose window has passed", async () => {
      manager.query.mockResolvedValue([]);

      await expect(service.peek("step-up", "user-1:delete")).resolves.toBe(0);
      const [sql] = manager.query.mock.calls[0];
      expect(sql).toContain("window_expires_at >= CURRENT_TIMESTAMP");
    });

    it("returns the stored count inside the window", async () => {
      manager.query.mockResolvedValue([{ count: "2" }]);

      await expect(service.peek("step-up", "user-1:delete")).resolves.toBe(2);
    });

    it("joins the caller's transaction", async () => {
      manager.query.mockResolvedValue([]);

      await service.peek("step-up", "user-1:delete");

      expect(runOutsideActiveScopedManager).not.toHaveBeenCalled();
    });
  });

  describe("reset", () => {
    it("deletes the one row", async () => {
      manager.query.mockResolvedValue([[], 1]);

      await service.reset("forgot-password", "email-hash");

      const [sql, params] = manager.query.mock.calls[0];
      expect(sql).toContain("DELETE FROM auth_attempt_counters");
      expect(params).toEqual(["forgot-password", "email-hash"]);
    });
  });
});
