import { AccountSubType } from "../../../accounts/entities/account.entity";
import { InvestmentAction } from "../../../securities/entities/investment-transaction.entity";
import { TransactionStatus } from "../../../transactions/entities/transaction.entity";
import {
  investmentData,
  mnyBill,
  mnyInvestmentDetail,
  mnySecurity,
  mnySecurityPrice,
  mnySecuritySplit,
  mnySplit,
  mnyTransaction,
  transactionData,
} from "../__fixtures__/mny-row-builders";
import { MappedAccounts, MappedSecurities } from "../model/mny-import-model";
import { MNY_ACTION, MNY_TRANSACTION_FLAG } from "../model/mny-model";
import { mapSecurities } from "./map-securities";
import { MapInvestmentsInput, mapInvestments } from "./map-investments";

/**
 * A Money investment account is an `at = 5` row plus its cash companion, which
 * `mapAccounts` turns into a linked brokerage/cash pair. These fixtures build
 * that shape directly: `hacct` 10 is the brokerage, `hacct` 11 its cash sleeve.
 */
function accountsFixture(handles: number[] = [10]): MappedAccounts {
  const accounts = handles.flatMap((handle) => [
    {
      key: `acct-${handle + 1}`,
      handle: handle + 1,
      name: `Brokerage ${handle} - Cash`,
      moneyName: `Brokerage ${handle} (Cash)`,
      accountType: "INVESTMENT" as never,
      accountSubType: AccountSubType.INVESTMENT_CASH,
      currencyCode: "USD",
      openingBalance: 0,
      creditLimit: null,
      closed: false,
      closedDate: null,
      favourite: false,
      excludeFromNetWorth: false,
      description: null,
      linkedKey: `acct-${handle}`,
    },
    {
      key: `acct-${handle}`,
      handle,
      name: `Brokerage ${handle} - Investments`,
      moneyName: `Brokerage ${handle}`,
      accountType: "INVESTMENT" as never,
      accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
      currencyCode: "USD",
      openingBalance: 0,
      creditLimit: null,
      closed: false,
      closedDate: null,
      favourite: false,
      excludeFromNetWorth: false,
      description: null,
      linkedKey: `acct-${handle + 1}`,
    },
  ]);

  return {
    baseCurrency: "USD",
    currencyCodes: ["USD"],
    accounts,
    keyByHandle: new Map(accounts.map((a) => [a.handle as number, a.key])),
    currencyByHandle: new Map(
      accounts.map((a) => [a.handle as number, a.currencyCode]),
    ),
    skipped: 0,
    warnings: [],
  };
}

function securitiesFixture(handles: number[] = [1]): MappedSecurities {
  return mapSecurities({
    securities: handles.map((handle) =>
      mnySecurity({
        handle,
        symbol: `SEC${handle}`,
        name: `Security ${handle}`,
      }),
    ),
    currencyByHandle: new Map(),
    baseCurrency: "USD",
    activeHandles: new Set(handles),
  });
}

function input(
  overrides: Partial<MapInvestmentsInput> = {},
): MapInvestmentsInput {
  return {
    transactions: transactionData(),
    investments: investmentData(),
    accounts: accountsFixture(),
    securities: securitiesFixture(),
    bills: [],
    ...overrides,
  };
}

/** A `TRN` row in the brokerage account carrying a security. */
function invRow(overrides: Parameters<typeof mnyTransaction>[0] = {}) {
  return mnyTransaction({ account: 10, security: 1, ...overrides });
}

describe("mapInvestments", () => {
  describe("action mapping", () => {
    it("maps a buy with its quantity, price and commission", () => {
      const result = mapInvestments(
        input({
          transactions: transactionData({
            transactions: [
              invRow({ handle: 1, action: MNY_ACTION.BUY, amount: -1009.99 }),
            ],
          }),
          investments: investmentData({
            investmentDetails: [
              mnyInvestmentDetail({
                transaction: 1,
                quantity: 10,
                price: 100,
                commission: 9.99,
              }),
            ],
          }),
        }),
      );

      expect(result.transactions).toHaveLength(1);
      expect(result.transactions[0]).toMatchObject({
        handle: 1,
        accountKey: "acct-10",
        cashAccountKey: "acct-11",
        securityHandle: 1,
        action: InvestmentAction.BUY,
        quantity: 10,
        price: 100,
        commission: 9.99,
        totalAmount: 1009.99,
        cashAmount: -1009.99,
        currencyCode: "USD",
      });
    });

    it("maps a sell with cash arriving in the sleeve", () => {
      const result = mapInvestments(
        input({
          transactions: transactionData({
            transactions: [
              invRow({ handle: 1, action: MNY_ACTION.SELL, amount: 990.01 }),
            ],
          }),
          investments: investmentData({
            investmentDetails: [
              mnyInvestmentDetail({
                transaction: 1,
                quantity: 10,
                price: 100,
                commission: 9.99,
              }),
            ],
          }),
        }),
      );

      expect(result.transactions[0]).toMatchObject({
        action: InvestmentAction.SELL,
        totalAmount: 990.01,
        cashAmount: 990.01,
      });
    });

    // PR #192 iterated TRN_INV and so dropped every cash dividend in the file.
    it("maps an act=3 dividend, which has no TRN_INV row at all", () => {
      const result = mapInvestments(
        input({
          transactions: transactionData({
            transactions: [
              invRow({ handle: 1, action: MNY_ACTION.DIVIDEND, amount: 42.5 }),
            ],
          }),
        }),
      );

      expect(result.transactions).toHaveLength(1);
      expect(result.transactions[0]).toMatchObject({
        action: InvestmentAction.DIVIDEND,
        quantity: null,
        price: null,
        totalAmount: 42.5,
        cashAmount: 42.5,
        cashAccountKey: "acct-11",
      });
      expect(
        result.warnings.filter((w) => w.code === "missingInvestmentDetail"),
      ).toHaveLength(0);
    });

    // The PoC mapped act=16 to SELL, inventing proceeds and wrecking cost basis.
    it("maps act=16 to REMOVE_SHARES, never SELL", () => {
      const result = mapInvestments(
        input({
          transactions: transactionData({
            transactions: [
              invRow({
                handle: 1,
                action: MNY_ACTION.REMOVE_SHARES,
                amount: 0,
              }),
            ],
          }),
          investments: investmentData({
            investmentDetails: [
              mnyInvestmentDetail({ transaction: 1, quantity: 5, price: 100 }),
            ],
          }),
        }),
      );

      expect(result.transactions[0]).toMatchObject({
        action: InvestmentAction.REMOVE_SHARES,
        quantity: 5,
        totalAmount: 0,
        cashAmount: 0,
        cashAccountKey: null,
      });
    });

    it("gives a reinvestment a value but no cash leg", () => {
      const result = mapInvestments(
        input({
          transactions: transactionData({
            transactions: [
              invRow({ handle: 1, action: MNY_ACTION.REINVEST, amount: 250 }),
            ],
          }),
          investments: investmentData({
            investmentDetails: [
              mnyInvestmentDetail({
                transaction: 1,
                quantity: 2.5,
                price: 100,
              }),
            ],
          }),
        }),
      );

      expect(result.transactions[0]).toMatchObject({
        action: InvestmentAction.REINVEST,
        totalAmount: 250,
        cashAmount: 0,
        cashAccountKey: null,
      });
    });

    /**
     * Money's "Interest" activity (issue #1149): fixed-income interest paid to
     * a cash account, filed on tax reports as interest. While the code's name
     * was unknown it imported as DIVIDEND, which misfiled it. The file stores
     * the amount with the opposite sign from what Money's UI shows; direction
     * comes from the action, so the sleeve is still paid into.
     */
    it("maps act=4 interest to INTEREST with cash arriving in the sleeve", () => {
      const result = mapInvestments(
        input({
          transactions: transactionData({
            transactions: [
              invRow({ handle: 1, action: MNY_ACTION.INTEREST, amount: -37.2 }),
            ],
          }),
        }),
      );

      expect(result.transactions).toHaveLength(1);
      expect(result.transactions[0]).toMatchObject({
        action: InvestmentAction.INTEREST,
        quantity: null,
        price: null,
        totalAmount: 37.2,
        cashAmount: 37.2,
        cashAccountKey: "acct-11",
      });
      // Both halves are known now -- measured cash-only shape, name from
      // issue #1149 -- so the row is neither warned about nor flagged as
      // missing detail.
      expect(result.warnings).toHaveLength(0);
    });

    /**
     * Money's "Reinvest Interest" (issue #1149): CD/bond interest accrued
     * straight back into the holding. Like every reinvestment, it has a value
     * and no cash leg -- charging it to the sleeve would double-count money
     * that never landed there.
     */
    it("maps act=10 reinvested interest to REINVEST_INTEREST with no cash leg", () => {
      const result = mapInvestments(
        input({
          transactions: transactionData({
            transactions: [
              invRow({
                handle: 1,
                action: MNY_ACTION.REINVEST_INTEREST,
                amount: 125.5,
              }),
            ],
          }),
          investments: investmentData({
            investmentDetails: [
              mnyInvestmentDetail({
                transaction: 1,
                quantity: 125.5,
                price: 1,
              }),
            ],
          }),
        }),
      );

      expect(result.transactions[0]).toMatchObject({
        action: InvestmentAction.REINVEST_INTEREST,
        quantity: 125.5,
        totalAmount: 125.5,
        cashAmount: 0,
        cashAccountKey: null,
      });
      // Unmeasured on any file available here, so every row stays visible in
      // the verification report.
      expect(result.warnings).toContainEqual({
        code: "unconfirmedInvestmentAction",
        subject: "htrn=1",
        detail: `act=${MNY_ACTION.REINVEST_INTEREST}`,
        row: expect.objectContaining({ handle: 1 }),
      });
    });

    /**
     * Money's cash capital-gain distributions (issue #1149): short-term
     * (act 24) and long-term (act 26) both pay into the cash sleeve. Monize
     * has a single CAPITAL_GAIN action, so the term distinction ends at the
     * import. As cash payouts they are expected to have no TRN_INV row, and
     * its absence is not a missing-detail defect.
     */
    it.each([
      [MNY_ACTION.ST_CAPITAL_GAINS_DIST, InvestmentAction.CAPITAL_GAIN_SHORT],
      [MNY_ACTION.LT_CAPITAL_GAINS_DIST, InvestmentAction.CAPITAL_GAIN_LONG],
    ])("maps the cash capital-gain distribution act=%p", (act, expected) => {
      const result = mapInvestments(
        input({
          transactions: transactionData({
            transactions: [invRow({ handle: 1, action: act, amount: -88.4 })],
          }),
        }),
      );

      expect(result.transactions[0]).toMatchObject({
        action: expected,
        quantity: null,
        totalAmount: 88.4,
        cashAmount: 88.4,
        cashAccountKey: "acct-11",
      });
      expect(
        result.warnings.filter((w) => w.code === "missingInvestmentDetail"),
      ).toHaveLength(0);
      expect(result.warnings).toContainEqual(
        expect.objectContaining({
          code: "unconfirmedInvestmentAction",
          detail: `act=${act}`,
        }),
      );
    });

    /**
     * Money's reinvested capital-gain distributions (issue #1149): short-term
     * (act 27) and long-term (act 29) buy the distribution straight back into
     * the security -- a value, a position, and no cash leg.
     */
    it.each([
      [
        MNY_ACTION.REINVEST_ST_CAPITAL_GAINS,
        InvestmentAction.REINVEST_CAPITAL_GAIN_SHORT,
      ],
      [
        MNY_ACTION.REINVEST_LT_CAPITAL_GAINS,
        InvestmentAction.REINVEST_CAPITAL_GAIN_LONG,
      ],
    ])(
      "maps the reinvested capital-gain distribution act=%p",
      (act, expected) => {
        const result = mapInvestments(
          input({
            transactions: transactionData({
              transactions: [invRow({ handle: 1, action: act, amount: 61.75 })],
            }),
            investments: investmentData({
              investmentDetails: [
                mnyInvestmentDetail({
                  transaction: 1,
                  quantity: 2.47,
                  price: 25,
                }),
              ],
            }),
          }),
        );

        expect(result.transactions[0]).toMatchObject({
          action: expected,
          quantity: 2.47,
          totalAmount: 61.75,
          cashAmount: 0,
          cashAccountKey: null,
        });
      },
    );

    /**
     * Money's "Redeem CD/Bond" (issue #1149): a disposal whose cash figure may
     * carry accrued interest on top of quantity x price. TRN.amt wins as the
     * total -- recomputing from the detail would drop the accrued component --
     * so the sleeve receives exactly what Money says the redemption paid.
     */
    it("maps act=30 redeem CD/bond to REDEEM with TRN.amt as the proceeds", () => {
      const result = mapInvestments(
        input({
          transactions: transactionData({
            transactions: [
              invRow({
                handle: 1,
                action: MNY_ACTION.REDEEM_CD_BOND,
                amount: 10087.5,
              }),
            ],
          }),
          investments: investmentData({
            investmentDetails: [
              // 10,000 face value; the extra 87.50 is accrued interest.
              mnyInvestmentDetail({
                transaction: 1,
                quantity: 10000,
                price: 1,
              }),
            ],
          }),
        }),
      );

      expect(result.transactions[0]).toMatchObject({
        action: InvestmentAction.REDEEM,
        quantity: 10000,
        totalAmount: 10087.5,
        cashAmount: 10087.5,
        cashAccountKey: "acct-11",
      });
    });

    /**
     * `TRN_INV.amtInt` is the accrued interest inside that `TRN.amt`. It is
     * income, not proceeds, so it comes back out of the redemption's total --
     * which the realized-gain folds measure against cost basis -- and rides on
     * a linked INTEREST companion instead. The cash the sleeve receives is
     * unchanged: one movement of money, carrying both.
     * docs/specs/redemption-accrued-interest.md section 5.
     */
    it("splits act=30's amtInt out of the proceeds onto a linked INTEREST row", () => {
      const result = mapInvestments(
        input({
          transactions: transactionData({
            transactions: [
              invRow({
                handle: 1,
                action: MNY_ACTION.REDEEM_CD_BOND,
                amount: 10087.5,
              }),
            ],
          }),
          investments: investmentData({
            investmentDetails: [
              mnyInvestmentDetail({
                transaction: 1,
                quantity: 10000,
                price: 1,
                interest: 87.5,
              }),
            ],
          }),
        }),
      );

      expect(result.transactions).toHaveLength(2);
      const [redemption, companion] = result.transactions;

      expect(redemption).toMatchObject({
        action: InvestmentAction.REDEEM,
        totalAmount: 10000,
        // The interest still reaches the sleeve, in the redemption's own row.
        cashAmount: 10087.5,
        cashAccountKey: "acct-11",
        linkedInvestmentId: companion.id,
      });
      expect(companion).toMatchObject({
        action: InvestmentAction.INTEREST,
        totalAmount: 87.5,
        price: 87.5,
        quantity: null,
        // No second cash row, and no handle: nothing may adopt a banking row
        // on the companion's behalf.
        cashAmount: 0,
        cashAccountKey: null,
        handle: null,
        linkedInvestmentId: redemption.id,
      });
    });

    it("leaves accrued interest on a non-redemption alone", () => {
      // Money records amtInt on other detail rows too, but no other action
      // pays it out, so nothing may invent an interest row from it.
      const result = mapInvestments(
        input({
          transactions: transactionData({
            transactions: [
              invRow({ handle: 1, action: MNY_ACTION.SELL, amount: 500 }),
            ],
          }),
          investments: investmentData({
            investmentDetails: [
              mnyInvestmentDetail({
                transaction: 1,
                quantity: 5,
                price: 100,
                interest: 12.5,
              }),
            ],
          }),
        }),
      );

      expect(result.transactions).toHaveLength(1);
      expect(result.transactions[0]).toMatchObject({
        action: InvestmentAction.SELL,
        totalAmount: 500,
        cashAmount: 500,
      });
    });

    /**
     * `act` 12 credits units to a plan account that no cash pays for: it never
     * has a `TRN_XFER` cash counterpart in 92 occurrences, where `act` 1 has one
     * 2,015 times in 2,029. Charging its value to the sleeve, as BUY does, left
     * one employer-matched RRSP $18,457.22 overdrawn against Money's own $91.00.
     */
    it("gives act=12 a value and a position but no cash leg", () => {
      const result = mapInvestments(
        input({
          transactions: transactionData({
            transactions: [
              invRow({
                handle: 1,
                action: MNY_ACTION.CONTRIBUTION,
                amount: 392.99,
              }),
            ],
          }),
          investments: investmentData({
            investmentDetails: [
              mnyInvestmentDetail({
                transaction: 1,
                quantity: 37.706223,
                price: 10.422481,
              }),
            ],
          }),
        }),
      );

      expect(result.transactions[0]).toMatchObject({
        action: InvestmentAction.REINVEST,
        quantity: 37.706223,
        totalAmount: 392.99,
        cashAmount: 0,
        cashAccountKey: null,
      });
    });

    it("takes quantity as positive even when Money stored it signed", () => {
      const result = mapInvestments(
        input({
          transactions: transactionData({
            transactions: [invRow({ handle: 1, action: MNY_ACTION.SELL })],
          }),
          investments: investmentData({
            investmentDetails: [
              mnyInvestmentDetail({
                transaction: 1,
                quantity: -10,
                price: 100,
              }),
            ],
          }),
        }),
      );

      expect(result.transactions[0].quantity).toBe(10);
      expect(result.transactions[0].action).toBe(InvestmentAction.SELL);
    });

    it("skips an unknown act code and counts it", () => {
      const result = mapInvestments(
        input({
          transactions: transactionData({
            transactions: [invRow({ handle: 1, action: 99 })],
          }),
        }),
      );

      expect(result.transactions).toHaveLength(0);
      expect(result.skipped).toBe(1);
      expect(result.warnings).toEqual([
        {
          code: "unknownInvestmentAction",
          subject: "htrn=1",
          detail: "act=99",
          row: expect.objectContaining({ handle: 1 }),
        },
      ]);
    });

    it("warns per row mapped through an action whose meaning is inferred", () => {
      const result = mapInvestments(
        input({
          transactions: transactionData({
            transactions: [
              invRow({
                handle: 1,
                action: MNY_ACTION.CAPITAL_GAIN,
                amount: 12,
              }),
            ],
          }),
        }),
      );

      expect(result.transactions[0].action).toBe(InvestmentAction.CAPITAL_GAIN);
      expect(result.warnings).toContainEqual({
        code: "unconfirmedInvestmentAction",
        subject: "htrn=1",
        detail: `act=${MNY_ACTION.CAPITAL_GAIN}`,
        row: expect.objectContaining({ handle: 1 }),
      });
    });

    it("keeps a row whose TRN_INV detail is missing, cash only", () => {
      const result = mapInvestments(
        input({
          transactions: transactionData({
            transactions: [
              invRow({ handle: 1, action: MNY_ACTION.BUY, amount: -500 }),
            ],
          }),
        }),
      );

      expect(result.transactions[0]).toMatchObject({
        action: InvestmentAction.BUY,
        quantity: null,
        totalAmount: 500,
        cashAmount: -500,
      });
      expect(result.warnings).toContainEqual({
        code: "missingInvestmentDetail",
        subject: "htrn=1",
        detail: `act=${MNY_ACTION.BUY}`,
        row: expect.objectContaining({ handle: 1 }),
      });
    });

    it("carries the reconciliation status and void flag through", () => {
      const result = mapInvestments(
        input({
          transactions: transactionData({
            transactions: [
              invRow({ handle: 1, action: MNY_ACTION.BUY, clearedStatus: 2 }),
              invRow({
                handle: 2,
                action: MNY_ACTION.BUY,
                flags: MNY_TRANSACTION_FLAG.VOID,
              }),
            ],
          }),
        }),
      );

      expect(result.transactions.map((t) => t.status)).toEqual([
        TransactionStatus.RECONCILED,
        TransactionStatus.VOID,
      ]);
    });
  });

  describe("inclusion rules", () => {
    it("ignores rows with no security: those are the banking mapper's", () => {
      const result = mapInvestments(
        input({
          transactions: transactionData({
            transactions: [
              mnyTransaction({ handle: 1, account: 10, security: null }),
            ],
          }),
        }),
      );

      expect(result.transactions).toHaveLength(0);
      expect(result.skipped).toBe(0);
    });

    // The two share-adjustment rows this catches in the maintainer's file are
    // the whole of two holdings mismatches: 2 shares of one fund and 3 of
    // another, in an account Money shows as empty.
    it("ignores a scheduled instance Money never posted", () => {
      const result = mapInvestments(
        input({
          transactions: transactionData({
            transactions: [
              invRow({ handle: 1, action: MNY_ACTION.BUY, flags: 0x20000 }),
              invRow({ handle: 2, action: MNY_ACTION.BUY, flags: 0x40000 }),
            ],
          }),
          investments: investmentData({
            investmentDetails: [
              mnyInvestmentDetail({ transaction: 1, quantity: 2, price: 10 }),
              mnyInvestmentDetail({ transaction: 2, quantity: 3, price: 10 }),
            ],
          }),
        }),
      );

      expect(result.transactions).toEqual([]);
      expect(result.skipped).toBe(0);
    });

    it("ignores recurrence templates, bill templates and split children", () => {
      const result = mapInvestments(
        input({
          transactions: transactionData({
            transactions: [
              invRow({ handle: 1, action: MNY_ACTION.BUY, frequency: 3 }),
              invRow({ handle: 2, action: MNY_ACTION.BUY, frequency: 3 }),
              invRow({ handle: 3, action: MNY_ACTION.BUY }),
            ],
            splits: [mnySplit({ parent: 9, child: 3 })],
          }),
          bills: [mnyBill({ templateTransaction: 2 })],
        }),
      );

      expect(result.transactions).toHaveLength(0);
      expect(result.skipped).toBe(0);
    });

    it("ignores rows in an account the user left out", () => {
      const result = mapInvestments(
        input({
          transactions: transactionData({
            transactions: [
              invRow({ handle: 1, account: 77, action: MNY_ACTION.BUY }),
            ],
          }),
        }),
      );

      expect(result.transactions).toHaveLength(0);
      expect(result.skipped).toBe(0);
    });

    it("skips a row whose account is not a brokerage side", () => {
      const result = mapInvestments(
        input({
          transactions: transactionData({
            transactions: [
              invRow({ handle: 1, account: 11, action: MNY_ACTION.BUY }),
            ],
          }),
        }),
      );

      expect(result.transactions).toHaveLength(0);
      expect(result.skipped).toBe(1);
      expect(result.warnings[0].code).toBe("investmentAccountMismatch");
    });

    it("skips a row whose security did not survive the securities mapper", () => {
      const result = mapInvestments(
        input({
          transactions: transactionData({
            transactions: [
              invRow({ handle: 1, security: 99, action: MNY_ACTION.BUY }),
            ],
          }),
        }),
      );

      expect(result.transactions).toHaveLength(0);
      expect(result.skipped).toBe(1);
    });

    it("skips a row with no usable date", () => {
      const result = mapInvestments(
        input({
          transactions: transactionData({
            transactions: [
              invRow({ handle: 1, date: null, action: MNY_ACTION.BUY }),
            ],
          }),
        }),
      );

      expect(result.skipped).toBe(1);
      expect(result.warnings[0].code).toBe("unusableTransaction");
    });
  });

  describe("act 15 + 16 share transfers", () => {
    const pairInput = () =>
      input({
        accounts: accountsFixture([10, 20]),
        transactions: transactionData({
          transactions: [
            invRow({
              handle: 1,
              account: 20,
              action: MNY_ACTION.ADD_SHARES,
              date: "2026-03-01",
            }),
            invRow({
              handle: 2,
              account: 10,
              action: MNY_ACTION.REMOVE_SHARES,
              date: "2026-03-01",
            }),
          ],
        }),
        investments: investmentData({
          investmentDetails: [
            mnyInvestmentDetail({ transaction: 1, quantity: 7, price: 12 }),
            mnyInvestmentDetail({ transaction: 2, quantity: 7, price: 12 }),
          ],
        }),
      });

    it("pairs them into linked TRANSFER_IN / TRANSFER_OUT rows", () => {
      const result = mapInvestments(pairInput());

      const incoming = result.transactions.find((t) => t.handle === 1);
      const outgoing = result.transactions.find((t) => t.handle === 2);

      expect(incoming?.action).toBe(InvestmentAction.TRANSFER_IN);
      expect(outgoing?.action).toBe(InvestmentAction.TRANSFER_OUT);
      expect(incoming?.linkedInvestmentId).toBe(outgoing?.id);
      expect(outgoing?.linkedInvestmentId).toBe(incoming?.id);
      expect(result.transfersPaired).toBe(1);
    });

    it("does not pair two rows in the same account", () => {
      const base = pairInput();
      const result = mapInvestments({
        ...base,
        transactions: transactionData({
          transactions: base.transactions.transactions.map((row) => ({
            ...row,
            account: 10,
          })),
        }),
      });

      expect(result.transfersPaired).toBe(0);
      expect(result.transactions.map((t) => t.action)).toEqual([
        InvestmentAction.ADD_SHARES,
        InvestmentAction.REMOVE_SHARES,
      ]);
    });

    it("does not pair across different quantities", () => {
      const base = pairInput();
      const result = mapInvestments({
        ...base,
        investments: investmentData({
          investmentDetails: [
            mnyInvestmentDetail({ transaction: 1, quantity: 7 }),
            mnyInvestmentDetail({ transaction: 2, quantity: 3 }),
          ],
        }),
      });

      expect(result.transfersPaired).toBe(0);
    });

    // Shares transferred in from a broker are the ordinary way a portfolio
    // starts, so an unpaired row is not an anomaly and must not warn --
    // money2002.mny alone has 60 of them.
    it("leaves an unpaired row as ADD_SHARES, without a warning", () => {
      const result = mapInvestments(
        input({
          transactions: transactionData({
            transactions: [
              invRow({ handle: 1, action: MNY_ACTION.ADD_SHARES }),
            ],
          }),
          investments: investmentData({
            investmentDetails: [
              mnyInvestmentDetail({ transaction: 1, quantity: 4 }),
            ],
          }),
        }),
      );

      expect(result.transactions[0].action).toBe(InvestmentAction.ADD_SHARES);
      expect(result.warnings).toEqual([]);
    });

    it("pairs each removal only once", () => {
      const result = mapInvestments(
        input({
          accounts: accountsFixture([10, 20, 30]),
          transactions: transactionData({
            transactions: [
              invRow({ handle: 1, account: 20, action: MNY_ACTION.ADD_SHARES }),
              invRow({ handle: 2, account: 30, action: MNY_ACTION.ADD_SHARES }),
              invRow({
                handle: 3,
                account: 10,
                action: MNY_ACTION.REMOVE_SHARES,
              }),
            ],
          }),
          investments: investmentData({
            investmentDetails: [1, 2, 3].map((transaction) =>
              mnyInvestmentDetail({ transaction, quantity: 7 }),
            ),
          }),
        }),
      );

      expect(result.transfersPaired).toBe(1);
      expect(
        result.transactions.filter(
          (t) => t.action === InvestmentAction.ADD_SHARES,
        ),
      ).toHaveLength(1);
    });
  });

  describe("SEC_SPLIT", () => {
    /**
     * The importer used to synthesize a SPLIT row per holder. Money's own `LOT`
     * rows are not split-adjusted, so that left shares in accounts Money shows
     * as empty -- 200 VTI, 140 VWO, 960 XIC and 1,200 XIU in the maintainer's
     * file, 3 MSFT and 1,175 LEH in Money Plus's `sample.mny`.
     */
    it("changes no position, and says which split it did not apply", () => {
      const result = mapInvestments(
        input({
          accounts: accountsFixture([10, 20]),
          transactions: transactionData({
            transactions: [
              invRow({
                handle: 1,
                account: 10,
                action: MNY_ACTION.BUY,
                date: "2026-01-01",
              }),
              invRow({
                handle: 2,
                account: 20,
                action: MNY_ACTION.BUY,
                date: "2026-01-02",
              }),
            ],
          }),
          investments: investmentData({
            securitySplits: [
              mnySecuritySplit({
                handle: 5,
                sharesBefore: 1,
                sharesAfter: 3,
                recordDate: "2026-02-01",
              }),
            ],
            prices: [mnySecurityPrice({ security: 1, split: 5 })],
            investmentDetails: [
              mnyInvestmentDetail({ transaction: 1, quantity: 10, price: 30 }),
              mnyInvestmentDetail({ transaction: 2, quantity: 5, price: 30 }),
            ],
          }),
        }),
      );

      expect(
        result.transactions.filter((t) => t.action === InvestmentAction.SPLIT),
      ).toEqual([]);
      expect(result.warnings).toEqual([
        {
          code: "securitySplitNotApplied",
          subject: "SEC1",
          detail: "2026-02-01: 1 -> 3",
        },
      ]);
    });

    // Canadian ETFs record their annual reinvested distribution this way: units
    // before equal units after, so there is nothing to tell the user about.
    it("says nothing about a split that changes no share count", () => {
      const result = mapInvestments(
        input({
          investments: investmentData({
            securitySplits: [
              mnySecuritySplit({
                handle: 5,
                sharesBefore: 100,
                sharesAfter: 100,
              }),
            ],
            prices: [mnySecurityPrice({ security: 1, split: 5 })],
          }),
        }),
      );

      expect(result.warnings).toEqual([]);
    });

    it("says nothing when no price row resolves the split to a security", () => {
      const result = mapInvestments(
        input({
          investments: investmentData({
            securitySplits: [mnySecuritySplit({ handle: 5 })],
          }),
        }),
      );

      expect(result.warnings).toEqual([]);
    });

    it("says nothing about an unusable ratio instead of dividing by zero", () => {
      const result = mapInvestments(
        input({
          investments: investmentData({
            securitySplits: [
              mnySecuritySplit({ handle: 5, sharesBefore: 0, sharesAfter: 2 }),
            ],
            prices: [mnySecurityPrice({ security: 1, split: 5 })],
          }),
        }),
      );

      expect(result.warnings).toEqual([]);
    });
  });

  describe("referenced entities", () => {
    it("reports the securities, payees and categories the rows use", () => {
      const result = mapInvestments(
        input({
          securities: securitiesFixture([1, 2]),
          transactions: transactionData({
            transactions: [
              invRow({
                handle: 1,
                action: MNY_ACTION.DIVIDEND,
                payee: 4,
                category: 9,
              }),
              invRow({ handle: 2, security: 2, action: MNY_ACTION.BUY }),
            ],
          }),
        }),
      );

      expect([...result.referencedSecurities].sort()).toEqual([1, 2]);
      expect([...result.referencedPayees]).toEqual([4]);
      expect([...result.referencedCategories]).toEqual([9]);
    });
  });
});
