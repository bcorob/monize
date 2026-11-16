import { TestingModule } from "@nestjs/testing";
import { Module } from "@nestjs/common";
import { DataSource } from "typeorm";
import { Account, AccountType } from "@/accounts/entities/account.entity";
import { Transaction } from "@/transactions/entities/transaction.entity";
import { datedLoanDebt, datedLoanDebts } from "@/accounts/dated-loan-debt.util";
import { withScopedDb } from "@/common/db/scoped-db";
import { withUserContext } from "@/common/db/with-context";
import {
  createIntegrationModule,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { createTestAccount } from "../helpers/test-factories";

/**
 * The PostgreSQL half of `datedLoanDebts` (`docs/specs/loan-installment-settlement.md`
 * section 7.1, test matrix row B3): the batched statement equals
 * `datedLoanDebt` date by date on a real ledger. Both are composed from the
 * one as-of balance join, and only a real database can show that the
 * composition over `unnest` bounds each date the same way the single-date
 * query does: the boundary inclusive, later rows excluded, a VOID row moved no
 * money, a split child is not a movement.
 *
 * The ledger is the one `scheduled-loan-dated-balance.integration.spec.ts`
 * reads, so a disagreement between the two helpers would also be a
 * disagreement with the scheduled bill (INV-LOAN-006).
 */
@Module({})
class LoanSettlementDebtTestModule {}

describe("datedLoanDebts against the ledger (integration)", () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let userId: string;
  let loan: { id: string; userId: string };

  beforeAll(async () => {
    module = await createIntegrationModule([LoanSettlementDebtTestModule]);
    dataSource = module.get(DataSource);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanTables(dataSource, ["transactions", "accounts", "users"]);
    await dataSource.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places)
       VALUES ('USD', 'US Dollar', '$', 2)
       ON CONFLICT DO NOTHING`,
    );
    userId = (await createTestUserDirect(dataSource)).id;

    const account = await createTestAccount(dataSource, userId, {
      name: "Mortgage",
      openingBalance: -200000,
      currentBalance: -200000,
    });
    await dataSource.manager.update(Account, account.id, {
      accountType: AccountType.LOAN,
    });
    loan = { id: account.id, userId };

    const insertLoanRow = (
      amount: number,
      date: string,
      extra: Partial<Transaction> = {},
    ) =>
      dataSource.manager.save(
        dataSource.manager.create(Transaction, {
          userId,
          accountId: loan.id,
          transactionDate: date,
          amount,
          currencyCode: "USD",
          status: "UNRECONCILED",
          ...extra,
        } as Partial<Transaction>),
      );

    // A principal payment before the first date asked for: counts everywhere.
    await insertLoanRow(1500, "2026-07-20");
    // A VOID row moved no money: excluded on every date.
    await insertLoanRow(999, "2026-07-21", { status: "VOID" } as never);
    // A split child is not a movement; its zero parent contributes nothing.
    const parent = await insertLoanRow(0, "2026-07-22", {
      isSplit: true,
    } as never);
    await insertLoanRow(12345, "2026-07-22", {
      parentTransactionId: parent.id,
    } as never);
    // A payment on a date asked for: the boundary is inclusive.
    await insertLoanRow(500, "2026-08-01");
    // A later payment belongs to the later dates only.
    await insertLoanRow(1500, "2026-08-15");
  });

  const dates = [
    "2026-07-19",
    "2026-07-20",
    "2026-07-22",
    "2026-08-01",
    "2026-08-14",
    "2026-08-15",
    "2026-09-01",
  ];

  const inScope = <T>(
    fn: (m: Parameters<typeof datedLoanDebt>[0]) => Promise<T>,
  ) => withUserContext(userId, () => withScopedDb(dataSource, fn));

  it("equals datedLoanDebt on every date, with every predicate exercised", async () => {
    const batched = await inScope((m) => datedLoanDebts(m, loan, dates));
    expect(batched).not.toBeNull();

    for (const date of dates) {
      const single = await inScope((m) => datedLoanDebt(m, loan, date));
      expect(batched!.get(date)).toBe(single);
    }

    expect(Object.fromEntries(batched!)).toEqual({
      "2026-07-19": 200000, // nothing yet
      "2026-07-20": 198500, // the first payment, inclusive
      "2026-07-22": 198500, // VOID and the split child excluded
      "2026-08-01": 198000, // the payment on the date, inclusive
      "2026-08-14": 198000,
      "2026-08-15": 196500, // the later payment
      "2026-09-01": 196500,
    });
  });

  it("asks once for a repeated date and answers it once", async () => {
    const batched = await inScope((m) =>
      datedLoanDebts(m, loan, ["2026-08-01", "2026-08-01"]),
    );
    expect(batched).toEqual(new Map([["2026-08-01", 198000]]));
  });

  it("answers null for an account that is not the owner's, as datedLoanDebt does", async () => {
    const other = {
      id: loan.id,
      userId: (await createTestUserDirect(dataSource)).id,
    };
    expect(
      await withUserContext(other.userId, () =>
        withScopedDb(dataSource, (m) => datedLoanDebts(m, other, dates)),
      ),
    ).toBeNull();
    expect(
      await withUserContext(other.userId, () =>
        withScopedDb(dataSource, (m) => datedLoanDebt(m, other, dates[0])),
      ),
    ).toBeNull();
  });

  it("reads an empty ledger as the opening balance, not as unknown", async () => {
    await dataSource.query(`DELETE FROM transactions WHERE account_id = $1`, [
      loan.id,
    ]);
    const batched = await inScope((m) =>
      datedLoanDebts(m, loan, ["2026-08-01"]),
    );
    expect(batched).toEqual(new Map([["2026-08-01", 200000]]));
  });
});
