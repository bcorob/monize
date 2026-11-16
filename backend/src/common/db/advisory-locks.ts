import { Logger } from "@nestjs/common";
/**
 * Session advisory locks the startup paths take.
 *
 * `db-init` and `db-migrate` both run in **every** backend process. Neither took
 * a lock, and both are check-then-act: the initializer asks whether `users`
 * exists and then applies `schema.sql`; the migrator reads the applied-filename
 * set and then applies each pending file. Start two pods against a fresh
 * database, or against one pending migration, and both decide the same work is
 * outstanding. One wins; the other hits duplicate DDL or the tracker's primary
 * key, rolls back, and exits non-zero under `set -e`. It usually succeeds after
 * a restart, once it can see the winner's state -- so the symptom is a
 * crash-looping pod during every rollout that carries a migration, and a
 * rollout that looks like it is failing when it is only racing.
 *
 * The two scripts are separate processes on separate connections, so no one
 * session holds the lock from init through migrate. Instead each takes the
 * **same** key for the duration of its own run, which serialises every pairing
 * that matters -- two initializers, two migrators, and an initializer applying
 * `schema.sql` while a migrator replays migrations on top of it -- because each
 * script re-reads the database's state after acquiring rather than trusting a
 * decision made before the wait. Session-scoped rather than transaction-scoped
 * because the migrator's work spans many transactions -- one per migration file
 * -- and Postgres releases the lock when the connection closes, which happens
 * in the `finally` of each script and also if the process is killed. There is
 * no unlock to forget and no stuck lock to clean up.
 *
 * The backend's pooled runtime connections never take session advisory locks --
 * the RLS design forbids cross-transaction session state there
 * (docs/specs/row-level-security.md). These scripts are the deliberate
 * exception: each holds one dedicated `pg.Client` connection for its whole run
 * and then closes it. That shape requires the startup scripts to reach
 * Postgres directly; routed through a transaction-mode pooler (pgBouncer), the
 * lock and the DDL could land on different server sessions.
 */

/**
 * Key for the database-lifecycle lock (schema initialization plus migrations).
 *
 * An arbitrary constant, and it only has to be arbitrary: advisory lock keys
 * share one namespace per database, so the requirement is that nothing else in
 * this database picks the same number. Written as a literal rather than derived
 * from `hashtext()` so it cannot change with a Postgres version or a typo in a
 * seed string -- a key that shifts is a lock nobody is holding.
 */
export const DB_LIFECYCLE_LOCK_KEY = 4150293001;

/**
 * How long an acquisition may wait before startup gives up, as a Postgres
 * duration. Generous on purpose: the normal wait is "however long the winner
 * needs", and a large migration run can hold the lock for minutes. The timeout
 * exists only for the pathological case -- a holder that is wedged (a paused
 * container, a connection the server still believes is alive) would otherwise
 * hang every replica's startup forever, with nothing in the log but the
 * waiting line. Timing out turns that into a non-zero exit naming the cause,
 * which a restart loop surfaces and retries.
 */
export const DB_LIFECYCLE_LOCK_TIMEOUT = "600s";

/** Minimal query surface shared by `pg.Client` and the test doubles. */
interface LockClient {
  query(text: string, params?: unknown[]): Promise<unknown>;
}

const logger = new Logger("DbLifecycleLock");

/**
 * Block until this session holds the database-lifecycle lock.
 *
 * Deliberately blocking rather than `pg_try_advisory_lock`: a follower that
 * gives up early has to either exit (a crash-looping pod, the thing being
 * fixed) or proceed unsynchronised (the race, still there). Waiting and then
 * re-reading the state is the only outcome that leaves every replica running.
 * The `lock_timeout` bounds the wait for the wedged-holder case only, and is
 * reset once the lock is held so a migration's own lock waits keep the
 * server's configured behavior.
 */
export async function acquireDbLifecycleLock(
  client: LockClient,
  log: (message: string) => void = (message) => logger.log(message),
): Promise<void> {
  log(
    "Waiting for the database lifecycle lock (only one process initializes or migrates at a time)...",
  );
  await client.query("SELECT set_config('lock_timeout', $1, false)", [
    DB_LIFECYCLE_LOCK_TIMEOUT,
  ]);
  try {
    await client.query("SELECT pg_advisory_lock($1)", [DB_LIFECYCLE_LOCK_KEY]);
  } catch (error) {
    // 55P03 lock_not_available: the timeout above elapsed while waiting.
    if ((error as { code?: string })?.code === "55P03") {
      throw new Error(
        `Could not acquire the database lifecycle lock within ${DB_LIFECYCLE_LOCK_TIMEOUT}: ` +
          "another session holds it and did not finish. Inspect pg_locks " +
          `(locktype = 'advisory', objid = ${DB_LIFECYCLE_LOCK_KEY}) to find ` +
          "the holder; startup will retry on the next restart.",
        { cause: error },
      );
    }
    throw error;
  }
  await client.query("RESET lock_timeout");
  log("Acquired the database lifecycle lock.");
}
