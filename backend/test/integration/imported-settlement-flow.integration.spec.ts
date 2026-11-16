import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { AccountType } from "@/accounts/entities/account.entity";
import { withScopedDb } from "@/common/db/scoped-db";
import { withUserContext } from "@/common/db/with-context";
import { addDaysYMD, todayYMD } from "@/common/date-utils";
import { loadExternalFlowSubtotals } from "@/securities/external-flow.util";
import { loadUnmeasuredFlowRows } from "@/net-worth/unmeasured-flows.util";
import {
  cleanTables,
  createIntegrationModule,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { createTestAccount } from "../helpers/test-factories";

/**
 * A trade in the shape the QIF/CSV import writes, against a real PostgreSQL.
 *
 * The import settles an investment action as a TRANSFER: the action's cash leg
 * (`investment_transactions.transaction_id`) is a row on the brokerage, and its
 * linked counterpart is the sleeve's cash. The period routes draw their flow
 * around the sleeves alone, so before `investmentScope` the sleeve leg read as
 * a transfer across the boundary -- every imported BUY a withdrawal, every
 * dividend a deposit -- and the brokerage leg made the settled-trade count fire
 * on every trade, withholding the account result for every window (#1516).
 *
 * The two statements are asserted together because they are one decision: a
 * trade the count calls settled inside must also be one whose sleeve leg the
 * flow leaves out, or the result is reported over a wrong flow.
 */
describe("imported trade settlement (integration)", () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let userId: string;
  let brokerageId: string;
  let cashId: string;
  let otherBrokerageId: string;
  let chequingId: string;

  const day = addDaysYMD(todayYMD(), -3);
  const window = {
    afterDate: addDaysYMD(todayYMD(), -30),
    throughDate: todayYMD(),
  };

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
      "transaction_splits",
      "transactions",
      "accounts",
      "users",
    ]);
    userId = (await createTestUserDirect(dataSource)).id;
    const make = async (name: string, accountType: AccountType) =>
      (await createTestAccount(dataSource, userId, { name, accountType })).id;
    brokerageId = await make("Brokerage", AccountType.INVESTMENT);
    cashId = await make("Brokerage cash", AccountType.INVESTMENT);
    otherBrokerageId = await make("Other brokerage", AccountType.INVESTMENT);
    chequingId = await make("Chequing", AccountType.CHEQUING);
  });

  /** A linked transfer pair; returns the id of the leg on `from`. */
  const transfer = async (
    from: string,
    to: string,
    amount: number,
  ): Promise<string> => {
    const insert = async (accountId: string, value: number) => {
      const [row] = await dataSource.query(
        `INSERT INTO transactions
           (user_id, account_id, transaction_date, amount, currency_code,
            exchange_rate, is_transfer, status)
         VALUES ($1, $2, $3, $4, 'CAD', 1, true, 'UNRECONCILED')
         RETURNING id`,
        [userId, accountId, day, value],
      );
      return row.id as string;
    };
    const fromId = await insert(from, -amount);
    const toId = await insert(to, amount);
    await dataSource.query(
      `UPDATE transactions SET linked_transaction_id = $2 WHERE id = $1`,
      [fromId, toId],
    );
    await dataSource.query(
      `UPDATE transactions SET linked_transaction_id = $2 WHERE id = $1`,
      [toId, fromId],
    );
    return fromId;
  };

  /** An investment action whose cash leg is `cashLegId`. */
  const action = async (
    accountId: string,
    kind: "BUY" | "DIVIDEND",
    total: number,
    cashLegId: string,
  ) => {
    await dataSource.query(
      `INSERT INTO investment_transactions
         (user_id, account_id, action, transaction_date, total_amount,
          transaction_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, accountId, kind, day, total, cashLegId],
    );
  };

  /** A dividend paid into the sleeve, the import's way: brokerage -> cash. */
  const importedDividend = async (amount: number) =>
    action(
      brokerageId,
      "DIVIDEND",
      amount,
      await transfer(brokerageId, cashId, amount),
    );

  /** A BUY paid from the sleeve, the import's way: cash -> brokerage. */
  const importedBuy = async (amount: number) => {
    const sleeveLeg = await transfer(cashId, brokerageId, amount);
    const [{ id }] = await dataSource.query(
      `SELECT linked_transaction_id AS id FROM transactions WHERE id = $1`,
      [sleeveLeg],
    );
    await action(brokerageId, "BUY", amount, id);
  };

  const flows = (investmentScope?: string[]) =>
    withUserContext(userId, () =>
      loadExternalFlowSubtotals(
        (sql, params) => withScopedDb(dataSource, (m) => m.query(sql, params)),
        { userId, ...window, accountIds: [cashId], investmentScope },
      ),
    );

  const settledCount = async () => {
    const rows = await withUserContext(userId, () =>
      loadUnmeasuredFlowRows(
        (sql, params) => withScopedDb(dataSource, (m) => m.query(sql, params)),
        {
          userId,
          ...window,
          scope: [brokerageId, cashId],
          cashScope: [cashId],
        },
      ),
    );
    return rows.externallySettledTrades.reduce((n, r) => n + r.count, 0);
  };

  it("leaves an imported trade's sleeve leg out of the flow", async () => {
    await importedDividend(300);
    await importedBuy(1_000);

    await expect(flows([brokerageId, cashId])).resolves.toEqual([]);
  });

  it("counted the same legs as flows without an investment scope", async () => {
    // The boundary the period routes drew before: the dividend read as a 300
    // deposit and the BUY as a 1,000 withdrawal.
    await importedDividend(300);
    await importedBuy(1_000);

    const rows = await flows();
    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe(-700);
  });

  it("does not count an imported trade as settled outside the valued cash", async () => {
    await importedDividend(300);
    await importedBuy(1_000);

    await expect(settledCount()).resolves.toBe(0);
  });

  it("still counts a deposit from an ordinary account", async () => {
    await importedDividend(300);
    await transfer(chequingId, cashId, 5_000);

    const rows = await flows([brokerageId, cashId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe(5_000);
  });

  it("still counts cash that paid for a trade on a brokerage outside the scope", async () => {
    // The shares land outside the valuation, so the cash left the portfolio.
    const sleeveLeg = await transfer(cashId, otherBrokerageId, 400);
    const [{ id }] = await dataSource.query(
      `SELECT linked_transaction_id AS id FROM transactions WHERE id = $1`,
      [sleeveLeg],
    );
    await action(otherBrokerageId, "BUY", 400, id);

    const rows = await flows([brokerageId, cashId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe(-400);
  });

  it("still counts a trade whose cash leg sits on an ordinary account", async () => {
    // A dividend paid straight to chequing: the cash never reached the sleeve.
    const [{ id }] = await dataSource.query(
      `INSERT INTO transactions
         (user_id, account_id, transaction_date, amount, currency_code,
          exchange_rate, status)
       VALUES ($1, $2, $3, 50, 'CAD', 1, 'UNRECONCILED')
       RETURNING id`,
      [userId, chequingId, day],
    );
    await action(brokerageId, "DIVIDEND", 50, id);

    await expect(settledCount()).resolves.toBe(1);
  });
});
