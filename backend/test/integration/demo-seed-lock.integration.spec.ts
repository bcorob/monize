import { Client } from "pg";

import {
  DB_LIFECYCLE_LOCK_KEY,
  acquireDbLifecycleLock,
} from "@/common/db/advisory-locks";
import { demoUserExistsOn } from "@/db-demo-check";

/**
 * Two demo containers started together seed once.
 *
 * What makes that true is `pg_advisory_lock`: a session-scoped lock, taken on a
 * dedicated direct connection, that the follower blocks on and then re-reads
 * behind. None of that is observable from one connection -- a mocked client can
 * be told the lock was granted and would demonstrate nothing -- so this runs
 * two real `pg.Client` sessions and interleaves them (VER-001,
 * `docs/verification-contract.md`).
 *
 * `seed.ts` itself is not invoked. It calls `process.exit` and builds a Nest
 * application context, neither of which belongs in a Jest worker; what it adds
 * over the previous version is the lock and the re-check behind it, and those
 * are exactly what is driven here, through the same two exported functions it
 * calls.
 */
describe("demo seed lifecycle lock (real PostgreSQL)", () => {
  const DEMO_EMAIL = "demo@monize.com";

  let first: Client;
  let second: Client;

  // The same connection the startup scripts make: read from the environment,
  // direct, never through a pool. `INTEGRATION_TYPEORM_OPTIONS` reads the same
  // variables with the same defaults, which is what keeps the two in step.
  const connection = () =>
    new Client({
      host: process.env.DATABASE_HOST || "localhost",
      port: parseInt(process.env.DATABASE_PORT || "5432", 10),
      user: process.env.DATABASE_USER || "monize_user",
      password: process.env.DATABASE_PASSWORD || "monize_password",
      database: process.env.DATABASE_NAME || "monize_test",
    });

  const holders = async (): Promise<number> => {
    const probe = connection();
    await probe.connect();
    try {
      const { rows } = await probe.query(
        `SELECT count(*)::int AS held FROM pg_locks
          WHERE locktype = 'advisory' AND objid = $1 AND granted`,
        [DB_LIFECYCLE_LOCK_KEY],
      );
      return rows[0].held as number;
    } finally {
      await probe.end();
    }
  };

  beforeEach(async () => {
    first = connection();
    second = connection();
    await first.connect();
    await second.connect();
    await first.query(
      `CREATE TABLE IF NOT EXISTS users (
         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         email TEXT UNIQUE
       )`,
    );
    await first.query("DELETE FROM users WHERE email = $1", [DEMO_EMAIL]);
  });

  afterEach(async () => {
    await first.end().catch(() => undefined);
    await second.end().catch(() => undefined);
  });

  it("makes the second seeder wait for the first", async () => {
    await acquireDbLifecycleLock(first, () => undefined);

    let secondAcquired = false;
    const waiting = acquireDbLifecycleLock(second, () => undefined).then(() => {
      secondAcquired = true;
    });

    // Still blocked: the lock is held, and the follower is not "checking and
    // carrying on", it is queued behind the holder.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(secondAcquired).toBe(false);
    expect(await holders()).toBe(1);

    // The winner seeds, then its connection closes -- which is the release.
    await first.query("INSERT INTO users (email) VALUES ($1)", [DEMO_EMAIL]);
    await first.end();

    await waiting;
    expect(secondAcquired).toBe(true);
  });

  it("lets the follower find the seed already done", async () => {
    await acquireDbLifecycleLock(first, () => undefined);
    // Before the winner writes anything, the answer is "not seeded" -- which is
    // what both containers saw, and why both used to seed.
    await expect(demoUserExistsOn(first)).resolves.toBe(false);

    await first.query("INSERT INTO users (email) VALUES ($1)", [DEMO_EMAIL]);
    await first.end();

    await acquireDbLifecycleLock(second, () => undefined);
    // The re-check behind the lock is what turns the follower into a no-op.
    await expect(demoUserExistsOn(second)).resolves.toBe(true);
  });

  // A session lock dies with its connection: there is no unlock to forget, and
  // a killed container leaves nothing for an operator to clear.
  it("releases the lock when the holder's connection closes", async () => {
    await acquireDbLifecycleLock(first, () => undefined);
    expect(await holders()).toBe(1);

    await first.end();

    expect(await holders()).toBe(0);
  });
});
