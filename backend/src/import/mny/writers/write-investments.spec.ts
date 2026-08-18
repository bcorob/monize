import { EntityManager } from "typeorm";
import { InvestmentAction } from "../../../securities/entities/investment-transaction.entity";
import { TransactionStatus } from "../../../transactions/entities/transaction.entity";
import {
  MappedInvestmentTransaction,
  MappedSecurity,
} from "../model/mny-import-model";
import { writeInvestments, writeSecurities } from "./write-investments";

/**
 * The investment writer's contract: securities are find-or-create by symbol, a
 * cash leg is one plain transaction in the cash sleeve (never a transfer pair
 * that would give the brokerage side a balance the file never had), and the
 * share-transfer link is back-patched after every row exists because the column
 * is a self-referencing foreign key.
 */

function security(overrides: Partial<MappedSecurity> = {}): MappedSecurity {
  return {
    handle: 1,
    symbol: "VOO",
    moneySymbol: "VOO",
    name: "Vanguard S&P 500",
    currencyCode: "USD",
    skipPriceUpdates: false,
    ...overrides,
  };
}

function investment(
  overrides: Partial<MappedInvestmentTransaction> = {},
): MappedInvestmentTransaction {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    handle: 1,
    accountKey: "acct-10",
    cashAccountKey: "acct-11",
    securityHandle: 1,
    action: InvestmentAction.BUY,
    transactionDate: "2026-01-15",
    quantity: 10,
    price: 100,
    commission: 9.99,
    totalAmount: 1009.99,
    currencyCode: "USD",
    cashAmount: -1009.99,
    status: TransactionStatus.CLEARED,
    payeeHandle: null,
    categoryHandle: null,
    description: null,
    linkedInvestmentId: null,
    ...overrides,
  };
}

interface Doubles {
  manager: EntityManager;
  securities: Record<string, jest.Mock>;
  investments: Record<string, jest.Mock>;
  transactions: Record<string, jest.Mock>;
  query: jest.Mock;
}

function doubles(existingSecurities: { id: string; symbol: string }[] = []) {
  const securities = {
    find: jest.fn().mockResolvedValue(existingSecurities),
    insert: jest.fn().mockResolvedValue(undefined),
  } as unknown as Record<string, jest.Mock>;
  const investments = {
    insert: jest.fn().mockResolvedValue(undefined),
  } as unknown as Record<string, jest.Mock>;
  const transactions = {
    insert: jest.fn().mockResolvedValue(undefined),
  } as unknown as Record<string, jest.Mock>;
  const query = jest.fn().mockResolvedValue([[], 0]);

  const manager = {
    getRepository: jest.fn((entity: { name?: string }) => {
      if (entity?.name === "Security") return securities;
      if (entity?.name === "InvestmentTransaction") return investments;
      return transactions;
    }),
    query,
  } as unknown as EntityManager;

  return { manager, securities, investments, transactions, query } as Doubles;
}

const baseInput = {
  accountIdByKey: new Map([
    ["acct-10", "aaaaaaaa-0000-0000-0000-000000000010"],
    ["acct-11", "aaaaaaaa-0000-0000-0000-000000000011"],
  ]),
  securityIdByHandle: new Map([[1, "ssssssss-0000-0000-0000-000000000001"]]),
  categoryIdByHandle: new Map<number, string>(),
  payeeIdByHandle: new Map<number, string>(),
  payeeNameByHandle: new Map<number, string>(),
  symbolByHandle: new Map([[1, "VOO"]]),
};

describe("writeSecurities", () => {
  it("creates the securities the user does not have", async () => {
    const { manager, securities } = doubles();

    const result = await writeSecurities(manager, "user-1", [
      security({ handle: 1, symbol: "VOO" }),
      security({ handle: 2, symbol: "VTI", name: "Total Market" }),
    ]);

    expect(result.created).toBe(2);
    expect(result.reused).toBe(0);
    expect(result.idByHandle.size).toBe(2);
    expect(securities.insert).toHaveBeenCalledTimes(1);
    expect(securities.insert.mock.calls[0][0]).toHaveLength(2);
  });

  it("reuses a security the user already has, matched case-insensitively", async () => {
    const { manager, securities } = doubles([
      { id: "existing", symbol: "voo" },
    ]);

    const result = await writeSecurities(manager, "user-1", [
      security({ handle: 1, symbol: "VOO" }),
    ]);

    expect(result.reused).toBe(1);
    expect(result.created).toBe(0);
    expect(result.idByHandle.get(1)).toBe("existing");
    expect(securities.insert).not.toHaveBeenCalled();
  });

  it("leaves the security type unset rather than guessing from Money's sct", async () => {
    const { manager, securities } = doubles();

    await writeSecurities(manager, "user-1", [security()]);

    expect(securities.insert.mock.calls[0][0][0]).toMatchObject({
      securityType: null,
      exchange: null,
      isActive: true,
    });
  });

  it("carries the placeholder-symbol flag through so quotes are not fetched", async () => {
    const { manager, securities } = doubles();

    await writeSecurities(manager, "user-1", [
      security({ symbol: "AGF*", skipPriceUpdates: true }),
    ]);

    expect(securities.insert.mock.calls[0][0][0].skipPriceUpdates).toBe(true);
  });

  it("does nothing, and does not query, when there are no securities", async () => {
    const { manager, securities } = doubles();

    const result = await writeSecurities(manager, "user-1", []);

    expect(result.created).toBe(0);
    expect(securities.find).not.toHaveBeenCalled();
  });
});

describe("writeInvestments", () => {
  it("writes the investment row and its cash leg, linked", async () => {
    const { manager, investments, transactions } = doubles();

    const result = await writeInvestments(manager, "user-1", {
      ...baseInput,
      transactions: [investment()],
    });

    expect(result.investmentTransactionsCreated).toBe(1);
    expect(result.cashTransactionsCreated).toBe(1);

    const cashRow = transactions.insert.mock.calls[0][0][0];
    const investmentRow = investments.insert.mock.calls[0][0][0];

    expect(cashRow).toMatchObject({
      accountId: "aaaaaaaa-0000-0000-0000-000000000011",
      amount: -1009.99,
      isTransfer: false,
      status: TransactionStatus.CLEARED,
    });
    expect(investmentRow).toMatchObject({
      id: "11111111-1111-1111-1111-111111111111",
      accountId: "aaaaaaaa-0000-0000-0000-000000000010",
      transactionId: cashRow.id,
      securityId: "ssssssss-0000-0000-0000-000000000001",
      action: InvestmentAction.BUY,
      quantity: 10,
      totalAmount: 1009.99,
      linkedTransactionId: null,
    });
  });

  it("persists the mapped status on the investment row, not only the cash leg", async () => {
    // The writer used to carry the status onto the cash leg alone, so a
    // Money-voided trade's shares stayed counted while its cash claimed not to
    // have moved -- and rows with no cash leg dropped the status entirely.
    const { manager, investments } = doubles();

    await writeInvestments(manager, "user-1", {
      ...baseInput,
      transactions: [investment({ status: TransactionStatus.RECONCILED })],
    });

    expect(investments.insert.mock.calls[0][0][0].status).toBe(
      TransactionStatus.RECONCILED,
    );
  });

  it("writes a Money-voided trade as VOID on both the investment row and its cash leg", async () => {
    const { manager, investments, transactions } = doubles();

    await writeInvestments(manager, "user-1", {
      ...baseInput,
      transactions: [investment({ status: TransactionStatus.VOID })],
    });

    expect(investments.insert.mock.calls[0][0][0].status).toBe(
      TransactionStatus.VOID,
    );
    expect(transactions.insert.mock.calls[0][0][0].status).toBe(
      TransactionStatus.VOID,
    );
  });

  it("inserts the cash row before the investment row that references it", async () => {
    const { manager, investments, transactions } = doubles();
    const order: string[] = [];
    transactions.insert.mockImplementation(() => {
      order.push("cash");
      return Promise.resolve();
    });
    investments.insert.mockImplementation(() => {
      order.push("investment");
      return Promise.resolve();
    });

    await writeInvestments(manager, "user-1", {
      ...baseInput,
      transactions: [investment()],
    });

    expect(order).toEqual(["cash", "investment"]);
  });

  it("writes no cash leg for a share-only action", async () => {
    const { manager, transactions } = doubles();

    const result = await writeInvestments(manager, "user-1", {
      ...baseInput,
      transactions: [
        investment({
          action: InvestmentAction.ADD_SHARES,
          cashAccountKey: null,
          cashAmount: 0,
          totalAmount: 0,
        }),
      ],
    });

    expect(result.cashTransactionsCreated).toBe(0);
    expect(transactions.insert).not.toHaveBeenCalled();
  });

  it("back-patches the share-transfer link once both legs exist", async () => {
    const { manager, query } = doubles();
    const outId = "22222222-2222-2222-2222-222222222222";

    await writeInvestments(manager, "user-1", {
      ...baseInput,
      transactions: [
        investment({
          action: InvestmentAction.TRANSFER_IN,
          cashAccountKey: null,
          cashAmount: 0,
          linkedInvestmentId: outId,
        }),
        investment({
          id: outId,
          handle: 2,
          action: InvestmentAction.TRANSFER_OUT,
          cashAccountKey: null,
          cashAmount: 0,
          linkedInvestmentId: "11111111-1111-1111-1111-111111111111",
        }),
      ],
    });

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain("UPDATE investment_transactions");
    expect(query.mock.calls[0][1]).toHaveLength(4);
  });

  it("leaves a link alone when its partner was not inserted", async () => {
    const { manager, query } = doubles();

    await writeInvestments(manager, "user-1", {
      ...baseInput,
      transactions: [
        investment({
          linkedInvestmentId: "99999999-9999-9999-9999-999999999999",
        }),
      ],
    });

    expect(query).not.toHaveBeenCalled();
  });

  it("skips rows whose account was not created", async () => {
    const { manager, investments } = doubles();

    const result = await writeInvestments(manager, "user-1", {
      ...baseInput,
      transactions: [investment({ accountKey: "acct-77" })],
    });

    expect(result.investmentTransactionsCreated).toBe(0);
    expect(investments.insert).not.toHaveBeenCalled();
  });

  it("reports both the brokerage and the cash account as affected", async () => {
    const { manager } = doubles();

    const result = await writeInvestments(manager, "user-1", {
      ...baseInput,
      transactions: [investment()],
    });

    expect([...result.affectedAccountIds].sort()).toEqual([
      "aaaaaaaa-0000-0000-0000-000000000010",
      "aaaaaaaa-0000-0000-0000-000000000011",
    ]);
    expect([...result.brokerageAccountIds]).toEqual([
      "aaaaaaaa-0000-0000-0000-000000000010",
    ]);
  });

  it("falls back to the security symbol when Money recorded no memo", async () => {
    const { manager, investments } = doubles();

    await writeInvestments(manager, "user-1", {
      ...baseInput,
      transactions: [investment({ description: null })],
    });

    expect(investments.insert.mock.calls[0][0][0].description).toBe("VOO");
  });

  it("labels the cash leg with the activity when Money recorded no payee", async () => {
    // Issue #1204: Money files carry no payee on a trade, so every imported
    // cash leg rendered as a bare "-" in the register -- the one column that
    // could say why the money moved. The label is the same one a natively
    // entered and a QIF-imported trade already store.
    const { manager, transactions } = doubles();

    await writeInvestments(manager, "user-1", {
      ...baseInput,
      transactions: [investment()],
    });

    expect(transactions.insert.mock.calls[0][0][0]).toMatchObject({
      payeeId: null,
      payeeName: "Buy: VOO 10 @ $100.00",
    });
  });

  it("quotes the label in the row's own currency", async () => {
    const { manager, transactions } = doubles();

    await writeInvestments(manager, "user-1", {
      ...baseInput,
      transactions: [investment({ currencyCode: "EUR" })],
    });

    expect(transactions.insert.mock.calls[0][0][0].payeeName).toBe(
      "Buy: VOO 10 @ €100.00",
    );
  });

  it("labels an income leg with its total rather than a unit price", async () => {
    const { manager, transactions } = doubles();

    await writeInvestments(manager, "user-1", {
      ...baseInput,
      transactions: [
        investment({
          action: InvestmentAction.DIVIDEND,
          quantity: null,
          price: null,
          commission: 0,
          totalAmount: 42.5,
          cashAmount: 42.5,
        }),
      ],
    });

    expect(transactions.insert.mock.calls[0][0][0].payeeName).toBe(
      "Dividend: VOO $42.50",
    );
  });

  it("says Unknown when the security handle resolves to nothing", async () => {
    const { manager, transactions } = doubles();

    await writeInvestments(manager, "user-1", {
      ...baseInput,
      symbolByHandle: new Map<number, string>(),
      transactions: [investment()],
    });

    expect(transactions.insert.mock.calls[0][0][0].payeeName).toBe(
      "Buy: Unknown 10 @ $100.00",
    );
  });

  it("carries Money's own payee and category onto the cash leg", async () => {
    const { manager, transactions } = doubles();

    await writeInvestments(manager, "user-1", {
      ...baseInput,
      payeeIdByHandle: new Map([[4, "payee-4"]]),
      payeeNameByHandle: new Map([[4, "Broker"]]),
      categoryIdByHandle: new Map([[9, "category-9"]]),
      transactions: [investment({ payeeHandle: 4, categoryHandle: 9 })],
    });

    // The synthesized label is a fallback, never an override: a payee the
    // user recorded in Money is not replaced by generated text.
    expect(transactions.insert.mock.calls[0][0][0]).toMatchObject({
      payeeId: "payee-4",
      payeeName: "Broker",
      categoryId: "category-9",
    });
  });

  it("labels the leg rather than linking half a payee", async () => {
    // A handle that resolves to an id but no name (or the reverse) is not a
    // payee: writing one half leaves the register showing whichever survived.
    const { manager, transactions } = doubles();

    await writeInvestments(manager, "user-1", {
      ...baseInput,
      payeeIdByHandle: new Map([[4, "payee-4"]]),
      payeeNameByHandle: new Map<number, string>(),
      transactions: [investment({ payeeHandle: 4 })],
    });

    expect(transactions.insert.mock.calls[0][0][0]).toMatchObject({
      payeeId: null,
      payeeName: "Buy: VOO 10 @ $100.00",
    });
  });

  it("reports progress after every chunk", async () => {
    const { manager } = doubles();
    const onProgress = jest.fn().mockResolvedValue(undefined);

    await writeInvestments(manager, "user-1", {
      ...baseInput,
      transactions: [investment(), investment({ id: "b", handle: 2 })],
      onProgress,
    });

    expect(onProgress).toHaveBeenCalledWith(2, 2);
  });
});
