import { DataSource } from "typeorm";

import { PostgresThrottlerStorage } from "@/common/throttler/postgres-throttler-storage";
import { returnedRows } from "@/common/db/query-result";
import { withSystemContext } from "@/common/db/with-context";

import { INTEGRATION_TYPEORM_OPTIONS } from "../helpers/integration-setup";
import { applyRlsPolicies } from "../helpers/rls-setup";

/**
 * The limit is a property of the statement, not of the class.
 *
 * `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` is the whole throttler: the
 * second writer blocks on the first's row lock, then re-evaluates its `CASE`
 * expressions against the row the first committed. A mocked manager told to
 * return 1 and then 2 proves nothing about that, so every count below is made
 * by PostgreSQL across **two separate pools** -- the closest one test process
 * gets to two replicas (VER-001, `docs/verification-contract.md`).
 *
 * The window and block arithmetic is tested the same way and for the same
 * reason the auth counters are: it moved off a process clock precisely because
 * two replicas' clocks differ, so every comparison here is one the database
 * makes against timestamps it stamped itself.
 */
describe("PostgresThrottlerStorage (real PostgreSQL)", () => {
  let dataSourceA: DataSource;
  let dataSourceB: DataSource;
  let storageA: PostgresThrottlerStorage;
  let storageB: PostgresThrottlerStorage;

  const LONG_WINDOW_MS = 60_000;
  const NO_BLOCK = 0;

  /** A fresh key per case, so one test's counter is never another's. */
  let keySeq = 0;
  const nextKey = () => `key-${Date.now()}-${(keySeq += 1)}`;

  beforeAll(async () => {
    dataSourceA = new DataSource(INTEGRATION_TYPEORM_OPTIONS as never);
    await dataSourceA.initialize();
    await applyRlsPolicies(dataSourceA);
    // A second DataSource is a second pool, so the two storages cannot share a
    // connection however the pool hands them out.
    dataSourceB = new DataSource(INTEGRATION_TYPEORM_OPTIONS as never);
    await dataSourceB.initialize();

    storageA = new PostgresThrottlerStorage(dataSourceA);
    storageB = new PostgresThrottlerStorage(dataSourceB);
  });

  afterAll(async () => {
    if (dataSourceA?.isInitialized) await dataSourceA.destroy();
    if (dataSourceB?.isInitialized) await dataSourceB.destroy();
  });

  it("counts one budget across two connections, not one each", async () => {
    const key = nextKey();

    const first = await storageA.increment(
      key,
      LONG_WINDOW_MS,
      100,
      NO_BLOCK,
      "default",
    );
    const second = await storageB.increment(
      key,
      LONG_WINDOW_MS,
      100,
      NO_BLOCK,
      "default",
    );
    const third = await storageA.increment(
      key,
      LONG_WINDOW_MS,
      100,
      NO_BLOCK,
      "default",
    );

    // The defect this table exists to fix: two in-process Maps would each
    // report 1, then 1, then 2.
    expect([first.totalHits, second.totalHits, third.totalHits]).toEqual([
      1, 2, 3,
    ]);
  });

  it("loses no increment when both connections race", async () => {
    const key = nextKey();

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        (index % 2 === 0 ? storageA : storageB).increment(
          key,
          LONG_WINDOW_MS,
          100,
          NO_BLOCK,
          "default",
        ),
      ),
    );

    // Every count distinct and contiguous: the row lock serializes them, so no
    // two callers can be handed the same number and none can be skipped.
    expect(results.map((r) => r.totalHits).sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
  });

  it("keeps a separate budget per throttler name on one key", async () => {
    // One route can carry several @Throttle decorators with different windows;
    // the guard hashes the name into the key, and the primary key carries it
    // too, so a stricter limiter cannot be spent by a looser one's traffic.
    const key = nextKey();

    await storageA.increment(key, LONG_WINDOW_MS, 100, NO_BLOCK, "default");
    await storageA.increment(key, LONG_WINDOW_MS, 100, NO_BLOCK, "default");
    const other = await storageB.increment(
      key,
      LONG_WINDOW_MS,
      100,
      NO_BLOCK,
      "login",
    );

    expect(other.totalHits).toBe(1);
  });

  it("blocks on the hit that passes the limit, on whichever connection makes it", async () => {
    const key = nextKey();
    const LIMIT = 2;
    const BLOCK_MS = 60_000;

    const first = await storageA.increment(
      key,
      LONG_WINDOW_MS,
      LIMIT,
      BLOCK_MS,
      "login",
    );
    const second = await storageB.increment(
      key,
      LONG_WINDOW_MS,
      LIMIT,
      BLOCK_MS,
      "login",
    );
    const third = await storageA.increment(
      key,
      LONG_WINDOW_MS,
      LIMIT,
      BLOCK_MS,
      "login",
    );

    expect(first.isBlocked).toBe(false);
    expect(second.isBlocked).toBe(false);
    // The third request is the limit+1, and the replica that did not see the
    // first two is the one that refuses it.
    expect(third.isBlocked).toBe(true);
    expect(third.timeToBlockExpire).toBeGreaterThan(0);
    expect(third.timeToBlockExpire).toBeLessThanOrEqual(BLOCK_MS / 1000);
  });

  it("does not let a blocked client extend its own block by hammering", async () => {
    const key = nextKey();
    const BLOCK_MS = 60_000;

    await storageA.increment(key, LONG_WINDOW_MS, 1, BLOCK_MS, "login");
    const blocked = await storageA.increment(
      key,
      LONG_WINDOW_MS,
      1,
      BLOCK_MS,
      "login",
    );
    const stillBlocked = await storageB.increment(
      key,
      LONG_WINDOW_MS,
      1,
      BLOCK_MS,
      "login",
    );

    expect(blocked.isBlocked).toBe(true);
    expect(stillBlocked.isBlocked).toBe(true);
    // Hits stop accumulating while blocked, matching @nestjs/throttler's
    // in-memory storage: a sliding count would turn a fixed sentence into an
    // indefinite one, which is a different control from what the decorators
    // describe.
    expect(stillBlocked.totalHits).toBe(blocked.totalHits);
    expect(stillBlocked.timeToBlockExpire).toBeLessThanOrEqual(
      blocked.timeToBlockExpire,
    );
  });

  it("starts a fresh window once the old one has passed", async () => {
    const key = nextKey();
    // A window short enough to pass inside the test, measured by the database.
    const SHORT_WINDOW_MS = 300;

    const first = await storageA.increment(
      key,
      SHORT_WINDOW_MS,
      100,
      NO_BLOCK,
      "default",
    );
    const second = await storageA.increment(
      key,
      SHORT_WINDOW_MS,
      100,
      NO_BLOCK,
      "default",
    );
    expect([first.totalHits, second.totalHits]).toEqual([1, 2]);

    await sleepPastWindow(dataSourceA, SHORT_WINDOW_MS);

    const afterExpiry = await storageB.increment(
      key,
      SHORT_WINDOW_MS,
      100,
      NO_BLOCK,
      "default",
    );

    // Reset in place rather than deleted-then-inserted, which is what makes the
    // daily sweep a collection of garbage and never part of the limit.
    expect(afterExpiry.totalHits).toBe(1);
  });

  it("lifts a lapsed block and counts again from one", async () => {
    const key = nextKey();
    const SHORT_BLOCK_MS = 300;

    await storageA.increment(key, LONG_WINDOW_MS, 1, SHORT_BLOCK_MS, "login");
    const blocked = await storageA.increment(
      key,
      LONG_WINDOW_MS,
      1,
      SHORT_BLOCK_MS,
      "login",
    );
    expect(blocked.isBlocked).toBe(true);

    await sleepPastWindow(dataSourceA, SHORT_BLOCK_MS);

    const afterBlock = await storageB.increment(
      key,
      LONG_WINDOW_MS,
      1,
      SHORT_BLOCK_MS,
      "login",
    );

    expect(afterBlock.isBlocked).toBe(false);
    expect(afterBlock.totalHits).toBe(1);
    expect(afterBlock.timeToBlockExpire).toBe(0);
  });

  it("writes rows the sweeper's predicate can collect", async () => {
    const key = nextKey();
    const SHORT_WINDOW_MS = 300;
    await storageA.increment(key, SHORT_WINDOW_MS, 100, NO_BLOCK, "default");

    await sleepPastWindow(dataSourceA, SHORT_WINDOW_MS);

    // returnedRows, because a DELETE ... RETURNING comes back as the
    // [rows, affected] tuple rather than as a bare row array -- reading it as
    // an array of rows yields undefined per element and an assertion that
    // passes for the wrong reason.
    const deleted = returnedRows<{ key: string }>(
      await withSystemContext(() => sweepExpired(dataSourceA)),
    );

    expect(deleted.map((r) => r.key)).toContain(key);
  });

  it("spares a row whose block outlives its window", async () => {
    const key = nextKey();
    const SHORT_WINDOW_MS = 300;

    await storageA.increment(key, SHORT_WINDOW_MS, 1, 60_000, "login");
    await storageA.increment(key, SHORT_WINDOW_MS, 1, 60_000, "login");

    await sleepPastWindow(dataSourceA, SHORT_WINDOW_MS);

    const deleted = returnedRows<{ key: string }>(
      await withSystemContext(() => sweepExpired(dataSourceA)),
    );

    // Deleting this row would hand a blocked client a clean count, which is the
    // one way a garbage collector could weaken a limit.
    expect(deleted.map((r) => r.key)).not.toContain(key);
  });
});

/**
 * The exact predicate `AuthStateSweeperService` runs, so the sweep and the rows
 * it is meant to collect cannot drift apart.
 */
async function sweepExpired(dataSource: DataSource): Promise<unknown> {
  return dataSource.query(
    `DELETE FROM http_throttle_counters
      WHERE window_expires_at < CURRENT_TIMESTAMP
        AND (blocked_until IS NULL OR blocked_until < CURRENT_TIMESTAMP)
      RETURNING key`,
  );
}

/**
 * Wait until the database agrees the window has passed.
 *
 * `pg_sleep` rather than a JavaScript timer: the expiry is compared against
 * `CURRENT_TIMESTAMP` in the same statement that reads it, so the only clock
 * that decides the outcome is the database's. A process-side sleep would be
 * asserting against the wrong clock and would be flaky for that reason.
 */
async function sleepPastWindow(
  dataSource: DataSource,
  windowMs: number,
): Promise<void> {
  await dataSource.query(`SELECT pg_sleep($1)`, [(windowMs + 200) / 1000]);
}
