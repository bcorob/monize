import { DataSource } from "typeorm";

import {
  FAILURE_LOG_INTERVAL_MS,
  PostgresThrottlerStorage,
  STATEMENT_DEADLINE_MS,
} from "./postgres-throttler-storage";

/**
 * What a mocked manager can prove about this class, and what it cannot.
 *
 * It can prove the contract with `@nestjs/throttler`: the units (milliseconds
 * in, seconds out), which clock the conversions use, the shape of the statement
 * and its bind parameters, and what happens when the database is gone. It
 * cannot prove that the statement itself counts correctly under two concurrent
 * writers -- that is a property of PostgreSQL, and it is asserted on two real
 * connections in `test/integration/postgres-throttler.integration.spec.ts`
 * (VER-001, `docs/verification-contract.md`).
 */
describe("PostgresThrottlerStorage", () => {
  const NOW = new Date("2026-03-01T12:00:00.000Z");

  let query: jest.Mock;
  let storage: PostgresThrottlerStorage;

  /** One row as the statement returns it, with the database's clock in it. */
  const row = (overrides: Partial<Record<string, unknown>> = {}) => [
    {
      hits: 1,
      window_expires_at: new Date(NOW.getTime() + 60_000),
      blocked_until: null,
      db_now: NOW,
      ...overrides,
    },
  ];

  beforeEach(() => {
    query = jest.fn().mockResolvedValue(row());
    storage = new PostgresThrottlerStorage({
      transaction: (fn: unknown) =>
        (fn as (m: { query: jest.Mock }) => unknown)({ query }),
      query,
    } as unknown as DataSource);
  });

  const sql = () => (query.mock.calls[0]?.[0] as string) ?? "";
  const params = () => (query.mock.calls[0]?.[1] as unknown[]) ?? [];

  describe("the statement", () => {
    it("binds the throttler name, the key and both durations as milliseconds", async () => {
      await storage.increment("key-hash", 60_000, 100, 30_000, "default");

      // The library hands milliseconds; a storage that treated them as seconds
      // would enforce a one-minute window for a full minute of every hour.
      expect(params()).toEqual(["default", "key-hash", 60_000, 100, 30_000]);
    });

    it("rounds a fractional duration rather than passing it to an interval", async () => {
      await storage.increment("k", 1500.7, 5, 900.2, "default");

      expect(params()[2]).toBe(1501);
      expect(params()[4]).toBe(900);
    });

    it("is a single upsert keyed by throttler name and key", async () => {
      await storage.increment("k", 60_000, 100, 0, "default");

      // One statement is the whole mechanism: a read then a write lets two
      // replicas each see "4 of 5" and both allow the fifth.
      expect(query).toHaveBeenCalledTimes(1);
      expect(sql()).toContain("INSERT INTO http_throttle_counters");
      expect(sql()).toContain("ON CONFLICT (name, key) DO UPDATE");
      expect(sql()).toContain("RETURNING");
    });

    it("reads the clock from the database, not from this process", async () => {
      // Two replicas whose clocks differ by a second must not disagree about
      // whether a window has passed, so every comparison and every conversion
      // is against a timestamp the database stamped in the same statement.
      expect(sql()).not.toContain("$6");
      await storage.increment("k", 60_000, 100, 0, "default");
      expect(sql()).toContain("CURRENT_TIMESTAMP AS db_now");
      expect(sql()).not.toMatch(/\bnow\(\)/);
    });
  });

  describe("the record it returns", () => {
    it("reports the hit count and the window in whole seconds", async () => {
      query.mockResolvedValue(
        row({ hits: 7, window_expires_at: new Date(NOW.getTime() + 42_000) }),
      );

      const record = await storage.increment("k", 60_000, 100, 0, "default");

      expect(record).toEqual({
        totalHits: 7,
        timeToExpire: 42,
        isBlocked: false,
        timeToBlockExpire: 0,
      });
    });

    it("rounds a partial second up, as the library's own storage does", async () => {
      query.mockResolvedValue(
        row({ window_expires_at: new Date(NOW.getTime() + 41_001) }),
      );

      const record = await storage.increment("k", 60_000, 100, 0, "default");

      // Math.ceil, so a Retry-After never tells a client to come back before
      // the window has actually passed.
      expect(record.timeToExpire).toBe(42);
    });

    it("counts a hit as blocked while the block is in the future", async () => {
      // 12s remaining against a configured 30s block: the two must differ, or a
      // storage that returned the configured duration instead of the remaining
      // time would pass. That mutation used to survive the whole suite.
      query.mockResolvedValue(
        row({ hits: 101, blocked_until: new Date(NOW.getTime() + 12_000) }),
      );

      const record = await storage.increment("k", 60_000, 100, 30_000, "x");

      expect(record.isBlocked).toBe(true);
      expect(record.timeToBlockExpire).toBe(12);
    });

    it("never reports a negative window while a block runs on", async () => {
      // A blocked key's window is frozen, so once it passes the raw difference
      // goes negative -- and the guard puts timeToExpire in X-RateLimit-Reset,
      // which would tell the client to come back in the past.
      query.mockResolvedValue(
        row({
          hits: 6,
          window_expires_at: new Date(NOW.getTime() - 90_000),
          blocked_until: new Date(NOW.getTime() + 20_000),
        }),
      );

      const record = await storage.increment("k", 60_000, 5, 60_000, "login");

      expect(record.timeToExpire).toBe(0);
      expect(record.timeToBlockExpire).toBe(20);
    });

    it("blocks the very first request when the limit is zero", async () => {
      // The INSERT arm's own block branch, which no other case reaches: with
      // limit 0 the first hit is already over it.
      query.mockResolvedValue(
        row({ hits: 1, blocked_until: new Date(NOW.getTime() + 5_000) }),
      );

      const record = await storage.increment("k", 60_000, 0, 5_000, "x");

      expect(record.isBlocked).toBe(true);
      expect(params()[3]).toBe(0);
    });

    it("is not blocked by a block the database has already passed", async () => {
      // The statement clears a lapsed block, but a row read in the same
      // instant it lapses must not be reported as blocked either.
      query.mockResolvedValue(
        row({ blocked_until: new Date(NOW.getTime() - 1) }),
      );

      const record = await storage.increment("k", 60_000, 100, 30_000, "x");

      expect(record.isBlocked).toBe(false);
      expect(record.timeToBlockExpire).toBe(0);
    });

    it("parses timestamps the driver hands back as strings", async () => {
      // A raw query can return either, depending on the column and the parser.
      query.mockResolvedValue(
        row({
          hits: "3",
          window_expires_at: new Date(NOW.getTime() + 10_000).toISOString(),
          blocked_until: new Date(NOW.getTime() + 5_000).toISOString(),
          db_now: NOW.toISOString(),
        }),
      );

      const record = await storage.increment("k", 60_000, 1, 5_000, "x");

      expect(record).toEqual({
        totalHits: 3,
        timeToExpire: 10,
        isBlocked: true,
        timeToBlockExpire: 5,
      });
    });
  });

  describe("when the database is unreachable", () => {
    let error: jest.SpyInstance;

    beforeEach(() => {
      query.mockRejectedValue(new Error("connection terminated"));
      error = jest
        .spyOn(
          (storage as unknown as { logger: { error: (m: string) => void } })
            .logger,
          "error",
        )
        .mockImplementation(() => undefined);
    });

    afterEach(() => {
      error.mockRestore();
      jest.useRealTimers();
    });

    it("fails open rather than refusing the request", async () => {
      // A closed throttler takes the whole API down with the database, before
      // any handler runs. What is lost is one window's leniency on routes whose
      // real refusal is a row elsewhere (auth_attempt_counters).
      const record = await storage.increment("k", 60_000, 100, 0, "default");

      expect(record).toEqual({
        totalHits: 0,
        timeToExpire: 0,
        isBlocked: false,
        timeToBlockExpire: 0,
      });
    });

    it("logs once a minute, not once a request", async () => {
      jest.useFakeTimers().setSystemTime(NOW);

      await storage.increment("k", 60_000, 100, 0, "default");
      await storage.increment("k", 60_000, 100, 0, "default");
      await storage.increment("k", 60_000, 100, 0, "default");

      expect(error).toHaveBeenCalledTimes(1);

      jest.setSystemTime(new Date(NOW.getTime() + FAILURE_LOG_INTERVAL_MS));
      await storage.increment("k", 60_000, 100, 0, "default");

      expect(error).toHaveBeenCalledTimes(2);
    });

    it("names the cause, so the log says which dependency went", async () => {
      await storage.increment("k", 60_000, 100, 0, "default");

      expect(error.mock.calls[0][0]).toContain("connection terminated");
      expect(error.mock.calls[0][0]).toContain("failing");
    });

    it("reports a blip as transient, with nothing for /health to show", async () => {
      await storage.increment("k", 60_000, 100, 0, "default");

      // A connection that comes back restores the limiter on its own.
      expect(storage.degradedReason()).toBeNull();
    });
  });

  describe("when the failure is structural", () => {
    let error: jest.SpyInstance;

    const failWith = (code: string, message: string) => {
      const failure = Object.assign(new Error(message), { code });
      query.mockRejectedValue(failure);
    };

    beforeEach(() => {
      error = jest
        .spyOn(
          (storage as unknown as { logger: { error: (m: string) => void } })
            .logger,
          "error",
        )
        .mockImplementation(() => undefined);
    });

    afterEach(() => error.mockRestore());

    it.each([
      ["42P01", 'relation "http_throttle_counters" does not exist'],
      ["42501", "permission denied for table http_throttle_counters"],
      ["42601", "syntax error at or near ON"],
    ])("records %s so /health can report it", async (code, message) => {
      failWith(code, message);

      await storage.increment("k", 60_000, 100, 0, "default");

      // This does not heal when the connection comes back: every HTTP rate
      // limit in the deployment is off until somebody fixes it, and every other
      // signal stays green because the storage fails open.
      expect(storage.degradedReason()).toContain(code);
      expect(error.mock.calls[0][0]).toContain("Rate limiting is DISABLED");
    });

    it("logs every occurrence, not once a minute", async () => {
      jest.useFakeTimers().setSystemTime(NOW);
      failWith("42P01", "relation does not exist");

      await storage.increment("k", 60_000, 100, 0, "default");
      await storage.increment("k", 60_000, 100, 0, "default");
      await storage.increment("k", 60_000, 100, 0, "default");

      // The once-a-minute throttle is for a blip. Folding a permanently
      // disabled limiter into it is how it stays unnoticed.
      expect(error).toHaveBeenCalledTimes(3);
      jest.useRealTimers();
    });

    it("clears the report once the statement works again", async () => {
      failWith("42P01", "relation does not exist");
      await storage.increment("k", 60_000, 100, 0, "default");
      expect(storage.degradedReason()).not.toBeNull();

      query.mockResolvedValue(row());
      await storage.increment("k", 60_000, 100, 0, "default");

      expect(storage.degradedReason()).toBeNull();
    });
  });

  describe("a key it already knows is blocked", () => {
    it("is refused without touching the database", async () => {
      // A client hammering through its block would otherwise turn every refused
      // request into a transaction and a row lock on one hot page: a rate
      // limiter that amplifies load instead of shedding it.
      query.mockResolvedValue(
        row({ hits: 6, blocked_until: new Date(NOW.getTime() + 30_000) }),
      );
      const first = await storage.increment("k", 60_000, 5, 30_000, "login");
      expect(first.isBlocked).toBe(true);
      expect(query).toHaveBeenCalledTimes(1);

      const second = await storage.increment("k", 60_000, 5, 30_000, "login");

      expect(second.isBlocked).toBe(true);
      expect(second.timeToBlockExpire).toBeGreaterThan(0);
      expect(query).toHaveBeenCalledTimes(1);
    });

    it("goes back to the database once the block has lapsed", async () => {
      // The cache can only ever refuse during a period the database would also
      // have refused; reopening the window is the database's decision alone.
      jest.useFakeTimers().setSystemTime(NOW);
      query.mockResolvedValue(
        row({ hits: 6, blocked_until: new Date(NOW.getTime() + 1_000) }),
      );
      await storage.increment("k", 60_000, 5, 1_000, "login");

      jest.setSystemTime(new Date(NOW.getTime() + 2_000));
      query.mockResolvedValue(row());
      const after = await storage.increment("k", 60_000, 5, 1_000, "login");

      expect(after.isBlocked).toBe(false);
      expect(query).toHaveBeenCalledTimes(2);
      jest.useRealTimers();
    });

    it("keeps a separate block per throttler on one key", async () => {
      query.mockResolvedValue(
        row({ hits: 6, blocked_until: new Date(NOW.getTime() + 30_000) }),
      );
      await storage.increment("k", 60_000, 5, 30_000, "login");

      query.mockResolvedValue(row());
      const other = await storage.increment("k", 60_000, 100, 0, "default");

      // A stricter limiter's block must not refuse a looser limiter's traffic.
      expect(other.isBlocked).toBe(false);
      expect(query).toHaveBeenCalledTimes(2);
    });
  });

  describe("when the database is saturated rather than down", () => {
    it("fails open on its own deadline instead of queueing behind the pool", async () => {
      // The pool's acquire has no timeout, so `withScopedDb` queues rather than
      // throwing: without a deadline of its own the fail-open path is
      // unreachable in exactly the degradation it was written for, and every
      // request stalls inside the guard.
      jest.useFakeTimers();
      const error = jest
        .spyOn(
          (storage as unknown as { logger: { error: (m: string) => void } })
            .logger,
          "error",
        )
        .mockImplementation(() => undefined);
      query.mockImplementation(() => new Promise(() => undefined));

      const pending = storage.increment("k", 60_000, 100, 0, "default");
      await jest.advanceTimersByTimeAsync(STATEMENT_DEADLINE_MS);

      await expect(pending).resolves.toEqual({
        totalHits: 0,
        timeToExpire: 0,
        isBlocked: false,
        timeToBlockExpire: 0,
      });
      error.mockRestore();
      jest.useRealTimers();
    });
  });
});
