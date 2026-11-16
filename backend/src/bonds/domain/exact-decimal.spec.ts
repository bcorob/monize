import { ExactDecimal } from "./exact-decimal";

const d = (s: string) => ExactDecimal.parse(s);

describe("ExactDecimal", () => {
  describe("parse", () => {
    it.each(["0", "100.00", "-0.50", "0.0440", "12"])("accepts %s", (s) => {
      expect(() => d(s)).not.toThrow();
    });

    it.each(["", " 1", "1 ", "1e5", "1.", ".5", "+1", "1,5", "abc", "--1"])(
      "refuses %j",
      (s) => {
        expect(() => d(s)).toThrow(TypeError);
      },
    );

    it("refuses a JavaScript number", () => {
      expect(() => ExactDecimal.parse(1.5 as unknown as string)).toThrow(
        TypeError,
      );
    });

    it("normalises equal values to one representation", () => {
      expect(d("0.50").cmp(d("0.5"))).toBe(0);
      expect(d("0.50").denominator).toBe(2n);
      expect(d("-0").numerator).toBe(0n);
    });
  });

  describe("fromInt and ratio", () => {
    it("builds from a safe integer", () => {
      expect(ExactDecimal.fromInt(-7).toFixed(2)).toBe("-7.00");
    });

    it.each([1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
      "refuses %s",
      (n) => {
        expect(() => ExactDecimal.fromInt(n)).toThrow(TypeError);
      },
    );

    it("forms a day-count ratio exactly", () => {
      expect(
        ExactDecimal.ratio(1, 3)
          .mul(ExactDecimal.fromInt(3))
          .cmp(ExactDecimal.ONE),
      ).toBe(0);
      expect(() => ExactDecimal.ratio(1, 0)).toThrow(RangeError);
      expect(() => ExactDecimal.ratio(1.5, 2)).toThrow(TypeError);
    });
  });

  describe("arithmetic", () => {
    it("adds and subtracts without float error", () => {
      expect(d("0.1").add(d("0.2")).cmp(d("0.3"))).toBe(0);
      expect(d("0.3").sub(d("0.1")).cmp(d("0.2"))).toBe(0);
      expect(d("1").sub(d("3")).isNegative()).toBe(true);
    });

    it("multiplies and divides exactly", () => {
      expect(d("1.044").mul(d("1.044")).toFixed(6)).toBe("1.089936");
      expect(d("1").div(d("3")).mul(d("3")).cmp(ExactDecimal.ONE)).toBe(0);
      expect(d("1").div(d("-4")).toFixed(2)).toBe("-0.25");
    });

    it("refuses division by zero and a zero denominator", () => {
      expect(() => d("1").div(ExactDecimal.ZERO)).toThrow(RangeError);
      expect(() => ExactDecimal.of(1n, 0n)).toThrow(RangeError);
    });

    it("negates and tests zero", () => {
      expect(d("2").negate().toFixed(1)).toBe("-2.0");
      expect(ExactDecimal.ZERO.isZero()).toBe(true);
      expect(d("2").isZero()).toBe(false);
      expect(ExactDecimal.of(1n, -2n).denominator).toBe(2n);
    });

    it("compares and picks max", () => {
      expect(d("1").cmp(d("2"))).toBe(-1);
      expect(d("2").cmp(d("1"))).toBe(1);
      expect(ExactDecimal.max(d("1"), d("2")).toFixed(0)).toBe("2");
      expect(ExactDecimal.max(d("3"), d("2")).toFixed(0)).toBe("3");
    });
  });

  describe("rounding", () => {
    it("rounds half up at .xx5, where binary floats get it wrong", () => {
      expect(d("1.005").toFixed(2)).toBe("1.01");
      expect(d("1.004").toFixed(2)).toBe("1.00");
      expect(d("0.3125").toFixed(2)).toBe("0.31");
      expect(d("2.675").toFixed(2)).toBe("2.68");
    });

    it("rounds negative ties away from zero", () => {
      expect(d("-1.005").toFixed(2)).toBe("-1.01");
      expect(d("-0.004").toFixed(2)).toBe("0.00");
      expect(d("-0.50").toFixed(0)).toBe("-1");
    });

    it("formats padding and zero places", () => {
      expect(d("100").toFixed(2)).toBe("100.00");
      expect(d("-0.5").toFixed(2)).toBe("-0.50");
      expect(d("0.5").toFixed(0)).toBe("1");
      expect(d("0.05").toFixed(2)).toBe("0.05");
    });

    it("keeps the rounded value usable", () => {
      expect(d("104.4").mul(d("1.044")).roundHalfUp(2).toFixed(4)).toBe(
        "108.9900",
      );
    });

    it("refuses invalid places", () => {
      expect(() => d("1").roundHalfUp(-1)).toThrow(RangeError);
      expect(() => d("1").roundHalfUp(1.5)).toThrow(RangeError);
    });
  });

  describe("round", () => {
    it.each([
      // value, HALF_UP, HALF_EVEN, DOWN (2 decimals)
      ["1.005", "1.01", "1.00", "1.00"],
      ["1.015", "1.02", "1.02", "1.01"],
      ["1.025", "1.03", "1.02", "1.02"],
      ["1.0051", "1.01", "1.01", "1.00"],
      ["1.0049", "1.00", "1.00", "1.00"],
      ["-1.005", "-1.01", "-1.00", "-1.00"],
      ["-1.015", "-1.02", "-1.02", "-1.01"],
      ["-1.025", "-1.03", "-1.02", "-1.02"],
      ["-1.0051", "-1.01", "-1.01", "-1.00"],
      ["-0.004", "0.00", "0.00", "0.00"],
    ] as const)("%s", (value, halfUp, halfEven, down) => {
      expect(d(value).round(2, "HALF_UP").toFixed(2)).toBe(halfUp);
      expect(d(value).round(2, "HALF_EVEN").toFixed(2)).toBe(halfEven);
      expect(d(value).round(2, "DOWN").toFixed(2)).toBe(down);
    });

    it("rounds ties at zero and other decimals", () => {
      expect(d("0.5").round(0, "HALF_EVEN").toFixed(0)).toBe("0");
      expect(d("1.5").round(0, "HALF_EVEN").toFixed(0)).toBe("2");
      expect(d("2.5").round(0, "HALF_EVEN").toFixed(0)).toBe("2");
      expect(d("-2.5").round(0, "HALF_EVEN").toFixed(0)).toBe("-2");
      expect(d("-2.5").round(0, "HALF_UP").toFixed(0)).toBe("-3");
      expect(d("2.9").round(0, "DOWN").toFixed(0)).toBe("2");
      expect(d("-2.9").round(0, "DOWN").toFixed(0)).toBe("-2");
      expect(d("0.12345").round(4, "HALF_EVEN").toFixed(4)).toBe("0.1234");
      expect(d("0.12355").round(4, "HALF_EVEN").toFixed(4)).toBe("0.1236");
    });

    it("rounds an exact fraction, not a decimal approximation", () => {
      const third = ExactDecimal.of(1n, 3n);
      expect(third.round(2, "DOWN").toFixed(2)).toBe("0.33");
      expect(ExactDecimal.of(2n, 3n).round(2, "DOWN").toFixed(2)).toBe("0.66");
      expect(ExactDecimal.of(2n, 3n).round(2, "HALF_EVEN").toFixed(2)).toBe(
        "0.67",
      );
    });

    it("roundHalfUp is round(.., HALF_UP) and invalid places are refused", () => {
      expect(
        d("1.005").roundHalfUp(2).cmp(d("1.005").round(2, "HALF_UP")),
      ).toBe(0);
      expect(() => d("1").round(-1, "DOWN")).toThrow(RangeError);
      expect(() => d("1").round(1.5, "HALF_EVEN")).toThrow(RangeError);
    });
  });

  describe("toTrimmedString", () => {
    it("trims zeros down to the minimum places", () => {
      expect(d("0.0440").toTrimmedString(10, 4)).toBe("0.0440");
      expect(d("0.04").toTrimmedString(10, 4)).toBe("0.0400");
      expect(d("0.12345").toTrimmedString(10, 4)).toBe("0.12345");
      expect(d("2").toTrimmedString(10, 0)).toBe("2");
      expect(d("2.5").toTrimmedString(0, 0)).toBe("3");
    });
  });
});
