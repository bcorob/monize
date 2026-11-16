import { BadRequestException } from "@nestjs/common";
import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { AccountsModule } from "@/accounts/accounts.module";
import { AccountsService } from "@/accounts/accounts.service";
import { Account, AccountType } from "@/accounts/entities/account.entity";
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
 * INV-LOAN-010 against a real PostgreSQL: changing a loan's interest category
 * through `AccountsService.update` moves its payment template's interest line
 * in the same transaction, so a template the pricing manages stays managed;
 * an ambiguous template (an uncategorised escrow line beside the interest)
 * is left exactly as it was, and a category of another user is refused with
 * nothing written.
 *
 * The schedule is written by fixture rather than by the loan create (this
 * suite's module list does not reach the loan-create path); the update reads
 * and writes it with its own manager.
 */
describe("Loan interest category relink (integration)", () => {
  jest.setTimeout(120000);

  let module: TestingModule;
  let db: DataSource;
  let accounts: AccountsService;

  let userId: string;
  let loanId: string;
  let scheduleId: string;
  let categoryA: string;
  let categoryB: string;

  const asUser = <T>(fn: () => Promise<T>) => withUserContext(userId, fn);

  const lines = () =>
    db.manager.find(ScheduledTransactionSplit, {
      where: { scheduledTransactionId: scheduleId },
    });
  const loan = () => db.manager.findOneByOrFail(Account, { id: loanId });

  const addLine = (data: Partial<ScheduledTransactionSplit>) =>
    db.manager.save(
      db.manager.create(ScheduledTransactionSplit, {
        scheduledTransactionId: scheduleId,
        ...data,
      } as Partial<ScheduledTransactionSplit>),
    );

  beforeAll(async () => {
    module = await createIntegrationModule([AccountsModule]);
    db = module.get(DataSource);
    accounts = module.get(AccountsService);
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
    const chequingId = (
      await createTestAccount(db, userId, {
        name: "Chequing",
        openingBalance: 50000,
        currentBalance: 50000,
      })
    ).id;
    categoryA = (await createTestCategory(db, userId, { name: "Hypotheek" }))
      .id;
    categoryB = (
      await createTestCategory(db, userId, { name: "Hypotheek rente" })
    ).id;
    loanId = (
      await createTestAccount(db, userId, {
        name: "Mortgage",
        accountType: AccountType.MORTGAGE,
        openingBalance: -200000,
        currentBalance: -200000,
      })
    ).id;
    scheduleId = (
      await db.manager.save(
        db.manager.create(ScheduledTransaction, {
          userId,
          accountId: chequingId,
          name: "Mortgage Payment",
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
    await addLine({
      kind: "transfer",
      transferAccountId: loanId,
      amount: -500,
      memo: "Principal",
    } as Partial<ScheduledTransactionSplit>);
    await db.manager.update(Account, loanId, {
      interestRate: 6,
      paymentFrequency: "MONTHLY",
      paymentAmount: 1500,
      scheduledTransactionId: scheduleId,
    });
  });

  it("gives an uncategorised interest line the category set on the loan, leaving the template managed", async () => {
    await addLine({
      kind: "category",
      categoryId: null,
      amount: -1000,
      memo: "Interest",
    } as Partial<ScheduledTransactionSplit>);

    await asUser(() =>
      accounts.update(userId, loanId, { interestCategoryId: categoryB }),
    );

    const account = await loan();
    const rows = await lines();
    expect(account.interestCategoryId).toBe(categoryB);
    const interest = rows.find((r) => r.memo === "Interest");
    expect(interest?.categoryId).toBe(categoryB);
    expect(Number(interest?.amount)).toBe(-1000);
    expect(identifyLoanTemplate(rows, account).managed).toBe(true);
  });

  it("moves a managed template's interest line from A to B", async () => {
    await addLine({
      kind: "category",
      categoryId: categoryA,
      amount: -1000,
      memo: "Interest",
    } as Partial<ScheduledTransactionSplit>);
    await db.manager.update(Account, loanId, { interestCategoryId: categoryA });

    await asUser(() =>
      accounts.update(userId, loanId, { interestCategoryId: categoryB }),
    );

    const account = await loan();
    const rows = await lines();
    expect(rows.find((r) => r.memo === "Interest")?.categoryId).toBe(categoryB);
    expect(identifyLoanTemplate(rows, account).managed).toBe(true);
  });

  it("never marks an uncategorised escrow line as interest", async () => {
    await addLine({
      kind: "category",
      categoryId: categoryA,
      amount: -1000,
      memo: "Interest",
    } as Partial<ScheduledTransactionSplit>);
    await addLine({
      kind: "category",
      categoryId: null,
      amount: -250,
      memo: "Escrow",
    } as Partial<ScheduledTransactionSplit>);
    await db.manager.update(Account, loanId, { interestCategoryId: categoryA });

    await asUser(() =>
      accounts.update(userId, loanId, { interestCategoryId: categoryB }),
    );

    const rows = await lines();
    expect((await loan()).interestCategoryId).toBe(categoryB);
    expect(rows.find((r) => r.memo === "Interest")?.categoryId).toBe(categoryA);
    expect(rows.find((r) => r.memo === "Escrow")?.categoryId).toBeNull();
  });

  it("refuses another user's category and writes nothing", async () => {
    await addLine({
      kind: "category",
      categoryId: categoryA,
      amount: -1000,
      memo: "Interest",
    } as Partial<ScheduledTransactionSplit>);
    await db.manager.update(Account, loanId, { interestCategoryId: categoryA });
    const otherId = (await createTestUserDirect(db)).id;
    const foreign = (
      await createTestCategory(db, otherId, { name: "Not mine" })
    ).id;

    await expect(
      asUser(() =>
        accounts.update(userId, loanId, { interestCategoryId: foreign }),
      ),
    ).rejects.toThrow(BadRequestException);

    expect((await loan()).interestCategoryId).toBe(categoryA);
    expect((await lines()).find((r) => r.memo === "Interest")?.categoryId).toBe(
      categoryA,
    );
  });
});
