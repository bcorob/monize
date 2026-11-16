import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { AccountsModule } from "@/accounts/accounts.module";
import { Account, AccountType } from "@/accounts/entities/account.entity";
import { withUserContext } from "@/common/db/with-context";
import type { OccurrencePin } from "@/scheduled-transactions/occurrence-pin";
import { PostScheduledTransactionDto } from "@/scheduled-transactions/dto/post-scheduled-transaction.dto";
import { ScheduledTransaction } from "@/scheduled-transactions/entities/scheduled-transaction.entity";
import { ScheduledTransactionSplit } from "@/scheduled-transactions/entities/scheduled-transaction-split.entity";
import { ScheduledTransactionsModule } from "@/scheduled-transactions/scheduled-transactions.module";
import { ScheduledTransactionsService } from "@/scheduled-transactions/scheduled-transactions.service";
import { TransactionsModule } from "@/transactions/transactions.module";
import {
  createIntegrationModule,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import {
  createTestAccount,
  createTestCategory,
} from "../helpers/test-factories";

/**
 * A loan owing exactly one minor unit is owed, not paid off (audit A26-S15-06
 * / A26-L23, matrix row R6). `<= 0.01` claimed the occurrence with no
 * transaction, deactivated the schedule and left the loan at -0.01 for ever,
 * so the account could not be closed. The bill now posts the 0.01, the loan
 * ledger reaches 0.00 and the post-commit recalculation deactivates the
 * schedule.
 */
describe("Scheduled loan installment on a debt of one cent (integration)", () => {
  let module: TestingModule;
  let service: ScheduledTransactionsService;
  let dataSource: DataSource;
  let userId: string;
  let chequingId: string;
  let loanId: string;
  let interestCategoryId: string;
  let scheduledId: string;

  const FIRST = "2026-08-01";

  const postPinned = (
    dto: Partial<PostScheduledTransactionDto>,
    pin: OccurrencePin,
  ) =>
    withUserContext(userId, () =>
      (
        service.post.bind(service) as (
          userId: string,
          id: string,
          dto: PostScheduledTransactionDto,
          options: { occurrencePin: OccurrencePin },
        ) => Promise<ScheduledTransaction | null>
      )(userId, scheduledId, dto as PostScheduledTransactionDto, {
        occurrencePin: pin,
      }),
    );

  beforeAll(async () => {
    module = await createIntegrationModule([
      AccountsModule,
      TransactionsModule,
      ScheduledTransactionsModule,
    ]);
    service = module.get(ScheduledTransactionsService);
    dataSource = module.get(DataSource);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanTables(dataSource, [
      "action_history",
      "scheduled_transaction_postings",
      "scheduled_transaction_overrides",
      "scheduled_transaction_splits",
      "scheduled_transactions",
      "transaction_splits",
      "transactions",
      "accounts",
      "categories",
      "payees",
      "monthly_account_balances",
      "users",
    ]);
    await dataSource.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places)
       VALUES ('USD', 'US Dollar', '$', 2)
       ON CONFLICT DO NOTHING`,
    );
    userId = (await createTestUserDirect(dataSource)).id;
    chequingId = (
      await createTestAccount(dataSource, userId, {
        name: "Chequing",
        openingBalance: 50000,
        currentBalance: 50000,
      })
    ).id;
    interestCategoryId = (
      await createTestCategory(dataSource, userId, { name: "Loan Interest" })
    ).id;
  });

  async function makeLoan(currencyCode: string, debt: number): Promise<string> {
    const loan = await createTestAccount(dataSource, userId, {
      name: "Loan",
      currencyCode,
      openingBalance: -debt,
      currentBalance: -debt,
    });
    await dataSource.manager.update(Account, loan.id, {
      accountType: AccountType.LOAN,
      interestRate: 0,
      paymentFrequency: "MONTHLY",
      paymentAmount: 1500,
      interestCategoryId,
    });
    return loan.id;
  }

  async function makeTemplate(): Promise<void> {
    const scheduled = await dataSource.manager.save(
      dataSource.manager.create(ScheduledTransaction, {
        userId,
        accountId: chequingId,
        name: "Loan Payment",
        amount: -1500,
        currencyCode: "USD",
        frequency: "MONTHLY",
        nextDueDate: FIRST,
        startDate: "2026-01-01",
        isActive: true,
        isSplit: true,
      } as Partial<ScheduledTransaction>),
    );
    scheduledId = scheduled.id;
    // The template as an earlier, smaller debt left it; the posting
    // re-divides the bill from the ledger.
    await dataSource.manager.save([
      dataSource.manager.create(ScheduledTransactionSplit, {
        scheduledTransactionId: scheduledId,
        kind: "transfer",
        transferAccountId: loanId,
        amount: -500,
        memo: "Principal",
      } as Partial<ScheduledTransactionSplit>),
      dataSource.manager.create(ScheduledTransactionSplit, {
        scheduledTransactionId: scheduledId,
        kind: "category",
        categoryId: interestCategoryId,
        amount: -1000,
        memo: "Interest",
      } as Partial<ScheduledTransactionSplit>),
    ]);
  }

  /** The lines of the n-th posted transaction on the chequing account. */
  async function postedLines(date: string) {
    const [parent]: { id: string; amount: string }[] = await dataSource.query(
      `SELECT id, amount FROM transactions
        WHERE account_id = $1 AND transaction_date = $2 AND parent_transaction_id IS NULL`,
      [chequingId, date],
    );
    const lines: {
      amount: string;
      category_id: string | null;
      transfer_account_id: string | null;
    }[] = await dataSource.query(
      `SELECT s.amount, s.category_id,
              t.account_id AS transfer_account_id
         FROM transaction_splits s
         LEFT JOIN transactions t ON t.id = s.linked_transaction_id
        WHERE s.transaction_id = $1`,
      [parent.id],
    );
    const interest = lines.find((l) => l.category_id === interestCategoryId);
    const principal = lines.find((l) => l.transfer_account_id === loanId);
    return {
      parent: Number(parent.amount),
      interest: Number(interest?.amount),
      principal: Number(principal?.amount),
    };
  }

  async function loanBalance(): Promise<number> {
    const [{ current_balance: balance }]: { current_balance: string }[] =
      await dataSource.query(
        `SELECT current_balance FROM accounts WHERE id = $1`,
        [loanId],
      );
    return Number(balance);
  }

  async function scheduleActive(): Promise<boolean> {
    const [row]: { is_active: boolean }[] = await dataSource.query(
      `SELECT is_active FROM scheduled_transactions WHERE id = $1`,
      [scheduledId],
    );
    return row.is_active;
  }

  async function postedCount(): Promise<number> {
    const [{ c }]: { c: number }[] = await dataSource.query(
      `SELECT count(*)::int AS c FROM transactions
        WHERE account_id = $1 AND parent_transaction_id IS NULL`,
      [chequingId],
    );
    return c;
  }

  describe("A26-S15-06 (R6): the loan ledger owes 0.01", () => {
    beforeEach(async () => {
      loanId = await makeLoan("USD", 0.01);
      await makeTemplate();
    });

    it("posts one transaction of 0.01, clears the loan and deactivates the schedule", async () => {
      await postPinned(
        { transactionDate: FIRST },
        { occurrenceDate: FIRST, overrideId: null },
      );

      expect(await postedCount()).toBe(1);
      expect(await postedLines(FIRST)).toEqual({
        parent: -0.01,
        interest: 0,
        principal: -0.01,
      });
      expect(await loanBalance()).toBe(0);
      // The post-commit recalculation reads the cleared ledger.
      expect(await scheduleActive()).toBe(false);
    });
  });
});
