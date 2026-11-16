import type { EntityManager } from "typeorm";
import {
  LOGIN_LOCKOUT_BASE_MS,
  LOGIN_LOCKOUT_DECAY_MS,
  LOGIN_LOCKOUT_MAX_DOUBLINGS,
  LOGIN_LOCKOUT_MAX_MS,
  LOGIN_LOCKOUT_THRESHOLD,
  recordFailedLogin,
} from "./login-lockout";

/**
 * The arithmetic itself is PostgreSQL's, so what a real database computes is
 * proven in `test/integration/login-lockout.integration.spec.ts`. This spec pins
 * the parameters the statement is handed and how its `RETURNING` row is read.
 */
describe("recordFailedLogin", () => {
  const managerReturning = (result: unknown) => {
    const query = jest.fn().mockResolvedValue(result);
    return { manager: { query } as unknown as EntityManager, query };
  };

  it("caps the lock at four hours", () => {
    expect(LOGIN_LOCKOUT_THRESHOLD).toBe(5);
    expect(LOGIN_LOCKOUT_BASE_MS).toBe(30 * 60 * 1000);
    expect(LOGIN_LOCKOUT_MAX_MS).toBe(4 * 60 * 60 * 1000);
    expect(LOGIN_LOCKOUT_DECAY_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("hands the statement the cap and the decay window, not only the base", async () => {
    // The unbounded version passed three parameters and raised 2 to
    // floor(n / 5) - 1 with nothing above it, so every run of five failures
    // doubled a lock nobody but the attacker could end.
    const { manager, query } = managerReturning([[], 0]);

    await recordFailedLogin(manager, "user-1");

    const [sql, params] = query.mock.calls[0];
    expect(params).toEqual([
      "user-1",
      LOGIN_LOCKOUT_THRESHOLD,
      LOGIN_LOCKOUT_BASE_MS,
      LOGIN_LOCKOUT_MAX_DOUBLINGS,
      LOGIN_LOCKOUT_DECAY_MS,
    ]);
    expect(sql).toContain("LEAST(");
    expect(sql).toMatch(/\$4::numeric/);
    // One statement: the decay, the count and the lock are decided together.
    expect(query).toHaveBeenCalledTimes(1);
    expect(sql).toMatch(/^\s*WITH prev AS/);
    // The pre-update lock is read under the row lock, not from a snapshot.
    expect(sql).toMatch(/WHERE id = \$1 FOR UPDATE/);
    expect(sql).toContain("RETURNING");
  });

  it("reports a missing user as no attempt, not a first failure", async () => {
    const { manager } = managerReturning([[], 0]);

    await expect(recordFailedLogin(manager, "gone")).resolves.toEqual({
      attempts: 0,
      justLocked: false,
      lockedUntil: null,
    });
  });

  it("reports justLocked only for the write that crossed into locked", async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000);
    const crossing = managerReturning([
      [{ attempts: "5", old_locked_until: null, new_locked_until: future }],
      1,
    ]);
    const already = managerReturning([
      [{ attempts: 6, old_locked_until: future, new_locked_until: future }],
      1,
    ]);

    await expect(
      recordFailedLogin(crossing.manager, "user-1"),
    ).resolves.toEqual({ attempts: 5, justLocked: true, lockedUntil: future });
    await expect(recordFailedLogin(already.manager, "user-1")).resolves.toEqual(
      { attempts: 6, justLocked: false, lockedUntil: future },
    );
  });

  it("treats an expired stored lock as not locked", async () => {
    // What a decayed row looks like: the old lock is in the past, the new one
    // is cleared, and the count restarted at one.
    const past = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const { manager } = managerReturning([
      [{ attempts: 1, old_locked_until: past, new_locked_until: null }],
      1,
    ]);

    await expect(recordFailedLogin(manager, "user-1")).resolves.toEqual({
      attempts: 1,
      justLocked: false,
      lockedUntil: null,
    });
  });
});
