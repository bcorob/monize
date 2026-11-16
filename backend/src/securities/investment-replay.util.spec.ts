import { InvestmentAction } from "./entities/investment-transaction.entity";
import {
  acquisitionCost,
  applyActionToQuantity,
  applyReturnOfCapital,
  baseInvestmentAction,
  CASH_INCOME_ACTIONS,
  FUNDING_ACCOUNT_ACTIONS,
  incomeKind,
  investmentIncomeAmount,
  INVESTED_FLOW_KIND_BY_BASE_ACTION,
  investedFlowKind,
  isQuantityOnlyAction,
  MARKET_PRICED_TRADE_ACTIONS,
  orderTransferOutBeforeIn,
  reinvestedIncomeAmount,
  REINVESTED_INCOME_ACTIONS,
  returnOfCapitalAmount,
  SHARE_MOVING_ACTIONS,
} from "./investment-replay.util";

describe("baseInvestmentAction", () => {
  it.each([
    [InvestmentAction.REINVEST_INTEREST, InvestmentAction.REINVEST],
    [InvestmentAction.REINVEST_CAPITAL_GAIN_SHORT, InvestmentAction.REINVEST],
    [InvestmentAction.REINVEST_CAPITAL_GAIN_LONG, InvestmentAction.REINVEST],
    [InvestmentAction.CAPITAL_GAIN_SHORT, InvestmentAction.CAPITAL_GAIN],
    [InvestmentAction.CAPITAL_GAIN_LONG, InvestmentAction.CAPITAL_GAIN],
    [InvestmentAction.REDEEM, InvestmentAction.SELL],
  ])("normalizes the refinement %s to %s", (refinement, base) => {
    expect(baseInvestmentAction(refinement)).toBe(base);
  });

  it("returns every base action unchanged", () => {
    for (const action of Object.values(InvestmentAction)) {
      const base = baseInvestmentAction(action);
      // A base is a fixed point: normalizing twice changes nothing, so no
      // refinement can point at another refinement.
      expect(baseInvestmentAction(base)).toBe(base);
    }
  });

  it("covers every enum value: nothing maps outside the enum", () => {
    const values = new Set<string>(Object.values(InvestmentAction));
    for (const action of Object.values(InvestmentAction)) {
      expect(values.has(baseInvestmentAction(action) as string)).toBe(true);
    }
  });

  it("moves shares for every refinement exactly as its base does", () => {
    // The point of the normalizer: a refinement cannot drift from its base
    // one replay at a time. 40% -light history charts came from exactly that
    // kind of per-surface drift (see the applyActionToQuantity comment).
    for (const action of Object.values(InvestmentAction)) {
      expect(applyActionToQuantity(10, action, 4)).toBe(
        applyActionToQuantity(10, baseInvestmentAction(action), 4),
      );
    }
  });

  it("lists the share-moving refinements in SHARE_MOVING_ACTIONS", () => {
    // A replay that filters by this list would otherwise silently drop every
    // reinvested-interest and redemption row from history.
    for (const action of [
      InvestmentAction.REINVEST_INTEREST,
      InvestmentAction.REINVEST_CAPITAL_GAIN_SHORT,
      InvestmentAction.REINVEST_CAPITAL_GAIN_LONG,
      InvestmentAction.REDEEM,
    ]) {
      expect(SHARE_MOVING_ACTIONS).toContain(action);
    }
    expect(SHARE_MOVING_ACTIONS).not.toContain(
      InvestmentAction.CAPITAL_GAIN_SHORT,
    );
    expect(SHARE_MOVING_ACTIONS).not.toContain(
      InvestmentAction.CAPITAL_GAIN_LONG,
    );
  });

  it("classifies the cash income refinements and the traded refinements", () => {
    expect(CASH_INCOME_ACTIONS).toContain(InvestmentAction.CAPITAL_GAIN_SHORT);
    expect(CASH_INCOME_ACTIONS).toContain(InvestmentAction.CAPITAL_GAIN_LONG);
    expect(CASH_INCOME_ACTIONS).not.toContain(
      InvestmentAction.REINVEST_INTEREST,
    );
    expect(MARKET_PRICED_TRADE_ACTIONS).toContain(InvestmentAction.REDEEM);
    expect(MARKET_PRICED_TRADE_ACTIONS).toContain(
      InvestmentAction.REINVEST_INTEREST,
    );
    expect(MARKET_PRICED_TRADE_ACTIONS).not.toContain(
      InvestmentAction.TRANSFER_IN,
    );
  });
});

describe("applyActionToQuantity", () => {
  describe("acquisitions add shares", () => {
    it.each([
      InvestmentAction.BUY,
      InvestmentAction.REINVEST,
      InvestmentAction.TRANSFER_IN,
      InvestmentAction.ADD_SHARES,
    ])("%s adds the quantity", (action) => {
      expect(applyActionToQuantity(10, action, 5)).toBe(15);
    });
  });

  describe("disposals subtract shares", () => {
    it.each([
      InvestmentAction.SELL,
      InvestmentAction.TRANSFER_OUT,
      InvestmentAction.REMOVE_SHARES,
    ])("%s subtracts the quantity", (action) => {
      expect(applyActionToQuantity(10, action, 4)).toBe(6);
    });

    it("subtracts in full past zero rather than clamping", () => {
      // An over-sell is a fact about the history, not something a replay may
      // quietly absorb: clamping here made the same position reconcile in the
      // holdings rebuild and fail in the import cross-check.
      expect(
        applyActionToQuantity(10, InvestmentAction.REMOVE_SHARES, 25),
      ).toBe(-15);
      expect(applyActionToQuantity(10, InvestmentAction.SELL, 25)).toBe(-15);
    });
  });

  describe("SPLIT quantity is a ratio, not a share count", () => {
    // This is the regression the audit's P5-011 named: three net-worth
    // reducers ADDED the ratio to the share count. A 2-for-1 split of a
    // 10-share position came out as 12 shares, worth 600 at 50/share instead
    // of 1,000 -- a 40% understatement on every historical chart.
    it("multiplies by a 2-for-1 ratio (10 shares -> 20, not 12)", () => {
      expect(applyActionToQuantity(10, InvestmentAction.SPLIT, 2)).toBe(20);
      expect(applyActionToQuantity(10, InvestmentAction.SPLIT, 2)).not.toBe(12);
    });

    it("handles a 3-for-2 ratio", () => {
      expect(applyActionToQuantity(100, InvestmentAction.SPLIT, 1.5)).toBe(150);
    });

    it("handles a 1-for-2 reverse split", () => {
      expect(applyActionToQuantity(100, InvestmentAction.SPLIT, 0.5)).toBe(50);
    });

    it("compounds sequential splits multiplicatively", () => {
      let qty = 10;
      qty = applyActionToQuantity(qty, InvestmentAction.SPLIT, 2);
      qty = applyActionToQuantity(qty, InvestmentAction.SPLIT, 3);
      expect(qty).toBe(60);
    });

    it("leaves the position alone for a zero or negative ratio", () => {
      // A row that cannot say what the split was is not evidence the shares
      // went away, and 0 would silently destroy a real position.
      expect(applyActionToQuantity(10, InvestmentAction.SPLIT, 0)).toBe(10);
      expect(applyActionToQuantity(10, InvestmentAction.SPLIT, -2)).toBe(10);
    });

    it("leaves an empty position empty", () => {
      expect(applyActionToQuantity(0, InvestmentAction.SPLIT, 2)).toBe(0);
    });
  });

  describe("cash actions do not move shares", () => {
    it.each([
      InvestmentAction.DIVIDEND,
      InvestmentAction.INTEREST,
      InvestmentAction.CAPITAL_GAIN,
    ])("%s leaves the quantity unchanged", (action) => {
      expect(applyActionToQuantity(10, action, 999)).toBe(10);
    });

    it("leaves the quantity unchanged for an unrecognised action", () => {
      expect(applyActionToQuantity(10, "SOMETHING_NEW", 5)).toBe(10);
    });
  });

  it("accepts a raw action string, as the net-worth raw-SQL replays supply", () => {
    // The historical replays read raw rows, where `action` is a plain string
    // rather than the enum member. Both must fold identically.
    expect(applyActionToQuantity(10, "SPLIT", 2)).toBe(20);
    expect(applyActionToQuantity(10, "ADD_SHARES", 5)).toBe(15);
    expect(applyActionToQuantity(10, "REMOVE_SHARES", 5)).toBe(5);
  });

  it("covers every share-moving action in SHARE_MOVING_ACTIONS", () => {
    for (const action of SHARE_MOVING_ACTIONS) {
      expect(applyActionToQuantity(10, action, 2)).not.toBe(10);
    }
  });

  it("lists exactly the actions that move shares", () => {
    const moving = Object.values(InvestmentAction).filter(
      (action) => applyActionToQuantity(10, action, 2) !== 10,
    );
    expect([...SHARE_MOVING_ACTIONS].sort()).toEqual(moving.sort());
  });
});

describe("FUNDING_ACCOUNT_ACTIONS", () => {
  it("is exactly BUY, SELL and the sale-like REDEEM", () => {
    // REDEEM's base is SELL, so its proceeds route to a funding account the
    // same way -- the form offers the field for it, and a set without it
    // would silently clear what the form stored (issues #1149 + #1154).
    expect([...FUNDING_ACCOUNT_ACTIONS].sort()).toEqual(
      [
        InvestmentAction.BUY,
        InvestmentAction.SELL,
        InvestmentAction.REDEEM,
      ].sort(),
    );
  });

  it("excludes cash-only and share-only actions", () => {
    for (const action of [
      InvestmentAction.DIVIDEND,
      InvestmentAction.INTEREST,
      InvestmentAction.CAPITAL_GAIN,
      InvestmentAction.CAPITAL_GAIN_SHORT,
      InvestmentAction.CAPITAL_GAIN_LONG,
      InvestmentAction.REINVEST,
      InvestmentAction.REINVEST_INTEREST,
      InvestmentAction.REINVEST_CAPITAL_GAIN_SHORT,
      InvestmentAction.REINVEST_CAPITAL_GAIN_LONG,
      InvestmentAction.ADD_SHARES,
      InvestmentAction.REMOVE_SHARES,
      InvestmentAction.SPLIT,
    ]) {
      expect(FUNDING_ACCOUNT_ACTIONS.has(action)).toBe(false);
    }
  });
});

describe("isQuantityOnlyAction", () => {
  it("is true only for ADD_SHARES and REMOVE_SHARES", () => {
    expect(isQuantityOnlyAction(InvestmentAction.ADD_SHARES)).toBe(true);
    expect(isQuantityOnlyAction(InvestmentAction.REMOVE_SHARES)).toBe(true);
    expect(isQuantityOnlyAction(InvestmentAction.BUY)).toBe(false);
    expect(isQuantityOnlyAction(InvestmentAction.SPLIT)).toBe(false);
  });
});

describe("acquisitionCost", () => {
  it("includes the commission (P5-006)", () => {
    // 10 shares at 100 with 10 commission costs 1,010 -- which is exactly what
    // the linked cash debit takes out. A basis of 1,000 turns the commission
    // into 10 of phantom gain on the eventual sale.
    expect(acquisitionCost({ quantity: 10, price: 100, commission: 10 })).toBe(
      1010,
    );
  });

  it("converts price and commission together at the stored rate", () => {
    expect(
      acquisitionCost({
        quantity: 10,
        price: 100,
        commission: 10,
        exchangeRate: 0.9,
      }),
    ).toBeCloseTo(909, 10);
  });

  it("treats a missing commission as zero", () => {
    expect(acquisitionCost({ quantity: 10, price: 100 })).toBe(1000);
    expect(
      acquisitionCost({ quantity: 10, price: 100, commission: null }),
    ).toBe(1000);
  });

  it("defaults a missing rate to 1 only because same-currency needs no rate", () => {
    expect(
      acquisitionCost({ quantity: 2, price: 50, exchangeRate: null }),
    ).toBe(100);
  });

  it("treats a stored zero or negative rate as absent, not applicable", () => {
    // Rate 1 means same currency, never "no rate found" (`AGENTS.md`).
    // `|| 1` coerced a stored 0 to par and applied a negative rate as-is --
    // a negative basis with inverted gains -- in the one door every basis
    // calculation now goes through.
    expect(
      acquisitionCost({ quantity: 10, price: 100, exchangeRate: 0 }),
    ).toBeNull();
    expect(
      acquisitionCost({ quantity: 10, price: 100, exchangeRate: -1.2 }),
    ).toBeNull();
  });

  it("returns null when the price is unknown but something was acquired", () => {
    // Unknown is not free. Folding this to 0 let an incomplete import pass the
    // quantity reconciliation and report a confident gain on a basis of zero.
    expect(acquisitionCost({ quantity: 10, price: null })).toBeNull();
    expect(acquisitionCost({ quantity: 10, price: undefined })).toBeNull();
    expect(
      acquisitionCost({ quantity: 0, price: null, commission: 5 }),
    ).toBeNull();
  });

  it("treats a stored zero price as unpriced, not free", () => {
    // This case used to assert the opposite -- that `price: 0` was an
    // explicitly free acquisition. Before `assertAcquisitionPriced` shipped,
    // `create()` stored `price ?? 0` and the form accepted a blank field, so
    // real databases hold zero-price BUY/REINVEST rows that mean "unknown";
    // no legitimate zero can be stored from here on, because the guard
    // refuses it.
    expect(acquisitionCost({ quantity: 10, price: 0 })).toBeNull();
    expect(acquisitionCost({ quantity: 10, price: -5 })).toBeNull();
    // A row that acquired nothing and paid nothing has a settled cost of
    // zero regardless of its price field.
    expect(acquisitionCost({ quantity: 0, price: null })).toBe(0);
  });

  it("accepts the string numerics a raw select returns", () => {
    expect(
      acquisitionCost({
        quantity: "10",
        price: "100",
        commission: "10",
        exchangeRate: "1",
      }),
    ).toBe(1010);
  });
});

/**
 * A list that means something is written once, in the place that can check it:
 * every member of the action enum resolves to exactly one effect on the
 * invested part, and a new action is a failing test here rather than a silent
 * zero in a capital flow (`docs/specs/portfolio-period-result.md` section 10.2).
 */
describe("INVESTED_FLOW_KIND_BY_BASE_ACTION", () => {
  it("classifies every InvestmentAction member", () => {
    const unclassified = Object.values(InvestmentAction).filter(
      (action) =>
        !INVESTED_FLOW_KIND_BY_BASE_ACTION.has(
          baseInvestmentAction(action) as InvestmentAction,
        ),
    );

    expect(unclassified).toEqual([]);
  });

  it("puts each action on the side the measure needs it", () => {
    const kinds = Object.fromEntries(
      Object.values(InvestmentAction).map((action) => [
        action,
        investedFlowKind(action),
      ]),
    );

    expect(kinds).toEqual({
      // Buying is not earning: it funds the day and cancels out of the P&L.
      BUY: "capitalIn",
      TRANSFER_IN: "capitalIn",
      ADD_SHARES: "capitalIn",
      // Selling is not losing: the proceeds are what the position came to.
      SELL: "capitalOut",
      REDEEM: "capitalOut",
      TRANSFER_OUT: "capitalOut",
      REMOVE_SHARES: "capitalOut",
      // A return of capital pays back what was invested: the price falls by
      // what was paid, so it leaves the invested part without being earned.
      RETURN_OF_CAPITAL: "capitalOut",
      // Distributions are what the invested part EARNED, cash though they are.
      DIVIDEND: "income",
      INTEREST: "income",
      CAPITAL_GAIN: "income",
      CAPITAL_GAIN_SHORT: "income",
      CAPITAL_GAIN_LONG: "income",
      // A reinvestment is a distribution earned and put straight back into
      // shares: income AND capital, so the result they add up to is unchanged.
      REINVEST: "reinvestedIncome",
      REINVEST_INTEREST: "reinvestedIncome",
      REINVEST_CAPITAL_GAIN_SHORT: "reinvestedIncome",
      REINVEST_CAPITAL_GAIN_LONG: "reinvestedIncome",
      // A split is a ratio: no value crosses anything.
      SPLIT: "none",
    });
  });
});

describe("incomeKind", () => {
  it("records every distribution, in cash or in shares, as the cash kind it equals", () => {
    const kinds = Object.fromEntries(
      Object.values(InvestmentAction).map((action) => [
        action,
        incomeKind(action),
      ]),
    );

    expect(kinds).toEqual({
      DIVIDEND: "DIVIDEND",
      INTEREST: "INTEREST",
      CAPITAL_GAIN: "CAPITAL_GAIN",
      CAPITAL_GAIN_SHORT: "CAPITAL_GAIN_SHORT",
      CAPITAL_GAIN_LONG: "CAPITAL_GAIN_LONG",
      // A reinvested distribution is income of the same kind as its cash twin.
      REINVEST: "DIVIDEND",
      REINVEST_INTEREST: "INTEREST",
      REINVEST_CAPITAL_GAIN_SHORT: "CAPITAL_GAIN_SHORT",
      REINVEST_CAPITAL_GAIN_LONG: "CAPITAL_GAIN_LONG",
      BUY: null,
      SELL: null,
      REDEEM: null,
      TRANSFER_IN: null,
      TRANSFER_OUT: null,
      ADD_SHARES: null,
      REMOVE_SHARES: null,
      SPLIT: null,
      // A return of capital pays back cost; it is not income of any kind.
      RETURN_OF_CAPITAL: null,
    });
  });

  it("keeps the reinvestments out of the cash-income list", () => {
    // A period return or net invested reads the cash list; a reinvestment's
    // shares are already in the value those formulas compare.
    for (const action of REINVESTED_INCOME_ACTIONS) {
      expect(CASH_INCOME_ACTIONS).not.toContain(action);
    }
    expect(REINVESTED_INCOME_ACTIONS).toHaveLength(4);
  });
});

describe("reinvestedIncomeAmount", () => {
  it("is the stored total when the row carries one", () => {
    expect(
      reinvestedIncomeAmount({
        quantity: 2,
        price: 50,
        commission: 0,
        totalAmount: 100.25,
      }),
    ).toBe(100.25);
  });

  it("is quantity times price plus commission for a row created in the app, which stores no total", () => {
    expect(
      reinvestedIncomeAmount({
        quantity: 2,
        price: 50,
        commission: 1.5,
        totalAmount: 0,
      }),
    ).toBe(101.5);
  });

  it("is the stored total of an imported row that carries no price", () => {
    // A QIF ReinvDiv with a quantity and a total but no price line.
    expect(
      reinvestedIncomeAmount({
        quantity: 10,
        price: null,
        commission: 0,
        totalAmount: 500,
      }),
    ).toBe(500);
  });

  it("is unknown, not zero, for a row with neither a total nor a price", () => {
    expect(
      reinvestedIncomeAmount({
        quantity: 2,
        price: 0,
        commission: 0,
        totalAmount: 0,
      }),
    ).toBeNull();
  });
});

describe("investmentIncomeAmount", () => {
  it("is a cash distribution's total", () => {
    expect(
      investmentIncomeAmount({
        action: InvestmentAction.DIVIDEND,
        totalAmount: 12.34,
      }),
    ).toBe(12.34);
  });

  it("is a reinvested distribution's value, though the row stores no total", () => {
    expect(
      investmentIncomeAmount({
        action: InvestmentAction.REINVEST_CAPITAL_GAIN_LONG,
        quantity: 3,
        price: 20,
        totalAmount: 0,
      }),
    ).toBe(60);
  });

  it("leaves out a reinvest the cost basis leaves out", () => {
    const row = {
      action: InvestmentAction.REINVEST,
      quantity: 3,
      price: 0,
      totalAmount: 0,
    };
    expect(acquisitionCost(row)).toBeNull();
    expect(investmentIncomeAmount(row)).toBe(0);
  });

  it("is zero for a row that records no income", () => {
    expect(
      investmentIncomeAmount({
        action: InvestmentAction.BUY,
        quantity: 1,
        price: 10,
        totalAmount: 10,
      }),
    ).toBe(0);
  });
});

describe("orderTransferOutBeforeIn", () => {
  const at = new Date("2025-02-10T12:00:00Z");
  const row = (
    id: string,
    action: InvestmentAction,
    transactionDate = "2025-02-10",
    createdAt = at,
  ) => ({ id, action, transactionDate, createdAt });

  it("puts the OUT leg ahead of its IN leg at the same instant and moves nothing else", () => {
    const input = [
      row("in", InvestmentAction.TRANSFER_IN),
      row("out", InvestmentAction.TRANSFER_OUT),
    ];
    expect(orderTransferOutBeforeIn(input).map((r) => r.id)).toEqual([
      "out",
      "in",
    ]);
    // The input is not modified.
    expect(input.map((r) => r.id)).toEqual(["in", "out"]);
  });

  it("keeps date and created_at order ahead of the leg rank", () => {
    const rows = [
      row("in-early", InvestmentAction.TRANSFER_IN, "2025-02-09"),
      row("out-late", InvestmentAction.TRANSFER_OUT, "2025-02-11"),
      row(
        "in-later-instant",
        InvestmentAction.TRANSFER_IN,
        "2025-02-10",
        new Date("2025-02-10T12:00:01Z"),
      ),
      row("out-instant", InvestmentAction.TRANSFER_OUT),
    ];
    expect(orderTransferOutBeforeIn(rows).map((r) => r.id)).toEqual([
      "in-early",
      "out-instant",
      "in-later-instant",
      "out-late",
    ]);
  });

  it("is stable for rows that are not transfer legs", () => {
    const rows = [
      row("b", InvestmentAction.BUY),
      row("a", InvestmentAction.BUY),
    ];
    expect(orderTransferOutBeforeIn(rows).map((r) => r.id)).toEqual(["b", "a"]);
  });
});

/**
 * A return of capital (issue #1800) is not income: it pays back part of what
 * the shares cost, so it comes off the basis, never below zero, and only the
 * excess is a gain. `docs/specs/return-of-capital.md` section 3.
 */
describe("return of capital", () => {
  it("moves no shares and records no income", () => {
    expect(
      applyActionToQuantity(10, InvestmentAction.RETURN_OF_CAPITAL, 4),
    ).toBe(10);
    expect(SHARE_MOVING_ACTIONS).not.toContain(
      InvestmentAction.RETURN_OF_CAPITAL,
    );
    expect(CASH_INCOME_ACTIONS).not.toContain(
      InvestmentAction.RETURN_OF_CAPITAL,
    );
    expect(
      investmentIncomeAmount({
        action: InvestmentAction.RETURN_OF_CAPITAL,
        totalAmount: 50,
      }),
    ).toBe(0);
  });

  it("is a base action of its own, not a dividend refinement", () => {
    expect(baseInvestmentAction(InvestmentAction.RETURN_OF_CAPITAL)).toBe(
      InvestmentAction.RETURN_OF_CAPITAL,
    );
    // Its cash settles against the brokerage's cash sleeve, as a dividend's.
    expect(
      FUNDING_ACCOUNT_ACTIONS.has(InvestmentAction.RETURN_OF_CAPITAL),
    ).toBe(false);
  });

  it("reduces the basis by what it paid back", () => {
    // 100 shares that cost 1,000; a 150 return of capital leaves 850.
    expect(applyReturnOfCapital(1000, 150)).toEqual({
      costBasis: 850,
      basisReturned: 150,
      realizedGain: 0,
    });
  });

  it("stops at zero and realizes the excess as a gain", () => {
    // The basis cannot go below nothing; the 50 it could not absorb is a gain.
    expect(applyReturnOfCapital(100, 150)).toEqual({
      costBasis: 0,
      basisReturned: 100,
      realizedGain: 50,
    });
  });

  it("realizes all of it when there is no basis left to return", () => {
    expect(applyReturnOfCapital(0, 40)).toEqual({
      costBasis: 0,
      basisReturned: 0,
      realizedGain: 40,
    });
  });

  it("reads the stored total unsigned, converted at the row's rate", () => {
    expect(returnOfCapitalAmount({ totalAmount: -25 })).toBe(25);
    expect(
      returnOfCapitalAmount({ totalAmount: "25", exchangeRate: 1.5 }),
    ).toBe(37.5);
  });

  it("is unknown when the rate cannot convert it, never taken at par", () => {
    expect(
      returnOfCapitalAmount({ totalAmount: 25, exchangeRate: 0 }),
    ).toBeNull();
    expect(
      returnOfCapitalAmount({ totalAmount: "abc", exchangeRate: 1 }),
    ).toBeNull();
  });
});
