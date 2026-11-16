import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { Client } from "pg";
import { AppModule } from "../app.module";
import { SeedService } from "./seed.service";
import { DemoSeedService } from "./demo-seed.service";
import { acquireDbLifecycleLock } from "../common/db/advisory-locks";
import { demoCheckClient, demoUserExistsOn } from "../db-demo-check";

const logger = new Logger("Seed");

/**
 * Seeding runs under the database-lifecycle lock, like `db-init` and
 * `db-migrate`.
 *
 * Two demo containers started together both find no demo user, both exit the
 * probe non-zero, and both run this script. The probe takes the lock too, but
 * it cannot hold it across its own exit -- a session lock dies with its
 * connection, and the shell runs the seeder as a separate process. So the probe
 * narrows the window and this re-check closes it: the follower waits, acquires,
 * asks the question again on the connection holding the lock, and finds the
 * winner's demo user.
 *
 * Direct connection, not the pooled runtime one: through a transaction-mode
 * pooler the lock and the read could land on different server sessions
 * (`common/db/advisory-locks.ts`). It is opened before the Nest context so a
 * follower exits without paying for one.
 */
async function bootstrap() {
  const isDemoMode = process.env.DEMO_MODE?.toLowerCase() === "true";
  let lockClient: Client | null = null;

  try {
    lockClient = demoCheckClient();
    await lockClient.connect();
    await acquireDbLifecycleLock(lockClient, (message) => logger.log(message));

    if (isDemoMode && (await demoUserExistsOn(lockClient))) {
      // Another container seeded while this one waited for the lock. Exit 0:
      // the demo data it would have written is already there, and a non-zero
      // exit would crash-loop a pod over work that is done.
      logger.log("Demo user already exists; another process seeded it");
      await lockClient.end();
      process.exit(0);
    }
  } catch (error) {
    logger.error(
      "Could not take the database lifecycle lock for seeding",
      error instanceof Error ? error.stack : String(error),
    );
    await lockClient?.end().catch(() => undefined);
    process.exit(1);
  }

  const app = await NestFactory.createApplicationContext(AppModule);

  try {
    if (isDemoMode) {
      const demoSeedService = app.get(DemoSeedService);
      await demoSeedService.seedAll();
    } else {
      const seedService = app.get(SeedService);
      await seedService.seedAll();
    }
    logger.log("Seeding completed");
    await app.close();
    // The lock is held until here, so a follower waiting on it re-reads a
    // finished seed rather than a half-written one.
    await lockClient.end();
    process.exit(0);
  } catch (error) {
    logger.error(
      "Seeding failed",
      error instanceof Error ? error.stack : String(error),
    );
    await app.close();
    await lockClient.end().catch(() => undefined);
    process.exit(1);
  }
}

bootstrap();
