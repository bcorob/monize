import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";

import { TagsModule } from "@/tags/tags.module";
import { TagsService } from "@/tags/tags.service";
import { withUserContext } from "@/common/db/with-context";
import {
  createIntegrationModule,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { createTestAccount } from "../helpers/test-factories";

/**
 * `GET /tags/usage` orders the tag pickers: the tags used most recently go in
 * a group at the top (discussion #708). The unit spec can only assert the text
 * of the statement; here PostgreSQL evaluates it against the rows that decide
 * the answer: a tag on a split as well as on the transaction, a void row that
 * must not count, another user's tag that must not leak in, a future-dated
 * row, the two legs of one transfer, and a delegate's account scope.
 */
describe("tag usage (integration)", () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let tags: TagsService;
  let userId: string;
  let accountId: string;

  beforeAll(async () => {
    module = await createIntegrationModule([TagsModule]);
    dataSource = module.get(DataSource);
    tags = module.get(TagsService);
  });

  afterAll(async () => {
    await module.close();
  });

  const seedTag = async (owner: string, name: string): Promise<string> => {
    const [row] = await dataSource.query(
      `INSERT INTO tags (user_id, name) VALUES ($1, $2) RETURNING id`,
      [owner, name],
    );
    return row.id;
  };

  const seedTransaction = async (
    owner: string,
    account: string,
    date: string,
    status = "UNRECONCILED",
  ): Promise<string> => {
    const [row] = await dataSource.query(
      `INSERT INTO transactions (user_id, account_id, transaction_date, amount, currency_code, status)
       VALUES ($1, $2, $3, -10, 'USD', $4) RETURNING id`,
      [owner, account, date, status],
    );
    return row.id;
  };

  const tagTransaction = (transactionId: string, tagId: string) =>
    dataSource.query(
      `INSERT INTO transaction_tags (transaction_id, tag_id) VALUES ($1, $2)`,
      [transactionId, tagId],
    );

  const tagSplit = async (transactionId: string, tagId: string) => {
    const [split] = await dataSource.query(
      `INSERT INTO transaction_splits (transaction_id, amount) VALUES ($1, -10) RETURNING id`,
      [transactionId],
    );
    await dataSource.query(
      `INSERT INTO transaction_split_tags (transaction_split_id, tag_id) VALUES ($1, $2)`,
      [split.id, tagId],
    );
  };

  /** Both legs of a transfer, linked to each other, as createTransfer leaves them. */
  const seedTransfer = async (
    from: string,
    to: string,
    date: string,
  ): Promise<[string, string]> => {
    const out = await seedTransaction(userId, from, date);
    const into = await seedTransaction(userId, to, date);
    await dataSource.query(
      `UPDATE transactions SET linked_transaction_id = $2 WHERE id = $1`,
      [out, into],
    );
    await dataSource.query(
      `UPDATE transactions SET linked_transaction_id = $2 WHERE id = $1`,
      [into, out],
    );
    return [out, into];
  };

  /**
   * A transfer split and its counterpart, tagged the way applySplitTags tags
   * them: the split, and the counterpart transaction.
   */
  const tagSplitTransfer = async (
    parentId: string,
    to: string,
    date: string,
    tagId: string,
  ) => {
    const counterpart = await seedTransaction(userId, to, date);
    await dataSource.query(
      `UPDATE transactions SET linked_transaction_id = $2 WHERE id = $1`,
      [counterpart, parentId],
    );
    const [split] = await dataSource.query(
      `INSERT INTO transaction_splits (transaction_id, amount, kind, transfer_account_id, linked_transaction_id)
       VALUES ($1, -10, 'transfer', $2, $3) RETURNING id`,
      [parentId, to, counterpart],
    );
    await dataSource.query(
      `INSERT INTO transaction_split_tags (transaction_split_id, tag_id) VALUES ($1, $2)`,
      [split.id, tagId],
    );
    await tagTransaction(counterpart, tagId);
  };

  beforeEach(async () => {
    await cleanTables(dataSource, [
      "transaction_split_tags",
      "transaction_tags",
      "transaction_splits",
      "transactions",
      "tags",
      "accounts",
      "users",
    ]);
    const user = await createTestUserDirect(dataSource);
    userId = user.id;
    accountId = (
      await createTestAccount(dataSource, userId, { name: "Chequing" })
    ).id;
  });

  const usage = (scope?: string[]) =>
    withUserContext(userId, () => tags.getUsage(userId, scope));

  it("takes the latest date across transaction and split tags and counts both", async () => {
    const holiday = await seedTag(userId, "Holiday 2008");
    const groceries = await seedTag(userId, "Groceries");

    await tagTransaction(
      await seedTransaction(userId, accountId, "2008-12-20"),
      holiday,
    );
    await tagSplit(
      await seedTransaction(userId, accountId, "2008-12-24"),
      holiday,
    );
    await tagTransaction(
      await seedTransaction(userId, accountId, "2026-09-30"),
      groceries,
    );

    await expect(usage()).resolves.toEqual({
      [holiday]: { lastUsed: "2008-12-24", count: 2 },
      [groceries]: { lastUsed: "2026-09-30", count: 1 },
    });
  });

  it("ignores void transactions, so a tag used only on one is absent", async () => {
    const holiday = await seedTag(userId, "Holiday 2008");
    const voided = await seedTag(userId, "Voided only");

    await tagTransaction(
      await seedTransaction(userId, accountId, "2008-12-20"),
      holiday,
    );
    // A later void row must not make the tag look recent.
    await tagSplit(
      await seedTransaction(userId, accountId, "2026-10-01", "VOID"),
      holiday,
    );
    await tagTransaction(
      await seedTransaction(userId, accountId, "2026-10-01", "VOID"),
      voided,
    );

    await expect(usage()).resolves.toEqual({
      [holiday]: { lastUsed: "2008-12-20", count: 1 },
    });
  });

  it("does not report another user's tags", async () => {
    const other = await createTestUserDirect(dataSource);
    const otherAccount = await createTestAccount(dataSource, other.id);
    const otherTag = await seedTag(other.id, "Theirs");
    await tagTransaction(
      await seedTransaction(other.id, otherAccount.id, "2026-10-01"),
      otherTag,
    );

    await expect(usage()).resolves.toEqual({});
  });

  it("ignores a row dated after today", async () => {
    const typo = await seedTag(userId, "Car repair");
    await tagTransaction(
      await seedTransaction(userId, accountId, "2026-03-01"),
      typo,
    );
    // The year mistyped: it must not hold the tag at the top for decades.
    await tagTransaction(
      await seedTransaction(userId, accountId, "2999-03-01"),
      typo,
    );
    const futureOnly = await seedTag(userId, "Postdated");
    await tagTransaction(
      await seedTransaction(userId, accountId, "2999-03-01"),
      futureOnly,
    );

    await expect(usage()).resolves.toEqual({
      [typo]: { lastUsed: "2026-03-01", count: 1 },
    });
  });

  it("counts a tagged transfer once, not once per leg", async () => {
    const savings = (
      await createTestAccount(dataSource, userId, { name: "Second" })
    ).id;
    const moving = await seedTag(userId, "Moving");
    const [out, into] = await seedTransfer(accountId, savings, "2026-09-01");
    await tagTransaction(out, moving);
    await tagTransaction(into, moving);

    await expect(usage()).resolves.toEqual({
      [moving]: { lastUsed: "2026-09-01", count: 1 },
    });
  });

  it("counts each transfer split once, split and counterpart together", async () => {
    const savings = (
      await createTestAccount(dataSource, userId, { name: "Second" })
    ).id;
    const moving = await seedTag(userId, "Moving");
    const parent = await seedTransaction(userId, accountId, "2026-09-01");
    // Two transfer lines in one transaction are two uses.
    await tagSplitTransfer(parent, savings, "2026-09-01", moving);
    await tagSplitTransfer(parent, savings, "2026-09-01", moving);

    await expect(usage()).resolves.toEqual({
      [moving]: { lastUsed: "2026-09-01", count: 2 },
    });
  });

  it("narrows to a delegate's account scope, and an empty scope to nothing", async () => {
    const privateAccount = (
      await createTestAccount(dataSource, userId, { name: "Second" })
    ).id;
    const shared = await seedTag(userId, "Shared");
    const medical = await seedTag(userId, "Medical");
    await tagTransaction(
      await seedTransaction(userId, accountId, "2026-09-01"),
      shared,
    );
    await tagSplit(
      await seedTransaction(userId, privateAccount, "2026-10-01"),
      medical,
    );
    await tagTransaction(
      await seedTransaction(userId, privateAccount, "2026-10-01"),
      shared,
    );

    await expect(usage([accountId])).resolves.toEqual({
      [shared]: { lastUsed: "2026-09-01", count: 1 },
    });
    await expect(usage([])).resolves.toEqual({});
  });
});
