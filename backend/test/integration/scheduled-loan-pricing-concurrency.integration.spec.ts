import { TestingModule } from "@nestjs/testing";
import { Module } from "@nestjs/common";
import { DataSource } from "typeorm";
import { ScheduledTransactionLoanService } from "@/scheduled-transactions/scheduled-transaction-loan.service";
import { ScheduledTransaction } from "@/scheduled-transactions/entities/scheduled-transaction.entity";
import { ScheduledTransactionSplit } from "@/scheduled-transactions/entities/scheduled-transaction-split.entity";
import { TransactionsModule } from "@/transactions/transactions.module";
import { TransactionsService } from "@/transactions/transactions.service";
import { Account, AccountType } from "@/accounts/entities/account.entity";
import {
  createIntegrationModule,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import {
  createTestAccount,
  createTestCategory,
} from "../helpers/test-factories";
import { withUserContext } from "@/common/db/with-context";
import { withScopedDb } from "@/common/db/scoped-db";
import { lockAccountsForBalanceWrite } from "@/common/db/locks";

/**
 * CONC-001 for the scheduled loan installment (issue #1253, INV-LOAN-006).
 *
 * The occurrence's interest is `debt(d) x rate`, and that debt is an aggregate
 * over `transactions`. Reading it inside the posting transaction is not enough:
 * no ledger writer takes the scheduled-transaction row lock, so under READ
 * COMMITTED a principal payment can commit between the debt `SELECT` and the
 * posting's own write, and the split is then priced from a balance that was
 * already stale when it was written.
 *
 * `lockAccountsForBalanceWrite` is what closes that window, and this suite
 * proves it does -- with two real connections, because blocking is a property
 * of PostgreSQL and a mock cannot demonstrate it
 * (`docs/verification-contract.md`).
 *
 * **What this suite reaches, and what it does not.** The integration harness
 * replaces `ScheduledTransactionsModule` with a stub to break a require cycle,
 * so the real `ScheduledTransactionsService.post()` cannot be constructed here.
 * This suite therefore proves the *protocol*: that holding the pricing lock
 * across the debt read forces a real, production-path ledger write to queue
 * behind it. That the posting path actually takes that lock before it prices is
 * held by `pricing-lock.guard.spec.ts`, which scans the posting source. Neither
 * half is sufficient alone and the pair is stated here so a future reader does
 * not mistake one for both.
 */
@Module({ providers: [ScheduledTransactionLoanService] })
class ScheduledLoanPricingModule {}

describe("Scheduled loan pricing serialization (integration)", () => {
  let module: TestingModule;
  let loanService: ScheduledTransactionLoanService;
  let transactions: TransactionsService;
  let dataSource: DataSource;
  let userId: string;
  let chequingId: string;
  let loanId: string;
  let scheduled: ScheduledTransaction;
  let splits: ScheduledTransactionSplit[];

  beforeAll(async () => {
    module = await createIntegrationModule([
      TransactionsModule,
      ScheduledLoanPricingModule,
    ]);
    loanService = module.get(ScheduledTransactionLoanService);
    transactions = module.get(TransactionsService);
    dataSource = module.get(DataSource);
  });

  afterAll(async () => {
    await module.close();
  });

  /**
   * How many backends are parked on a lock. The race is only set up once the
   * competing writer is genuinely blocked; asserting on a sleep instead would
   * pass on a slow machine while proving nothing.
   */
  async function waitForBlockedBackends(expected: number): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const rows: { c: number }[] = await dataSource.query(
        `SELECT count(*)::int AS c
           FROM pg_stat_activity
          WHERE datname = current_database()
            AND state = 'active'
            AND wait_event_type = 'Lock'`,
      );
      if (rows[0].c >= expected) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(
      `Timed out waiting for ${expected} lock-blocked backend(s); the race was ` +
        "never set up, so the test would prove nothing.",
    );
  }

  beforeEach(async () => {
    await cleanTables(dataSource, [
      "action_history",
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

    const user = await createTestUserDirect(dataSource);
    userId = user.id;

    const chequing = await createTestAccount(dataSource, userId, {
      name: "Chequing",
      openingBalance: 50000,
      currentBalance: 50000,
    });
    chequingId = chequing.id;

    const interestCategory = await createTestCategory(dataSource, userId, {
      name: "Loan Interest",
    });

    // 200,000 at 6% monthly: one period costs exactly 1,000.00.
    const loan = await createTestAccount(dataSource, userId, {
      name: "Mortgage",
      openingBalance: -200000,
      currentBalance: -200000,
    });
    loanId = loan.id;
    await dataSource.manager.update(Account, loanId, {
      accountType: AccountType.LOAN,
      interestRate: 6,
      paymentFrequency: "MONTHLY",
      paymentAmount: 1500,
      interestCategoryId: interestCategory.id,
    });

    scheduled = await dataSource.manager.save(
      dataSource.manager.create(ScheduledTransaction, {
        userId,
        accountId: chequingId,
        name: "Mortgage Payment",
        amount: -1500,
        currencyCode: "USD",
        frequency: "MONTHLY",
        nextDueDate: "2026-08-01",
        startDate: "2026-01-01",
        isActive: true,
        isSplit: true,
      } as Partial<ScheduledTransaction>),
    );

    await dataSource.manager.save(
      dataSource.manager.create(ScheduledTransactionSplit, {
        scheduledTransactionId: scheduled.id,
        kind: "transfer",
        transferAccountId: loanId,
        amount: -500,
        memo: "Principal",
      } as Partial<ScheduledTransactionSplit>),
    );
    await dataSource.manager.save(
      dataSource.manager.create(ScheduledTransactionSplit, {
        scheduledTransactionId: scheduled.id,
        kind: "category",
        categoryId: interestCategory.id,
        amount: -1000,
        memo: "Interest",
      } as Partial<ScheduledTransactionSplit>),
    );
    splits = await dataSource.manager.find(ScheduledTransactionSplit, {
      where: { scheduledTransactionId: scheduled.id },
    });
  });

  it("makes a concurrent principal payment queue behind the pricing lock", async () => {
    let releasePricing!: () => void;
    const pricingCanRelease = new Promise<void>((resolve) => {
      releasePricing = resolve;
    });
    let signalPriced!: (value: number) => void;
    const pricedInterest = new Promise<number>((resolve) => {
      signalPriced = resolve;
    });

    // T1: the posting's critical section -- take the pricing lock, read the
    // dated debt through the production resolver, then hold until released.
    const pricing = withUserContext(userId, () =>
      withScopedDb(dataSource, async (m) => {
        await lockAccountsForBalanceWrite(m, [chequingId, loanId], userId);
        const decision = await loanService.resolvePostingAllocation(
          scheduled,
          splits,
          "2026-08-01",
        );
        if (decision.kind !== "allocation") {
          throw new Error(`expected an allocation, got ${decision.kind}`);
        }
        const interestSplit = splits.find((s) => s.categoryId !== null)!;
        signalPriced(decision.amountsBySplitId.get(interestSplit.id)!);
        await pricingCanRelease;
      }),
    );

    const interest = await pricedInterest;
    // Priced against the 200,000 it read: 200,000 x 0.005.
    expect(interest).toBe(-1000);

    // T2: an independent principal payment, through the real create path. It
    // must not be able to commit inside T1's pricing window.
    let paymentCommitted = false;
    const payment = withUserContext(userId, () =>
      transactions.create(userId, {
        accountId: loanId,
        transactionDate: "2026-07-25",
        amount: 50000,
        currencyCode: "USD",
        description: "Lump sum",
      } as never),
    ).then((created) => {
      paymentCommitted = true;
      return created;
    });

    // The mechanism: T2 parks on the account row lock T1 holds.
    await waitForBlockedBackends(1);
    expect(paymentCommitted).toBe(false);

    releasePricing();
    await Promise.all([pricing, payment]);

    // Serialized, not interleaved: the payment landed strictly after the
    // pricing transaction committed, so the figure T1 wrote was true of the
    // ledger for as long as T1 was entitled to it.
    expect(paymentCommitted).toBe(true);
    const after = await withUserContext(userId, () =>
      loanService.getLoanProjectionAnchor(userId, loanId),
    );
    expect(after.debt).toBe(150000);
  });
});
