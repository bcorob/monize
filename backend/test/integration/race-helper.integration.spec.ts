import { DataSource } from "typeorm";
import { withScopedDb } from "@/common/db/scoped-db";
import { withSystemContext } from "@/common/db/with-context";
import { INTEGRATION_TYPEORM_OPTIONS } from "../helpers/integration-setup";
import { createBarrier, openPeerDataSource, raceTwo } from "../helpers/race";

/**
 * The race helper's own proof (A26-M42, VER-002). A helper that silently
 * serialized its racers -- one connection, or a barrier that never made both
 * wait -- would make every race test built on it pass vacuously, so each
 * primitive is shown here producing the interleaving it promises: the lost
 * update a read-then-write without a lock suffers, and the parked pair a gate
 * releases.
 */
describe("race helper (integration)", () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = new DataSource({ ...INTEGRATION_TYPEORM_OPTIONS } as never);
    await dataSource.initialize();
    await dataSource.query(
      `CREATE TABLE IF NOT EXISTS race_helper_probe (id int PRIMARY KEY, n int NOT NULL)`,
    );
  });

  afterAll(async () => {
    await dataSource.query(`DROP TABLE IF EXISTS race_helper_probe`);
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query(`TRUNCATE race_helper_probe`);
    await dataSource.query(`INSERT INTO race_helper_probe VALUES (1, 0)`);
  });

  const current = async (ds: DataSource = dataSource): Promise<number> => {
    const [row] = await ds.query(
      `SELECT n FROM race_helper_probe WHERE id = 1`,
    );
    return Number(row.n);
  };

  /** Read n, optionally under a row lock, then write n + 1. */
  const increment =
    (ds: DataSource, { lock }: { lock: boolean }) =>
    (barrier: { arrive(): Promise<void> } | null) =>
      withSystemContext(() =>
        withScopedDb(ds, async (m) => {
          const [row] = await m.query(
            `SELECT n FROM race_helper_probe WHERE id = 1${lock ? " FOR UPDATE" : ""}`,
          );
          if (barrier) await barrier.arrive();
          await m.query(`UPDATE race_helper_probe SET n = $1 WHERE id = 1`, [
            Number(row.n) + 1,
          ]);
        }),
      );

  it("a barrier between read and write interleaves two connections (a lost update proves it)", async () => {
    const outcome = await raceTwo(
      dataSource,
      (barrier) => increment(dataSource, { lock: false })(barrier),
      (barrier) => increment(dataSource, { lock: false })(barrier),
    );

    expect(outcome.fulfilled).toBe(2);
    // Both read 0 before either wrote: the interleaving really happened.
    expect(await current()).toBe(1);
  });

  it("a gate parks both racers on their own connections and releases them", async () => {
    const outcome = await raceTwo(
      dataSource,
      () => increment(dataSource, { lock: true })(null),
      () => increment(dataSource, { lock: true })(null),
      {
        gate: {
          sql: `SELECT n FROM race_helper_probe WHERE id = 1 FOR UPDATE`,
        },
      },
    );

    expect(outcome.fulfilled).toBe(2);
    expect(await current()).toBe(2);
  });

  it("a peer DataSource is a second pool on the same database", async () => {
    const peer = await openPeerDataSource(dataSource);
    try {
      const outcome = await raceTwo(
        dataSource,
        (barrier) => increment(dataSource, { lock: false })(barrier),
        (barrier) => increment(peer, { lock: false })(barrier),
      );
      expect(outcome.fulfilled).toBe(2);
      expect(await current(peer)).toBe(1);
    } finally {
      await peer.destroy();
    }
  });

  it("reports a racer's rejection as an outcome, not a throw", async () => {
    const outcome = await raceTwo(
      dataSource,
      () => increment(dataSource, { lock: true })(null),
      () => Promise.reject(new Error("refused")),
    );

    expect(outcome.fulfilled).toBe(1);
    expect(outcome.reasons).toEqual([new Error("refused")]);
    expect(await current()).toBe(1);
  });

  it("a barrier a peer never reaches fails by name instead of hanging", async () => {
    const barrier = createBarrier(2, 50);
    await expect(barrier.arrive()).rejects.toThrow(
      /barrier timed out: 1 of 2 parties arrived/,
    );
  });
});
