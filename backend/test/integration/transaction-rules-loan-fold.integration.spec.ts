import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { Account, AccountType } from "@/accounts/entities/account.entity";
import { settlePendingHistoryWrites } from "@/action-history/action-history.service";
import { withUserContext } from "@/common/db/with-context";
import { ImportModule } from "@/import/import.module";
import { ImportService } from "@/import/import.service";
import { ScheduledTransaction } from "@/scheduled-transactions/entities/scheduled-transaction.entity";
import { ScheduledTransactionSplit } from "@/scheduled-transactions/entities/scheduled-transaction-split.entity";
import { TransactionRule } from "@/transaction-rules/transaction-rule.entity";
import { TransactionRulesModule } from "@/transaction-rules/transaction-rules.module";
import { TransactionRulesRunService } from "@/transaction-rules/transaction-rules-run.service";
import { TransactionsModule } from "@/transactions/transactions.module";
import { TransactionsService } from "@/transactions/transactions.service";
import {
  cleanTables,
  createIntegrationModule,
  createTestUserDirect,
} from "../helpers/integration-setup";
import {
  createTestAccount,
  createTestCategory,
} from "../helpers/test-factories";

/**
 * INV-RULE-005 against a real PostgreSQL (`docs/specs/loan-installment-settlement.md`
 * section 16, row B6): three months of one mortgage debit settle the same
 * way whichever path feeds them to the rule. A QIF file that lists them
 * newest first is inserted oldest first, so the rule on the `import` trigger
 * writes three claims whose `debtBefore` chain through the ledger each
 * earlier settlement left, the cursor stands at month four and the loan is
 * down by the three principals; the same three rows already in the ledger,
 * settled by one manual run (which plans every row before it writes any, so
 * it folds through `priorSettlements`), store the same `pricing` byte for
 * byte, apart from the two fields that say how the debt was arrived at:
 * the import's `debtLedger` is already the chained debt and its
 * `foldedPrincipal` is zero, the run's `debtLedger` is the opening 200,000
 * and its `foldedPrincipal` is the chain (spec section 7.2: both give the
 * same `debtBefore`, and so the same price).
 *
 * Fixtures from spec section 9.2: a LOAN of EUR 200,000 at 6 % nominal,
 * monthly, payment 1,500. Slot 1 books 500.00 + 1,000.00 on 200,000; slot 2
 * books 502.50 + 997.50 on 199,500; slot 3 books 505.01 + 994.99 on
 * 198,997.50.
 */
describe("Loan settlement: the chronological fold on the import and run paths (integration)", () => {
  jest.setTimeout(240000);

  let module: TestingModule;
  let db: DataSource;
  let transactions: TransactionsService;
  let importer: ImportService;
  let runs: TransactionRulesRunService;

  let userId: string;
  let chequingId: string;
  let loanId: string;
  let interestCategoryId: string;
  let scheduleId: string;
  let ruleId: string;

  const asUser = <T>(fn: () => Promise<T>) => withUserContext(userId, fn);

  /** The three debits, listed newest first, as a bank's export would. */
  const QIF =
    "!Type:Bank\n" +
    "D03/04/2024\nT-1500.00\nPING HYPOTHEKEN\n^\n" +
    "D02/02/2024\nT-1500.00\nPING HYPOTHEKEN\n^\n" +
    "D01/03/2024\nT-1500.00\nPING HYPOTHEKEN\n^\n";

  const importQif = () =>
    asUser(() =>
      importer.importQifFile(userId, {
        content: QIF,
        accountId: chequingId,
        categoryMappings: [],
        accountMappings: [],
        securityMappings: [],
        dateFormat: "MM/DD/YYYY",
      } as never),
    );

  const create = (transactionDate: string) =>
    asUser(() =>
      transactions.create(userId, {
        accountId: chequingId,
        transactionDate,
        amount: -1500,
        currencyCode: "EUR",
        payeeName: "ING HYPOTHEKEN",
      } as never),
    );

  const claims = async (): Promise<
    Array<{
      due: string;
      posted: string;
      source: string;
      transaction_id: string;
      pricing: Record<string, unknown>;
    }>
  > =>
    db.query(
      `SELECT TO_CHAR(original_due_date, 'YYYY-MM-DD') AS due,
              TO_CHAR(posted_date, 'YYYY-MM-DD') AS posted,
              source, transaction_id, pricing
         FROM scheduled_transaction_postings
        WHERE scheduled_transaction_id = $1
        ORDER BY original_due_date`,
      [scheduleId],
    );
  const nextDueDate = async (): Promise<string> =>
    (
      await db.query(
        `SELECT TO_CHAR(next_due_date, 'YYYY-MM-DD') AS next_due_date
           FROM scheduled_transactions WHERE id = $1`,
        [scheduleId],
      )
    )[0].next_due_date;
  const balanceOf = async (accountId: string): Promise<number> =>
    Number(
      (
        await db.query(`SELECT current_balance FROM accounts WHERE id = $1`, [
          accountId,
        ])
      )[0].current_balance,
    );
  const rowDatesOf = async (
    ids: readonly string[],
  ): Promise<Map<string, string>> =>
    new Map(
      (
        (await db.query(
          `SELECT id, TO_CHAR(transaction_date, 'YYYY-MM-DD') AS date
             FROM transactions WHERE id = ANY($1::uuid[])`,
          [[...ids]],
        )) as Array<{ id: string; date: string }>
      ).map((row) => [row.id, row.date]),
    );

  /** The chain of spec section 9.2, as the stored `pricing` records it. */
  const EXPECTED_CHAIN = [
    {
      dueDate: "2024-01-01",
      installmentNumber: 1,
      debtLedger: "200000.0000",
      foldedPrincipal: "0.0000",
      debtBefore: "200000.0000",
      lines: { principal: "500.00", interest: "1000.00", extra: "0.00" },
      outcome: "exact",
    },
    {
      dueDate: "2024-02-01",
      installmentNumber: 2,
      debtBefore: "199500.0000",
      lines: { principal: "502.50", interest: "997.50", extra: "0.00" },
      outcome: "exact",
    },
    {
      dueDate: "2024-03-01",
      installmentNumber: 3,
      debtBefore: "198997.5000",
      lines: { principal: "505.01", interest: "994.99", extra: "0.00" },
      outcome: "exact",
    },
  ];
  const LOAN_AFTER_THREE = -200000 + 500 + 502.5 + 505.01;

  async function seed(): Promise<void> {
    await settlePendingHistoryWrites();
    await cleanTables(db, [
      "transaction_rule_applications",
      "transaction_rules",
      "action_history",
      "scheduled_transaction_postings",
      "scheduled_transaction_splits",
      "scheduled_transaction_overrides",
      "scheduled_transactions",
      "transaction_splits",
      "transactions",
      "monthly_account_balances",
      "accounts",
      "categories",
      "payees",
      "users",
    ]);
    await db.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places)
       VALUES ('EUR', 'Euro', 'E', 2) ON CONFLICT DO NOTHING`,
    );
    userId = (await createTestUserDirect(db)).id;
    chequingId = (
      await createTestAccount(db, userId, {
        name: "Chequing",
        currencyCode: "EUR",
        openingBalance: 50000,
        currentBalance: 50000,
      })
    ).id;
    interestCategoryId = (
      await createTestCategory(db, userId, { name: "Loan Interest" })
    ).id;
    loanId = (
      await createTestAccount(db, userId, {
        name: "Mortgage",
        accountType: AccountType.LOAN,
        currencyCode: "EUR",
        openingBalance: -200000,
        currentBalance: -200000,
      })
    ).id;

    const saved = await db.manager.save(
      db.manager.create(ScheduledTransaction, {
        userId,
        accountId: chequingId,
        name: "Mortgage Payment",
        amount: -1500,
        currencyCode: "EUR",
        frequency: "MONTHLY",
        startDate: "2024-01-01",
        nextDueDate: "2024-01-01",
        isActive: true,
        isSplit: true,
        autoPost: false,
      } as Partial<ScheduledTransaction>),
    );
    scheduleId = saved.id;
    await db.manager.save(
      db.manager.create(ScheduledTransactionSplit, {
        scheduledTransactionId: scheduleId,
        kind: "transfer",
        transferAccountId: loanId,
        amount: -500,
        memo: "Principal",
      } as Partial<ScheduledTransactionSplit>),
    );
    await db.manager.save(
      db.manager.create(ScheduledTransactionSplit, {
        scheduledTransactionId: scheduleId,
        kind: "category",
        categoryId: interestCategoryId,
        amount: -1000,
        memo: "Interest",
      } as Partial<ScheduledTransactionSplit>),
    );
    await db.manager.update(Account, loanId, {
      interestRate: 6,
      paymentFrequency: "MONTHLY",
      paymentAmount: 1500,
      interestCategoryId,
      scheduledTransactionId: scheduleId,
    });

    ruleId = (
      await db.manager.save(
        db.manager.create(TransactionRule, {
          userId,
          name: "Hypotheek",
          enabled: true,
          position: 0,
          triggers: ["create", "import"],
          condition: { field: "payeeText", op: "contains", value: "ING" },
          actions: [
            {
              type: "settle_loan_installment",
              loanAccountId: loanId,
              dueDateWindow: { daysBefore: 3, daysAfter: 7 },
              excess: "extra_principal",
              shortfall: "refuse",
            },
          ],
          stopProcessing: true,
          activeFrom: null,
          activeTo: null,
          revision: 1,
        } as Partial<TransactionRule>),
      )
    ).id;
  }

  beforeAll(async () => {
    module = await createIntegrationModule([
      ImportModule,
      TransactionsModule,
      TransactionRulesModule,
    ]);
    db = module.get(DataSource);
    transactions = module.get(TransactionsService);
    importer = module.get(ImportService);
    runs = module.get(TransactionRulesRunService);
  });

  afterAll(async () => {
    await settlePendingHistoryWrites();
    await module.close();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await seed();
  });

  it("imports a file listed newest first oldest first, so three months settle in a chain: three claims, the cursor at month four, the loan down by the three principals", async () => {
    const result = await importQif();

    expect(result.errorMessages).toEqual([]);
    expect(result.imported).toBe(3);

    const stored = await claims();
    expect(
      stored.map((claim) => [claim.due, claim.posted, claim.source]),
    ).toEqual([
      ["2024-01-01", "2024-01-03", "rule"],
      ["2024-02-01", "2024-02-02", "rule"],
      ["2024-03-01", "2024-03-04", "rule"],
    ]);
    stored.forEach((claim, i) => {
      expect(claim.pricing).toMatchObject(EXPECTED_CHAIN[i]);
    });
    // Each settlement was priced on the ledger its predecessor left, not on
    // a fold: the import writes a row's settlement before the next row runs.
    expect(stored.map((claim) => claim.pricing.foldedPrincipal)).toEqual([
      "0.0000",
      "0.0000",
      "0.0000",
    ]);
    expect(stored.map((claim) => claim.pricing.debtLedger)).toEqual([
      "200000.0000",
      "199500.0000",
      "198997.5000",
    ]);
    // The rows were inserted in date order whatever the file's order.
    const dates = await rowDatesOf(stored.map((claim) => claim.transaction_id));
    expect(stored.map((claim) => dates.get(claim.transaction_id))).toEqual([
      "2024-01-03",
      "2024-02-02",
      "2024-03-04",
    ]);
    expect(await nextDueDate()).toBe("2024-04-01");
    expect(await balanceOf(loanId)).toBeCloseTo(LOAN_AFTER_THREE, 2);
    expect(await balanceOf(chequingId)).toBe(50000 - 4500);
  });

  it("settles the same three rows, already in the ledger, through one manual run with byte-identical pricing", async () => {
    await importQif();
    const imported = await claims();
    // Everything but the two fields that record how the debt was arrived at.
    const priced = (pricing: Record<string, unknown>): string => {
      const {
        debtLedger: _ledger,
        foldedPrincipal: _folded,
        ...rest
      } = pricing;
      return JSON.stringify(rest);
    };
    const importedPricing = imported.map((claim) => priced(claim.pricing));

    // The same three rows, created newest first with the rule off so nothing
    // settles on the way in; then one run of the rule over all of them.
    await seed();
    await db.query(
      `UPDATE transaction_rules SET enabled = false WHERE id = $1`,
      [ruleId],
    );
    await create("2024-03-04");
    await create("2024-02-02");
    await create("2024-01-03");
    expect(await claims()).toEqual([]);

    const preview = await asUser(() => runs.previewRun(userId, ruleId, {}));
    expect(preview.scanOrder).toBe("oldest_first");
    expect(preview.skipped).toEqual([]);
    expect(preview.matched.map((row) => row.date)).toEqual([
      "2024-01-03",
      "2024-02-02",
      "2024-03-04",
    ]);
    // The run plans every row before it writes any: the later rows fold the
    // earlier rows' principal out of the ledger's 200,000.
    const planned = preview.matched.map(
      (row) =>
        (
          row.changes.loanSettlement.after as {
            pricing: Record<string, string>;
          }
        ).pricing,
    );
    expect(
      planned.map((p) => [p.debtLedger, p.foldedPrincipal, p.debtBefore]),
    ).toEqual([
      ["200000.0000", "0.0000", "200000.0000"],
      ["200000.0000", "500.0000", "199500.0000"],
      ["200000.0000", "1002.5000", "198997.5000"],
    ]);

    const result = await asUser(() =>
      runs.run(userId, ruleId, { fingerprint: preview.fingerprint }),
    );
    expect(result.changed).toBe(3);

    const settled = await claims();
    expect(settled.map((claim) => claim.due)).toEqual([
      "2024-01-01",
      "2024-02-01",
      "2024-03-01",
    ]);
    settled.forEach((claim, i) => {
      expect(claim.pricing).toMatchObject(EXPECTED_CHAIN[i]);
    });
    // Byte for byte what the import path stored, `debtBefore` and every
    // priced and booked figure included; only the two fields that say how
    // the debt was arrived at differ, as the plan said they would.
    expect(settled.map((claim) => priced(claim.pricing))).toEqual(
      importedPricing,
    );
    expect(
      settled.map((claim) => [
        claim.pricing.debtLedger,
        claim.pricing.foldedPrincipal,
      ]),
    ).toEqual([
      ["200000.0000", "0.0000"],
      ["200000.0000", "500.0000"],
      ["200000.0000", "1002.5000"],
    ]);
    expect(await nextDueDate()).toBe("2024-04-01");
    expect(await balanceOf(loanId)).toBeCloseTo(LOAN_AFTER_THREE, 2);
  });
});
