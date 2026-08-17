import { InvestmentAction } from "../../../securities/entities/investment-transaction.entity";
import {
  investmentData,
  mnyAccount,
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
import { MNY_ACTION } from "../model/mny-model";
import { computeExpectedBalances } from "../mny-parser.service";
import { mapAccounts, cashKeyByAccountKey } from "./map-reference";
import { mapSecurities } from "./map-securities";
import { mapTransactions } from "./map-transactions";
import { mapInvestments } from "./map-investments";

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

  const banking = mapTransactions({
    transactions,
    accountKeyByHandle: mappedAccounts.keyByHandle,
    currencyByHandle: mappedAccounts.currencyByHandle,
    bills: [],
    cashKeyByAccountKey: cashKeyByAccountKey(mappedAccounts),
  });
  const investments = mapInvestments({
    transactions,
    investments: investmentTables,
    accounts: mappedAccounts,
    securities: mappedSecurities,
    bills: [],
  });

  return {
    banking,
    investments,
    /** Every row that will exist in the sleeve, from both writers. */
    sleeveRows: [
      ...banking.transactions.filter((row) => row.accountKey === "acct-6"),
      ...investments.transactions.filter(
        (row) => row.cashAccountKey === "acct-6" && row.cashAmount !== 0,
      ),
    ],
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

describe("a trade funded from an outside account", () => {
  /**
   * The other shape, and the one `buildCashCounterparts` exists for: the far
   * side of the transfer is the trade itself, so Monize has to synthesize the
   * cash arriving in the sleeve. Money shows two rows in the cash register for
   * this -- the transfer in, then the purchase -- and so does Monize.
   */
  const moneyRows = transactionData({
    transactions: [
      mnyTransaction({ handle: 20, account: CHEQUING, amount: -PURCHASE }),
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

  it("still synthesizes the cash arriving in the sleeve", () => {
    const { banking, sleeveRows, balances } = mapAll(
      moneyRows,
      purchaseDetail(21),
    );

    expect(banking.tradeCashLegs).toBe(0);
    expect(sleeveRows).toHaveLength(2);
    expect(
      banking.transactions.find((row) => row.accountKey === "acct-6"),
    ).toMatchObject({ amount: PURCHASE, isTransfer: true });

    // Cash in, cash out: the sleeve ends where it started and the chequing
    // account paid for the shares.
    expect(balances.get("acct-6")).toBe(SLEEVE_OPENING);
    expect(balances.get("acct-1")).toBe(-PURCHASE);
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

describe("a split in the sleeve with a leg paying for a trade", () => {
  it("keeps the synthesized counterpart, which is what balances the parent", () => {
    // A split *leg* is a different shape from a top-level row: the parent has
    // already taken the whole amount out of the sleeve, so the counterpart put
    // back in is what stops the trade's own leg debiting it twice. Dropping it
    // the way a top-level row is dropped would leave the sleeve short by the
    // purchase.
    const { banking, balances } = mapAll(
      transactionData({
        transactions: [
          mnyTransaction({ handle: 20, account: SLEEVE, amount: -2_500 }),
          mnyTransaction({ handle: 21, account: SLEEVE, amount: -PURCHASE }),
          mnyTransaction({ handle: 22, account: SLEEVE, amount: -100 }),
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
      }),
      purchaseDetail(23),
    );

    expect(banking.tradeCashLegs).toBe(0);
    expect(banking.transactions.find((row) => row.handle === 23)).toMatchObject(
      { accountKey: "acct-6", amount: PURCHASE },
    );
    // 5,000 - 2,500 (the split) + 2,400 (the counterpart) - 2,400 (the trade).
    expect(balances.get("acct-6")).toBe(SLEEVE_OPENING - 2_500);
  });
});
