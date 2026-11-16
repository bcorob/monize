import { TestingModule } from "@nestjs/testing";
import { DataSource, QueryFailedError } from "typeorm";
import { TransactionsModule } from "@/transactions/transactions.module";
import { TransactionsService } from "@/transactions/transactions.service";
import { TransactionBulkCreateService } from "@/transactions/transaction-bulk-create.service";
import { Account } from "@/accounts/entities/account.entity";
import { Transaction } from "@/transactions/entities/transaction.entity";
import { isExternalIdConflict } from "@/transactions/transaction-external-id";
import { withUserContext } from "@/common/db/with-context";
import {
  createIntegrationModule,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { createTestAccount } from "../helpers/test-factories";

/**
 * A create carrying an `externalId` is idempotent per account (issue #1713).
 *
 * What holds that is the partial unique index on
 * `transactions(account_id, external_id)`; the service's lookup before its
 * insert is advisory. The properties below are therefore PostgreSQL's: that a
 * second row with the key is refused, that the refusal names the index (the
 * service matches it by name), and that two creates racing past the lookup end
 * as one row and one balance movement. A mocked repository can be made to
 * answer any of these, which is why they are asserted here.
 */
describe("Transaction externalId (integration)", () => {
  jest.setTimeout(60000);

  let module: TestingModule;
  let service: TransactionsService;
  let bulk: TransactionBulkCreateService;
  let dataSource: DataSource;
  let userId: string;
  let chequingId: string;
  let savingsId: string;

  const asUser = <T>(fn: () => Promise<T>) => withUserContext(userId, fn);

  const balanceOf = async (accountId: string) =>
    Number(
      (await dataSource.manager.findOneByOrFail(Account, { id: accountId }))
        .currentBalance,
    );

  const rowsWithKey = (externalId: string) =>
    dataSource.manager.find(Transaction, { where: { externalId } });

  const expense = (externalId: string, accountId = chequingId) => ({
    accountId,
    transactionDate: "2026-01-15",
    amount: -50,
    currencyCode: "USD",
    externalId,
  });

  beforeAll(async () => {
    module = await createIntegrationModule([TransactionsModule]);
    service = module.get(TransactionsService);
    bulk = module.get(TransactionBulkCreateService);
    dataSource = module.get(DataSource);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanTables(dataSource, [
      "action_history",
      "transaction_tags",
      "transaction_splits",
      "transactions",
      "accounts",
      "categories",
      "payees",
      "users",
    ]);
    await dataSource.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places) VALUES ('USD', 'US Dollar', '$', 2) ON CONFLICT DO NOTHING`,
    );
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
        openingBalance: 0,
        currentBalance: 0,
      })
    ).id;
  });

  it("refuses a second row with the key in the account, naming the index the service matches", async () => {
    await asUser(() => service.create(userId, expense("bank-1")));

    const duplicate = dataSource.manager.save(
      dataSource.manager.create(Transaction, {
        userId,
        accountId: chequingId,
        transactionDate: "2026-01-16",
        amount: -1,
        currencyCode: "USD",
        externalId: "bank-1",
      }),
    );

    const error = await duplicate.then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(QueryFailedError);
    expect(isExternalIdConflict(error)).toBe(true);
  });

  it("answers a repeated create with the row it already made, moving the balance once", async () => {
    const first = await asUser(() =>
      service.createWithOutcome(userId, expense("bank-1")),
    );
    const second = await asUser(() =>
      service.createWithOutcome(userId, {
        ...expense("bank-1"),
        // A retry is answered by the key, not by the body.
        amount: -999,
      }),
    );

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.transaction.id).toBe(first.transaction.id);
    expect(Number(second.transaction.amount)).toBe(-50);
    expect(await rowsWithKey("bank-1")).toHaveLength(1);
    expect(await balanceOf(chequingId)).toBe(950);
  });

  it("ends two concurrent creates with one key as one row and one balance movement", async () => {
    const outcomes = await Promise.all([
      asUser(() => service.createWithOutcome(userId, expense("bank-race"))),
      asUser(() => service.createWithOutcome(userId, expense("bank-race"))),
    ]);

    expect(outcomes.map((o) => o.created).sort()).toEqual([false, true]);
    expect(outcomes[0].transaction.id).toBe(outcomes[1].transaction.id);
    expect(await rowsWithKey("bank-race")).toHaveLength(1);
    expect(await balanceOf(chequingId)).toBe(950);
  });

  it("keeps the key unique per account, not per user", async () => {
    await asUser(() => service.create(userId, expense("bank-1", chequingId)));
    await asUser(() => service.create(userId, expense("bank-1", savingsId)));

    expect(await rowsWithKey("bank-1")).toHaveLength(2);
  });

  it("answers a repeated transfer with the pair it already made, stored on the source leg", async () => {
    const transfer = {
      fromAccountId: chequingId,
      toAccountId: savingsId,
      transactionDate: "2026-01-15",
      amount: 200,
      externalId: "bank-xfer",
    };

    const first = await asUser(() =>
      service.createTransferWithOutcome(userId, transfer),
    );
    const second = await asUser(() =>
      service.createTransferWithOutcome(userId, transfer),
    );

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.transfer.fromTransaction.id).toBe(
      first.transfer.fromTransaction.id,
    );
    expect(second.transfer.toTransaction.id).toBe(
      first.transfer.toTransaction.id,
    );
    const keyed = await rowsWithKey("bank-xfer");
    expect(keyed.map((t) => t.accountId)).toEqual([chequingId]);
    expect(await balanceOf(chequingId)).toBe(800);
    expect(await balanceOf(savingsId)).toBe(200);
  });

  it("lets a bulk batch whose response was lost be sent again without duplicating anything", async () => {
    const batch = {
      items: [
        { transaction: expense("row-1") },
        {
          transfer: {
            fromAccountId: chequingId,
            toAccountId: savingsId,
            transactionDate: "2026-01-16",
            amount: 100,
            externalId: "row-2",
          },
        },
        // Refused: a transfer into the account it comes from.
        {
          transfer: {
            fromAccountId: chequingId,
            toAccountId: chequingId,
            transactionDate: "2026-01-17",
            amount: 1,
            externalId: "row-3",
          },
        },
      ],
    };
    const actor = { effectiveUserId: userId, realUserId: userId };

    const first = await asUser(() => bulk.createMany(actor, batch));
    const again = await asUser(() => bulk.createMany(actor, batch));

    expect(first).toMatchObject({ created: 2, existing: 0, failed: 1 });
    expect(first.results[2]).toMatchObject({
      index: 2,
      status: "failed",
      error: { statusCode: 400 },
    });
    expect(again).toMatchObject({ created: 0, existing: 2, failed: 1 });
    expect(again.results[0].id).toBe(first.results[0].id);
    expect(again.results[1].id).toBe(first.results[1].id);
    expect(await balanceOf(chequingId)).toBe(850);
    expect(await balanceOf(savingsId)).toBe(100);
  });
});
