import { DataSource } from "typeorm";

import {
  type FailedLoginResult,
  LOGIN_LOCKOUT_BASE_MS,
  LOGIN_LOCKOUT_MAX_MS,
  LOGIN_LOCKOUT_THRESHOLD,
  recordFailedLogin,
} from "@/auth/login-lockout";
import { withScopedDb } from "@/common/db/scoped-db";
import { withSystemContext } from "@/common/db/with-context";

import { INTEGRATION_TYPEORM_OPTIONS } from "../helpers/integration-setup";
import { applyRlsPolicies } from "../helpers/rls-setup";

/**
 * The password lockout is arithmetic PostgreSQL does inside one UPDATE, so it
 * is tested against PostgreSQL. A mocked manager can be told any `RETURNING`
 * row and proves nothing about the interval the statement computes.
 *
 * Three properties, each of which the previous statement lacked or never had a
 * real-database test for:
 *
 * - the lock is bounded: the exponent grew with every run of five failures, so
 *   anyone who knew an address could keep its owner locked out indefinitely,
 *   and a large enough count overflowed the interval into an error;
 * - the escalation is forgotten a day after a lock expires;
 * - N concurrent failures on two connections count N (INV-AUTH-002).
 */
describe("recordFailedLogin (real PostgreSQL)", () => {
  let dataSourceA: DataSource;
  let dataSourceB: DataSource;

  const USER_ID = "44444444-4444-4444-8444-444444444444";

  const fail = (dataSource: DataSource) =>
    withSystemContext(() =>
      withScopedDb(dataSource, (manager) =>
        recordFailedLogin(manager, USER_ID),
      ),
    );

  /** The stored state, with the lock as seconds from now (database clock). */
  const state = async () => {
    const rows: {
      attempts: number;
      locked_for_seconds: string | null;
    }[] = await dataSourceA.query(
      `SELECT failed_login_attempts AS attempts,
              EXTRACT(EPOCH FROM (locked_until - LOCALTIMESTAMP))::text
                AS locked_for_seconds
         FROM users WHERE id = $1`,
      [USER_ID],
    );
    const row = rows[0];
    return {
      attempts: Number(row.attempts),
      lockedForMs:
        row.locked_for_seconds === null
          ? null
          : Number(row.locked_for_seconds) * 1000,
    };
  };

  /** Seed the counter and a lock that ends `lockOffsetMs` from now. */
  const seed = async (attempts: number, lockOffsetMs: number | null) => {
    await dataSourceA.query(
      `UPDATE users
          SET failed_login_attempts = $2,
              locked_until = CASE
                WHEN $3::bigint IS NULL THEN NULL
                ELSE LOCALTIMESTAMP + ($3::bigint * INTERVAL '1 millisecond')
              END
        WHERE id = $1`,
      [USER_ID, attempts, lockOffsetMs],
    );
  };

  beforeAll(async () => {
    dataSourceA = new DataSource(INTEGRATION_TYPEORM_OPTIONS as never);
    await dataSourceA.initialize();
    await applyRlsPolicies(dataSourceA);
    // A second pool, so the concurrent case really runs on two connections.
    dataSourceB = new DataSource(INTEGRATION_TYPEORM_OPTIONS as never);
    await dataSourceB.initialize();
  });

  afterAll(async () => {
    if (dataSourceA?.isInitialized) await dataSourceA.destroy();
    if (dataSourceB?.isInitialized) await dataSourceB.destroy();
  });

  beforeEach(async () => {
    await dataSourceA.query("DELETE FROM users WHERE id = $1", [USER_ID]);
    await dataSourceA.query(
      "INSERT INTO users (id, email) VALUES ($1, 'lockout@example.com')",
      [USER_ID],
    );
  });

  it("locks on the fifth failure for the base window, and says so once", async () => {
    const results: FailedLoginResult[] = [];
    for (let i = 0; i < LOGIN_LOCKOUT_THRESHOLD; i++) {
      results.push(await fail(dataSourceA));
    }

    expect(results.map((r) => r.justLocked)).toEqual([
      false,
      false,
      false,
      false,
      true,
    ]);
    const { attempts, lockedForMs } = await state();
    expect(attempts).toBe(LOGIN_LOCKOUT_THRESHOLD);
    expect(lockedForMs).toBeGreaterThan(LOGIN_LOCKOUT_BASE_MS - 60_000);
    expect(lockedForMs).toBeLessThanOrEqual(LOGIN_LOCKOUT_BASE_MS);
  });

  it("still doubles the lock inside the cap", async () => {
    // Ten failures is the second tier: 60 minutes.
    await seed(9, -1000);

    await fail(dataSourceA);

    const { attempts, lockedForMs } = await state();
    expect(attempts).toBe(10);
    expect(lockedForMs).toBeGreaterThan(2 * LOGIN_LOCKOUT_BASE_MS - 60_000);
    expect(lockedForMs).toBeLessThanOrEqual(2 * LOGIN_LOCKOUT_BASE_MS);
  });

  it("never locks for longer than the cap, however many failures came before", async () => {
    // Uncapped, 1000 failures asked for 30 minutes * 2^199, which PostgreSQL
    // refuses as an out-of-range interval -- the login became a 500 -- and any
    // count short of that locked the owner out for years.
    await seed(999, -1000);

    const result = await fail(dataSourceA);

    expect(result.attempts).toBe(1000);
    const { lockedForMs } = await state();
    expect(lockedForMs).toBeGreaterThan(LOGIN_LOCKOUT_MAX_MS - 60_000);
    expect(lockedForMs).toBeLessThanOrEqual(LOGIN_LOCKOUT_MAX_MS);
  });

  it("forgets the escalation a day after the lock expired", async () => {
    // Twenty failures, locked, and the lock ran out 25 hours ago.
    await seed(20, -25 * 60 * 60 * 1000);

    const first = await fail(dataSourceA);

    // Counted as the first failure again: no lock, and the stale lock is gone
    // so the decay does not fire on every later failure too.
    expect(first).toMatchObject({ attempts: 1, justLocked: false });
    expect(await state()).toEqual({ attempts: 1, lockedForMs: null });

    for (let i = 1; i < LOGIN_LOCKOUT_THRESHOLD; i++) {
      await fail(dataSourceA);
    }
    // Five more failures lock again, at the base length -- not at the
    // fifth tier the old count would have reached.
    const { attempts, lockedForMs } = await state();
    expect(attempts).toBe(LOGIN_LOCKOUT_THRESHOLD);
    expect(lockedForMs).toBeGreaterThan(LOGIN_LOCKOUT_BASE_MS - 60_000);
    expect(lockedForMs).toBeLessThanOrEqual(LOGIN_LOCKOUT_BASE_MS);
  });

  it("keeps counting when the lock expired less than a day ago", async () => {
    await seed(10, -60 * 60 * 1000);

    await fail(dataSourceA);

    const { attempts, lockedForMs } = await state();
    expect(attempts).toBe(11);
    expect(lockedForMs).toBeGreaterThan(2 * LOGIN_LOCKOUT_BASE_MS - 60_000);
  });

  it("counts every one of N concurrent failures on two connections", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        fail(i % 2 === 0 ? dataSourceA : dataSourceB),
      ),
    );

    expect(results.map((r) => r.attempts).sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    // One lockout transition, whichever connection wrote it.
    expect(results.filter((r) => r.justLocked)).toHaveLength(1);
    expect((await state()).attempts).toBe(8);
  });
});
