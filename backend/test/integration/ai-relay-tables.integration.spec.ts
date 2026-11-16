import { DataSource } from "typeorm";
import { TestingModule } from "@nestjs/testing";

import { AiRelayPrompt } from "@/ai/relay/entities/ai-relay-prompt.entity";
import { AiRelayAgent } from "@/ai/relay/entities/ai-relay-agent.entity";
import { AiRelayAction } from "@/ai/relay/entities/ai-relay-action.entity";

import {
  createIntegrationModule,
  createTestUserDirect,
} from "../helpers/integration-setup";

/**
 * The three tables R2 adds, against a real database.
 *
 * The harness builds its schema from entity metadata while production applies
 * `database/schema.sql`, so round-tripping here is what makes each entity a
 * claim about the migration rather than a parallel definition of the same
 * table. `JSONB` is the part most worth exercising: `pg` hands those columns
 * back as objects, and a caller that reached for `JSON.parse` would fail only
 * at runtime.
 *
 * Nothing reads these tables yet -- R3, R4 and R5 move the relay onto them.
 */
describe("AI relay tables (real PostgreSQL)", () => {
  let module: TestingModule;
  let db: DataSource;
  let userId: string;

  const future = () => new Date(Date.now() + 60 * 60 * 1000);

  beforeAll(async () => {
    module = await createIntegrationModule([]);
    db = module.get(DataSource);
    userId = (
      await createTestUserDirect(db, { email: "relay-tables@test.local" })
    ).id;
  });

  afterAll(async () => {
    await module?.close();
  });

  beforeEach(async () => {
    await db.query("DELETE FROM ai_relay_prompts");
    await db.query("DELETE FROM ai_relay_actions");
    await db.query("DELETE FROM ai_relay_agents");
  });

  it("round-trips a prompt's JSONB payload as an object, not a string", async () => {
    const repo = db.getRepository(AiRelayPrompt);
    const saved = await repo.save(
      repo.create({
        userId,
        status: "pending",
        prompt: {
          prompt: "what did I spend on groceries?",
          history: [{ role: "user", content: "hello" }],
        },
        expiresAt: future(),
      }),
    );

    const row = await repo.findOneByOrFail({ id: saved.id });
    expect(row.prompt.prompt).toBe("what did I spend on groceries?");
    expect(row.prompt.history).toEqual([{ role: "user", content: "hello" }]);
    expect(row.answer).toBeNull();
    expect(row.claimedAt).toBeNull();
  });

  it("refuses a status outside the state machine's vocabulary", async () => {
    await expect(
      db.query(
        `INSERT INTO ai_relay_prompts (user_id, status, prompt, expires_at)
         VALUES ($1, 'in-progress', '{}'::jsonb, now() + interval '1 hour')`,
        [userId],
      ),
    ).rejects.toThrow(/ck_ai_relay_prompts_status/);
  });

  it("keys agent liveness one row per user", async () => {
    const repo = db.getRepository(AiRelayAgent);
    const now = new Date();
    await repo.save(repo.create({ userId, lastPollAt: now, idleSince: now }));
    // The upsert R4 writes on every poll: the primary key is what keeps a
    // second replica's poll from adding a second liveness row for one agent.
    await repo.save(repo.create({ userId, lastPollAt: now, idleSince: null }));

    const rows = await repo.find();
    expect(rows).toHaveLength(1);
    expect(rows[0].idleSince).toBeNull();
    expect(rows[0].idleDisconnectedAt).toBeNull();
  });

  it("scopes a buffered action card to its owner, not to the id alone", async () => {
    const other = (
      await createTestUserDirect(db, { email: "relay-other@test.local" })
    ).id;
    const repo = db.getRepository(AiRelayAction);

    // The same descriptor id under two owners is two cards. An id-only primary
    // key would have made the second insert overwrite the first user's card.
    await repo.save([
      repo.create({
        id: "act-1",
        userId,
        card: { kind: "create_transaction" } as never,
        expiresAt: future(),
      }),
      repo.create({
        id: "act-1",
        userId: other,
        card: { kind: "create_transaction" } as never,
        expiresAt: future(),
      }),
    ]);

    expect(await repo.count({ where: { id: "act-1" } })).toBe(2);
  });

  it("takes every relay row with the user, on all three tables", async () => {
    const doomed = (
      await createTestUserDirect(db, { email: "relay-doomed@test.local" })
    ).id;
    await db.query(
      `INSERT INTO ai_relay_prompts (user_id, status, prompt, expires_at)
       VALUES ($1, 'pending', '{}'::jsonb, now() + interval '1 hour')`,
      [doomed],
    );
    await db.query(
      `INSERT INTO ai_relay_agents (user_id, last_poll_at) VALUES ($1, now())`,
      [doomed],
    );
    await db.query(
      `INSERT INTO ai_relay_actions (id, user_id, card, expires_at)
       VALUES ('act-x', $1, '{}'::jsonb, now() + interval '1 hour')`,
      [doomed],
    );

    await db.query("DELETE FROM users WHERE id = $1", [doomed]);

    // A deleted account leaving its queued prompts behind is a row that would
    // still be claimable by an agent, so the cascade is load-bearing rather
    // than housekeeping.
    for (const table of [
      "ai_relay_prompts",
      "ai_relay_agents",
      "ai_relay_actions",
    ]) {
      const rows = await db.query(`SELECT 1 FROM ${table} WHERE user_id = $1`, [
        doomed,
      ]);
      expect(rows).toHaveLength(0);
    }
  });
});
