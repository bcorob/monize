import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { TransactionsModule } from "@/transactions/transactions.module";
import {
  Transaction,
  TransactionStatus,
} from "@/transactions/entities/transaction.entity";
import { TransactionSplit } from "@/transactions/entities/transaction-split.entity";
import { BudgetCategory } from "@/budgets/entities/budget-category.entity";
import { queryCategorySpending } from "@/budgets/budget-spending.util";
import { withScopedDb } from "@/common/db/scoped-db";
import { withUserContext } from "@/common/db/with-context";
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
 * The split-transfer half of `queryCategorySpending` against a real
 * PostgreSQL database. The unit suite mocks the QueryBuilder, so only this
 * test exercises the actual SQL (review #1131): the two-shape union (a
 * whole-row transfer joined through its linked counterpart, plus a split line
 * carrying transfer_account_id directly), the no-double-count claim -- a
 * counterpart row is not itself a split, and the incoming counterpart leg
 * fails the outflow predicate -- and the void/direction exclusions.
 */
describe("queryCategorySpending split transfers (integration)", () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let userId: string;
  let chequingId: string;
  let savingsId: string;
  let groceriesId: string;

  beforeAll(async () => {
    module = await createIntegrationModule([TransactionsModule]);
    dataSource = module.get(DataSource);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanTables(dataSource, [
      "transaction_splits",
      "transactions",
      "accounts",
      "categories",
      "payees",
      "users",
    ]);
    const user = await createTestUserDirect(dataSource);
    userId = user.id;
    chequingId = (
      await createTestAccount(dataSource, userId, { name: "Chequing" })
    ).id;
    savingsId = (
      await createTestAccount(dataSource, userId, { name: "Savings" })
    ).id;
    groceriesId = (
      await createTestCategory(dataSource, userId, { name: "Groceries" })
    ).id;
  });

  async function insertTransaction(
    overrides: Partial<Transaction>,
  ): Promise<Transaction> {
    const tx = dataSource.manager.create(Transaction, {
      userId,
      accountId: chequingId,
      transactionDate: "2026-07-10",
      amount: -100,
      currencyCode: "CAD",
      status: TransactionStatus.UNRECONCILED,
      isSplit: false,
      isTransfer: false,
      ...overrides,
    } as Partial<Transaction>);
    return dataSource.manager.save(tx);
  }

  /** A whole-row transfer: outgoing leg linked to its incoming counterpart. */
  async function insertWholeRowTransfer(
    amount: number,
    overrides: Partial<Transaction> = {},
  ): Promise<void> {
    const inbound = await insertTransaction({
      accountId: savingsId,
      amount: -amount,
      isTransfer: true,
      ...overrides,
    });
    const outbound = await insertTransaction({
      amount,
      isTransfer: true,
      linkedTransactionId: inbound.id,
      ...overrides,
    });
    inbound.linkedTransactionId = outbound.id;
    await dataSource.manager.save(inbound);
  }

  /**
   * A split parent carrying a category line and a transfer line, with the
   * transfer line's incoming counterpart row -- the shape a paycheque with a
   * savings component takes (audit P5-007).
   */
  async function insertSplitWithTransferLine(
    categoryAmount: number,
    transferAmount: number,
    overrides: Partial<Transaction> = {},
  ): Promise<void> {
    const parent = await insertTransaction({
      amount: categoryAmount + transferAmount,
      isSplit: true,
      ...overrides,
    });
    const counterpart = await insertTransaction({
      accountId: savingsId,
      amount: -transferAmount,
      isTransfer: true,
      ...overrides,
    });
    const categorySplit = dataSource.manager.create(TransactionSplit, {
      transactionId: parent.id,
      categoryId: groceriesId,
      amount: categoryAmount,
    } as Partial<TransactionSplit>);
    const transferSplit = dataSource.manager.create(TransactionSplit, {
      transactionId: parent.id,
      transferAccountId: savingsId,
      linkedTransactionId: counterpart.id,
      amount: transferAmount,
    } as Partial<TransactionSplit>);
    await dataSource.manager.save([categorySplit, transferSplit]);
  }

  function runQuery(budgetCategories: Partial<BudgetCategory>[]) {
    return withUserContext(userId, () =>
      withScopedDb(dataSource, (m) =>
        queryCategorySpending(
          m.getRepository(Transaction),
          m.getRepository(TransactionSplit),
          userId,
          budgetCategories as BudgetCategory[],
          "2026-07-01",
          "2026-07-31",
        ),
      ),
    );
  }

  const savingsBudgetCategory: Partial<BudgetCategory> = {
    id: "bc-transfer",
    categoryId: null,
    isTransfer: true,
    transferAccountId: null as unknown as string,
  };

  it("counts whole-row transfers and split-line transfers together, without double-counting", async () => {
    await insertWholeRowTransfer(-200);
    await insertSplitWithTransferLine(-700, -300);

    const { spendingMap, transferSpendingMap } = await runQuery([
      { id: "bc-cat", categoryId: groceriesId, isTransfer: false },
      { ...savingsBudgetCategory, transferAccountId: savingsId },
    ]);

    // 200 whole-row + 300 split-line. The split's counterpart row (+300 into
    // savings) and the whole-row transfer's inbound leg are both incoming, so
    // neither is counted a second time.
    expect(transferSpendingMap.get(savingsId)).toBe(500);
    // The category line of the split still lands on its category, untouched by
    // the transfer read.
    expect(spendingMap.get(groceriesId)).toBe(-700);
  });

  it("ignores transfers INTO the budgeted account and VOID rows", async () => {
    // A withdrawal from savings back to chequing: budget progress for a
    // savings budget must not move.
    const inbound = await insertTransaction({
      amount: 150,
      isTransfer: true,
    });
    const outbound = await insertTransaction({
      accountId: savingsId,
      amount: -150,
      isTransfer: true,
      linkedTransactionId: inbound.id,
    });
    inbound.linkedTransactionId = outbound.id;
    await dataSource.manager.save(inbound);

    // A voided contribution does not count either, in both shapes.
    await insertWholeRowTransfer(-75, {
      status: TransactionStatus.VOID,
    });
    await insertSplitWithTransferLine(-10, -80, {
      status: TransactionStatus.VOID,
    });

    const { transferSpendingMap } = await runQuery([
      { ...savingsBudgetCategory, transferAccountId: savingsId },
    ]);

    expect(transferSpendingMap.get(savingsId)).toBeUndefined();
  });

  it("scopes the split-line read to the requested destination accounts", async () => {
    const otherAccountId = (
      await createTestAccount(dataSource, userId, { name: "Vacation Fund" })
    ).id;
    await insertSplitWithTransferLine(-50, -60);

    const { transferSpendingMap } = await runQuery([
      { ...savingsBudgetCategory, transferAccountId: otherAccountId },
    ]);

    expect(transferSpendingMap.get(savingsId)).toBeUndefined();
    expect(transferSpendingMap.get(otherAccountId)).toBeUndefined();
  });
});
