import { InvestmentAction } from "../../../securities/entities/investment-transaction.entity";
import {
  hasInvestmentDetail,
  isUnconfirmedInvestmentAction,
  mapInvestmentAction,
} from "./mny-actions";
import {
  MNY_TRANSACTION_FLAG,
  isDebtAccountRow,
  isLoanPaymentTemplate,
  isUnpostedRow,
  isVoided,
} from "./mny-model";
import {
  MONEY99_ACTION,
  MONEY99_TRANSACTION_FLAG,
  translateMoney99Flags,
} from "./mny-money99";

describe("translateMoney99Flags", () => {
  it.each([
    ["VOID", MONEY99_TRANSACTION_FLAG.VOID, isVoided],
    ["DEBT_ACCOUNT", MONEY99_TRANSACTION_FLAG.DEBT_ACCOUNT, isDebtAccountRow],
    [
      "LOAN_PAYMENT_TEMPLATE",
      MONEY99_TRANSACTION_FLAG.LOAN_PAYMENT_TEMPLATE,
      isLoanPaymentTemplate,
    ],
    ["UNPOSTED", MONEY99_TRANSACTION_FLAG.UNPOSTED, isUnpostedRow],
  ])(
    "carries Money 99 %s to the bit the Money Plus predicate reads",
    (_name, bit, predicate) => {
      expect(predicate(translateMoney99Flags(bit))).toBe(true);
    },
  );

  it("carries the scheduled-series bit", () => {
    expect(
      translateMoney99Flags(MONEY99_TRANSACTION_FLAG.SCHEDULED_SERIES),
    ).toBe(MNY_TRANSACTION_FLAG.SCHEDULED_SERIES);
  });

  it("keeps the colliding bits apart: a loan template is not voided, a void is not a loan row", () => {
    // Read through the Money Plus masks, Money 99's loan-template bit is VOID
    // and its void bit is the loan-account bit.
    expect(isVoided(MONEY99_TRANSACTION_FLAG.LOAN_PAYMENT_TEMPLATE)).toBe(true);
    expect(isDebtAccountRow(MONEY99_TRANSACTION_FLAG.VOID)).toBe(true);

    const template = translateMoney99Flags(
      MONEY99_TRANSACTION_FLAG.LOAN_PAYMENT_TEMPLATE,
    );
    const voided = translateMoney99Flags(MONEY99_TRANSACTION_FLAG.VOID);
    expect(isVoided(template)).toBe(false);
    expect(isDebtAccountRow(voided)).toBe(false);
  });

  it("drops every bit it has no measurement for", () => {
    // Transfer side, receiving side, split parent and child, series origin:
    // all observed, none read, and each overlaps some Money Plus meaning.
    expect(translateMoney99Flags(0x2 | 0x4 | 0x8 | 0x20 | 0x40 | 0x800)).toBe(
      0,
    );
  });

  it("translates the flag words the test files carry", () => {
    // A pending instance of a scheduled transfer (0xe04) and the loan
    // template's counterpart in the loan account (0x10d).
    expect(isUnpostedRow(translateMoney99Flags(0xe04))).toBe(true);
    const counterpart = translateMoney99Flags(0x10d);
    expect(isLoanPaymentTemplate(counterpart)).toBe(true);
    expect(isVoided(counterpart)).toBe(false);
  });
});

describe("Money 97-99 action codes", () => {
  it.each([
    [MONEY99_ACTION.BUY, InvestmentAction.BUY],
    [MONEY99_ACTION.SELL, InvestmentAction.SELL],
    [MONEY99_ACTION.INTEREST, InvestmentAction.INTEREST],
    [MONEY99_ACTION.DIVIDEND, InvestmentAction.DIVIDEND],
    [MONEY99_ACTION.REINVEST, InvestmentAction.REINVEST],
    [MONEY99_ACTION.CAPITAL_GAIN, InvestmentAction.CAPITAL_GAIN],
    [MONEY99_ACTION.ADD_SHARES, InvestmentAction.ADD_SHARES],
    [MONEY99_ACTION.REMOVE_SHARES, InvestmentAction.REMOVE_SHARES],
  ])("maps act %i to %s", (act, expected) => {
    expect(mapInvestmentAction(act, "jet3")).toBe(expected);
  });

  it("does not read the Money Plus meaning of a shared code", () => {
    expect(mapInvestmentAction(1, "msisam")).toBe(InvestmentAction.BUY);
    expect(mapInvestmentAction(1, "jet3")).toBe(InvestmentAction.SELL);
    expect(mapInvestmentAction(4, "msisam")).toBe(InvestmentAction.INTEREST);
    expect(mapInvestmentAction(4, "jet3")).toBe(InvestmentAction.DIVIDEND);
    expect(mapInvestmentAction(2, "msisam")).toBe(InvestmentAction.SELL);
    expect(mapInvestmentAction(2, "jet3")).toBe(InvestmentAction.INTEREST);
  });

  it.each([3, 9, 12, 13, 17, 18, 19, 20, 22])(
    "leaves act %i unmapped",
    (act) => {
      expect(mapInvestmentAction(act, "jet3")).toBeNull();
    },
  );

  it("reports no Money 99 code as unconfirmed", () => {
    expect(isUnconfirmedInvestmentAction(14, "msisam")).toBe(true);
    expect(isUnconfirmedInvestmentAction(14, "jet3")).toBe(false);
  });

  it.each([
    [MONEY99_ACTION.INTEREST, false],
    [MONEY99_ACTION.DIVIDEND, false],
    [MONEY99_ACTION.CAPITAL_GAIN, false],
    [MONEY99_ACTION.OTHER_INCOME, false],
    [MONEY99_ACTION.OTHER_EXPENSE, false],
    [MONEY99_ACTION.BUY, true],
    [MONEY99_ACTION.REINVEST, true],
  ])("act %i has a TRN_INV row: %s", (act, expected) => {
    expect(hasInvestmentDetail(act, "jet3")).toBe(expected);
  });
});
