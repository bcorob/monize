import { BadRequestException } from "@nestjs/common";
import { validateSplitAmountSum } from "./split-amount.util";

describe("validateSplitAmountSum", () => {
  it("accepts splits whose 4dp sum equals the transaction amount", () => {
    expect(() =>
      validateSplitAmountSum(
        [{ amount: 50.0 }, { amount: 30.0 }, { amount: 20.0 }],
        100,
      ),
    ).not.toThrow();
  });

  it("rejects when the sum does not match", () => {
    expect(() =>
      validateSplitAmountSum([{ amount: 50 }, { amount: 30 }], 100),
    ).toThrow(BadRequestException);
  });

  it("rejects fewer than 2 splits by default", () => {
    expect(() => validateSplitAmountSum([{ amount: 100 }], 100)).toThrow(
      BadRequestException,
    );
  });

  it("rejects fewer than 2 splits when passthrough is disallowed by predicate", () => {
    expect(() =>
      validateSplitAmountSum([{ amount: 100 }], 100, {
        allowSinglePassthrough: true,
        isPassthrough: () => false,
      }),
    ).toThrow(BadRequestException);
  });

  it("allows a single split when allowSinglePassthrough + predicate match", () => {
    expect(() =>
      validateSplitAmountSum([{ amount: 100 }], 100, {
        allowSinglePassthrough: true,
        isPassthrough: () => true,
      }),
    ).not.toThrow();
  });

  it("tolerates rounding within 4dp precision", () => {
    expect(() =>
      validateSplitAmountSum(
        [{ amount: 33.3333 }, { amount: 33.3333 }, { amount: 33.3334 }],
        100,
      ),
    ).not.toThrow();
  });

  it("rejects float-precision mismatches beyond 4dp", () => {
    expect(() =>
      validateSplitAmountSum(
        [{ amount: 33.33333 }, { amount: 33.33333 }, { amount: 33.33333 }],
        100,
      ),
    ).toThrow(BadRequestException);
  });

  describe("mixed-sign children are accepted; the signed sum is the invariant", () => {
    it("accepts same-sign children under a negative parent", () => {
      expect(() =>
        validateSplitAmountSum([{ amount: -60 }, { amount: -40 }], -100),
      ).not.toThrow();
    });

    it("accepts a paycheck-shaped split: gross and withholdings under a net deposit", () => {
      // The canonical mixed-sign split, and the reason no sign rule exists:
      // Microsoft Money models a paycheck as gross salary (+) and withholdings
      // (-) under the net deposit, its importer writes exactly that shape, and
      // the form has only ever validated the sum -- so real ledgers hold these.
      // Refusing them would make the rows uneditable (the form resends the full
      // set on every save) and silently stop their scheduled postings.
      expect(() =>
        validateSplitAmountSum([{ amount: 3500 }, { amount: -500 }], 3000),
      ).not.toThrow();
    });

    it("accepts a refund netted under a charge (audit P5-004's example)", () => {
      // P5-004 proposed refusing this; category surfaces instead read the
      // children signed and net within the category (root CLAUDE.md, "debits
      // NET OF credits", issue #1125), so the credit child reduces what it is
      // filed under rather than fabricating income beside it.
      expect(() =>
        validateSplitAmountSum([{ amount: 50 }, { amount: -150 }], -100),
      ).not.toThrow();
    });

    it("accepts an investment split that both credits and debits", () => {
      // One brokerage line can sell (+proceeds), pay a fee (-) and buy (-) at
      // once; each child is validated against its computed cash impact.
      expect(() =>
        validateSplitAmountSum(
          [{ amount: 1000 }, { amount: -250 }, { amount: -700 }],
          50,
        ),
      ).not.toThrow();
    });

    it("accepts opposing children under a zero parent", () => {
      expect(() =>
        validateSplitAmountSum([{ amount: 100 }, { amount: -100 }], 0),
      ).not.toThrow();
    });

    it("still enforces the signed sum whatever the signs", () => {
      expect(() =>
        validateSplitAmountSum(
          [{ amount: 1000 }, { amount: -250 }, { amount: -700 }],
          999,
        ),
      ).toThrow(/must equal transaction amount/);
    });
  });
});
