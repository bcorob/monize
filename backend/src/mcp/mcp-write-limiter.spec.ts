import {
  AuthAttemptCounterMock,
  createAuthAttemptCounterMock,
} from "../test-helpers/auth-attempt-counter-testing";
import { AuthAttemptCounterService } from "../auth/auth-attempt-counter.service";
import { MCP_WRITE_SCOPE } from "../common/daily-write-limiter";
import { McpWriteLimiter, MCP_DAILY_WRITE_LIMIT } from "./mcp-write-limiter";

describe("McpWriteLimiter", () => {
  let counters: AuthAttemptCounterMock;
  let limiter: McpWriteLimiter;

  const make = (config?: unknown) =>
    new McpWriteLimiter(
      counters as unknown as AuthAttemptCounterService,
      config as never,
    );

  const recordMany = async (
    userId: string,
    n: number,
    tool = "create_transaction",
  ) => {
    for (let i = 0; i < n; i++) {
      await limiter.record(userId, tool);
    }
  };

  beforeEach(() => {
    counters = createAuthAttemptCounterMock();
    limiter = make();
  });

  describe("the counter contract", () => {
    // The scope is what every replica must spell identically, or each would
    // be counting a different thing; the key is the user.
    it("counts under the mcp-write scope keyed by the user id", async () => {
      await limiter.record("user-1", "create_transaction");
      await limiter.checkLimit("user-1");

      expect(MCP_WRITE_SCOPE).toBe("mcp-write");
      expect(counters.incrementUntilUtcMidnight).toHaveBeenCalledWith(
        "mcp-write",
        "user-1",
        1,
      );
      expect(counters.peek).toHaveBeenCalledWith("mcp-write", "user-1");
    });

    it("leaves the day boundary to the database, not this process's clock", async () => {
      // The window end is computed in SQL (next UTC midnight on the database
      // clock), so the limiter passes no duration at all.
      await limiter.record("user-1", "create_transaction");
      expect(counters.increment).not.toHaveBeenCalled();
      expect(counters.incrementUntilUtcMidnight.mock.calls[0]).toHaveLength(3);
    });
  });

  describe("checkLimit()", () => {
    it("allows operations when no previous writes exist", async () => {
      const result = await limiter.checkLimit("user-1");
      expect(result.allowed).toBe(true);
      expect(result.currentCount).toBe(0);
      expect(result.limit).toBe(MCP_DAILY_WRITE_LIMIT);
    });

    it("tracks operations per user", async () => {
      await limiter.record("user-1", "create_transaction");
      await limiter.record("user-1", "categorize_transaction");

      const u1 = await limiter.checkLimit("user-1");
      expect(u1.currentCount).toBe(2);
      expect(u1.allowed).toBe(true);

      const u2 = await limiter.checkLimit("user-2");
      expect(u2.currentCount).toBe(0);
      expect(u2.allowed).toBe(true);
    });

    it("blocks when daily limit is reached", async () => {
      await recordMany("user-1", MCP_DAILY_WRITE_LIMIT);

      const result = await limiter.checkLimit("user-1");
      expect(result.allowed).toBe(false);
      expect(result.currentCount).toBe(MCP_DAILY_WRITE_LIMIT);
      expect(result.limit).toBe(MCP_DAILY_WRITE_LIMIT);
    });

    it("allows operations up to but not beyond the limit", async () => {
      await recordMany("user-1", MCP_DAILY_WRITE_LIMIT - 1);

      const beforeLimit = await limiter.checkLimit("user-1");
      expect(beforeLimit.allowed).toBe(true);
      expect(beforeLimit.currentCount).toBe(MCP_DAILY_WRITE_LIMIT - 1);

      await limiter.record("user-1", "create_transaction");

      const atLimit = await limiter.checkLimit("user-1");
      expect(atLimit.allowed).toBe(false);
      expect(atLimit.currentCount).toBe(MCP_DAILY_WRITE_LIMIT);
    });

    it("does not count operations from other users", async () => {
      await recordMany("user-2", MCP_DAILY_WRITE_LIMIT);

      const result = await limiter.checkLimit("user-1");
      expect(result.allowed).toBe(true);
      expect(result.currentCount).toBe(0);
    });

    it("sees writes another instance recorded against the same rows", async () => {
      // Two limiters over one counter table stand in for two replicas: the
      // budget is the row's, not the process's.
      const other = make();
      await other.record("user-1", "create_payee");
      await other.record("user-1", "create_payee");

      expect((await limiter.checkLimit("user-1")).currentCount).toBe(2);
    });

    it("rejects when the count cannot be read, so the caller refuses", async () => {
      counters.peek.mockRejectedValueOnce(new Error("pool exhausted"));
      await expect(limiter.checkLimit("user-1")).rejects.toThrow(
        "pool exhausted",
      );
    });
  });

  describe("record()", () => {
    it("records an operation", async () => {
      await limiter.record("user-1", "create_transaction");

      const result = await limiter.checkLimit("user-1");
      expect(result.currentCount).toBe(1);
    });

    it("records multiple operations", async () => {
      await limiter.record("user-1", "create_transaction");
      await limiter.record("user-1", "categorize_transaction");
      await limiter.record("user-1", "create_transaction");

      const result = await limiter.checkLimit("user-1");
      expect(result.currentCount).toBe(3);
    });

    it("never rejects after the write it counts has committed", async () => {
      counters.incrementUntilUtcMidnight.mockRejectedValueOnce(
        new Error("pool exhausted"),
      );
      await expect(
        limiter.record("user-1", "create_transaction"),
      ).resolves.toBeUndefined();
    });
  });

  describe("window expiry", () => {
    it("reports zero once the day's window has passed", async () => {
      await limiter.record("user-1", "create_transaction");

      // Age the row rather than wait: the window's end is what the counter
      // compares, so a past end is exactly the state a new UTC day leaves.
      const [key] = [...counters.rows.keys()];
      counters.rows.set(key, {
        count: 1,
        windowExpiresAt: new Date(Date.now() - 1000),
      });

      const result = await limiter.checkLimit("user-1");
      expect(result.currentCount).toBe(0);
      expect(result.allowed).toBe(true);
    });
  });

  describe("reserve()", () => {
    it("allows a reservation under the limit", async () => {
      await expect(limiter.reserve("user-1", 5)).resolves.toBeUndefined();
    });

    it("allows a reservation that exactly reaches the limit", async () => {
      await expect(
        limiter.reserve("user-1", MCP_DAILY_WRITE_LIMIT),
      ).resolves.toBeUndefined();
    });

    it("blocks a reservation that would exceed the limit", async () => {
      const result = await limiter.reserve("user-1", MCP_DAILY_WRITE_LIMIT + 1);
      expect(result).toBeDefined();
      expect(result?.isError).toBe(true);
      expect(result?.content[0].text).toContain("Daily write limit reached");
    });

    it("does not count a reservation as a write", async () => {
      await limiter.reserve("user-1", 5);
      expect(counters.incrementUntilUtcMidnight).not.toHaveBeenCalled();
    });

    it("accounts for already-recorded writes when reserving", async () => {
      await recordMany("user-1", MCP_DAILY_WRITE_LIMIT - 2);

      // Two slots remain: reserving two is allowed, three is not.
      await expect(limiter.reserve("user-1", 2)).resolves.toBeUndefined();
      await expect(limiter.reserve("user-1", 3)).resolves.toBeDefined();
    });

    it("shares the budget across operations regardless of tool name", async () => {
      for (let i = 0; i < MCP_DAILY_WRITE_LIMIT; i++) {
        await limiter.record(
          "user-1",
          i % 2 === 0 ? "create_transaction" : "create_payee",
        );
      }

      // A single shared cap: once exhausted, any further write is blocked no
      // matter which domain/tool it belongs to.
      await expect(limiter.reserve("user-1", 1)).resolves.toBeDefined();
    });
  });

  describe("MCP_DAILY_WRITE_LIMIT constant", () => {
    it("is set to 50", () => {
      expect(MCP_DAILY_WRITE_LIMIT).toBe(50);
    });
  });

  describe("configurable limit via MCP_DAILY_WRITE_LIMIT env var", () => {
    const stubConfig = (value: unknown) => ({
      get: jest.fn().mockReturnValue(value),
    });

    it("uses the env value when set to a positive integer", async () => {
      limiter = make(stubConfig(5));
      await recordMany("user-1", 5);
      const result = await limiter.checkLimit("user-1");
      expect(result.limit).toBe(5);
      expect(result.allowed).toBe(false);
    });

    it("accepts the env value as a string (env vars are strings)", async () => {
      expect((await make(stubConfig("3")).checkLimit("user-1")).limit).toBe(3);
    });

    it("falls back to the default when the env value is missing", async () => {
      expect(
        (await make(stubConfig(undefined)).checkLimit("user-1")).limit,
      ).toBe(MCP_DAILY_WRITE_LIMIT);
    });

    it("falls back to the default for invalid or non-positive values", async () => {
      for (const bad of ["abc", "0", "-5", "2.5", ""]) {
        expect((await make(stubConfig(bad)).checkLimit("u")).limit).toBe(
          MCP_DAILY_WRITE_LIMIT,
        );
      }
    });
  });
});
