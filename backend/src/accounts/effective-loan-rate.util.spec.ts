import { readFileSync } from "fs";
import { join } from "path";
import {
  effectiveAnnualRateOn,
  EffectiveRateRow,
} from "./effective-loan-rate.util";

interface RateCase {
  name: string;
  rows: EffectiveRateRow[];
  asOfDate: string;
  fallback: number | null;
  expected: number | null;
}

const CASES: RateCase[] = JSON.parse(
  readFileSync(join(__dirname, "loan-rate-timeline-cases.json"), "utf8"),
).cases;

describe("effectiveAnnualRateOn", () => {
  it("has a shared truth table the frontend also asserts", () => {
    // The frontend's contract test reads this same file. A case added on one
    // side is a case both sides must satisfy, which is the whole point: the
    // two layers cannot import each other, and the scheduled bill and the
    // amortization projection must price at the same rate (INV-LOAN-006).
    expect(CASES.length).toBeGreaterThan(5);
  });

  it.each(CASES)("$name", ({ rows, asOfDate, fallback, expected }) => {
    expect(effectiveAnnualRateOn(rows, asOfDate, fallback)).toBe(expected);
  });

  it("reads a decimal column arriving as a string", () => {
    // `numeric` crosses the driver as a string; the rule must not compare or
    // return one (backend/CLAUDE.md, raw-select rule).
    expect(
      effectiveAnnualRateOn(
        [{ effectiveDate: "2026-01-01", annualRate: "7.2500" }],
        "2026-08-01",
        6,
      ),
    ).toBe(7.25);
  });

  it("falls back rather than returning NaN for an unreadable rate", () => {
    expect(
      effectiveAnnualRateOn(
        [{ effectiveDate: "2026-01-01", annualRate: "not a number" }],
        "2026-08-01",
        6,
      ),
    ).toBe(6);
  });
});
