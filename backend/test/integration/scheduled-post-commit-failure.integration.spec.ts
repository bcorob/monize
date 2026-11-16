import { ConflictException } from "@nestjs/common";
import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { AccountsModule } from "@/accounts/accounts.module";
import { withUserContext } from "@/common/db/with-context";
import { todayInTimezone } from "@/common/date-utils";
import { ScheduledTransaction } from "@/scheduled-transactions/entities/scheduled-transaction.entity";
import { ScheduledTransactionSplit } from "@/scheduled-transactions/entities/scheduled-transaction-split.entity";
import type { OccurrencePin } from "@/scheduled-transactions/occurrence-pin";
import { ScheduledTransactionLoanService } from "@/scheduled-transactions/scheduled-transaction-loan.service";
import { ScheduledTransactionsModule } from "@/scheduled-transactions/scheduled-transactions.module";
import { ScheduledTransactionsService } from "@/scheduled-transactions/scheduled-transactions.service";
import { SystemAlertService } from "@/system-alerts/system-alert.service";
import { TransactionsModule } from "@/transactions/transactions.module";
import { TransactionsService } from "@/transactions/transactions.service";
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
 * A step after the posting transaction committed must not turn a posted
 * occurrence into a reported failure (audit A26-S08-02 / A26-M14).
 *
 * `post()` commits the money, the occurrence claim and the cursor advance in one
 * transaction, then runs the transfer's `completeTransfer` and the loan
 * template's re-price. Their errors used to propagate: the auto-post cron raised
 * SCHEDULED_POST_FAILED ("could not be posted ... post it manually") for an
 * occurrence that WAS posted, and an HTTP caller saw an error for a committed
 * post and retried. The steps are now logged and left to the next run; every
 * refusal before or inside the transaction still throws.
 */
describe("A failure after the scheduled post commits is not 'not posted' (integration)", () => {
  const AMOUNT = -42.5;
  const OPENING = 1000;

  let module: TestingModule;
  let service: ScheduledTransactionsService;
  let dataSource: DataSource;
  let userId: string;
  let accountId: string;
  let otherAccountId: string;
  let categoryId: string;
  let firstDue: string;
  let secondDue: string;

  const spies: jest.SpyInstance[] = [];

  const postPinned = (id: string, pin: OccurrencePin) =>
    withUserContext(userId, () =>
      service.post(
        userId,
        id,
        { transactionDate: pin.occurrenceDate } as never,
        { occurrencePin: pin },
      ),
    );

  function firstOfMonthBefore(today: string, back: number): string {
    const [y, m] = today.split("-").map(Number);
    const index = y * 12 + (m - 1) - back;
    const year = Math.floor(index / 12);
    const month = (index % 12) + 1;
    return `${year}-${String(month).padStart(2, "0")}-01`;
  }

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

  afterEach(() => {
    while (spies.length > 0) spies.pop()!.mockRestore();
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
      "notifications",
      "users",
    ]);
    await dataSource.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places)
       VALUES ('USD', 'US Dollar', '$', 2)
       ON CONFLICT DO NOTHING`,
    );

    const today = todayInTimezone("UTC")!;
    firstDue = firstOfMonthBefore(today, 2);
    secondDue = firstOfMonthBefore(today, 1);

    const user = await createTestUserDirect(dataSource);
    userId = user.id;
    accountId = (
      await createTestAccount(dataSource, userId, {
        name: "Chequing",
        openingBalance: OPENING,
        currentBalance: OPENING,
      })
    ).id;
    otherAccountId = (
      await createTestAccount(dataSource, userId, {
        name: "Savings",
        openingBalance: 0,
        currentBalance: 0,
      })
    ).id;
    categoryId = (await createTestCategory(dataSource, userId, { name: "Gym" }))
      .id;
  });

  async function makeSchedule(
    overrides: Partial<ScheduledTransaction>,
  ): Promise<string> {
    const scheduled = await dataSource.manager.save(
      dataSource.manager.create(ScheduledTransaction, {
        userId,
        accountId,
        name: "Gym",
        amount: AMOUNT,
        currencyCode: "USD",
        frequency: "MONTHLY",
        nextDueDate: firstDue,
        startDate: "2020-01-01",
        isActive: true,
        autoPost: true,
        ...overrides,
      } as Partial<ScheduledTransaction>),
    );
    return scheduled.id;
  }

  /** Two category splits: enough for `scheduled.splits.length > 0`. */
  async function makeSplitSchedule(): Promise<string> {
    const id = await makeSchedule({ isSplit: true });
    for (const amount of [-20, -22.5]) {
      await dataSource.manager.save(
        dataSource.manager.create(ScheduledTransactionSplit, {
          scheduledTransactionId: id,
          kind: "category",
          categoryId,
          amount,
        } as Partial<ScheduledTransactionSplit>),
      );
    }
    return id;
  }

  async function readState(scheduledId: string) {
    const [{ c: transactions }]: { c: number }[] = await dataSource.query(
      `SELECT count(*)::int AS c FROM transactions WHERE account_id = $1`,
      [accountId],
    );
    const [{ c: otherLegs }]: { c: number }[] = await dataSource.query(
      `SELECT count(*)::int AS c FROM transactions WHERE account_id = $1`,
      [otherAccountId],
    );
    const postings: { original_due_date: string }[] = await dataSource.query(
      `SELECT TO_CHAR(original_due_date, 'YYYY-MM-DD') AS original_due_date
         FROM scheduled_transaction_postings
        WHERE scheduled_transaction_id = $1
        ORDER BY original_due_date`,
      [scheduledId],
    );
    const [{ next_due_date: nextDueDate }]: { next_due_date: string }[] =
      await dataSource.query(
        `SELECT TO_CHAR(next_due_date, 'YYYY-MM-DD') AS next_due_date
           FROM scheduled_transactions WHERE id = $1`,
        [scheduledId],
      );
    const [{ current_balance: balance }]: { current_balance: string }[] =
      await dataSource.query(
        `SELECT current_balance FROM accounts WHERE id = $1`,
        [accountId],
      );
    return {
      transactions,
      otherLegs,
      postings: postings.map((p) => p.original_due_date),
      nextDueDate,
      balance: Number(balance),
    };
  }

  function failRecalc() {
    const spy = jest
      .spyOn(
        module.get(ScheduledTransactionLoanService),
        "recalculateLoanPaymentSplits",
      )
      .mockRejectedValueOnce(new Error("lock timeout"));
    spies.push(spy);
    return spy;
  }

  it("A26-S08-02: the cron raises no SCHEDULED_POST_FAILED alert for an occurrence that is posted", async () => {
    const scheduledId = await makeSplitSchedule();
    const alerts = jest.spyOn(module.get(SystemAlertService), "raiseUserAlert");
    spies.push(alerts);
    const recalc = failRecalc();

    await service.processAutoPostTransactions();

    expect(recalc).toHaveBeenCalledTimes(1);
    expect(alerts).not.toHaveBeenCalled();
    const [{ c: notifications }]: { c: number }[] = await dataSource.query(
      `SELECT count(*)::int AS c FROM notifications WHERE alert_type = 'SCHEDULED_POST_FAILED'`,
    );
    expect(notifications).toBe(0);

    const state = await readState(scheduledId);
    expect(state.transactions).toBe(1);
    expect(state.postings).toEqual([firstDue]);
    expect(state.nextDueDate).toBe(secondDue);
    expect(state.balance).toBe(OPENING + AMOUNT);
  });

  it("A26-M14: a manual pinned post resolves, and its retry is refused, not written twice", async () => {
    const scheduledId = await makeSplitSchedule();
    failRecalc();
    const pin = { occurrenceDate: firstDue, overrideId: null };

    const posted = await postPinned(scheduledId, pin);

    expect(posted).not.toBeNull();
    expect(posted!.nextDueDate).toBe(secondDue);

    await expect(postPinned(scheduledId, pin)).rejects.toBeInstanceOf(
      ConflictException,
    );

    const state = await readState(scheduledId);
    expect(state.transactions).toBe(1);
    expect(state.postings).toEqual([firstDue]);
    expect(state.nextDueDate).toBe(secondDue);
    expect(state.balance).toBe(OPENING + AMOUNT);
  });

  it("A26-S08-02: a transfer whose completeTransfer fails still posts both legs once and holds the claim", async () => {
    const scheduledId = await makeSchedule({
      isTransfer: true,
      transferAccountId: otherAccountId,
    });
    const complete = jest
      .spyOn(module.get(TransactionsService), "completeTransfer")
      .mockRejectedValueOnce(new Error("history down"));
    spies.push(complete);

    const posted = await postPinned(scheduledId, {
      occurrenceDate: firstDue,
      overrideId: null,
    });

    expect(posted).not.toBeNull();
    expect(complete).toHaveBeenCalledTimes(1);
    const state = await readState(scheduledId);
    expect(state.transactions).toBe(1);
    expect(state.otherLegs).toBe(1);
    expect(state.postings).toEqual([firstDue]);
    expect(state.nextDueDate).toBe(secondDue);
  });
});
