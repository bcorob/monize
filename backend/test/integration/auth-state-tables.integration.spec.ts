import { DataSource } from "typeorm";
import { TestingModule } from "@nestjs/testing";

import { AuthAttemptCounter } from "@/auth/entities/auth-attempt-counter.entity";
import { SingleUseToken } from "@/auth/entities/single-use-token.entity";
import { AuthStateSweeperService } from "@/auth/auth-state-sweeper.service";

import { createIntegrationModule } from "../helpers/integration-setup";

/**
 * The two tables A1 adds, against a real database.
 *
 * The harness builds its schema from entity metadata (`synchronize: true`)
 * while production applies `database/schema.sql`, so an entity that names a
 * column the migration did not create passes every unit test and fails on a
 * deployed database. Round-tripping a row here is what makes the entity a claim
 * about the migration rather than a parallel definition of the same table.
 *
 * The sweep is exercised for its predicate, not its row count: the cutoff has
 * to be the database's own clock, because every replica fires this cron and the
 * earliest local clock would otherwise delete a counter another replica is
 * still enforcing.
 */
describe("auth state tables (real PostgreSQL)", () => {
  let module: TestingModule;
  let db: DataSource;

  const HOUR_MS = 60 * 60 * 1000;
  const future = () => new Date(Date.now() + HOUR_MS);
  const past = () => new Date(Date.now() - HOUR_MS);

  beforeAll(async () => {
    module = await createIntegrationModule([]);
    db = module.get(DataSource);
  });

  afterAll(async () => {
    await module?.close();
  });

  beforeEach(async () => {
    await db.query("DELETE FROM auth_attempt_counters");
    await db.query("DELETE FROM single_use_tokens");
  });

  it("round-trips an attempt counter through the entity", async () => {
    const repo = db.getRepository(AuthAttemptCounter);
    const windowExpiresAt = future();

    await repo.save(
      repo.create({
        scope: "2fa-user",
        key: "11111111-1111-4111-8111-111111111111",
        count: 3,
        windowExpiresAt,
      }),
    );

    const row = await repo.findOneOrFail({
      where: { scope: "2fa-user", key: "11111111-1111-4111-8111-111111111111" },
    });
    expect(row.count).toBe(3);
    expect(row.windowExpiresAt.getTime()).toBe(windowExpiresAt.getTime());
  });

  it("keys an attempt counter by scope and key together", async () => {
    const repo = db.getRepository(AuthAttemptCounter);
    // Same key under two limiters is two counters: the composite primary key is
    // what keeps a forgot-password limit from consuming a 2FA one.
    await repo.save([
      repo.create({
        scope: "forgot-password",
        key: "shared",
        count: 1,
        windowExpiresAt: future(),
      }),
      repo.create({
        scope: "verification-email",
        key: "shared",
        count: 2,
        windowExpiresAt: future(),
      }),
    ]);

    expect(await repo.count({ where: { key: "shared" } })).toBe(2);
  });

  it("lets the primary key decide a single-use claim, not a prior read", async () => {
    const claim = async (): Promise<boolean> => {
      const rows: unknown[] = await db.query(
        `INSERT INTO single_use_tokens (purpose, token_hash, expires_at)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING
         RETURNING token_hash`,
        ["totp", "a".repeat(64), future()],
      );
      return rows.length > 0;
    };

    // Sequential rather than raced: the property under test is that the second
    // INSERT loses on the key. Two live connections racing it is A3's spec,
    // where the claim has a service to call.
    expect(await claim()).toBe(true);
    expect(await claim()).toBe(false);
  });

  it("sweeps only rows the database's own clock has passed", async () => {
    const counters = db.getRepository(AuthAttemptCounter);
    const tokens = db.getRepository(SingleUseToken);
    await counters.save([
      counters.create({
        scope: "2fa-token",
        key: "stale",
        count: 5,
        windowExpiresAt: past(),
      }),
      counters.create({
        scope: "2fa-token",
        key: "live",
        count: 1,
        windowExpiresAt: future(),
      }),
    ]);
    await tokens.save([
      tokens.create({
        purpose: "totp",
        tokenHash: "stale",
        expiresAt: past(),
      }),
      tokens.create({
        purpose: "totp",
        tokenHash: "live",
        expiresAt: future(),
      }),
    ]);

    await new AuthStateSweeperService(db).sweepExpiredAuthState();

    expect((await counters.find()).map((row) => row.key)).toEqual(["live"]);
    expect((await tokens.find()).map((row) => row.tokenHash)).toEqual(["live"]);
  });
});
