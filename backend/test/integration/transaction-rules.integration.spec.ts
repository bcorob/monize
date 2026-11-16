import { ConflictException, NotFoundException } from "@nestjs/common";
import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";

import { TransactionRulesModule } from "@/transaction-rules/transaction-rules.module";
import { TransactionRulesService } from "@/transaction-rules/transaction-rules.service";
import { CreateTransactionRuleDto } from "@/transaction-rules/dto/create-transaction-rule.dto";
import { withUserContext } from "@/common/db/with-context";

import {
  cleanTables,
  createEnforcedIntegrationModule,
  createTestUserDirect,
  EnforcedIntegrationHarness,
} from "../helpers/integration-setup";
import { createTestCategory } from "../helpers/test-factories";

/**
 * The transaction-rules service against a real database enforcing RLS.
 *
 * Positions are a claim about the deferred unique index
 * `uq_transaction_rules_user_position` (a reorder passes through duplicates and
 * only the commit checks), about the per-user advisory lock that serializes
 * `MAX(position) + 1`, and about the policy that scopes the table to its owner.
 * A mocked manager can show none of the three.
 */
describe("Transaction rules under RLS enforcement", () => {
  jest.setTimeout(180000);

  let harness: EnforcedIntegrationHarness;
  let module: TestingModule;
  let db: DataSource;
  let service: TransactionRulesService;

  let aliceId: string;
  let bobId: string;
  let aliceCategoryId: string;
  let bobCategoryId: string;

  const rule = (
    name: string,
    categoryId: string = aliceCategoryId,
  ): CreateTransactionRuleDto =>
    ({
      name,
      triggers: ["create"],
      condition: { field: "description", op: "contains", value: name },
      actions: [{ type: "set_category", categoryId }],
    }) as CreateTransactionRuleDto;

  const asAlice = <T>(fn: () => Promise<T>) => withUserContext(aliceId, fn);

  async function rows(
    userId: string,
  ): Promise<Array<{ id: string; name: string; position: number }>> {
    return db.query(
      `SELECT id, name, position FROM transaction_rules
        WHERE user_id = $1 ORDER BY position`,
      [userId],
    );
  }

  async function seedThree(): Promise<string[]> {
    const ids: string[] = [];
    for (const name of ["one", "two", "three"]) {
      ids.push((await asAlice(() => service.create(aliceId, rule(name)))).id);
    }
    return ids;
  }

  beforeAll(async () => {
    harness = await createEnforcedIntegrationModule([TransactionRulesModule]);
    module = harness.module;
    db = harness.owner;
    service = module.get(TransactionRulesService);

    await cleanTables(db, ["transaction_rules", "categories", "users"]);
    aliceId = (await createTestUserDirect(db, { firstName: "Alice" })).id;
    bobId = (await createTestUserDirect(db, { firstName: "Bob" })).id;
    aliceCategoryId = (
      await createTestCategory(db, aliceId, { name: "Alice groceries" })
    ).id;
    bobCategoryId = (
      await createTestCategory(db, bobId, { name: "Bob groceries" })
    ).id;
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await db.query("DELETE FROM transaction_rules");
  });

  it("appends positions 0, 1, 2 and reorders them in one transaction", async () => {
    const [a, b, c] = await seedThree();
    expect((await rows(aliceId)).map((r) => r.position)).toEqual([0, 1, 2]);

    // Reversing swaps every position; the deferred unique index is checked at
    // commit, so the intermediate duplicates must not fail the statement.
    const reordered = await asAlice(() => service.reorder(aliceId, [c, b, a]));
    expect(reordered.map((r) => r.id)).toEqual([c, b, a]);

    expect((await rows(aliceId)).map((r) => [r.id, r.position])).toEqual([
      [c, 0],
      [b, 1],
      [a, 2],
    ]);
    const listed = await asAlice(() => service.list(aliceId));
    expect(listed.map((r) => r.id)).toEqual([c, b, a]);
  });

  it("compacts positions to 0, 1 when the middle rule is deleted", async () => {
    const [a, b, c] = await seedThree();

    await asAlice(() => service.remove(aliceId, b));

    expect((await rows(aliceId)).map((r) => [r.id, r.position])).toEqual([
      [a, 0],
      [c, 1],
    ]);
  });

  it("refuses a reorder list that is not exactly the user's ids and changes nothing", async () => {
    const [a, b, c] = await seedThree();
    const foreign = (
      await withUserContext(bobId, () =>
        service.create(bobId, rule("bobs", bobCategoryId)),
      )
    ).id;

    for (const bad of [
      [c, b], // partial
      [c, b, a, a], // repeated
      [c, b, foreign], // another user's rule in place of one of ours
      [c, b, a, foreign], // extra id
    ]) {
      await expect(
        asAlice(() => service.reorder(aliceId, bad)),
      ).rejects.toBeInstanceOf(ConflictException);
    }

    expect((await rows(aliceId)).map((r) => [r.id, r.position])).toEqual([
      [a, 0],
      [b, 1],
      [c, 2],
    ]);
    expect((await rows(bobId)).map((r) => r.position)).toEqual([0]);
  });

  it("refuses an update with a stale revision, and bumps the revision on a good one", async () => {
    const created = await asAlice(() =>
      service.create(aliceId, rule("original")),
    );
    expect(created.revision).toBe(1);

    const updated = await asAlice(() =>
      service.update(aliceId, created.id, { revision: 1, name: "renamed" }),
    );
    expect(updated.name).toBe("renamed");
    expect(updated.revision).toBe(2);

    await expect(
      asAlice(() =>
        service.update(aliceId, created.id, { revision: 1, name: "stale" }),
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    const [row] = await db.query(
      `SELECT name, revision FROM transaction_rules WHERE id = $1`,
      [created.id],
    );
    expect(row).toEqual({ name: "renamed", revision: 2 });
  });

  it("refuses a rule naming another user's category and writes nothing", async () => {
    await expect(
      asAlice(() => service.create(aliceId, rule("theft", bobCategoryId))),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ errorCode: "REFERENCE_NOT_FOUND" }),
    });
    expect(await rows(aliceId)).toEqual([]);

    // The same refusal on update leaves the stored rule and its revision alone.
    const own = await asAlice(() => service.create(aliceId, rule("mine")));
    await expect(
      asAlice(() =>
        service.update(aliceId, own.id, {
          revision: 1,
          actions: [{ type: "set_category", categoryId: bobCategoryId }],
        } as never),
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ errorCode: "REFERENCE_NOT_FOUND" }),
    });
    const [row] = await db.query(
      `SELECT revision, actions FROM transaction_rules WHERE id = $1`,
      [own.id],
    );
    expect(row.revision).toBe(1);
    expect(row.actions[0].categoryId).toBe(aliceCategoryId);
  });

  it("hides one user's rule from another: reads and writes are 404 and nothing moves", async () => {
    const own = await asAlice(() => service.create(aliceId, rule("private")));
    const asBob = <T>(fn: () => Promise<T>) => withUserContext(bobId, fn);

    // Bob names Alice's id under his own identity, and even claims to be Alice
    // in the argument: the policy filters on the connection's identity, not on
    // the parameter, so the row is invisible either way.
    for (const uid of [bobId, aliceId]) {
      await expect(
        asBob(() => service.get(uid, own.id)),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        asBob(() => service.update(uid, own.id, { revision: 1, name: "x" })),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        asBob(() => service.setEnabled(uid, own.id, false)),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        asBob(() => service.remove(uid, own.id)),
      ).rejects.toBeInstanceOf(NotFoundException);
    }
    expect(await asBob(() => service.list(bobId))).toEqual([]);
    expect(await asBob(() => service.list(aliceId))).toEqual([]);

    const [row] = await db.query(
      `SELECT name, enabled, revision FROM transaction_rules WHERE id = $1`,
      [own.id],
    );
    expect(row).toEqual({ name: "private", enabled: true, revision: 1 });
  });

  it("gives concurrent creates for one user distinct, gap-free positions", async () => {
    // Two writers alone can miss the race by timing; eight cannot. Without the
    // per-user advisory lock each reads the same MAX(position) and the deferred
    // unique index rejects the losers at commit.
    const names = Array.from({ length: 8 }, (_, i) => `rule-${i}`);
    const results = await Promise.all(
      names.map((name) =>
        withUserContext(aliceId, () => service.create(aliceId, rule(name))),
      ),
    );

    expect(results).toHaveLength(names.length);
    expect((await rows(aliceId)).map((r) => r.position)).toEqual(
      names.map((_, i) => i),
    );
  });

  it("gives two concurrent creates for one user positions 0 and 1", async () => {
    await Promise.all([
      withUserContext(aliceId, () => service.create(aliceId, rule("left"))),
      withUserContext(aliceId, () => service.create(aliceId, rule("right"))),
    ]);
    expect((await rows(aliceId)).map((r) => r.position)).toEqual([0, 1]);
  });
});
