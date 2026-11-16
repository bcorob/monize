import { Logger } from "@nestjs/common";
import { Client } from "pg";
import { DEMO_USER_EMAIL } from "./database/demo-credentials";
import { acquireDbLifecycleLock } from "./common/db/advisory-locks";

/**
 * Demo-mode startup probe: exits 0 when the demo user already exists (the
 * entrypoint then skips seeding) and 1 when it does not, or when the check
 * itself could not run -- seeding is idempotent, so a failed probe re-seeds
 * rather than leaving a demo deployment empty.
 *
 * This used to be a `node -e` blob inside docker-entrypoint.sh with `echo`
 * around it, which put four unformatted lines at the top of every demo
 * startup. As a compiled script it logs through the Nest `Logger` like the
 * rest of the boot sequence.
 *
 * The probe takes the database-lifecycle lock before it reads, for the same
 * reason `db-init` does: two demo containers started together both find no demo
 * user, both exit 1, and both seed. Waiting means the follower's read happens
 * after the winner's seed instead of alongside it.
 *
 * The lock does not span the exit, though -- the shell runs the seeder as a
 * separate process, and a session lock dies with its connection. That is why
 * `seed.ts` re-reads this same predicate after taking the lock itself: the
 * probe narrows the window, the seeder's re-check closes it.
 */
const logger = new Logger("DbDemoCheck");

/** The query surface both this script and `seed.ts` need from a `pg.Client`. */
export interface DemoCheckClient {
  query(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: unknown[] } | unknown>;
}

/**
 * Whether the demo user is already there, asked on a caller's own connection.
 *
 * Separate from the connect-and-close wrapper below so `seed.ts` can ask the
 * same question **on the connection holding the lifecycle lock** -- a re-check
 * on a second connection would be answering about a moment the lock does not
 * cover, which is the whole thing it is there to prevent.
 */
export async function demoUserExistsOn(
  client: DemoCheckClient,
): Promise<boolean> {
  const result = (await client.query("SELECT id FROM users WHERE email = $1", [
    DEMO_USER_EMAIL,
  ])) as { rows?: unknown[] };
  return (result?.rows?.length ?? 0) > 0;
}

/** A direct connection for the startup scripts, never a pooled runtime one. */
export function demoCheckClient(): Client {
  return new Client({
    host: process.env.DATABASE_HOST,
    port: parseInt(process.env.DATABASE_PORT || "5432", 10),
    user: process.env.DATABASE_USER,
    password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME,
  });
}

export async function demoUserExists(): Promise<boolean> {
  const client = demoCheckClient();

  await client.connect();
  try {
    // Session-scoped, and released when this connection closes in the `finally`
    // -- there is no unlock to forget. Direct connection, not a pooled one:
    // routed through a transaction-mode pooler the lock and the read could land
    // on different server sessions (`common/db/advisory-locks.ts`).
    await acquireDbLifecycleLock(client, (message) => logger.log(message));
    return await demoUserExistsOn(client);
  } finally {
    await client.end();
  }
}

/**
 * Probe entry point. Exported so the spec can drive all three outcomes
 * (present, absent, unreachable) without spawning the script.
 */
export async function checkDemoUser(): Promise<void> {
  logger.log("Demo mode detected; checking whether the demo user exists");
  let exists: boolean;
  try {
    exists = await demoUserExists();
  } catch (error) {
    logger.warn(
      `Could not check for the demo user (${
        error instanceof Error ? error.message : String(error)
      }); seeding will be attempted`,
    );
    process.exit(1);
  }

  if (exists) {
    logger.log("Demo user already exists; skipping seed");
    process.exit(0);
  }

  logger.log("Demo user not found; seeding demo data");
  process.exit(1);
}

if (require.main === module) {
  checkDemoUser();
}
