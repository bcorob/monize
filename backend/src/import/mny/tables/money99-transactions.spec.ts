import { fakeMnyDatabase } from "../__fixtures__/fake-mny-database";
import { mnyTransaction, mnyTransfer } from "../__fixtures__/mny-row-builders";
import { isUnpostedRow, isVoided } from "../model/mny-model";
import { MONEY99_ACTION, MONEY99_TRANSACTION_FLAG } from "../model/mny-money99";
import { adaptMoney99Transactions } from "./money99-transactions";
import { readTransactionData } from "./read-transactions";

/** Money 99's shape for "other income": an investment row and its cash pair. */
function otherIncomePair() {
  return {
    transactions: [
      mnyTransaction({
        handle: 87,
        account: 2,
        linkedAccount: 3,
        security: 57,
        category: 130,
        action: MONEY99_ACTION.OTHER_INCOME,
        amount: -10,
        memo: "Other income",
      }),
      mnyTransaction({
        handle: 88,
        account: 3,
        linkedAccount: 2,
        amount: 10,
        memo: "Other income",
      }),
    ],
    transfers: [mnyTransfer({ from: 88, to: 87 })],
  };
}

describe("adaptMoney99Transactions", () => {
  it("rebuilds every row's flags in the Money Plus layout", () => {
    const { transactions } = adaptMoney99Transactions(
      [
        mnyTransaction({ handle: 1, flags: MONEY99_TRANSACTION_FLAG.VOID }),
        mnyTransaction({ handle: 2, flags: 0xe04 }),
      ],
      [],
    );

    expect(isVoided(transactions[0].flags)).toBe(true);
    expect(isUnpostedRow(transactions[1].flags)).toBe(true);
  });

  it("imports other income as the cash row alone, carrying the investment row's category", () => {
    const { transactions, transfers } = adaptMoney99Transactions(
      otherIncomePair().transactions,
      otherIncomePair().transfers,
    );

    expect(transactions).toEqual([
      expect.objectContaining({
        handle: 88,
        account: 3,
        linkedAccount: null,
        security: null,
        category: 130,
        amount: 10,
      }),
    ]);
    expect(transfers).toEqual([]);
  });

  it("collapses other expenses the same way, keeping the cash row's sign", () => {
    const { transactions } = adaptMoney99Transactions(
      [
        mnyTransaction({
          handle: 89,
          account: 2,
          security: 57,
          category: 140,
          action: MONEY99_ACTION.OTHER_EXPENSE,
          amount: 10,
        }),
        mnyTransaction({ handle: 90, account: 3, amount: -10 }),
      ],
      [mnyTransfer({ from: 90, to: 89 })],
    );

    expect(transactions).toEqual([
      expect.objectContaining({ handle: 90, amount: -10, category: 140 }),
    ]);
  });

  it("keeps a category the cash row already has", () => {
    const pair = otherIncomePair();
    const { transactions } = adaptMoney99Transactions(
      [pair.transactions[0], { ...pair.transactions[1], category: 7 }],
      pair.transfers,
    );

    expect(transactions[0].category).toBe(7);
  });

  it("leaves an other-income row with no cash partner for the investment mapper", () => {
    const pair = otherIncomePair();
    const { transactions } = adaptMoney99Transactions(
      [pair.transactions[0]],
      [],
    );

    expect(transactions).toEqual([
      expect.objectContaining({ handle: 87, security: 57 }),
    ]);
  });

  it("leaves every other transfer pair alone, a dividend's included", () => {
    const rows = [
      mnyTransaction({
        handle: 53,
        account: 2,
        security: 57,
        action: MONEY99_ACTION.DIVIDEND,
        amount: -2,
      }),
      mnyTransaction({ handle: 54, account: 3, amount: 2 }),
    ];
    const pairs = [mnyTransfer({ from: 54, to: 53 })];

    const result = adaptMoney99Transactions(rows, pairs);

    expect(result.transactions.map((row) => row.handle)).toEqual([53, 54]);
    expect(result.transfers).toEqual(pairs);
  });
});

describe("readTransactionData on a Money 97-99 file", () => {
  const columns = ["htrn", "hacct", "hsec", "amt", "grftt", "act", "hcls1"];

  it("reads the old classification column and adapts the rows", () => {
    const db = fakeMnyDatabase(
      {
        TRN: {
          columns,
          rows: [
            {
              htrn: 91,
              hacct: 1,
              hsec: null,
              amt: 2000,
              grftt: MONEY99_TRANSACTION_FLAG.VOID,
              act: -1,
              hcls1: 300,
            },
          ],
        },
        TRN_SPLIT: { columns: ["htrn", "htrnParent", "iSplit"] },
        TRN_XFER: { columns: ["htrnFrom", "htrnLink"] },
      },
      "jet3",
    );

    const data = readTransactionData(db);

    expect(data.format).toBe("jet3");
    expect(data.transactions[0].classification1).toBe(300);
    expect(isVoided(data.transactions[0].flags)).toBe(true);
  });

  it("does not translate a Money Plus file's flags", () => {
    const db = fakeMnyDatabase({
      TRN: {
        columns,
        rows: [{ htrn: 1, hacct: 1, amt: 0, grftt: 0x80, act: -1 }],
      },
    });

    const data = readTransactionData(db);

    expect(data.format).toBe("msisam");
    expect(data.transactions[0].flags).toBe(0x80);
  });
});
