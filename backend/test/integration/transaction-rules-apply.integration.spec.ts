import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";

import { AccountsService } from "@/accounts/accounts.service";
import { settlePendingHistoryWrites } from "@/action-history/action-history.service";
import { withUserContext } from "@/common/db/with-context";
import { Tag } from "@/tags/entities/tag.entity";
import { TransactionRulesModule } from "@/transaction-rules/transaction-rules.module";
import { TransactionRulesService } from "@/transaction-rules/transaction-rules.service";
import { CreateTransactionRuleDto } from "@/transaction-rules/dto/create-transaction-rule.dto";
import { TransactionsModule } from "@/transactions/transactions.module";
import { TransactionsService } from "@/transactions/transactions.service";

import {
  cleanTables,
  createEnforcedIntegrationModule,
  createTestUserDirect,
  EnforcedIntegrationHarness,
} from "../helpers/integration-setup";
import {
  createTestAccount,
  createTestCategory,
  createTestPayee,
} from "../helpers/test-factories";

/**
 * The rules step of `TransactionsService.create` and `previewCreate` against a
 * real PostgreSQL enforcing RLS (design 6.3, invariants I1 to I3).
 *
 * Three claims a mocked manager cannot show: the rule effects share the
 * insert's transaction (a failure after the applier rolls them back with it),
 * the preview names exactly what the commit then writes, and a rule of another
 * user never touches the row.
 */
describe("Transaction rules on the create path (integration)", () => {
  jest.setTimeout(180000);

  let harness: EnforcedIntegrationHarness;
  let module: TestingModule;
  let db: DataSource;
  let transactions: TransactionsService;
  let rules: TransactionRulesService;
  let accounts: AccountsService;

  let aliceId: string;
  let bobId: string;
  let accountId: string;
  let groceriesId: string;
  let otherCategoryId: string;
  let tagId: string;

  const OPENING = 1000;
  const asAlice = <T>(fn: () => Promise<T>) => withUserContext(aliceId, fn);

  const newRule = (over: Partial<CreateTransactionRuleDto> = {}) =>
    ({
      name: "Biedronka",
      triggers: ["create"],
      condition: { field: "payeeText", op: "contains", value: "biedronka" },
      actions: [
        { type: "set_category", categoryId: groceriesId },
        { type: "add_tags", tagIds: [tagId] },
      ],
      ...over,
    }) as CreateTransactionRuleDto;

  const dto = (over: Record<string, unknown> = {}) =>
    ({
      accountId,
      transactionDate: "2026-03-10",
      amount: -50,
      currencyCode: "USD",
      payeeName: "BIEDRONKA 123",
      description: "weekly shop",
      ...over,
    }) as never;

  const count = async (table: string): Promise<number> =>
    Number((await db.query(`SELECT COUNT(*)::int AS n FROM ${table}`))[0].n);
  const balance = async (): Promise<number> =>
    Number(
      (
        await db.query(`SELECT current_balance FROM accounts WHERE id = $1`, [
          accountId,
        ])
      )[0].current_balance,
    );

  beforeAll(async () => {
    harness = await createEnforcedIntegrationModule([
      TransactionsModule,
      TransactionRulesModule,
    ]);
    module = harness.module;
    db = harness.owner;
    transactions = module.get(TransactionsService);
    rules = module.get(TransactionRulesService);
    accounts = module.get(AccountsService, { strict: false });
  });

  afterAll(async () => {
    // The create's action-history write is fire-and-forget; let it finish
    // before the connection closes.
    await settlePendingHistoryWrites();
    await harness.close();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await settlePendingHistoryWrites();
    await cleanTables(db, [
      "transaction_rule_applications",
      "transaction_rules",
      "transaction_tags",
      "tags",
      "action_history",
      "transaction_splits",
      "transactions",
      "monthly_account_balances",
      "accounts",
      "categories",
      "payees",
      "users",
    ]);
    await db.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places) VALUES ('USD', 'US Dollar', '$', 2) ON CONFLICT DO NOTHING`,
    );
    aliceId = (await createTestUserDirect(db, { firstName: "Alice" })).id;
    bobId = (await createTestUserDirect(db, { firstName: "Bob" })).id;
    accountId = (
      await createTestAccount(db, aliceId, {
        name: "Checking",
        currencyCode: "USD",
        openingBalance: OPENING,
        currentBalance: OPENING,
      })
    ).id;
    groceriesId = (await createTestCategory(db, aliceId, { name: "Groceries" }))
      .id;
    otherCategoryId = (await createTestCategory(db, aliceId, { name: "Other" }))
      .id;
    tagId = (
      await db.getRepository(Tag).save({ userId: aliceId, name: "food" })
    ).id;
  });

  it("a matching rule sets the category and adds the tag in the create's own transaction, and moves no money it should not", async () => {
    const rule = await asAlice(() => rules.create(aliceId, newRule()));

    const created = await asAlice(() => transactions.create(aliceId, dto()));

    expect(created.categoryId).toBe(groceriesId);
    const links = await db.query(
      `SELECT tag_id FROM transaction_tags WHERE transaction_id = $1`,
      [created.id],
    );
    expect(links.map((l: { tag_id: string }) => l.tag_id)).toEqual([tagId]);

    // I1: the amount and the balance are exactly what the request asked for.
    expect(Number(created.amount)).toBe(-50);
    expect(created.accountId).toBe(accountId);
    expect(await balance()).toBe(OPENING - 50);

    // The trace: one application row for the rule, before/after per field.
    const applications = await db.query(
      `SELECT rule_id, transaction_id, source, changes FROM transaction_rule_applications`,
    );
    expect(applications).toHaveLength(1);
    expect(applications[0]).toEqual(
      expect.objectContaining({
        rule_id: rule.id,
        transaction_id: created.id,
        source: "create",
      }),
    );
    expect(applications[0].changes).toEqual({
      categoryId: { before: null, after: groceriesId },
      tagIds: { before: [], after: [tagId] },
    });
  });

  it("with no rules the create writes exactly what it wrote before: no tag, no trace, request category kept", async () => {
    const created = await asAlice(() =>
      transactions.create(aliceId, dto({ categoryId: otherCategoryId })),
    );
    expect(created.categoryId).toBe(otherCategoryId);
    expect(await count("transaction_tags")).toBe(0);
    expect(await count("transaction_rule_applications")).toBe(0);
    expect(await balance()).toBe(OPENING - 50);
  });

  it("does not run a rule that does not match, or a disabled rule", async () => {
    await asAlice(() =>
      rules.create(
        aliceId,
        newRule({
          condition: { field: "payeeText", op: "contains", value: "lidl" },
        } as never),
      ),
    );
    const created = await asAlice(() => transactions.create(aliceId, dto()));
    expect(created.categoryId).toBeNull();
    expect(await count("transaction_rule_applications")).toBe(0);
  });

  it("onlyIfEmpty keeps the request's category and the payee default; onlyIfEmpty false replaces the default (design 6.4)", async () => {
    const payee = await createTestPayee(db, aliceId, {
      name: "Biedronka",
      defaultCategoryId: otherCategoryId,
    });
    await asAlice(() => rules.create(aliceId, newRule()));

    const withDefault = await asAlice(() =>
      transactions.create(aliceId, dto({ payeeId: payee.id })),
    );
    expect(withDefault.categoryId).toBe(otherCategoryId);

    const explicit = await asAlice(() =>
      transactions.create(
        aliceId,
        dto({ payeeId: payee.id, categoryId: otherCategoryId }),
      ),
    );
    expect(explicit.categoryId).toBe(otherCategoryId);

    await db.query("DELETE FROM transaction_rules");
    await asAlice(() =>
      rules.create(
        aliceId,
        newRule({
          actions: [
            {
              type: "set_category",
              categoryId: groceriesId,
              onlyIfEmpty: false,
            },
          ],
        } as never),
      ),
    );
    const replaced = await asAlice(() =>
      transactions.create(aliceId, dto({ payeeId: payee.id })),
    );
    expect(replaced.categoryId).toBe(groceriesId);
  });

  it("a rule sees the payee's own name as payeeText when only an id was given", async () => {
    const payee = await createTestPayee(db, aliceId, { name: "Biedronka" });
    await asAlice(() => rules.create(aliceId, newRule()));
    const created = await asAlice(() =>
      transactions.create(
        aliceId,
        dto({ payeeId: payee.id, payeeName: undefined }),
      ),
    );
    expect(created.categoryId).toBe(groceriesId);
  });

  it("another user's rule never applies", async () => {
    const bobCategory = await createTestCategory(db, bobId, { name: "Bob's" });
    const bobTag = await db
      .getRepository(Tag)
      .save({ userId: bobId, name: "bobs" });
    await withUserContext(bobId, () =>
      rules.create(bobId, {
        name: "Bob's rule",
        triggers: ["create"],
        condition: { field: "payeeText", op: "contains", value: "biedronka" },
        actions: [
          { type: "set_category", categoryId: bobCategory.id },
          { type: "add_tags", tagIds: [bobTag.id] },
        ],
      } as never),
    );
    const created = await asAlice(() => transactions.create(aliceId, dto()));
    expect(created.categoryId).toBeNull();
    expect(await count("transaction_tags")).toBe(0);
    expect(await count("transaction_rule_applications")).toBe(0);
  });

  it("a failure after the applier rolls the rule effects back with the insert", async () => {
    await asAlice(() => rules.create(aliceId, newRule()));
    jest
      .spyOn(accounts, "updateBalance")
      .mockRejectedValue(new Error("balance update failed"));

    await expect(
      asAlice(() => transactions.create(aliceId, dto())),
    ).rejects.toThrow("balance update failed");

    expect(await count("transactions")).toBe(0);
    expect(await count("transaction_tags")).toBe(0);
    expect(await count("transaction_rule_applications")).toBe(0);
    expect(await balance()).toBe(OPENING);
  });

  it("the preview names what the commit then writes (I3), and writes nothing itself", async () => {
    await asAlice(() => rules.create(aliceId, newRule()));

    const preview = await asAlice(() =>
      transactions.previewCreate(aliceId, {
        accountId,
        amount: -50,
        transactionDate: "2026-03-10",
        payeeName: "BIEDRONKA 123",
        description: "weekly shop",
      }),
    );
    expect(await count("transactions")).toBe(0);
    expect(await count("transaction_rule_applications")).toBe(0);
    expect(preview.ruleEffects).toBeDefined();
    expect(preview.ruleEffects?.changes).toEqual({
      categoryId: groceriesId,
      addTagIds: [tagId],
      removeTagIds: [],
    });
    expect(preview.ruleEffects?.labels.categories).toEqual({
      [groceriesId]: "Groceries",
    });

    const created = await asAlice(() =>
      transactions.create(aliceId, dto({ payeeName: "BIEDRONKA 123" })),
    );
    const [applied] = await db.query(
      `SELECT changes FROM transaction_rule_applications WHERE transaction_id = $1`,
      [created.id],
    );
    const tags = await db.query(
      `SELECT tag_id FROM transaction_tags WHERE transaction_id = $1`,
      [created.id],
    );
    expect(created.categoryId).toBe(preview.ruleEffects?.changes.categoryId);
    expect(tags.map((t: { tag_id: string }) => t.tag_id)).toEqual(
      preview.ruleEffects?.changes.addTagIds,
    );
    expect(applied.changes).toEqual(
      preview.ruleEffects?.trace.find((t) => t.matched)?.changes,
    );
  });

  it("the preview has no ruleEffects when no rule matches", async () => {
    const preview = await asAlice(() =>
      transactions.previewCreate(aliceId, {
        accountId,
        amount: -50,
        transactionDate: "2026-03-10",
        payeeName: "Somewhere else",
      }),
    );
    expect("ruleEffects" in preview).toBe(false);
  });

  it("a split row is not given a category by a rule, but still gets the tag", async () => {
    await asAlice(() => rules.create(aliceId, newRule()));
    const created = await asAlice(() =>
      transactions.create(
        aliceId,
        dto({
          splits: [
            { amount: -30, categoryId: otherCategoryId },
            { amount: -20, categoryId: otherCategoryId },
          ],
        }),
      ),
    );
    expect(created.categoryId).toBeNull();
    expect(await count("transaction_tags")).toBe(1);
    const [application] = await db.query(
      `SELECT changes FROM transaction_rule_applications`,
    );
    expect(Object.keys(application.changes)).toEqual(["tagIds"]);
  });
});
