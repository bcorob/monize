import { convertWithRateLookup } from "./currency-conversion.util";

describe("convertWithRateLookup", () => {
  const rates = new Map<string, number>([
    ["USD->CAD", 1.35],
    ["EUR->USD", 1.1],
  ]);
  const getRate = (from: string, to: string) => rates.get(`${from}->${to}`);

  it("returns the amount unchanged when currencies match", () => {
    expect(convertWithRateLookup(100, "USD", "USD", getRate)).toBe(100);
  });

  it("returns the amount unchanged when the from currency is empty", () => {
    expect(convertWithRateLookup(100, "", "USD", getRate)).toBe(100);
  });

  it("applies the direct rate when available", () => {
    expect(convertWithRateLookup(100, "USD", "CAD", getRate)).toBeCloseTo(135);
  });

  it("falls back to the inverse (reciprocal) rate", () => {
    // No CAD->USD rate, but USD->CAD = 1.35, so CAD->USD = 1/1.35
    expect(convertWithRateLookup(135, "CAD", "USD", getRate)).toBeCloseTo(100);
  });

  it("prefers the direct rate over the inverse when both exist", () => {
    const both = new Map<string, number>([
      ["USD->CAD", 1.35],
      ["CAD->USD", 0.8], // intentionally inconsistent
    ]);
    expect(
      convertWithRateLookup(100, "USD", "CAD", (f, t) =>
        both.get(`${f}->${t}`),
      ),
    ).toBeCloseTo(135);
  });

  it("returns null when no rate is available in either direction", () => {
    expect(convertWithRateLookup(100, "GBP", "JPY", getRate)).toBeNull();
  });

  it("returns null rather than dividing by a zero inverse rate", () => {
    const zero = new Map<string, number>([["USD->CAD", 0]]);
    expect(
      convertWithRateLookup(100, "CAD", "USD", (f, t) =>
        zero.get(`${f}->${t}`),
      ),
    ).toBeNull();
  });

  it("treats a zero direct rate as absent rather than applying it", () => {
    // Multiplying by 0 would report a real holding as worthless -- a confident
    // wrong number, which is worse than an admitted unknown.
    const zero = new Map<string, number>([["USD->CAD", 0]]);
    expect(
      convertWithRateLookup(100, "USD", "CAD", (f, t) =>
        zero.get(`${f}->${t}`),
      ),
    ).toBeNull();
  });

  it("treats a negative rate as absent, in either direction", () => {
    const negative = new Map<string, number>([["USD->CAD", -1.35]]);
    const lookup = (f: string, t: string) => negative.get(`${f}->${t}`);
    expect(convertWithRateLookup(100, "USD", "CAD", lookup)).toBeNull();
    // And it must not be reached through the inverse branch either, which would
    // otherwise flip the sign of the amount.
    expect(convertWithRateLookup(100, "CAD", "USD", lookup)).toBeNull();
  });

  it("falls through to a usable inverse when the direct rate is invalid", () => {
    const mixed = new Map<string, number>([
      ["USD->CAD", 0],
      ["CAD->USD", 0.8],
    ]);
    expect(
      convertWithRateLookup(100, "USD", "CAD", (f, t) =>
        mixed.get(`${f}->${t}`),
      ),
    ).toBeCloseTo(125); // 100 / 0.8
  });

  it("never returns the amount unchanged for two different currencies", () => {
    // The invariant behind audit P5-009: rate 1 is reachable only when the two
    // codes are equal. For any other pair the result is a real conversion or
    // null -- never a silent pass-through that looks like a valid 1:1.
    const result = convertWithRateLookup(100, "GBP", "JPY", getRate);
    expect(result).toBeNull();
    expect(result).not.toBe(100);
  });
});
