import { AccountSubType } from "../../../accounts/entities/account.entity";
import { InvestmentAction } from "../../../securities/entities/investment-transaction.entity";
import { TransactionStatus } from "../../../transactions/entities/transaction.entity";
import { mnyLot, mnySecurity } from "../__fixtures__/mny-row-builders";
import {
  MappedAccounts,
  MappedInvestmentTransaction,
  MappedSecurities,
} from "../model/mny-import-model";
import { mapSecurities } from "./map-securities";
import { crossCheckHoldings, replayPositions } from "./check-holdings";

function accountsFixture(): MappedAccounts {
  const accounts = [
    {
      key: "acct-10",
      handle: 10,
      name: "Brokerage - Investments",
      moneyName: "Brokerage",
      accountType: "INVESTMENT" as never,
      accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
      currencyCode: "USD",
      openingBalance: 0,
      creditLimit: null,
      closed: false,
      closedDate: null,
      favourite: false,
      description: null,
      linkedKey: "acct-11",
    },
  ];

  return {
    baseCurrency: "USD",
    currencyCodes: ["USD"],
    accounts,
    keyByHandle: new Map([[10, "acct-10"]]),
    currencyByHandle: new Map([[10, "USD"]]),
    skipped: 0,
    warnings: [],
  };
}

const securities: MappedSecurities = mapSecurities({
  securities: [mnySecurity({ handle: 1, symbol: "VOO", name: "Vanguard" })],
  currencyByHandle: new Map(),
  baseCurrency: "USD",
  activeHandles: new Set([1]),
});

function tx(
  action: InvestmentAction,
  quantity: number | null,
  overrides: Partial<MappedInvestmentTransaction> = {},
): MappedInvestmentTransaction {
  return {
    id: `id-${action}-${quantity}-${overrides.transactionDate ?? ""}`,
    handle: 1,
    accountKey: "acct-10",
    cashAccountKey: null,
    fundingAccountKey: null,
    cashTransactionId: null,
    transactionSplitId: null,
    securityHandle: 1,
    action,
    transactionDate: "2026-01-01",
    quantity,
    price: 100,
    commission: 0,
    totalAmount: 0,
    currencyCode: "USD",
    exchangeRate: 1,
    cashAmount: 0,
    status: TransactionStatus.CLEARED,
    payeeHandle: null,
    categoryHandle: null,
    description: null,
    linkedInvestmentId: null,
    ...overrides,
  };
}

describe("replayPositions", () => {
  it("adds on buys and subtracts on sells", () => {
    const positions = replayPositions([
      tx(InvestmentAction.BUY, 10),
      tx(InvestmentAction.SELL, 4),
    ]);

    expect(positions.get("acct-10|1")).toBe(6);
  });

  it("treats REMOVE_SHARES and TRANSFER_OUT as reductions", () => {
    const positions = replayPositions([
      tx(InvestmentAction.ADD_SHARES, 10),
      tx(InvestmentAction.REMOVE_SHARES, 3),
      tx(InvestmentAction.TRANSFER_OUT, 2),
      tx(InvestmentAction.TRANSFER_IN, 5),
    ]);

    expect(positions.get("acct-10|1")).toBe(10);
  });

  it("multiplies by the ratio on a split", () => {
    const positions = replayPositions([
      tx(InvestmentAction.BUY, 10),
      tx(InvestmentAction.SPLIT, 3, { transactionDate: "2026-02-01" }),
    ]);

    expect(positions.get("acct-10|1")).toBe(30);
  });

  it("excludes a VOID BUY from the projection", () => {
    // Adversarial: a voided trade moved no shares, and Money's own open lots
    // never contain its quantity. Including it would inflate the projected
    // position to 15 and report a share discrepancy the import itself created.
    const positions = replayPositions([
      tx(InvestmentAction.BUY, 10),
      tx(InvestmentAction.BUY, 5, {
        transactionDate: "2026-02-01",
        status: TransactionStatus.VOID,
      }),
    ]);

    expect(positions.get("acct-10|1")).toBe(10);
  });

  it("ignores actions that move no shares", () => {
    const positions = replayPositions([
      tx(InvestmentAction.BUY, 10),
      tx(InvestmentAction.DIVIDEND, null),
      tx(InvestmentAction.CAPITAL_GAIN, null),
    ]);

    expect(positions.get("acct-10|1")).toBe(10);
  });
});

describe("crossCheckHoldings", () => {
  const base = { accounts: accountsFixture(), securities };

  it("returns nothing when the file has no LOT table", () => {
    const result = crossCheckHoldings({
      ...base,
      transactions: [tx(InvestmentAction.BUY, 10)],
      lots: [],
    });

    expect(result.checks).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("passes when open lots and the replay agree", () => {
    const result = crossCheckHoldings({
      ...base,
      transactions: [
        tx(InvestmentAction.BUY, 10),
        tx(InvestmentAction.SELL, 4),
      ],
      lots: [
        mnyLot({ handle: 1, account: 10, security: 1, quantity: 6 }),
        // A closed lot: Money keeps it, and it is not part of the position.
        mnyLot({
          handle: 2,
          account: 10,
          security: 1,
          quantity: 4,
          sellTransaction: 99,
        }),
      ],
    });

    expect(result.checks).toEqual([
      {
        accountKey: "acct-10",
        securityHandle: 1,
        symbol: "VOO",
        lotQuantity: 6,
        replayQuantity: 6,
        delta: 0,
        matches: true,
      },
    ]);
    expect(result.warnings).toEqual([]);
  });

  // A seeded mismatch must warn, never fail the import: PR #192's investment
  // accounts were wrong precisely because bad positions were written silently.
  it("warns, naming the account and security, when they disagree", () => {
    const result = crossCheckHoldings({
      ...base,
      transactions: [tx(InvestmentAction.BUY, 10)],
      lots: [mnyLot({ account: 10, security: 1, quantity: 4 })],
    });

    expect(result.checks[0]).toMatchObject({
      lotQuantity: 4,
      replayQuantity: 10,
      delta: 6,
      matches: false,
    });
    expect(result.warnings).toEqual([
      {
        code: "holdingsMismatch",
        subject: "Brokerage - Investments: VOO",
        detail: "replay 10 vs lots 4",
      },
    ]);
  });

  it("reports a position the lots know about and the replay does not", () => {
    const result = crossCheckHoldings({
      ...base,
      transactions: [],
      lots: [mnyLot({ account: 10, security: 1, quantity: 12 })],
    });

    expect(result.checks[0]).toMatchObject({
      lotQuantity: 12,
      replayQuantity: 0,
      matches: false,
    });
  });

  it("ignores lots in an account the user left out", () => {
    const result = crossCheckHoldings({
      ...base,
      transactions: [],
      lots: [mnyLot({ account: 77, security: 1, quantity: 12 })],
    });

    expect(result.checks).toEqual([]);
  });

  it("drops lines both readings agree are closed positions", () => {
    const result = crossCheckHoldings({
      ...base,
      transactions: [tx(InvestmentAction.BUY, 5), tx(InvestmentAction.SELL, 5)],
      lots: [
        mnyLot({ account: 10, security: 1, quantity: 5, sellTransaction: 9 }),
      ],
    });

    expect(result.checks).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("tolerates rounding at the eighth decimal place", () => {
    const result = crossCheckHoldings({
      ...base,
      transactions: [tx(InvestmentAction.BUY, 10)],
      lots: [mnyLot({ account: 10, security: 1, quantity: 10.000000001 })],
    });

    expect(result.checks[0].matches).toBe(true);
  });
});
