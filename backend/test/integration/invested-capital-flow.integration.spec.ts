import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";

import {
  Account,
  AccountSubType,
  AccountType,
} from "@/accounts/entities/account.entity";
import { InvestmentAction } from "@/securities/entities/investment-transaction.entity";
import { TransactionStatus } from "@/transactions/entities/transaction-status.enum";
import {
  foldInvestedFlows,
  loadInvestedCapitalFlowRows,
} from "@/net-worth/invested-capital-flow.util";
import { withUserContext } from "@/common/db/with-context";
import { withScopedDb } from "@/common/db/scoped-db";
import {
  createIntegrationModule,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { createTestAccount } from "../helpers/test-factories";

/**
 * The invested part's capital and income statement, run against a real
 * PostgreSQL.
 *
 * `invested-capital-flow.util.spec.ts` can only assert the TEXT of the
 * statement. Two things only a database can answer: that every placeholder it
 * names is bound and no other -- an unreferenced parameter is a type PostgreSQL
 * cannot infer and it refuses at PARSE, which no mocked-query spec can see --
 * and that the grouping actually subtotals per day, per currency and per
 * action over rows in two currencies.
 */
describe("invested capital flow loader (integration)", () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let userId: string;
  let brokerage: Account;
  let cash: Account;
  let usdSecurityId: string;
  let eurSecurityId: string;

  beforeAll(async () => {
    module = await createIntegrationModule([]);
    dataSource = module.get(DataSource);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanTables(dataSource, [
      "investment_transactions",
      "holdings",
      "securities",
      "transaction_splits",
      "transactions",
      "accounts",
      "users",
    ]);
    await dataSource.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places)
       VALUES ('USD', 'US Dollar', '$', 2), ('EUR', 'Euro', 'E', 2)
       ON CONFLICT DO NOTHING`,
    );

    const user = await createTestUserDirect(dataSource);
    userId = user.id;

    cash = await createTestAccount(dataSource, userId, {
      name: "Brokerage cash",
      currencyCode: "USD",
    });
    await dataSource.manager.update(Account, cash.id, {
      accountType: AccountType.INVESTMENT,
      accountSubType: AccountSubType.INVESTMENT_CASH,
    });
    brokerage = await createTestAccount(dataSource, userId, {
      name: "Brokerage",
      currencyCode: "USD",
    });
    await dataSource.manager.update(Account, brokerage.id, {
      accountType: AccountType.INVESTMENT,
      accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
      linkedAccountId: cash.id,
    });

    usdSecurityId = await insertSecurity("AAPL", "USD");
    eurSecurityId = await insertSecurity("SAP", "EUR");
  });

  async function insertSecurity(
    symbol: string,
    currency: string,
  ): Promise<string> {
    const rows = await dataSource.query(
      `INSERT INTO securities (user_id, symbol, name, security_type, currency_code)
       VALUES ($1, $2, $2, 'STOCK', $3) RETURNING id`,
      [userId, symbol, currency],
    );
    return rows[0].id;
  }

  async function addInvestmentRow(row: {
    securityId: string;
    action: InvestmentAction;
    date: string;
    quantity: number;
    price: number;
    totalAmount: number;
    status?: TransactionStatus;
  }): Promise<void> {
    await dataSource.query(
      `INSERT INTO investment_transactions
         (user_id, account_id, security_id, action, transaction_date,
          quantity, price, commission, total_amount, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, $9)`,
      [
        userId,
        brokerage.id,
        row.securityId,
        row.action,
        row.date,
        row.quantity,
        row.price,
        row.totalAmount,
        row.status ?? TransactionStatus.CLEARED,
      ],
    );
  }

  const load = () =>
    withUserContext(userId, () =>
      loadInvestedCapitalFlowRows(
        (sql, params) =>
          withScopedDb(dataSource, (m) => m.query(sql, params as any[])),
        {
          userId,
          afterDate: "2026-01-01",
          throughDate: "2026-03-31",
          accountIds: [brokerage.id, cash.id],
        },
      ),
    );

  it("parses, and subtotals per day, currency and action", async () => {
    await addInvestmentRow({
      securityId: usdSecurityId,
      action: InvestmentAction.BUY,
      date: "2026-02-02",
      quantity: 80,
      price: 100,
      totalAmount: 8000,
    });
    await addInvestmentRow({
      securityId: usdSecurityId,
      action: InvestmentAction.SELL,
      date: "2026-03-02",
      quantity: 80,
      price: 112.5,
      totalAmount: 9000,
    });
    await addInvestmentRow({
      securityId: usdSecurityId,
      action: InvestmentAction.DIVIDEND,
      date: "2026-03-02",
      quantity: 1,
      price: 100,
      totalAmount: 100,
    });
    // A second currency on the same day as the sale: the statement must keep
    // the two apart so each converts at its own pair.
    await addInvestmentRow({
      securityId: eurSecurityId,
      action: InvestmentAction.BUY,
      date: "2026-03-02",
      quantity: 10,
      price: 50,
      totalAmount: 500,
    });

    const rows = await load();

    expect(
      rows
        .map((row) => ({
          date: row.date,
          currency: row.currency,
          action: row.action,
          total: row.total,
        }))
        .sort((a, b) =>
          `${a.date}${a.currency}${a.action}`.localeCompare(
            `${b.date}${b.currency}${b.action}`,
          ),
        ),
    ).toEqual([
      {
        date: "2026-02-02",
        currency: "USD",
        action: "BUY",
        total: 8000,
      },
      { date: "2026-03-02", currency: "EUR", action: "BUY", total: 500 },
      {
        date: "2026-03-02",
        currency: "USD",
        action: "DIVIDEND",
        total: 100,
      },
      { date: "2026-03-02", currency: "USD", action: "SELL", total: 9000 },
    ]);
  });

  it("reads rows as effects: a VOID row moved no value", async () => {
    await addInvestmentRow({
      securityId: usdSecurityId,
      action: InvestmentAction.BUY,
      date: "2026-02-02",
      quantity: 80,
      price: 100,
      totalAmount: 8000,
      status: TransactionStatus.VOID,
    });

    await expect(load()).resolves.toEqual([]);
  });

  it("excludes a row dated on the lower bound and one after the upper", async () => {
    // The lower bound is exclusive: IV(b) is a close and already holds it.
    await addInvestmentRow({
      securityId: usdSecurityId,
      action: InvestmentAction.BUY,
      date: "2026-01-01",
      quantity: 10,
      price: 100,
      totalAmount: 1000,
    });
    await addInvestmentRow({
      securityId: usdSecurityId,
      action: InvestmentAction.BUY,
      date: "2026-04-01",
      quantity: 10,
      price: 100,
      totalAmount: 1000,
    });

    await expect(load()).resolves.toEqual([]);
  });

  it("folds the loaded rows into one currency, each day at its own rate", async () => {
    await addInvestmentRow({
      securityId: usdSecurityId,
      action: InvestmentAction.BUY,
      date: "2026-02-02",
      quantity: 80,
      price: 100,
      totalAmount: 8000,
    });
    await addInvestmentRow({
      securityId: eurSecurityId,
      action: InvestmentAction.DIVIDEND,
      date: "2026-02-02",
      quantity: 1,
      price: 100,
      totalAmount: 100,
    });

    const { byDay } = foldInvestedFlows(
      await load(),
      "USD",
      new Map([["EUR->USD", [{ date: "2026-02-02", rate: 1.1 }]]]),
      { warn: () => undefined },
      // Neither row is a share-moving leg, so no close is ever asked for.
      () => null,
    );

    expect(byDay.get("2026-02-02")).toEqual({
      capitalIn: 8000,
      capitalOut: 0,
      income: 110,
      reinvestedIncome: 0,
      complete: true,
      missingPairs: [],
      unpricedSecurityIds: [],
    });
  });

  it("keeps each reinvestment its own row, valued at its own price", async () => {
    // Two reinvestments of one security on one day, as the app writes them:
    // quantity and price, no total. Grouped together, MAX(price) would value
    // both at the dearer price; the statement keeps them apart.
    await addInvestmentRow({
      securityId: usdSecurityId,
      action: InvestmentAction.REINVEST,
      date: "2026-02-02",
      quantity: 2,
      price: 50,
      totalAmount: 0,
    });
    await addInvestmentRow({
      securityId: usdSecurityId,
      action: InvestmentAction.REINVEST,
      date: "2026-02-02",
      quantity: 1,
      price: 40,
      totalAmount: 0,
    });
    await addInvestmentRow({
      securityId: usdSecurityId,
      action: InvestmentAction.REINVEST_INTEREST,
      date: "2026-02-02",
      quantity: 1,
      price: 10,
      totalAmount: 0,
    });

    const rows = await load();
    expect(rows).toHaveLength(3);

    const { byDay } = foldInvestedFlows(
      rows,
      "USD",
      new Map(),
      { warn: () => undefined },
      // A reinvestment is valued from its own price, never from a close.
      () => null,
    );

    expect(byDay.get("2026-02-02")).toEqual({
      capitalIn: 0,
      capitalOut: 0,
      income: 0,
      reinvestedIncome: 150,
      complete: true,
      missingPairs: [],
      unpricedSecurityIds: [],
    });
  });

  it("values a transfer leg at the day's close, whatever basis it carries", async () => {
    // The row is recorded at a historical cost of 10 a share; the day's close
    // is 100. `IV` moves by 30 x 100, so the capital flow must too, or the
    // difference reads as a gain nobody made.
    await addInvestmentRow({
      securityId: usdSecurityId,
      action: InvestmentAction.TRANSFER_IN,
      date: "2026-02-02",
      quantity: 30,
      price: 10,
      totalAmount: 0,
    });

    const { byDay } = foldInvestedFlows(
      await load(),
      "USD",
      new Map(),
      { warn: () => undefined },
      () => 100,
    );

    expect(byDay.get("2026-02-02")?.capitalIn).toBe(3000);
  });

  it("withholds the day and names the security when nothing priced the leg", async () => {
    await addInvestmentRow({
      securityId: usdSecurityId,
      action: InvestmentAction.TRANSFER_IN,
      date: "2026-02-02",
      quantity: 30,
      price: 0,
      totalAmount: 0,
    });

    const { byDay } = foldInvestedFlows(
      await load(),
      "USD",
      new Map(),
      { warn: () => undefined },
      () => null,
    );

    expect(byDay.get("2026-02-02")).toMatchObject({
      capitalIn: 0,
      complete: false,
      unpricedSecurityIds: [usdSecurityId],
    });
  });
});
