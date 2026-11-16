import { AuthAttemptCounterService } from "../auth/auth-attempt-counter.service";
import {
  AuthAttemptCounterMock,
  createAuthAttemptCounterMock,
} from "../test-helpers/auth-attempt-counter-testing";
import {
  AI_WRITE_SCOPE,
  DailyWriteLimiter,
  MCP_WRITE_SCOPE,
} from "./daily-write-limiter";

describe("DailyWriteLimiter", () => {
  let counters: AuthAttemptCounterMock;
  let limiter: DailyWriteLimiter;

  beforeEach(() => {
    counters = createAuthAttemptCounterMock();
    limiter = new DailyWriteLimiter(
      counters as unknown as AuthAttemptCounterService,
      "test-scope",
      3,
    );
  });

  it("names the two surfaces' scopes", () => {
    expect(AI_WRITE_SCOPE).toBe("ai-write");
    expect(MCP_WRITE_SCOPE).toBe("mcp-write");
  });

  describe("checkLimit()", () => {
    it("reads the count for its scope and the user", async () => {
      await limiter.checkLimit("user-1");
      expect(counters.peek).toHaveBeenCalledWith("test-scope", "user-1");
    });

    it("allows below the limit", async () => {
      await limiter.record("user-1", "t", 2);
      await expect(limiter.checkLimit("user-1")).resolves.toEqual({
        allowed: true,
        currentCount: 2,
        limit: 3,
      });
    });

    it("refuses at the limit", async () => {
      await limiter.record("user-1", "t", 3);
      await expect(limiter.checkLimit("user-1")).resolves.toEqual({
        allowed: false,
        currentCount: 3,
        limit: 3,
      });
    });

    it("refuses over the limit", async () => {
      await limiter.record("user-1", "t", 5);
      await expect(limiter.checkLimit("user-1")).resolves.toEqual({
        allowed: false,
        currentCount: 5,
        limit: 3,
      });
    });

    it("keeps each scope's count separate for one user", async () => {
      const other = new DailyWriteLimiter(
        counters as unknown as AuthAttemptCounterService,
        "other-scope",
        3,
      );
      await limiter.record("user-1", "t", 3);
      expect((await other.checkLimit("user-1")).currentCount).toBe(0);
    });
  });

  describe("record()", () => {
    it("counts one write by default, in one statement", async () => {
      await limiter.record("user-1", "create_payee");
      expect(counters.incrementUntilUtcMidnight).toHaveBeenCalledTimes(1);
      expect(counters.incrementUntilUtcMidnight).toHaveBeenCalledWith(
        "test-scope",
        "user-1",
        1,
      );
    });

    it("counts a bulk action in one statement, not one per row", async () => {
      // A statement per row cost N round trips on fresh connections, and a
      // failure partway left the count short by an amount nobody knew.
      await limiter.record("user-1", "create_transaction", 4);
      expect(counters.incrementUntilUtcMidnight).toHaveBeenCalledTimes(1);
      expect(counters.incrementUntilUtcMidnight).toHaveBeenCalledWith(
        "test-scope",
        "user-1",
        4,
      );
      expect(counters.increment).not.toHaveBeenCalled();
      expect((await limiter.checkLimit("user-1")).currentCount).toBe(4);
    });

    it("counts nothing for a count of zero", async () => {
      await limiter.record("user-1", "create_transaction", 0);
      expect(counters.incrementUntilUtcMidnight).not.toHaveBeenCalled();
    });

    // Recording follows a committed write; a rejection here would report a
    // write the user now has as a failure the caller might retry.
    it("does not reject when the counter cannot be written", async () => {
      counters.incrementUntilUtcMidnight.mockRejectedValue(
        new Error("pool exhausted"),
      );
      await expect(
        limiter.record("user-1", "create_transaction", 2),
      ).resolves.toBeUndefined();
    });
  });
});
