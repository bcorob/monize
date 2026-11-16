import {
  MIN_PRECISE_QUOTED_RATE,
  chooseFxQuote,
  quoteNeedsInverse,
} from "./quoted-rate.util";

/**
 * The provider rounds a latest FX quote to four decimals (issue #1604), so of
 * a pair's two quotes the larger carries more significant digits, and one below
 * `MIN_PRECISE_QUOTED_RATE` carries too few to be stored on its own.
 */
describe("quoteNeedsInverse", () => {
  it.each([
    [null, true],
    [0, true],
    [-1, true],
    [Number.NaN, true],
    [0.0001, true],
    [0.7143, true],
    [1, false],
    [1.4, false],
    [13973.23, false],
  ])("for a quote of %p is %p", (rate, expected) => {
    expect(quoteNeedsInverse(rate)).toBe(expected);
  });
});

describe("chooseFxQuote", () => {
  it("takes the inverse when the direct quote was rounded to almost nothing", () => {
    expect(
      chooseFxQuote(
        { from: "IDR", to: "SGD", rate: 0.0001 },
        { from: "SGD", to: "IDR", rate: 13973.23 },
      ),
    ).toEqual({
      observation: { from: "SGD", to: "IDR", rate: 13973.23 },
      reason: null,
    });
  });

  it("keeps the direct quote when it carries more digits than the inverse", () => {
    expect(
      chooseFxQuote(
        { from: "USD", to: "CAD", rate: 1.4 },
        { from: "CAD", to: "USD", rate: 0.7143 },
      ).observation,
    ).toEqual({ from: "USD", to: "CAD", rate: 1.4 });
  });

  it("keeps the direct quote when the inverse was not asked", () => {
    expect(
      chooseFxQuote({ from: "USD", to: "CAD", rate: 1.4 }, null).observation,
    ).toEqual({ from: "USD", to: "CAD", rate: 1.4 });
  });

  it("keeps a precise quote below 1 when the inverse did not answer", () => {
    expect(
      chooseFxQuote(
        { from: "MYR", to: "SGD", rate: 0.3126 },
        { from: "SGD", to: "MYR", rate: null },
      ).observation,
    ).toEqual({ from: "MYR", to: "SGD", rate: 0.3126 });
  });

  it("gives a tie to the quote asked first", () => {
    expect(
      chooseFxQuote(
        { from: "CAD", to: "USD", rate: 0.72 },
        { from: "USD", to: "CAD", rate: 0.72 },
      ).observation,
    ).toEqual({ from: "CAD", to: "USD", rate: 0.72 });
  });

  it("is unavailable when neither symbol answered with a positive rate", () => {
    expect(
      chooseFxQuote(
        { from: "VND", to: "SGD", rate: 0 },
        { from: "SGD", to: "VND", rate: null },
      ),
    ).toEqual({ observation: null, reason: "unavailable" });
  });

  it("is imprecise when both directions quote a placeholder-sized figure", () => {
    expect(
      chooseFxQuote(
        { from: "IDR", to: "SGD", rate: 0.01 },
        { from: "SGD", to: "IDR", rate: 0.01 },
      ),
    ).toEqual({ observation: null, reason: "imprecise" });
  });

  it("is imprecise when the only answer is below the precision floor", () => {
    expect(
      chooseFxQuote(
        { from: "JPY", to: "USD", rate: 0.0063 },
        { from: "USD", to: "JPY", rate: null },
      ),
    ).toEqual({ observation: null, reason: "imprecise" });
  });

  it("accepts a quote exactly at the precision floor", () => {
    expect(
      chooseFxQuote(
        { from: "AAA", to: "BBB", rate: MIN_PRECISE_QUOTED_RATE },
        null,
      ).observation?.rate,
    ).toBe(MIN_PRECISE_QUOTED_RATE);
  });
});
