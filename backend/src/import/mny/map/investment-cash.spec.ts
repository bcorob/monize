import { InvestmentAction } from "../../../securities/entities/investment-transaction.entity";
import { TransactionStatus } from "../../../transactions/entities/transaction.entity";
import {
  MappedInvestmentTransaction,
  MappedInvestments,
  MnyInvestmentCashSource,
} from "../model/mny-import-model";
import {
  applyInvestmentCashSources,
  investmentWritesOwnCashRow,
  tradesByHandle,
} from "./investment-cash";

/**
 * The join between the two mappers, in isolation.
 *
 * `trade-cash-legs.spec.ts` covers what a Money file produces end to end; this
 * covers the three answers this module gives on its own -- which trades the
 * transaction mapper may see, which of them writes its own cash row, and what
 * rate a trade settled at when its funding row is in another currency.
 */

function trade(
  overrides: Partial<MappedInvestmentTransaction> = {},
): MappedInvestmentTransaction {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    handle: 21,
    accountKey: "acct-5",
    cashAccountKey: "acct-6",
    fundingAccountKey: null,
    cashTransactionId: null,
    transactionSplitId: null,
    securityHandle: 9,
    action: InvestmentAction.BUY,
    transactionDate: "2026-03-01",
    quantity: 10,
    price: 240,
    commission: 0,
    totalAmount: 2400,
    currencyCode: "USD",
    exchangeRate: 1,
    cashAmount: -2400,
    status: TransactionStatus.CLEARED,
    payeeHandle: null,
    categoryHandle: null,
    description: null,
    linkedInvestmentId: null,
    ...overrides,
  };
}

function investments(
  transactions: MappedInvestmentTransaction[],
): MappedInvestments {
  return {
    transactions,
    referencedSecurities: new Set(),
    referencedPayees: new Set(),
    referencedCategories: new Set(),
    transfersPaired: 0,
    skipped: 0,
    warnings: [],
  };
}

function source(
  overrides: Partial<MnyInvestmentCashSource> = {},
): MnyInvestmentCashSource {
  return {
    accountKey: "acct-1",
    currencyCode: "USD",
    amount: -2400,
    status: TransactionStatus.CLEARED,
    transactionId: "bbbbbbbb-0000-0000-0000-000000000001",
    splitId: null,
    ...overrides,
  };
}

describe("investmentWritesOwnCashRow", () => {
  it("is true for a trade settling in its own cash sleeve", () => {
    expect(investmentWritesOwnCashRow(trade())).toBe(true);
  });

  it("is false for an action that moves no cash", () => {
    expect(
      investmentWritesOwnCashRow(
        trade({
          action: InvestmentAction.ADD_SHARES,
          cashAccountKey: null,
          cashAmount: 0,
        }),
      ),
    ).toBe(false);
  });

  it("is false once the trade has adopted a banking row as its cash leg", () => {
    // Issue #1212: writing a second row is the duplicate in the register, and
    // counting it again is the balance moving twice.
    expect(
      investmentWritesOwnCashRow(
        trade({ cashAccountKey: "acct-1", cashTransactionId: "row" }),
      ),
    ).toBe(false);
  });

  it("is false for a trade embedded in a split leg", () => {
    expect(
      investmentWritesOwnCashRow(
        trade({ cashAccountKey: "acct-1", transactionSplitId: "leg" }),
      ),
    ).toBe(false);
  });
});

describe("tradesByHandle", () => {
  it("keys the trades the transaction mapper may act on", () => {
    const map = tradesByHandle(investments([trade()]));

    expect(map.get(21)).toEqual({
      accountKey: "acct-5",
      action: InvestmentAction.BUY,
      cashAmount: -2400,
      status: TransactionStatus.CLEARED,
    });
  });

  it("leaves out a row with no Money handle", () => {
    // A `SEC_SPLIT`-derived row has no `TRN` behind it, so no banking row can
    // be paired with it.
    expect(tradesByHandle(investments([trade({ handle: null })])).size).toBe(0);
  });
});

describe("applyInvestmentCashSources", () => {
  it("returns the investments unchanged when nothing was paired", () => {
    const mapped = investments([trade()]);

    expect(applyInvestmentCashSources(mapped, new Map())).toBe(mapped);
  });

  it("points a funded trade at the row that paid for it", () => {
    const result = applyInvestmentCashSources(
      investments([trade()]),
      new Map([[21, source()]]),
    );

    expect(result.transactions[0]).toMatchObject({
      cashAccountKey: "acct-1",
      fundingAccountKey: "acct-1",
      cashTransactionId: "bbbbbbbb-0000-0000-0000-000000000001",
      transactionSplitId: null,
      exchangeRate: 1,
    });
  });

  it("names no funding account for a trade embedded in a split", () => {
    // `createEmbeddedForSplit` writes `fundingAccountId: null`: the parent
    // transaction's own account is the cash side, and naming a funding account
    // as well would claim a second one.
    const result = applyInvestmentCashSources(
      investments([trade()]),
      new Map([[21, source({ transactionId: null, splitId: "leg-1" })]]),
    );

    expect(result.transactions[0]).toMatchObject({
      cashAccountKey: "acct-1",
      fundingAccountKey: null,
      cashTransactionId: null,
      transactionSplitId: "leg-1",
    });
  });

  it("derives the rate from the two amounts Money recorded", () => {
    // 3,120 CAD leaving the chequing account for a 2,400 USD purchase. 1 here
    // would post the cash unconverted, which is the whole FX spread.
    const result = applyInvestmentCashSources(
      investments([trade()]),
      new Map([[21, source({ currencyCode: "CAD", amount: -3_120 })]]),
    );

    expect(result.transactions[0].exchangeRate).toBe(1.3);
  });

  it("does not invent a rate it cannot derive", () => {
    // Unreachable from a real file -- a trade with no total moves no cash, so
    // it is never paired -- but a rate is a division and Infinity is worse than
    // a wrong number: it would be stored, then multiplied by the cash amount.
    const result = applyInvestmentCashSources(
      investments([trade({ totalAmount: 0 })]),
      new Map([[21, source({ currencyCode: "CAD" })]]),
    );

    expect(result.transactions[0].exchangeRate).toBe(1);
  });

  it("voids a trade whose funding row records money that did not move", () => {
    // Two rows describing one movement of money share the VOID boundary. Left
    // active, the trade would keep its shares while the cash side said the
    // purchase never happened.
    const result = applyInvestmentCashSources(
      investments([trade()]),
      new Map([[21, source({ status: TransactionStatus.VOID })]]),
    );

    expect(result.transactions[0].status).toBe(TransactionStatus.VOID);
  });

  it("gives an embedded trade its parent's status outright", () => {
    // `createEmbeddedForSplit` does the same: the parent owns an embedded row's
    // status, so a reconciled paycheque's investment line is reconciled too.
    const result = applyInvestmentCashSources(
      investments([trade({ status: TransactionStatus.UNRECONCILED })]),
      new Map([
        [
          21,
          source({
            transactionId: null,
            splitId: "leg-1",
            status: TransactionStatus.RECONCILED,
          }),
        ],
      ]),
    );

    expect(result.transactions[0].status).toBe(TransactionStatus.RECONCILED);
  });

  it("leaves an adopted funding row's reconciliation state per-ledger", () => {
    // Only VOID is shared. A cleared bank row does not make the trade cleared.
    const result = applyInvestmentCashSources(
      investments([trade({ status: TransactionStatus.UNRECONCILED })]),
      new Map([[21, source({ status: TransactionStatus.RECONCILED })]]),
    );

    expect(result.transactions[0].status).toBe(TransactionStatus.UNRECONCILED);
  });

  it("leaves other trades alone", () => {
    const result = applyInvestmentCashSources(
      investments([trade(), trade({ id: "other", handle: 30 })]),
      new Map([[21, source()]]),
    );

    expect(result.transactions[1].cashTransactionId).toBeNull();
    expect(result.transactions[1].cashAccountKey).toBe("acct-6");
  });
});
