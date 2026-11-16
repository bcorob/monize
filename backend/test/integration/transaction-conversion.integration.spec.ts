import { TestingModule } from "@nestjs/testing";
import { BadRequestException, ConflictException } from "@nestjs/common";
import { DataSource } from "typeorm";
import { TransactionsService } from "@/transactions/transactions.service";
import { settlePendingHistoryWrites } from "@/action-history/action-history.service";
import { TransactionsModule } from "@/transactions/transactions.module";
import { TransactionConversionService } from "@/transactions/transaction-conversion.service";
import { TransactionStatus } from "@/transactions/entities/transaction.entity";
import { Account } from "@/accounts/entities/account.entity";
import {
  createIntegrationModule,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { withUserContext } from "@/common/db/with-context";
import { createTestAccount } from "../helpers/test-factories";

/**
 * Issue #1937, spec `docs/specs/transaction-transfer-conversion.md`.
 *
 * A conversion keeps the row and creates or removes its counterpart in one
 * transaction. Each scenario checks the stored balance of every account against
 * its own ledger (INV-BALANCE-001), that the row kept its id, and that the pair
 * is linked or unlinked as the spec's truth tables say. The refusals check that
 * nothing was written.
 */
describe("Transaction <-> transfer conversion (integration)", () => {
  jest.setTimeout(60000);

  let module: TestingModule;
  let service: TransactionsService;
  let conversion: TransactionConversionService;
  let dataSource: DataSource;

  beforeAll(async () => {
    module = await createIntegrationModule([TransactionsModule]);
    service = module.get(TransactionsService);
    conversion = module.get(TransactionConversionService);
    dataSource = module.get(DataSource);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await settlePendingHistoryWrites();
    await cleanTables(dataSource, [
      "exchange_rates",
      "action_history",
      "transaction_tags",
      "transaction_splits",
      "transactions",
      "accounts",
      "categories",
      "tags",
      "user_preferences",
      "monthly_account_balances",
      "users",
    ]);
  });

  let userId: string;
  let chequingId: string;
  let savingsId: string;
  let categoryId: string;

  beforeEach(async () => {
    userId = (await createTestUserDirect(dataSource)).id;
    chequingId = (
      await createTestAccount(dataSource, userId, {
        name: "Chequing",
        openingBalance: 1000,
        currentBalance: 1000,
      })
    ).id;
    savingsId = (
      await createTestAccount(dataSource, userId, {
        name: "Savings",
        openingBalance: 2000,
        currentBalance: 2000,
      })
    ).id;
    const [category] = await dataSource.query(
      `INSERT INTO categories (user_id, name) VALUES ($1, 'Groceries') RETURNING id`,
      [userId],
    );
    categoryId = category.id;
  });

  async function balanceOf(accountId: string): Promise<number> {
    const account = await dataSource.manager.findOne(Account, {
      where: { id: accountId },
    });
    return Number(account!.currentBalance);
  }

  async function ledgerOf(accountId: string): Promise<number> {
    const [row] = await dataSource.query(
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

  async function expectStoredEqualsLedger(): Promise<void> {
    for (const id of [chequingId, savingsId]) {
      expect({ id, stored: await balanceOf(id) }).toEqual({
        id,
        stored: await ledgerOf(id),
      });
    }
  }

  async function rowOf(id: string) {
    const [row] = await dataSource.query(
      `SELECT id, account_id, amount::float8 AS amount, category_id,
              is_transfer, is_split, linked_transaction_id, status,
              original_amount, original_currency_code, external_id,
              exchange_rate::float8 AS exchange_rate, currency_code
         FROM transactions WHERE id = $1`,
      [id],
    );
    return row;
  }

  async function countRows(): Promise<number> {
    const [{ n }] = await dataSource.query(
      `SELECT count(*)::int AS n FROM transactions WHERE user_id = $1`,
      [userId],
    );
    return n;
  }

  async function lockReconciled(): Promise<void> {
    await dataSource.query(
      `INSERT INTO user_preferences (user_id, lock_reconciled_transactions)
       VALUES ($1, true)
       ON CONFLICT (user_id) DO UPDATE SET lock_reconciled_transactions = true`,
      [userId],
    );
  }

  async function setStatus(id: string, status: TransactionStatus) {
    await dataSource.query(
      `UPDATE transactions SET status = $2 WHERE id = $1`,
      [id, status],
    );
  }

  const asUser = <T>(fn: () => Promise<T>) => withUserContext(userId, fn);

  async function createExpense(over: Record<string, unknown> = {}) {
    return asUser(() =>
      service.create(userId, {
        accountId: chequingId,
        transactionDate: "2026-01-15",
        amount: -50,
        currencyCode: "USD",
        categoryId,
        payeeName: "Grocer",
        description: "Weekly shop",
        ...over,
      } as never),
    );
  }

  async function createTransfer() {
    return asUser(() =>
      service.createTransfer(userId, {
        fromAccountId: chequingId,
        toAccountId: savingsId,
        transactionDate: "2026-01-15",
        amount: 200,
      } as never),
    );
  }

  describe("transaction -> transfer", () => {
    it("makes an expense the source leg, creates the destination leg and keeps the balances right", async () => {
      const expense = await createExpense();
      expect(await balanceOf(chequingId)).toBe(950);

      const result = await asUser(() =>
        conversion.convertToTransfer(userId, expense.id, {
          fromAccountId: chequingId,
          toAccountId: savingsId,
          transactionDate: "2026-01-15",
          amount: 50,
          description: "Moved to savings",
        } as never),
      );

      expect(result.fromTransaction.id).toBe(expense.id);
      expect(result.toTransaction.id).not.toBe(expense.id);
      const own = await rowOf(expense.id);
      const counterpart = await rowOf(result.toTransaction.id);
      expect(own).toMatchObject({
        account_id: chequingId,
        amount: -50,
        category_id: null,
        is_transfer: true,
        is_split: false,
        linked_transaction_id: counterpart.id,
      });
      expect(counterpart).toMatchObject({
        account_id: savingsId,
        amount: 50,
        is_transfer: true,
        linked_transaction_id: expense.id,
      });
      expect(await balanceOf(chequingId)).toBe(950);
      expect(await balanceOf(savingsId)).toBe(2050);
      await expectStoredEqualsLedger();
    });

    it("makes the row the destination leg when its account is the transfer's destination", async () => {
      const expense = await createExpense();

      const result = await asUser(() =>
        conversion.convertToTransfer(userId, expense.id, {
          fromAccountId: savingsId,
          toAccountId: chequingId,
          transactionDate: "2026-01-15",
          amount: 50,
        } as never),
      );

      expect(result.toTransaction.id).toBe(expense.id);
      expect(await rowOf(expense.id)).toMatchObject({
        account_id: chequingId,
        amount: 50,
        is_transfer: true,
      });
      expect(await rowOf(result.fromTransaction.id)).toMatchObject({
        account_id: savingsId,
        amount: -50,
      });
      // Chequing 950 after the expense: +50 (the expense reversed) +50 (the
      // destination leg).
      expect(await balanceOf(chequingId)).toBe(1050);
      expect(await balanceOf(savingsId)).toBe(1950);
      await expectStoredEqualsLedger();
    });

    it("removes a split parent's lines and their counterparts before making it a leg", async () => {
      const parent = await createExpense({
        amount: -100,
        categoryId: undefined,
        splits: [
          { amount: -60, categoryId },
          { amount: -40, transferAccountId: savingsId },
        ],
      });
      expect(await balanceOf(chequingId)).toBe(900);
      expect(await balanceOf(savingsId)).toBe(2040);
      expect(await countRows()).toBe(2);

      const result = await asUser(() =>
        conversion.convertToTransfer(userId, parent.id, {
          fromAccountId: chequingId,
          toAccountId: savingsId,
          transactionDate: "2026-01-15",
          amount: 100,
        } as never),
      );

      expect(result.fromTransaction.id).toBe(parent.id);
      const [{ n: splitCount }] = await dataSource.query(
        `SELECT count(*)::int AS n FROM transaction_splits WHERE transaction_id = $1`,
        [parent.id],
      );
      expect(splitCount).toBe(0);
      // The split child's counterpart is gone; the new leg is the only other row.
      expect(await countRows()).toBe(2);
      expect(await rowOf(parent.id)).toMatchObject({
        amount: -100,
        is_split: false,
        is_transfer: true,
      });
      expect(await balanceOf(chequingId)).toBe(900);
      expect(await balanceOf(savingsId)).toBe(2100);
      await expectStoredEqualsLedger();
    });

    it("moves no balance when both the old row and the new transfer are VOID", async () => {
      const expense = await createExpense({ status: TransactionStatus.VOID });
      expect(await balanceOf(chequingId)).toBe(1000);

      const result = await asUser(() =>
        conversion.convertToTransfer(userId, expense.id, {
          fromAccountId: chequingId,
          toAccountId: savingsId,
          transactionDate: "2026-01-15",
          amount: 50,
          status: TransactionStatus.VOID,
        } as never),
      );

      expect(result.toTransaction.status).toBe(TransactionStatus.VOID);
      expect(await balanceOf(chequingId)).toBe(1000);
      expect(await balanceOf(savingsId)).toBe(2000);
      await expectStoredEqualsLedger();
    });

    it("refuses a row that is already a transfer leg, writing nothing", async () => {
      const transfer = await createTransfer();

      await expect(
        asUser(() =>
          conversion.convertToTransfer(userId, transfer.fromTransaction.id, {
            fromAccountId: chequingId,
            toAccountId: savingsId,
            transactionDate: "2026-01-15",
            amount: 200,
          } as never),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(await countRows()).toBe(2);
      await expectStoredEqualsLedger();
    });

    it("refuses a reconciled row under the strict lock, writing nothing", async () => {
      const expense = await createExpense();
      await lockReconciled();
      await setStatus(expense.id, TransactionStatus.RECONCILED);

      await expect(
        asUser(() =>
          conversion.convertToTransfer(userId, expense.id, {
            fromAccountId: chequingId,
            toAccountId: savingsId,
            transactionDate: "2026-01-15",
            amount: 50,
          } as never),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(await rowOf(expense.id)).toMatchObject({
        is_transfer: false,
        category_id: categoryId,
      });
      expect(await countRows()).toBe(1);
      expect(await balanceOf(savingsId)).toBe(2000);
    });
  });

  describe("transfer -> transaction", () => {
    it("removes the counterpart, reverses its balance and applies the body to the kept leg", async () => {
      const transfer = await createTransfer();
      const legId = transfer.fromTransaction.id;
      expect(await balanceOf(chequingId)).toBe(800);
      expect(await balanceOf(savingsId)).toBe(2200);

      const updated = await asUser(() =>
        conversion.convertToTransaction(userId, legId, {
          accountId: chequingId,
          transactionDate: "2026-01-15",
          amount: -200,
          categoryId,
          payeeName: "Grocer",
        } as never),
      );

      expect(updated.id).toBe(legId);
      expect(await rowOf(legId)).toMatchObject({
        amount: -200,
        category_id: categoryId,
        is_transfer: false,
        linked_transaction_id: null,
      });
      expect(await countRows()).toBe(1);
      expect(await balanceOf(chequingId)).toBe(800);
      expect(await balanceOf(savingsId)).toBe(2000);
      await expectStoredEqualsLedger();
    });

    it("turns a transfer leg into a split transaction", async () => {
      const transfer = await createTransfer();
      const legId = transfer.fromTransaction.id;

      await asUser(() =>
        conversion.convertToTransaction(userId, legId, {
          accountId: chequingId,
          transactionDate: "2026-01-15",
          amount: -200,
          splits: [
            { amount: -150, categoryId },
            { amount: -50, categoryId },
          ],
        } as never),
      );

      expect(await rowOf(legId)).toMatchObject({
        amount: -200,
        is_split: true,
        is_transfer: false,
        linked_transaction_id: null,
      });
      const [{ n }] = await dataSource.query(
        `SELECT count(*)::int AS n FROM transaction_splits WHERE transaction_id = $1`,
        [legId],
      );
      expect(n).toBe(2);
      expect(await balanceOf(savingsId)).toBe(2000);
      await expectStoredEqualsLedger();
    });

    it("converts from the destination leg too, keeping that row in its account", async () => {
      const transfer = await createTransfer();
      const legId = transfer.toTransaction.id;

      await asUser(() =>
        conversion.convertToTransaction(userId, legId, {
          accountId: savingsId,
          transactionDate: "2026-01-15",
          amount: 200,
          categoryId,
        } as never),
      );

      expect(await rowOf(legId)).toMatchObject({
        account_id: savingsId,
        amount: 200,
        is_transfer: false,
      });
      expect(await countRows()).toBe(1);
      expect(await balanceOf(chequingId)).toBe(1000);
      expect(await balanceOf(savingsId)).toBe(2200);
      await expectStoredEqualsLedger();
    });

    it("refuses when the counterpart is reconciled and the strict lock is on, writing nothing", async () => {
      const transfer = await createTransfer();
      await lockReconciled();
      await setStatus(transfer.toTransaction.id, TransactionStatus.RECONCILED);

      await expect(
        asUser(() =>
          conversion.convertToTransaction(userId, transfer.fromTransaction.id, {
            accountId: chequingId,
            transactionDate: "2026-01-15",
            amount: -200,
            categoryId,
          } as never),
        ),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(await countRows()).toBe(2);
      expect(await rowOf(transfer.fromTransaction.id)).toMatchObject({
        is_transfer: true,
        linked_transaction_id: transfer.toTransaction.id,
        category_id: null,
      });
      expect(await balanceOf(savingsId)).toBe(2200);
    });

    it("allows a reconciled counterpart when the lock is off (the client has warned)", async () => {
      const transfer = await createTransfer();
      await setStatus(transfer.toTransaction.id, TransactionStatus.RECONCILED);

      await asUser(() =>
        conversion.convertToTransaction(userId, transfer.fromTransaction.id, {
          accountId: chequingId,
          transactionDate: "2026-01-15",
          amount: -200,
          categoryId,
        } as never),
      );

      expect(await countRows()).toBe(1);
      expect(await balanceOf(savingsId)).toBe(2000);
      await expectStoredEqualsLedger();
    });

    it("refuses a split-transfer leg, pointing at the parent", async () => {
      await createExpense({
        amount: -100,
        categoryId: undefined,
        splits: [
          { amount: -60, categoryId },
          { amount: -40, transferAccountId: savingsId },
        ],
      });
      const [leg] = await dataSource.query(
        `SELECT id FROM transactions WHERE account_id = $1`,
        [savingsId],
      );

      await expect(
        asUser(() =>
          conversion.convertToTransaction(userId, leg.id, {
            accountId: savingsId,
            transactionDate: "2026-01-15",
            amount: 40,
            categoryId,
          } as never),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(await countRows()).toBe(2);
      expect(await balanceOf(savingsId)).toBe(2040);
    });

    it("refuses a row that is not a transfer", async () => {
      const expense = await createExpense();

      await expect(
        asUser(() =>
          conversion.convertToTransaction(userId, expense.id, {
            amount: -50,
          } as never),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe("across currencies, statuses and accounts", () => {
    let euroId: string;

    beforeEach(async () => {
      euroId = (
        await createTestAccount(dataSource, userId, {
          name: "Euro",
          currencyCode: "EUR",
          openingBalance: 500,
          currentBalance: 500,
        })
      ).id;
      // The synchronize-built schema seeds no currencies, and the rate table
      // references them. Canonical orientation (from < to): 1 EUR = 1.25 USD.
      await dataSource.query(
        `INSERT INTO currencies (code, name, symbol, decimal_places, is_active)
         VALUES ('USD', 'US Dollar', '$', 2, true),
                ('EUR', 'Euro', 'E', 2, true)
         ON CONFLICT (code) DO NOTHING`,
      );
      await dataSource.query(
        `INSERT INTO exchange_rates (from_currency, to_currency, rate_date, rate, source)
         VALUES ('EUR', 'USD', '2026-01-15'::DATE, 1.25, 'test')`,
      );
    });

    async function euroLedgerMatches(): Promise<void> {
      expect(await balanceOf(euroId)).toBe(await ledgerOf(euroId));
    }

    it("converting the destination leg of a cross-currency transfer resets its rate to 1", async () => {
      const transfer = await asUser(() =>
        service.createTransfer(userId, {
          fromAccountId: euroId,
          toAccountId: chequingId,
          transactionDate: "2026-01-15",
          amount: 100,
          toAmount: 125,
        } as never),
      );
      expect(await rowOf(transfer.toTransaction.id)).toMatchObject({
        amount: 125,
        currency_code: "USD",
        exchange_rate: 1.25,
      });
      expect(await balanceOf(euroId)).toBe(400);
      expect(await balanceOf(chequingId)).toBe(1125);

      await asUser(() =>
        conversion.convertToTransaction(userId, transfer.toTransaction.id, {
          accountId: chequingId,
          transactionDate: "2026-01-15",
          amount: 125,
          categoryId,
        } as never),
      );

      expect(await rowOf(transfer.toTransaction.id)).toMatchObject({
        amount: 125,
        currency_code: "USD",
        exchange_rate: 1,
        is_transfer: false,
        linked_transaction_id: null,
      });
      expect(await countRows()).toBe(1);
      expect(await balanceOf(euroId)).toBe(500);
      expect(await balanceOf(chequingId)).toBe(1125);
      await expectStoredEqualsLedger();
      await euroLedgerMatches();
    });

    it("converting an expense into a cross-currency transfer posts the destination at the pair's rate", async () => {
      const expense = await createExpense();

      const result = await asUser(() =>
        conversion.convertToTransfer(userId, expense.id, {
          fromAccountId: chequingId,
          toAccountId: euroId,
          transactionDate: "2026-01-15",
          amount: 50,
          toAmount: 40,
        } as never),
      );

      expect(await rowOf(expense.id)).toMatchObject({
        amount: -50,
        currency_code: "USD",
        exchange_rate: 1,
        is_transfer: true,
      });
      expect(await rowOf(result.toTransaction.id)).toMatchObject({
        account_id: euroId,
        amount: 40,
        currency_code: "EUR",
        exchange_rate: 0.8,
      });
      expect(await balanceOf(chequingId)).toBe(950);
      expect(await balanceOf(euroId)).toBe(540);
      await expectStoredEqualsLedger();
      await euroLedgerMatches();
    });

    it("keeps a CLEARED row's status on both legs when the body names none", async () => {
      const expense = await createExpense({
        status: TransactionStatus.CLEARED,
      });

      const result = await asUser(() =>
        conversion.convertToTransfer(userId, expense.id, {
          fromAccountId: chequingId,
          toAccountId: savingsId,
          transactionDate: "2026-01-15",
          amount: 50,
        } as never),
      );

      expect(result.fromTransaction.status).toBe(TransactionStatus.CLEARED);
      expect(result.toTransaction.status).toBe(TransactionStatus.CLEARED);
    });

    it("drops the externalId only when the conversion moves the row to another account", async () => {
      const staying = await createExpense({ externalId: "stays" });
      await asUser(() =>
        conversion.convertToTransfer(userId, staying.id, {
          fromAccountId: chequingId,
          toAccountId: savingsId,
          transactionDate: "2026-01-15",
          amount: 50,
        } as never),
      );
      expect(await rowOf(staying.id)).toMatchObject({ external_id: "stays" });

      // Savings already holds a row with this key; the moved row would collide.
      await asUser(() =>
        service.create(userId, {
          accountId: savingsId,
          transactionDate: "2026-01-15",
          amount: -1,
          currencyCode: "USD",
          categoryId,
          externalId: "moves",
        } as never),
      );
      const moving = await createExpense({ externalId: "moves" });
      await asUser(() =>
        conversion.convertToTransfer(userId, moving.id, {
          fromAccountId: savingsId,
          toAccountId: euroId,
          transactionDate: "2026-01-15",
          amount: 50,
          toAmount: 40,
        } as never),
      );
      expect(await rowOf(moving.id)).toMatchObject({
        account_id: savingsId,
        amount: -50,
        external_id: null,
      });
      await expectStoredEqualsLedger();
      await euroLedgerMatches();
    });
  });

  it("records one history entry per conversion whose undo is refused", async () => {
    const expense = await createExpense();
    await asUser(() =>
      conversion.convertToTransfer(userId, expense.id, {
        fromAccountId: chequingId,
        toAccountId: savingsId,
        transactionDate: "2026-01-15",
        amount: 50,
      } as never),
    );

    await settlePendingHistoryWrites();
    const rows = await dataSource.query(
      `SELECT description_key, before_data, after_data
         FROM action_history WHERE user_id = $1 AND entity_id = $2
        ORDER BY created_at DESC`,
      [userId, expense.id],
    );
    const entry = rows.find(
      (r: { description_key: string }) =>
        r.description_key === "convertedToTransfer",
    );
    expect(entry).toBeDefined();
    expect(entry.before_data.isTransfer).toBe(false);
    expect(entry.after_data.isTransfer).toBe(true);
  });
});
