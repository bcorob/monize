import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";

import { AccountsService } from "@/accounts/accounts.service";
import {
  ActionHistoryService,
  settlePendingHistoryWrites,
} from "@/action-history/action-history.service";
import { withUserContext } from "@/common/db/with-context";
import { TransactionRulesModule } from "@/transaction-rules/transaction-rules.module";
import { TransactionRulesService } from "@/transaction-rules/transaction-rules.service";
import { TransactionRulesRunService } from "@/transaction-rules/transaction-rules-run.service";
import { CreateTransactionRuleDto } from "@/transaction-rules/dto/create-transaction-rule.dto";
import { TransactionsModule } from "@/transactions/transactions.module";
import { TransactionsService } from "@/transactions/transactions.service";

import {
  cleanTables,
  createEnforcedIntegrationModule,
  createTestUserDirect,
  EnforcedIntegrationHarness,
} from "../helpers/integration-setup";
import { createTestAccount, createTestPayee } from "../helpers/test-factories";

/**
 * Glob captures and the two text actions against a real PostgreSQL enforcing
 * RLS (design 10.1 and 10.2). A bank's free text names the counterparty; the
 * rule `*Nazwa odbiorcy: {payee} Rachunek*` captures it and
 * `set_payee_from_text` resolves it to an existing payee, creates a missing
 * one with `createIfMissing`, and `set_description` rewrites the description.
 *
 * What a mocked manager cannot show: the created payee shares the insert's
 * transaction (a failure after the applier drops it with the row), the preview
 * creates nothing and equals the commit except for the payee it says will be
 * created, and one undo of a manual run restores description and payee while
 * the created payee stays.
 */
describe("Transaction rules: captures and text actions (integration)", () => {
  jest.setTimeout(180000);

  let harness: EnforcedIntegrationHarness;
  let module: TestingModule;
  let db: DataSource;
  let transactions: TransactionsService;
  let rules: TransactionRulesService;
  let run: TransactionRulesRunService;
  let accounts: AccountsService;
  let history: ActionHistoryService;

  let aliceId: string;
  let accountId: string;
  let kowalskiId: string;

  const asAlice = <T>(fn: () => Promise<T>) => withUserContext(aliceId, fn);

  const bankText = (name: string) =>
    `Przelew. Nazwa odbiorcy: ${name} Rachunek odbiorcy: 12 3456`;

  const captureRule = (over: Partial<CreateTransactionRuleDto> = {}) =>
    ({
      name: "Bank transfers",
      triggers: ["create"],
      condition: {
        field: "payeeText",
        op: "matches",
        value: "*Nazwa odbiorcy: {payee} Rachunek*",
      },
      actions: [
        {
          type: "set_payee_from_text",
          template: "{payee}",
          createIfMissing: true,
          onlyIfEmpty: true,
        },
        {
          type: "set_description",
          template: "Payment to {payee}",
          mode: "replace",
          onlyIfEmpty: false,
        },
      ],
      ...over,
    }) as CreateTransactionRuleDto;

  const dto = (over: Record<string, unknown> = {}) =>
    ({
      accountId,
      transactionDate: "2026-03-10",
      amount: -50,
      currencyCode: "USD",
      payeeName: bankText("Jan Kowalski"),
      description: "card payment",
      ...over,
    }) as never;

  const count = async (table: string): Promise<number> =>
    Number((await db.query(`SELECT COUNT(*)::int AS n FROM ${table}`))[0].n);
  const rowOf = async (id: string) =>
    (
      await db.query(
        `SELECT payee_id, payee_name, description, amount FROM transactions WHERE id = $1`,
        [id],
      )
    )[0];
  const payeeNamed = async (name: string) =>
    (await db.query(`SELECT id FROM payees WHERE name = $1`, [name])) as Array<{
      id: string;
    }>;
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
    run = module.get(TransactionRulesRunService);
    accounts = module.get(AccountsService, { strict: false });
    history = module.get(ActionHistoryService, { strict: false });
  });

  afterAll(async () => {
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
    accountId = (
      await createTestAccount(db, aliceId, {
        name: "Checking",
        currencyCode: "USD",
        openingBalance: 1000,
        currentBalance: 1000,
      })
    ).id;
    kowalskiId = (await createTestPayee(db, aliceId, { name: "Jan Kowalski" }))
      .id;
  });

  it("sets an existing payee from the captured text and rewrites the description, moving no money", async () => {
    const rule = await asAlice(() => rules.create(aliceId, captureRule()));

    const created = await asAlice(() => transactions.create(aliceId, dto()));

    const stored = await rowOf(created.id);
    expect(stored.payee_id).toBe(kowalskiId);
    expect(stored.payee_name).toBe("Jan Kowalski");
    expect(stored.description).toBe("Payment to Jan Kowalski");
    expect(Number(stored.amount)).toBe(-50);
    expect(await balance()).toBe(950);
    expect(await count("payees")).toBe(1);
    const [application] = await db.query(
      `SELECT rule_id, source, changes FROM transaction_rule_applications`,
    );
    expect(application.rule_id).toBe(rule.id);
    expect(application.source).toBe("create");
    expect(application.changes).toEqual({
      payeeId: { before: null, after: kowalskiId },
      payeeName: {
        before: bankText("Jan Kowalski"),
        after: "Jan Kowalski",
      },
      description: {
        before: "card payment",
        after: "Payment to Jan Kowalski",
      },
    });
  });

  it("creates a missing payee with createIfMissing, once, through the payee service", async () => {
    await asAlice(() => rules.create(aliceId, captureRule()));

    const first = await asAlice(() =>
      transactions.create(
        aliceId,
        dto({ payeeName: bankText("Nowak Sp. z o.o.") }),
      ),
    );
    const second = await asAlice(() =>
      transactions.create(
        aliceId,
        dto({ payeeName: bankText("Nowak Sp. z o.o.") }),
      ),
    );

    const made = await payeeNamed("Nowak Sp. z o.o.");
    expect(made).toHaveLength(1);
    for (const tx of [first, second]) {
      const stored = await rowOf(tx.id);
      expect(stored.payee_id).toBe(made[0].id);
      expect(stored.payee_name).toBe("Nowak Sp. z o.o.");
    }
    const applications = await db.query(
      `SELECT transaction_id, changes FROM transaction_rule_applications ORDER BY applied_at`,
    );
    const byTx = new Map(
      applications.map((a: { transaction_id: string; changes: object }) => [
        a.transaction_id,
        a.changes,
      ]),
    );
    expect(byTx.get(first.id)).toMatchObject({
      payeeId: { before: null, after: made[0].id },
      payeeCreated: true,
    });
    // The second row found the payee the first one made: nothing created.
    expect(byTx.get(second.id)).not.toHaveProperty("payeeCreated");
  });

  it("without createIfMissing a name nobody has leaves the payee alone", async () => {
    await asAlice(() =>
      rules.create(
        aliceId,
        captureRule({
          actions: [
            {
              type: "set_payee_from_text",
              template: "{payee}",
              createIfMissing: false,
              onlyIfEmpty: true,
            },
          ],
        } as never),
      ),
    );
    const created = await asAlice(() =>
      transactions.create(
        aliceId,
        dto({ payeeName: bankText("Nobody Known") }),
      ),
    );
    expect((await rowOf(created.id)).payee_id).toBeNull();
    expect(await count("payees")).toBe(1);
    expect(await count("transaction_rule_applications")).toBe(0);
  });

  it("a failure after the applier rolls the created payee and the rewrite back with the insert", async () => {
    await asAlice(() => rules.create(aliceId, captureRule()));
    jest
      .spyOn(accounts, "updateBalance")
      .mockRejectedValue(new Error("balance update failed"));

    await expect(
      asAlice(() =>
        transactions.create(
          aliceId,
          dto({ payeeName: bankText("Nowak Sp. z o.o.") }),
        ),
      ),
    ).rejects.toThrow("balance update failed");

    expect(await count("transactions")).toBe(0);
    expect(await count("transaction_rule_applications")).toBe(0);
    expect(await payeeNamed("Nowak Sp. z o.o.")).toHaveLength(0);
    expect(await count("payees")).toBe(1);
    expect(await balance()).toBe(1000);
  });

  it("the preview creates nothing and equals the commit except for the payee it says will be created", async () => {
    await asAlice(() => rules.create(aliceId, captureRule()));
    const input = {
      accountId,
      amount: -50,
      transactionDate: "2026-03-10",
      payeeName: bankText("Nowak Sp. z o.o."),
      description: "card payment",
    };

    const preview = await asAlice(() =>
      transactions.previewCreate(aliceId, input),
    );

    expect(await count("payees")).toBe(1);
    expect(await count("transactions")).toBe(0);
    expect(await count("transaction_rule_applications")).toBe(0);
    expect(preview.ruleEffects?.changes).toMatchObject({
      createPayee: "Nowak Sp. z o.o.",
      payeeName: "Nowak Sp. z o.o.",
      description: "Payment to Nowak Sp. z o.o.",
    });
    const planned = preview.ruleEffects?.trace.find((t) => t.matched)?.changes;
    expect(planned?.payeeCreated).toBe(true);

    const created = await asAlice(() =>
      transactions.create(aliceId, dto({ payeeName: input.payeeName })),
    );
    const [applied] = await db.query(
      `SELECT changes FROM transaction_rule_applications WHERE transaction_id = $1`,
      [created.id],
    );
    const made = await payeeNamed("Nowak Sp. z o.o.");
    expect(made).toHaveLength(1);
    expect(applied.changes.payeeId).toEqual({
      before: null,
      after: made[0].id,
    });
    expect({ ...applied.changes, payeeId: undefined }).toEqual({
      ...planned,
      payeeId: undefined,
    });
    expect((await rowOf(created.id)).description).toBe(
      preview.ruleEffects?.changes.description,
    );
  });

  it("a manual run previews the new fields, writes them, and one undo restores description and payee while the created payee stays", async () => {
    const before = await asAlice(() =>
      transactions.create(
        aliceId,
        dto({ payeeName: bankText("Nowak Sp. z o.o.") }),
      ),
    );
    expect((await rowOf(before.id)).description).toBe("card payment");
    const rule = await asAlice(() => rules.create(aliceId, captureRule()));

    const preview = await asAlice(() => run.previewRun(aliceId, rule.id, {}));

    expect(preview.matched).toHaveLength(1);
    expect(preview.matched[0].changes).toMatchObject({
      payeeName: { after: "Nowak Sp. z o.o." },
      payeeCreated: true,
      description: {
        before: "card payment",
        after: "Payment to Nowak Sp. z o.o.",
      },
    });
    expect(await payeeNamed("Nowak Sp. z o.o.")).toHaveLength(0);

    const result = await asAlice(() =>
      run.run(aliceId, rule.id, { fingerprint: preview.fingerprint }),
    );

    expect(result.changed).toBe(1);
    const made = await payeeNamed("Nowak Sp. z o.o.");
    expect(made).toHaveLength(1);
    const written = await rowOf(before.id);
    expect(written.payee_id).toBe(made[0].id);
    expect(written.description).toBe("Payment to Nowak Sp. z o.o.");
    const [trace] = await db.query(
      `SELECT source, changes FROM transaction_rule_applications WHERE transaction_id = $1`,
      [before.id],
    );
    expect(trace.source).toBe("manual");
    expect(trace.changes.payeeId.after).toBe(made[0].id);

    await settlePendingHistoryWrites();
    await asAlice(() => history.undo(aliceId));

    const restored = await rowOf(before.id);
    expect(restored.payee_id).toBeNull();
    expect(restored.payee_name).toBe(bankText("Nowak Sp. z o.o."));
    expect(restored.description).toBe("card payment");
    // A payee is reference data: undo leaves the one the run created.
    expect(await payeeNamed("Nowak Sp. z o.o.")).toHaveLength(1);
  });

  it("a stale preview is refused when the payee appears before the commit", async () => {
    await asAlice(() =>
      transactions.create(
        aliceId,
        dto({ payeeName: bankText("Nowak Sp. z o.o.") }),
      ),
    );
    const rule = await asAlice(() => rules.create(aliceId, captureRule()));
    const preview = await asAlice(() => run.previewRun(aliceId, rule.id, {}));
    await createTestPayee(db, aliceId, { name: "Nowak Sp. z o.o." });

    await expect(
      asAlice(() =>
        run.run(aliceId, rule.id, { fingerprint: preview.fingerprint }),
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ errorCode: "PREVIEW_CHANGED" }),
    });
    expect(await count("transaction_rule_applications")).toBe(0);
  });
});
