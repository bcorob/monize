import { ConflictException } from "@nestjs/common";
import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { AccountsModule } from "@/accounts/accounts.module";
import { AccountsService } from "@/accounts/accounts.service";
import { Account, AccountType } from "@/accounts/entities/account.entity";
import {
  ActionHistoryService,
  settlePendingHistoryWrites,
} from "@/action-history/action-history.service";
import { withUserContext } from "@/common/db/with-context";
import { identifyLoanTemplate } from "@/loan-installments/price-installment";
import { ScheduledTransaction } from "@/scheduled-transactions/entities/scheduled-transaction.entity";
import { ScheduledTransactionSplit } from "@/scheduled-transactions/entities/scheduled-transaction-split.entity";
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
 * A26-H06 (A26-S07-02, A26-S15-01): undo and redo of an account edit restore
 * intent, not a snapshot.
 *
 * The generic entity undo wrote every column of the edit-time snapshot back:
 * a rename undone after a movement no action recorded (the due-balance cron,
 * a sync, a grantee's posting) put the edit-time `current_balance` back --
 * chequing 5,000.00 stored beside a ledger of 4,800.00. On a loan it restored
 * the interest category without moving the template's interest line back, so
 * the template stopped being managed (INV-LOAN-010), and a method change
 * without the reprice (INV-LOAN-007).
 */
describe("Undo of an account edit (integration)", () => {
  jest.setTimeout(60000);

  let module: TestingModule;
  let db: DataSource;
  let accounts: AccountsService;
  let history: ActionHistoryService;
  let userId: string;

  const asUser = <T>(fn: () => Promise<T>) => withUserContext(userId, fn);

  beforeAll(async () => {
    module = await createIntegrationModule([AccountsModule]);
    db = module.get(DataSource);
    accounts = module.get(AccountsService);
    history = module.get(ActionHistoryService, { strict: false });
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanTables(db, [
      "action_history",
      "scheduled_transaction_splits",
      "scheduled_transaction_overrides",
      "scheduled_transactions",
      "transaction_splits",
      "transactions",
      "accounts",
      "categories",
      "users",
    ]);
    userId = (await createTestUserDirect(db)).id;
  });

  async function undo() {
    await settlePendingHistoryWrites();
    return asUser(() => history.undo(userId));
  }

  async function redo() {
    await settlePendingHistoryWrites();
    return asUser(() => history.redo(userId));
  }

  async function ledgerOf(accountId: string): Promise<number> {
    const [row] = await db.query(
      `SELECT (a.opening_balance + COALESCE(SUM(t.amount)
                 FILTER (WHERE t.status IS DISTINCT FROM 'VOID'), 0))::float8 AS v
         FROM accounts a
         LEFT JOIN transactions t ON t.account_id = a.id
        WHERE a.id = $1
        GROUP BY a.opening_balance`,
      [accountId],
    );
    return Number(row.v);
  }

  /** A movement no action records: a ledger row and its atomic delta. */
  async function unrecordedMovement(accountId: string, amount: number) {
    await db.query(
      `INSERT INTO transactions (user_id, account_id, transaction_date, amount,
                                 currency_code, status)
       VALUES ($1, $2, CURRENT_DATE, $3, 'USD', 'UNRECONCILED')`,
      [userId, accountId, amount],
    );
    await db.query(
      `UPDATE accounts SET current_balance = current_balance + $1 WHERE id = $2`,
      [amount, accountId],
    );
  }

  describe("a cash account", () => {
    let chequingId: string;

    beforeEach(async () => {
      chequingId = (
        await createTestAccount(db, userId, {
          name: "Chequing",
          openingBalance: 5000,
          currentBalance: 5000,
        })
      ).id;
    });

    const account = () =>
      db.manager.findOneByOrFail(Account, { id: chequingId });

    it("undo of a rename reverts the name and leaves the balance on its ledger", async () => {
      await asUser(() =>
        accounts.update(userId, chequingId, { name: "Chequing renamed" }),
      );
      await unrecordedMovement(chequingId, -200);

      await undo();

      expect((await account()).name).toBe("Chequing");
      expect(Number((await account()).currentBalance)).toBe(4800);
      expect(Number((await account()).currentBalance)).toBe(
        await ledgerOf(chequingId),
      );
    });

    it("redo of the rename leaves the balance on its ledger too", async () => {
      await asUser(() =>
        accounts.update(userId, chequingId, { name: "Chequing renamed" }),
      );
      await undo();
      await unrecordedMovement(chequingId, -75);

      await redo();

      expect((await account()).name).toBe("Chequing renamed");
      expect(Number((await account()).currentBalance)).toBe(4925);
    });

    it("undo of an opening-balance change recomputes the balance from the ledger", async () => {
      await asUser(() =>
        accounts.update(userId, chequingId, { openingBalance: 6000 }),
      );
      expect(Number((await account()).currentBalance)).toBe(6000);
      await unrecordedMovement(chequingId, -200);

      await undo();

      expect(Number((await account()).openingBalance)).toBe(5000);
      expect(Number((await account()).currentBalance)).toBe(4800);
    });
  });

  describe("a loan with a payment template", () => {
    let loanId: string;
    let scheduleId: string;
    let categoryA: string;
    let categoryB: string;

    const lines = () =>
      db.manager.find(ScheduledTransactionSplit, {
        where: { scheduledTransactionId: scheduleId },
      });
    const loan = () => db.manager.findOneByOrFail(Account, { id: loanId });

    beforeEach(async () => {
      const chequingId = (
        await createTestAccount(db, userId, {
          name: "Chequing",
          openingBalance: 50000,
          currentBalance: 50000,
        })
      ).id;
      categoryA = (await createTestCategory(db, userId, { name: "Rente A" }))
        .id;
      categoryB = (await createTestCategory(db, userId, { name: "Rente B" }))
        .id;
      loanId = (
        await createTestAccount(db, userId, {
          name: "Loan",
          accountType: AccountType.LOAN,
          openingBalance: -200000,
          currentBalance: -200000,
        })
      ).id;
      scheduleId = (
        await db.manager.save(
          db.manager.create(ScheduledTransaction, {
            userId,
            accountId: chequingId,
            name: "Loan Payment",
            amount: -1500,
            currencyCode: "USD",
            frequency: "MONTHLY",
            startDate: "2026-01-01",
            nextDueDate: "2026-11-01",
            isActive: true,
            isSplit: true,
            autoPost: false,
          } as Partial<ScheduledTransaction>),
        )
      ).id;
      for (const line of [
        {
          kind: "transfer",
          transferAccountId: loanId,
          amount: -500,
          memo: "Principal",
        },
        {
          kind: "category",
          categoryId: categoryA,
          amount: -1000,
          memo: "Interest",
        },
      ]) {
        await db.manager.save(
          db.manager.create(ScheduledTransactionSplit, {
            scheduledTransactionId: scheduleId,
            ...line,
          } as Partial<ScheduledTransactionSplit>),
        );
      }
      await db.manager.update(Account, loanId, {
        interestRate: 6,
        paymentFrequency: "MONTHLY",
        paymentAmount: 1500,
        interestCategoryId: categoryA,
        scheduledTransactionId: scheduleId,
      });
    });

    it("refuses to undo an interest-category change, leaving the template managed", async () => {
      await asUser(() =>
        accounts.update(userId, loanId, { interestCategoryId: categoryB }),
      );
      expect(identifyLoanTemplate(await lines(), await loan()).managed).toBe(
        true,
      );

      await expect(undo()).rejects.toBeInstanceOf(ConflictException);

      expect((await loan()).interestCategoryId).toBe(categoryB);
      expect(identifyLoanTemplate(await lines(), await loan()).managed).toBe(
        true,
      );
    });

    it("still undoes a loan edit that touched no template-coupled column", async () => {
      await asUser(() => accounts.update(userId, loanId, { name: "My loan" }));

      await undo();

      expect((await loan()).name).toBe("Loan");
      expect(identifyLoanTemplate(await lines(), await loan()).managed).toBe(
        true,
      );
    });
  });
});
