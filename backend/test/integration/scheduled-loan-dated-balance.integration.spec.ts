import { TestingModule } from "@nestjs/testing";
import { Module } from "@nestjs/common";
import { DataSource } from "typeorm";
import { ScheduledTransactionLoanService } from "@/scheduled-transactions/scheduled-transaction-loan.service";
import { ScheduledTransaction } from "@/scheduled-transactions/entities/scheduled-transaction.entity";
import { ScheduledTransactionSplit } from "@/scheduled-transactions/entities/scheduled-transaction-split.entity";
import { Account, AccountType } from "@/accounts/entities/account.entity";
import { Transaction } from "@/transactions/entities/transaction.entity";
import { NetWorthService } from "@/net-worth/net-worth.service";
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

/**
 * Issue #1253 -- the PostgreSQL half of INV-LOAN-006.
 *
 * A scheduled loan installment's interest is priced from the ledger debt
 * through the schedule's next due date: opening balance plus every non-void,
 * top-level transaction dated on or before that date. The unit specs prove the
 * arithmetic against a mocked query; this suite proves the query itself against
 * a real database -- the boundary is inclusive, later rows belong to later
 * installments, a VOID row moved no money, and a split child is not a movement
 * (its parent already carries the total). `docs/verification-contract.md`:
 * mocks are supporting evidence only for PostgreSQL properties.
 *
 * The fixture is the issue's own shape: the stored template still carries the
 * split priced at a 200,000 debt (interest 1,000.00), while the ledger has
 * since taken principal-only payments the through-today `current_balance`
 * read model can never include. All three consumers of the dated balance are
 * exercised: the post-posting recalculation, the posting-boundary resolution,
 * and the amortization report's projection anchor.
 */
@Module({
  providers: [
    ScheduledTransactionLoanService,
    // The harness mocks NetWorthService.triggerDebouncedRecalc on whatever
    // module graph it built; nothing here recalculates net worth, so a stub
    // satisfies that lookup without dragging the whole NetWorthModule in.
    {
      provide: NetWorthService,
      useValue: { triggerDebouncedRecalc: () => undefined },
    },
  ],
})
class ScheduledLoanTestModule {}

describe("Scheduled loan dated ledger balance (integration)", () => {
  let module: TestingModule;
  let service: ScheduledTransactionLoanService;
  let dataSource: DataSource;
  let userId: string;
  let chequingId: string;
  let loanId: string;
  let scheduledId: string;
  let principalSplitId: string;
  let interestSplitId: string;

  beforeAll(async () => {
    module = await createIntegrationModule([ScheduledLoanTestModule]);
    service = module.get(ScheduledTransactionLoanService);
    dataSource = module.get(DataSource);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanTables(dataSource, [
      "scheduled_transaction_splits",
      "scheduled_transactions",
      "transactions",
      "accounts",
      "categories",
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

    // 200,000 of debt at 6% nominal, monthly: one period costs 1,000.00 on the
    // opening balance, which is what the stored template still says.
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

    const scheduled = await dataSource.manager.save(
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
    scheduledId = scheduled.id;

    const principalSplit = await dataSource.manager.save(
      dataSource.manager.create(ScheduledTransactionSplit, {
        scheduledTransactionId: scheduledId,
        kind: "transfer",
        transferAccountId: loanId,
        amount: -500,
        memo: "Principal",
      } as Partial<ScheduledTransactionSplit>),
    );
    principalSplitId = principalSplit.id;
    const interestSplit = await dataSource.manager.save(
      dataSource.manager.create(ScheduledTransactionSplit, {
        scheduledTransactionId: scheduledId,
        kind: "category",
        categoryId: interestCategory.id,
        amount: -1000,
        memo: "Interest",
      } as Partial<ScheduledTransactionSplit>),
    );
    interestSplitId = interestSplit.id;

    // The ledger the dated balance must read, exercising every predicate:
    const insertLoanRow = (
      amount: number,
      date: string,
      extra: Partial<Transaction> = {},
    ) =>
      dataSource.manager.save(
        dataSource.manager.create(Transaction, {
          userId,
          accountId: loanId,
          transactionDate: date,
          amount,
          currencyCode: "USD",
          status: "UNRECONCILED",
          ...extra,
        } as Partial<Transaction>),
      );

    // A principal-only payment before the due date: counts.
    await insertLoanRow(1500, "2026-07-20");
    // A payment ON the due date: the boundary is inclusive, so it counts.
    await insertLoanRow(500, "2026-08-01");
    // A payment after the due date belongs to a later installment: excluded.
    await insertLoanRow(1500, "2026-08-15");
    // A VOID row moved no money: excluded.
    await insertLoanRow(999, "2026-07-21", { status: "VOID" } as never);
    // A split child is not a movement -- its parent carries the total. The
    // zero-amount parent contributes nothing; the child must not either.
    const splitParent = await insertLoanRow(0, "2026-07-22", {
      isSplit: true,
    } as never);
    await insertLoanRow(12345, "2026-07-22", {
      parentTransactionId: splitParent.id,
    } as never);

    // Debt through 2026-08-01: 200,000 - 1,500 - 500 = 198,000.
    // Interest at 0.5%/period: 990.00; principal: 1,500 - 990 = 510.00.
  });

  it("recalculates the template from the dated ledger, not the stored balance or prior splits", async () => {
    await withUserContext(userId, () =>
      service.recalculateLoanPaymentSplits(scheduledId),
    );

    const splits = await dataSource.manager.find(ScheduledTransactionSplit, {
      where: { scheduledTransactionId: scheduledId },
    });
    const principal = splits.find((s) => s.id === principalSplitId)!;
    const interest = splits.find((s) => s.id === interestSplitId)!;
    expect(Number(interest.amount)).toBe(-990);
    expect(Number(principal.amount)).toBe(-510);

    // The parent still equals the sum of its children.
    const scheduled = await dataSource.manager.findOne(ScheduledTransaction, {
      where: { id: scheduledId },
    });
    expect(Number(scheduled!.amount)).toBe(-1500);
  });

  it("resolves the posting allocation from the same boundary", async () => {
    const scheduled = await dataSource.manager.findOne(ScheduledTransaction, {
      where: { id: scheduledId },
    });
    const splits = await dataSource.manager.find(ScheduledTransactionSplit, {
      where: { scheduledTransactionId: scheduledId },
    });

    const allocation = await withUserContext(userId, () =>
      service.resolvePostingAllocation(scheduled!, splits, "2026-08-01"),
    );

    expect(allocation.kind).toBe("allocation");
    if (allocation.kind !== "allocation") throw new Error("unreachable");
    expect(allocation.amountsBySplitId.get(interestSplitId)).toBe(-990);
    expect(allocation.amountsBySplitId.get(principalSplitId)).toBe(-510);
    expect(allocation.parentAmount).toBe(-1500);
  });

  it("anchors the amortization projection on the schedule's due date and its debt", async () => {
    const anchor = await withUserContext(userId, () =>
      service.getLoanProjectionAnchor(userId, loanId),
    );

    expect(anchor).toEqual({ nextDueDate: "2026-08-01", debt: 198000 });
  });

  it("anchors on the date an override moved the occurrence to", async () => {
    // The posting prices at the date the money actually moves, which an
    // override can shift off the recurrence slot; an anchor left on the
    // abandoned slot puts the report back into disagreement with the bill.
    // Only a real database can prove which date the statement selects.
    await dataSource.query(
      `INSERT INTO scheduled_transaction_overrides
         (scheduled_transaction_id, original_date, override_date)
       VALUES ($1, $2, $3)`,
      [scheduledId, "2026-08-01", "2026-08-20"],
    );

    const anchor = await withUserContext(userId, () =>
      service.getLoanProjectionAnchor(userId, loanId),
    );

    // 2026-08-15 is dated between the slot and the moved date, so it counts
    // only once the boundary follows the occurrence: 198,000 - 1,500.
    expect(anchor).toEqual({ nextDueDate: "2026-08-20", debt: 196500 });
  });

  it("answers nulls for a loan with no active scheduled payment", async () => {
    await dataSource.manager.update(ScheduledTransaction, scheduledId, {
      isActive: false,
    });

    const anchor = await withUserContext(userId, () =>
      service.getLoanProjectionAnchor(userId, loanId),
    );

    expect(anchor).toEqual({ nextDueDate: null, debt: null });
  });
});
