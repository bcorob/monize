import { manifestDocument } from "../adapters/pl/pl-test-input";
import { BondTerms, parseBondTerms } from "../domain/bond-terms";
import { ExactDecimal } from "../domain/exact-decimal";
import { principalAt, roundMoney, yearFraction } from "./accrual";

function termsWith(change: (doc: Record<string, any>) => void): BondTerms {
  const doc = manifestDocument("ror1027");
  change(doc);
  return parseBondTerms(doc);
}

describe("roundMoney", () => {
  const value = ExactDecimal.parse("1.005");

  it.each([
    ["HALF_UP", "1.01"],
    ["HALF_EVEN", "1.00"],
    ["DOWN", "1.00"],
  ])("rounds by %s", (mode, expected) => {
    const terms = termsWith((d) => (d.rounding.mode = mode));
    expect(roundMoney(terms, value).toFixed(2)).toBe(expected);
  });

  it("rounds to the terms' decimals", () => {
    const terms = termsWith((d) => (d.rounding.moneyDecimals = 0));
    expect(roundMoney(terms, ExactDecimal.parse("100.5")).toFixed(0)).toBe(
      "101",
    );
  });
});

describe("yearFraction", () => {
  const monthly = termsWith(() => undefined);
  const period = { start: "2026-11-01", end: "2026-12-01" };

  it("is 1 / F for a whole period", () => {
    const whole = yearFraction(monthly, period, period.start, period.end);
    expect(whole.cmp(ExactDecimal.of(1n, 12n))).toBe(0);
  });

  it("is the elapsed share of the period's days over F", () => {
    const part = yearFraction(monthly, period, "2026-11-01", "2026-11-11");
    expect(part.cmp(ExactDecimal.of(10n, 360n))).toBe(0);
    const none = yearFraction(monthly, period, "2026-11-01", "2026-11-01");
    expect(none.isZero()).toBe(true);
  });
});

describe("principalAt", () => {
  it("is the face value whatever the date for a fixed nominal", () => {
    const terms = termsWith(() => undefined);
    const face = terms.instrument.faceValue;
    expect(principalAt(terms, { date: "2026-11-01" }).toFixed(2)).toBe(
      ExactDecimal.parse(face).toFixed(2),
    );
    expect(principalAt(terms, { date: "2030-01-01" }).toFixed(2)).toBe(
      ExactDecimal.parse(face).toFixed(2),
    );
  });
});
