import { chainTwrPercent, subPeriodFactor } from "./twr-chain.util";

describe("subPeriodFactor", () => {
  it("is the growth of the capital that was at risk", () => {
    expect(subPeriodFactor(8_000, 8_800)).toBeCloseTo(1.1, 10);
  });

  it("refuses a non-positive base: a ratio over nothing has no meaning", () => {
    // Over a negative base it would reverse its own sign, which is how a
    // profitable sale could read as a loss.
    expect(subPeriodFactor(0, 100)).toBeNull();
    expect(subPeriodFactor(-1_000, 0)).toBeNull();
  });

  it("refuses a negative ending value rather than laundering it", () => {
    expect(subPeriodFactor(8_000, -1)).toBeNull();
  });

  it("is zero, not null, for capital that went to nothing", () => {
    expect(subPeriodFactor(8_000, 0)).toBe(0);
  });
});

describe("chainTwrPercent", () => {
  it("chains the factors and subtracts one", () => {
    expect(chainTwrPercent([1.1, 1.2])).toBeCloseTo(32, 10);
  });

  it("is null for an empty chain: unknown, not zero", () => {
    // No sub-period was measurable. A caller that knows its own zero reports
    // that zero itself rather than reading it out of an empty product.
    expect(chainTwrPercent([])).toBeNull();
  });

  it("is zero for a chain of flat sub-periods", () => {
    expect(chainTwrPercent([1, 1, 1])).toBe(0);
  });
});
