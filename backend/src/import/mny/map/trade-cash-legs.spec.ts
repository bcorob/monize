import { InvestmentAction } from "../../../securities/entities/investment-transaction.entity";
import { SplitKind } from "../../../transactions/entities/split-kind.enum";
import {
  investmentData,
  mnyAccount,
  mnyCurrency,
  mnyInvestmentDetail,
  mnySecurity,
  mnySplit,
  mnyTransaction,
  mnyTransfer,
  referenceData,
  transactionData,
} from "../__fixtures__/mny-row-builders";
import { MnyTransactionData } from "../tables/read-transactions";
import { MnyInvestmentData } from "../tables/read-investments";
import { DEFAULT_MNY_IMPORT_OPTIONS } from "../model/mny-import-options";
import { MNY_ACTION, MNY_TRANSACTION_FLAG } from "../model/mny-model";
import { TransactionStatus } from "../../../transactions/entities/transaction.entity";
import { computeExpectedBalances } from "../mny-parser.service";
import { mapAccounts, cashKeyByAccountKey } from "./map-reference";
import { mapSecurities } from "./map-securities";
import { mapTransactions } from "./map-transactions";
import { mapInvestments } from "./map-investments";
import {
  applyInvestmentCashSources,
  investmentWritesOwnCashRow,
  reconcileEmbeddedAccruedInterest,
  tradesByHandle,
} from "./investment-cash";

/**
 * Issue #1175: what the cash register of a brokerage account ends up holding.
 *
 * Money keeps an investment account's cash in a companion account and records
 * the cash half of a trade there as an ordinary `TRN` row paired to the trade
 * through `TRN_XFER`. Monize writes that row itself, from the investment
 * transaction, so importing Money's copy as well produced three rows where
 * Money shows one: the purchase, plus a transfer in and a transfer out that
 * cancelled each other.
 *
 * The cancellation is why no balance check caught it, and it is also what makes
 * the fix safe -- so these tests assert the row count **and** the balance
 * together. Either one alone was satisfied by the defect.
 *
 * The two mappers are exercised together on purpose: neither can see this on
 * its own, because the duplication is one mapper writing what the other already
 * wrote.
 */

/** `hacct` 1 chequing, 5 the brokerage, 6 the cash companion Money pairs it with. */
const CHEQUING = 1;
const BROKERAGE = 5;
const SLEEVE = 6;
const SECURITY = 9;

const SLEEVE_OPENING = 5_000;
const PURCHASE = 2_400;

function accounts() {
  return mapAccounts(
    referenceData({
      accounts: [
        mnyAccount({ handle: CHEQUING, type: 0, name: "Chequing" }),
        mnyAccount({
          handle: BROKERAGE,
          type: 5,
          name: "Brokerage",
          relatedAccount: SLEEVE,
        }),
        mnyAccount({
          handle: SLEEVE,
          type: 0,
          name: "Brokerage (Cash)",
          relatedAccount: BROKERAGE,
          openingBalance: SLEEVE_OPENING,
        }),
      ],
    }),
    DEFAULT_MNY_IMPORT_OPTIONS,
    "USD",
  );
}

function securities() {
  return mapSecurities({
    securities: [mnySecurity({ handle: SECURITY, symbol: "VOO" })],
    currencyByHandle: new Map(),
    baseCurrency: "USD",
    activeHandles: new Set([SECURITY]),
  });
}

/** The `TRN_INV` detail of the one purchase every fixture here makes. */
function purchaseDetail(handle: number): MnyInvestmentData {
  return investmentData({
    securities: [mnySecurity({ handle: SECURITY, symbol: "VOO" })],
    investmentDetails: [
      mnyInvestmentDetail({ transaction: handle, price: 240, quantity: 10 }),
    ],
  });
}

/** Runs the whole banking + investment mapping the way the parser does. */
function mapAll(
  transactions: MnyTransactionData,
  investmentTables: MnyInvestmentData,
) {
  const mappedAccounts = accounts();
  const mappedSecurities = securities();

  const mappedInvestments = mapInvestments({
    transactions,
    investments: investmentTables,
    accounts: mappedAccounts,
    securities: mappedSecurities,
    bills: [],
  });
  const banking = mapTransactions({
    transactions,
    accountKeyByHandle: mappedAccounts.keyByHandle,
    currencyByHandle: mappedAccounts.currencyByHandle,
    bills: [],
    cashKeyByAccountKey: cashKeyByAccountKey(mappedAccounts),
    tradesByHandle: tradesByHandle(mappedInvestments),
  });
  const investments = reconcileEmbeddedAccruedInterest(
    applyInvestmentCashSources(
      mappedInvestments,
      banking.investmentCashSources,
    ),
  );

  /** Every row a given account's register will hold, from both writers. */
  const rowsIn = (accountKey: string) => [
    ...banking.transactions.filter((row) => row.accountKey === accountKey),
    ...investments.transactions.filter(
      (row) =>
        investmentWritesOwnCashRow(row) && row.cashAccountKey === accountKey,
    ),
  ];

  return {
    banking,
    investments,
    rowsIn,
    /** Every row that will exist in the sleeve, from both writers. */
    sleeveRows: rowsIn("acct-6"),
    balances: computeExpectedBalances(
      mappedAccounts,
      banking,
      "2099-12-31",
      investments,
    ),
  };
}

describe("a trade funded from the brokerage's own cash account", () => {
  /**
   * Money's shape: the trade in the brokerage, its cash half in the companion
   * account, paired through `TRN_XFER`.
   */
  const moneyRows = transactionData({
    transactions: [
      mnyTransaction({
        handle: 20,
        account: SLEEVE,
        amount: -PURCHASE,
        memo: "Buy VOO",
      }),
      mnyTransaction({
        handle: 21,
        account: BROKERAGE,
        amount: PURCHASE,
        security: SECURITY,
        action: MNY_ACTION.BUY,
      }),
    ],
    transfers: [mnyTransfer({ from: 20, to: 21 })],
  });

  it("puts exactly one row in the cash register, the trade's own leg", () => {
    const { banking, investments, sleeveRows } = mapAll(
      moneyRows,
      purchaseDetail(21),
    );

    // Money's copy of the cash leg is not imported: the investment writer
    // creates that row, linked to the trade through `transaction_id`.
    expect(banking.transactions).toEqual([]);
    expect(banking.tradeCashLegs).toBe(1);

    expect(sleeveRows).toHaveLength(1);
    expect(investments.transactions).toHaveLength(1);
    expect(investments.transactions[0]).toMatchObject({
      accountKey: "acct-5",
      action: InvestmentAction.BUY,
      cashAccountKey: "acct-6",
      cashAmount: -PURCHASE,
      totalAmount: PURCHASE,
    });
  });

  it("moves the cash balance exactly once", () => {
    // The defect was invisible to this assertion alone -- the imported row and
    // its synthesized mirror summed to zero -- which is the whole reason the
    // row count above is asserted beside it.
    const { balances } = mapAll(moneyRows, purchaseDetail(21));

    expect(balances.get("acct-6")).toBe(SLEEVE_OPENING - PURCHASE);
    // The brokerage side holds shares, never cash.
    expect(balances.get("acct-5")).toBe(0);
  });

  it("reports no warning, because nothing about the file is wrong", () => {
    const { banking, investments } = mapAll(moneyRows, purchaseDetail(21));

    expect(banking.warnings).toEqual([]);
    expect(investments.warnings).toEqual([]);
    expect(banking.skipped).toBe(0);
    // There is no transfer here: one movement of cash, recorded by the trade.
    expect(banking.transfersLinked).toBe(0);
  });
});

describe("a trade funded from an outside account (issue #1212)", () => {
  /**
   * Money records the cash half in the account that paid -- here chequing --
   * and pairs it with the trade. Monize used to read that pairing as a transfer
   * into the brokerage's cash sleeve, then have the trade take the money
   * straight back out again: two rows in a register Money shows nothing in, and
   * a purchase that claimed to be funded by the sleeve rather than by the
   * account the user actually paid from.
   *
   * The row stays where Money put it and becomes the trade's cash leg.
   */
  const moneyRows = transactionData({
    transactions: [
      mnyTransaction({
        handle: 20,
        account: CHEQUING,
        amount: -PURCHASE,
        memo: "Buy VOO",
      }),
      mnyTransaction({
        handle: 21,
        account: BROKERAGE,
        amount: PURCHASE,
        security: SECURITY,
        action: MNY_ACTION.BUY,
      }),
    ],
    transfers: [mnyTransfer({ from: 20, to: 21 })],
  });

  it("leaves the cash sleeve empty and keeps one row in the paying account", () => {
    const { rowsIn, sleeveRows } = mapAll(moneyRows, purchaseDetail(21));

    expect(sleeveRows).toEqual([]);
    expect(rowsIn("acct-1")).toHaveLength(1);
  });

  it("makes the paying account's row the trade's cash leg, not a transfer", () => {
    const { banking, investments } = mapAll(moneyRows, purchaseDetail(21));

    const bank = banking.transactions.find((row) => row.handle === 20);
    expect(bank).toMatchObject({
      accountKey: "acct-1",
      amount: -PURCHASE,
      isTransfer: false,
      linkedTransactionId: null,
    });
    // The trade names the account the funds came from, exactly as a natively
    // entered purchase funded from elsewhere does, and adopts that row rather
    // than writing a second one.
    expect(investments.transactions[0]).toMatchObject({
      accountKey: "acct-5",
      action: InvestmentAction.BUY,
      cashAccountKey: "acct-1",
      fundingAccountKey: "acct-1",
      cashTransactionId: bank?.id,
      transactionSplitId: null,
      exchangeRate: 1,
    });
    expect(banking.transfersLinked).toBe(0);
    expect(banking.warnings).toEqual([]);
    expect(investments.warnings).toEqual([]);
  });

  it("moves each balance exactly once", () => {
    const { balances } = mapAll(moneyRows, purchaseDetail(21));

    // The sleeve is untouched -- no cash ever arrived there or left it.
    expect(balances.get("acct-6")).toBe(SLEEVE_OPENING);
    expect(balances.get("acct-1")).toBe(-PURCHASE);
    expect(balances.get("acct-5")).toBe(0);
  });

  it("voids the funding row when Money voided the trade", () => {
    // The row would otherwise claim the chequing account paid for a purchase
    // that, per the trade beside it, never happened -- and it would move the
    // balance, since only VOID rows are excluded from it.
    const { banking, investments, balances } = mapAll(
      transactionData({
        transactions: [
          mnyTransaction({ handle: 20, account: CHEQUING, amount: -PURCHASE }),
          mnyTransaction({
            handle: 21,
            account: BROKERAGE,
            amount: PURCHASE,
            security: SECURITY,
            action: MNY_ACTION.BUY,
            flags: MNY_TRANSACTION_FLAG.VOID,
          }),
        ],
        transfers: [mnyTransfer({ from: 20, to: 21 })],
      }),
      purchaseDetail(21),
    );

    expect(investments.transactions[0].status).toBe(TransactionStatus.VOID);
    expect(banking.transactions[0].status).toBe(TransactionStatus.VOID);
    expect(balances.get("acct-1")).toBe(0);
  });

  it("derives the rate when the paying account is in another currency", () => {
    // Money records both halves of one event: 2,400 in the brokerage's currency
    // and 3,120 leaving a CAD chequing account. Their ratio is the rate the
    // settlement happened at, and writing 1 there would post the cash
    // unconverted -- short by the whole spread.
    const mappedAccounts = mapAccounts(
      referenceData({
        currencies: [
          mnyCurrency({ handle: 1, isoCode: "USD" }),
          mnyCurrency({ handle: 2, isoCode: "CAD" }),
        ],
        accounts: [
          mnyAccount({
            handle: CHEQUING,
            type: 0,
            name: "Chequing",
            currency: 2,
          }),
          mnyAccount({
            handle: BROKERAGE,
            type: 5,
            name: "Brokerage",
            relatedAccount: SLEEVE,
            currency: 1,
          }),
          mnyAccount({
            handle: SLEEVE,
            type: 0,
            name: "Brokerage (Cash)",
            relatedAccount: BROKERAGE,
            currency: 1,
          }),
        ],
      }),
      DEFAULT_MNY_IMPORT_OPTIONS,
      "USD",
    );
    const rows = transactionData({
      transactions: [
        mnyTransaction({ handle: 20, account: CHEQUING, amount: -3_120 }),
        mnyTransaction({
          handle: 21,
          account: BROKERAGE,
          amount: PURCHASE,
          security: SECURITY,
          action: MNY_ACTION.BUY,
        }),
      ],
      transfers: [mnyTransfer({ from: 20, to: 21 })],
    });

    const mappedInvestments = mapInvestments({
      transactions: rows,
      investments: purchaseDetail(21),
      accounts: mappedAccounts,
      securities: securities(),
      bills: [],
    });
    const banking = mapTransactions({
      transactions: rows,
      accountKeyByHandle: mappedAccounts.keyByHandle,
      currencyByHandle: mappedAccounts.currencyByHandle,
      bills: [],
      cashKeyByAccountKey: cashKeyByAccountKey(mappedAccounts),
      tradesByHandle: tradesByHandle(mappedInvestments),
    });
    const investments = applyInvestmentCashSources(
      mappedInvestments,
      banking.investmentCashSources,
    );

    expect(investments.transactions[0]).toMatchObject({
      currencyCode: "USD",
      totalAmount: PURCHASE,
      cashAccountKey: "acct-1",
      exchangeRate: 1.3,
    });
  });
});

describe("a trade the investment mapper did not write", () => {
  it("keeps Money's own funding row as an ordinary transfer", () => {
    // `act` 99 is not an action Monize knows, so there is no trade to fund.
    // Dropping the pairing's meaning here would be inventing one: the money
    // Money recorded still has to arrive somewhere, so the old synthesized
    // sleeve counterpart is what stands in for the row that will not exist.
    const { banking, investments } = mapAll(
      transactionData({
        transactions: [
          mnyTransaction({ handle: 20, account: CHEQUING, amount: -PURCHASE }),
          mnyTransaction({
            handle: 21,
            account: BROKERAGE,
            amount: PURCHASE,
            security: SECURITY,
            action: 99,
          }),
        ],
        transfers: [mnyTransfer({ from: 20, to: 21 })],
      }),
      purchaseDetail(21),
    );

    expect(investments.transactions).toEqual([]);
    expect(banking.transactions).toHaveLength(2);
    expect(
      banking.transactions.find((row) => row.accountKey === "acct-6"),
    ).toMatchObject({ amount: PURCHASE, isTransfer: true });
  });
});

describe("cash moved into the sleeve without a trade", () => {
  it("imports both sides of an ordinary transfer into the cash account", () => {
    // Neither side carries a security, so this is a plain transfer between two
    // accounts and none of the trade-cash-leg reasoning applies to it.
    const { banking, balances } = mapAll(
      transactionData({
        transactions: [
          mnyTransaction({ handle: 20, account: CHEQUING, amount: -1_000 }),
          mnyTransaction({ handle: 21, account: SLEEVE, amount: 1_000 }),
        ],
        transfers: [mnyTransfer({ from: 20, to: 21 })],
      }),
      investmentData(),
    );

    expect(banking.tradeCashLegs).toBe(0);
    expect(banking.transactions).toHaveLength(2);
    expect(banking.transfersLinked).toBe(1);
    expect(balances.get("acct-6")).toBe(SLEEVE_OPENING + 1_000);
  });
});

describe("a split with a leg paying for a trade (issue #1211)", () => {
  /**
   * Issue #515 gave Monize a place for exactly this: a split leg whose amount
   * *is* an investment action's cash impact, with the investment row embedded
   * in the leg. The import did not use it -- the leg became a transfer to the
   * brokerage's cash sleeve, so the register showed the purchase as a transfer
   * to an account the user never chose, and the sleeve gained a transfer in and
   * a purchase out that Money shows nothing of.
   */
  const paycheque = (parentAccount: number) =>
    transactionData({
      transactions: [
        mnyTransaction({ handle: 20, account: parentAccount, amount: -2_500 }),
        mnyTransaction({
          handle: 21,
          account: parentAccount,
          amount: -PURCHASE,
        }),
        mnyTransaction({ handle: 22, account: parentAccount, amount: -100 }),
        mnyTransaction({
          handle: 23,
          account: BROKERAGE,
          amount: PURCHASE,
          security: SECURITY,
          action: MNY_ACTION.BUY,
        }),
      ],
      splits: [
        mnySplit({ parent: 20, child: 21, position: 0 }),
        mnySplit({ parent: 20, child: 22, position: 1 }),
      ],
      transfers: [mnyTransfer({ from: 21, to: 23 })],
    });

  it("embeds the trade in the leg instead of transferring to the sleeve", () => {
    const { banking, investments } = mapAll(
      paycheque(CHEQUING),
      purchaseDetail(23),
    );

    const parent = banking.transactions.find((row) => row.handle === 20);
    expect(parent?.splits).toHaveLength(2);
    expect(parent?.splits[0]).toMatchObject({
      kind: SplitKind.INVESTMENT,
      categoryHandle: null,
      transferAccountKey: null,
      linkedTransactionId: null,
      investmentHandle: 23,
      amount: -PURCHASE,
    });

    expect(investments.transactions[0]).toMatchObject({
      accountKey: "acct-5",
      action: InvestmentAction.BUY,
      transactionSplitId: parent?.splits[0].id,
      cashTransactionId: null,
      // Embedded rows name no funding account: the parent transaction's own
      // account is the cash side, the same shape `createEmbeddedForSplit` writes.
      fundingAccountKey: null,
      cashAccountKey: "acct-1",
    });
  });

  it("puts no row in any cash register but the parent's own", () => {
    const { banking, rowsIn, sleeveRows, balances } = mapAll(
      paycheque(CHEQUING),
      purchaseDetail(23),
    );

    expect(banking.transactions).toHaveLength(1);
    expect(rowsIn("acct-1")).toHaveLength(1);
    expect(sleeveRows).toEqual([]);
    expect(balances.get("acct-1")).toBe(-2_500);
    expect(balances.get("acct-6")).toBe(SLEEVE_OPENING);
  });

  it("does the same when the split sits in the sleeve itself", () => {
    // The old rule kept a synthesized counterpart here, on the premise that the
    // parent had already taken the cash out and something had to put it back.
    // With the trade embedded in the leg there is nothing to put back: the
    // parent row is the only movement, and it is already right.
    const { banking, sleeveRows, balances } = mapAll(
      paycheque(SLEEVE),
      purchaseDetail(23),
    );

    expect(sleeveRows).toHaveLength(1);
    expect(banking.transactions.map((row) => row.handle)).toEqual([20]);
    expect(balances.get("acct-6")).toBe(SLEEVE_OPENING - 2_500);
  });
});

/**
 * A CD redemption that paid accrued interest. Money writes it as a split in the
 * cash account -- principal in the investment leg, interest in a sibling -- and
 * Monize records the interest on the redemption's own INTEREST companion
 * instead, so the split has nothing left to hold and the parent becomes the
 * redemption's single cash row.
 * docs/specs/redemption-accrued-interest.md section 5.
 */
describe("a redemption whose interest Money put in a sibling split leg", () => {
  const PRINCIPAL = 10_000;
  const INTEREST = 87.5;
  const PAYOUT = PRINCIPAL + INTEREST;

  const redemptionRows = (legs: { amount: number; handle: number }[]) =>
    transactionData({
      transactions: [
        mnyTransaction({ handle: 20, account: SLEEVE, amount: PAYOUT }),
        ...legs.map((leg) =>
          mnyTransaction({
            handle: leg.handle,
            account: SLEEVE,
            amount: leg.amount,
          }),
        ),
        mnyTransaction({
          handle: 23,
          account: BROKERAGE,
          amount: PAYOUT,
          security: SECURITY,
          action: MNY_ACTION.REDEEM_CD_BOND,
        }),
      ],
      splits: legs.map((leg, position) =>
        mnySplit({ parent: 20, child: leg.handle, position }),
      ),
      transfers: [mnyTransfer({ from: 21, to: 23 })],
    });

  const redemptionDetail = investmentData({
    securities: [mnySecurity({ handle: SECURITY, symbol: "VOO" })],
    investmentDetails: [
      mnyInvestmentDetail({
        transaction: 23,
        price: 1_000,
        quantity: 10,
        interest: INTEREST,
      }),
    ],
  });

  const twoLegs = () =>
    redemptionRows([
      { handle: 21, amount: PRINCIPAL },
      { handle: 22, amount: INTEREST },
    ]);

  it("collapses the split into one cash row the redemption adopts", () => {
    const { banking, investments } = mapAll(twoLegs(), redemptionDetail);

    const parent = banking.transactions.find((row) => row.handle === 20);
    expect(parent?.splits).toEqual([]);
    expect(parent?.collapsedTradeHandle).toBe(23);
    expect(parent?.amount).toBe(PAYOUT);

    const redemption = investments.transactions.find(
      (row) => row.action === InvestmentAction.REDEEM,
    );
    expect(redemption).toMatchObject({
      // Proceeds, so the realized-gain folds are unaffected by the interest.
      totalAmount: PRINCIPAL,
      cashTransactionId: parent?.id,
      transactionSplitId: null,
      fundingAccountKey: "acct-6",
    });
  });

  it("leaves the sleeve holding one row for the whole payout", () => {
    const { sleeveRows, balances } = mapAll(twoLegs(), redemptionDetail);

    // The defect this guards: registering no cash source makes the trade write
    // its own sleeve row beside Money's, and the account gains the payout twice.
    expect(sleeveRows).toHaveLength(1);
    expect(balances.get("acct-6")).toBe(SLEEVE_OPENING + PAYOUT);
  });

  it("records the interest once, as a linked INTEREST row", () => {
    const { investments } = mapAll(twoLegs(), redemptionDetail);

    const companions = investments.transactions.filter(
      (row) => row.action === InvestmentAction.INTEREST,
    );
    expect(companions).toHaveLength(1);
    expect(companions[0]).toMatchObject({
      totalAmount: INTEREST,
      cashAmount: 0,
      cashAccountKey: null,
    });
  });

  it("keeps a split whose sibling is not the accrued interest", () => {
    // Only the shape Money writes for this one thing is rewritten. A leg that
    // records something else is the user's data, and it stays a split.
    const { banking, investments } = mapAll(
      redemptionRows([
        { handle: 21, amount: PRINCIPAL },
        { handle: 22, amount: INTEREST + 10 },
      ]),
      redemptionDetail,
    );

    const parent = banking.transactions.find((row) => row.handle === 20);
    expect(parent?.splits).toHaveLength(2);
    expect(parent?.collapsedTradeHandle).toBeNull();
    expect(
      investments.transactions.find(
        (row) => row.action === InvestmentAction.REDEEM,
      ),
    ).toMatchObject({
      transactionSplitId: parent?.splits[0].id,
      linkedInvestmentId: null,
      accruedInterest: 0,
    });
    expect(
      investments.transactions.filter(
        (row) => row.action === InvestmentAction.INTEREST,
      ),
    ).toHaveLength(0);
  });

  it("keeps a three-leg split", () => {
    const { banking, investments } = mapAll(
      redemptionRows([
        { handle: 21, amount: PRINCIPAL },
        { handle: 22, amount: INTEREST },
        { handle: 24, amount: 25 },
      ]),
      redemptionDetail,
    );

    const parent = banking.transactions.find((row) => row.handle === 20);
    expect(parent?.splits).toHaveLength(3);
    expect(parent?.collapsedTradeHandle).toBeNull();
    expect(
      investments.transactions.find(
        (row) => row.action === InvestmentAction.REDEEM,
      ),
    ).toMatchObject({
      transactionSplitId: parent?.splits[0].id,
      linkedInvestmentId: null,
      accruedInterest: 0,
    });
    expect(
      investments.transactions.filter(
        (row) => row.action === InvestmentAction.INTEREST,
      ),
    ).toHaveLength(0);
  });
});
